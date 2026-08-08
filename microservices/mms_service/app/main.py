import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import uuid
import shutil
import logging
import threading
import json
import time
import concurrent.futures
from pathlib import Path
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
import torch
import torchaudio
import numpy as np

# Landmark-based boundary refinement (PanPhon features + Auto-Landmark detection)
from landmark_refinement import refine_boundaries_with_landmarks

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("mms_service")

app = FastAPI(
    title="MMS Forced Aligner Service",
    description="FastAPI service for zero-shot and fine-tuned MMS-FA alignment.",
    version="1.0.0"
)

# Directory Setup
DATA_DIR = Path(os.environ.get("MMS_DATA_DIR", "/app/data" if os.path.exists("/app/data") else str(Path(__file__).resolve().parent.parent / "data")))
TRAIN_DATA_DIR = DATA_DIR / "training_data"
WEIGHTS_DIR = DATA_DIR / "weights"
MODEL_WEIGHTS_PATH = WEIGHTS_DIR / "mms_fine_tuned_head.pth"

TRAIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

# Device Configuration
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
logger.info(f"Using device: {device}")

if device.type == "cpu":
    # Reserve at least 2 cores for Uvicorn / OS to prevent socket hangup
    num_threads = max(1, (os.cpu_count() or 4) - 2)
    torch.set_num_threads(num_threads)
    logger.info(f"Set PyTorch CPU threads to {num_threads} (reserved 2 cores for web server)")

# Load MMS_FA Aligner resources
logger.info("Loading MMS_FA Model bundle...")
bundle = torchaudio.pipelines.MMS_FA
model = bundle.get_model()
model.to(device)

# Save a copy of the original base (zero-shot) weights of the CTC head
base_head_state_dict = {k: v.cpu().clone() for k, v in model.model.aux.state_dict().items()}

tokenizer = bundle.get_tokenizer()
dictionary = bundle.get_dict()
aligner = bundle.get_aligner()
FRAME_DURATION_S = 320 / 16000.0

# Threading locks
model_lock = threading.Lock()
training_lock = threading.Lock()
align_counter_lock = threading.Lock()
active_align_requests = 0
training_should_stop = False

# Global Training State
training_state = {
    "status": "idle",       # "idle", "training", "paused", "error"
    "current_epoch": 0,
    "total_epochs": 0,
    "current_loss": 0.0,
    "history": [],
    "error_message": None
}

stable_head_state_dict = None

def load_latest_weights():
    """Load latest fine-tuned weights if available, protecting model weights update with a lock."""
    global stable_head_state_dict
    with model_lock:
        if MODEL_WEIGHTS_PATH.exists():
            try:
                # Load on CPU first to avoid VRAM allocation spikes
                state_dict = torch.load(MODEL_WEIGHTS_PATH, map_location="cpu")
                model.model.aux.load_state_dict({k: v.to(device) for k, v in state_dict.items()})
                stable_head_state_dict = state_dict
                logger.info("Successfully loaded latest fine-tuned weights.")
                return True
            except Exception as e:
                logger.error(f"Failed to load fine-tuned weights: {e}")

        # Fallback to base weights
        model.model.aux.load_state_dict({k: v.to(device) for k, v in base_head_state_dict.items()})
        stable_head_state_dict = {k: v.cpu().clone() for k, v in base_head_state_dict.items()}
        logger.info("No fine-tuned weights found. Operating with base pre-trained model.")
        return False

# Initial weights load
load_latest_weights()

def parse_lyrics_to_phonemes(lyrics_str: str) -> List[str]:
    """Parse lyrics/phonemes string from JSON list, comma-separated, or space-separated format."""
    lyrics_str = lyrics_str.strip()
    if not lyrics_str:
        return []

    # Try parsing as JSON array
    if lyrics_str.startswith("[") and lyrics_str.endswith("]"):
        try:
            parsed = json.loads(lyrics_str)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except Exception:
            pass

    # Try splitting by comma
    if "," in lyrics_str:
        return [p.strip() for p in lyrics_str.split(",") if p.strip()]

    # Default to space-separated splitting
    return [p.strip() for p in lyrics_str.split() if p.strip()]

def run_training_loop(epochs: int, lr: float):
    """Executes the CTC projection layer fine-tuning loop."""
    global training_state, training_should_stop

    with training_lock:
        if training_state["status"] in ("training", "paused"):
            logger.warning("Training is already running or paused, skipping execution.")
            return
        training_should_stop = False
        training_state["status"] = "training"
        training_state["current_epoch"] = 0
        training_state["total_epochs"] = epochs
        training_state["current_loss"] = 0.0
        training_state["history"] = []
        training_state["error_message"] = None

    try:
        logger.info("Starting automatic fine-tuning...")

        # Load dataset from data/training_data
        wav_paths = sorted(TRAIN_DATA_DIR.glob("*.wav"))
        if not wav_paths:
            raise ValueError("No WAV files found in training_data directory.")

        dataset = []
        for wav_path in wav_paths:
            lab_path = wav_path.with_suffix(".lab")
            if not lab_path.exists():
                continue

            phonemes = []
            with open(lab_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                # Handle space-separated phoneme strings
                phonemes = [p for p in content.split() if p not in ("pau", "br", "sp", "sil", "spn")]

            if not phonemes:
                continue

            # Load and resample audio to 16000Hz mono
            waveform, sr = torchaudio.load(str(wav_path))
            if waveform.size(0) > 1:
                waveform = waveform.mean(dim=0, keepdim=True)
            if sr != 16000:
                waveform = torchaudio.functional.resample(waveform, sr, 16000)

            # Clean and tokenize phonemes
            cleaned_phonemes = []
            for ph in phonemes:
                ph_clean = "".join(c for c in ph.lower() if c in dictionary)
                if not ph_clean:
                    ph_clean = "-"
                cleaned_phonemes.append(ph_clean)

            token_ids = tokenizer(cleaned_phonemes)
            flat_tokens = [tok for ph_list in token_ids for tok in ph_list]

            dataset.append({
                "waveform": waveform.squeeze(0),
                "targets": torch.tensor(flat_tokens, dtype=torch.int32),
                "phonemes": phonemes,
                "cleaned_phonemes": cleaned_phonemes
            })

        if not dataset:
            raise ValueError("No valid audio-phoneme pairs found for training.")

        logger.info(f"Loaded {len(dataset)} valid files for training.")

        # Lock model and freeze backbone
        with model_lock:
            for p in model.parameters():
                p.requires_grad = False
            for p in model.model.aux.parameters():
                p.requires_grad = True

            optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr)

        ctc_loss = torch.nn.CTCLoss(blank=0, zero_infinity=True)

        # Fine-tuning loop
        for epoch in range(epochs):
            if training_should_stop:
                raise RuntimeError("Training stopped by user.")
            with training_lock:
                training_state["current_epoch"] = epoch + 1
            epoch_loss = 0.0
            for item in dataset:
                if training_should_stop:
                    raise RuntimeError("Training stopped by user.")
                # Pause training if there are active alignment requests
                paused_logged = False
                while True:
                    if training_should_stop:
                        raise RuntimeError("Training stopped by user.")
                    with align_counter_lock:
                        if active_align_requests == 0:
                            break
                    if not paused_logged:
                        with training_lock:
                            training_state["status"] = "paused"
                        logger.info("Training paused to yield to active MMS alignment requests...")
                        paused_logged = True
                    time.sleep(0.5)

                if paused_logged:
                    with training_lock:
                        training_state["status"] = "training"
                    logger.info("Training resumed.")

                # Keep lock during forward/backward steps to prevent inference conflicts
                with model_lock:
                    torch.cuda.empty_cache()
                    model.train()
                    optimizer.zero_grad()
                    wf = item["waveform"].unsqueeze(0).to(device)
                    targets = item["targets"].unsqueeze(0).to(device)

                    with torch.autocast(device_type="cuda" if "cuda" in str(device) else "cpu", dtype=torch.float16 if "cuda" in str(device) else torch.bfloat16):
                        emissions, _ = model(wf)
                        log_probs = torch.nn.functional.log_softmax(emissions, dim=-1)

                    log_probs = log_probs.transpose(0, 1)

                    input_lengths = torch.tensor([log_probs.size(0)], dtype=torch.int32, device=device)
                    target_lengths = torch.tensor([targets.size(1)], dtype=torch.int32, device=device)

                    loss = ctc_loss(log_probs, targets, input_lengths, target_lengths)
                    loss.backward()

                    torch.nn.utils.clip_grad_norm_(model.model.aux.parameters(), max_norm=1.0)
                    optimizer.step()
                    epoch_loss += loss.item()

                    # Explicitly delete GPU tensors to free memory immediately
                    del wf, targets, emissions, log_probs, input_lengths, target_lengths, loss
                    if "cuda" in str(device):
                        torch.cuda.empty_cache()

                # Yield GIL to allow Uvicorn to handle status / health requests
                time.sleep(0.01)

            avg_loss = epoch_loss / len(dataset)

            with training_lock:
                training_state["current_loss"] = avg_loss
                training_state["history"].append({"epoch": epoch + 1, "loss": avg_loss})

            logger.info(f"Epoch {epoch+1}/{epochs} | Avg Loss: {avg_loss:.4f}")

        # Save the fine-tuned weights
        with model_lock:
            torch.save(model.model.aux.state_dict(), str(MODEL_WEIGHTS_PATH))
        logger.info(f"Model saved to {MODEL_WEIGHTS_PATH}.")

        # Reset weights to loaded model
        load_latest_weights()

        with training_lock:
            training_state["status"] = "idle"

    except Exception as e:
        logger.error(f"Error during training: {e}")
        with training_lock:
            if str(e) == "Training stopped by user.":
                training_state["status"] = "idle"
            else:
                training_state["status"] = "error"
                training_state["error_message"] = str(e)

# --- Sibilant Boundary Refinement ---
# Sibilant/fricative phonemes that produce high-frequency noise
# This set covers common IPA and romanized representations
SIBILANT_PHONEMES = {
    's', 'z', 'sh', 'zh', 'ch', 'ts', 'dz',
    'ʃ', 'ʒ', 'tʃ', 'dʒ', 'ɕ', 'ʑ', 'tɕ', 'dʑ',
    'θ', 'ð', 'f', 'v', 'h', 'ç', 'x', 'ɸ', 'β',
    'ɹ̥',  # voiceless approximant
}

# Vowel-like phonemes (voiced, harmonic structure)
VOWEL_PHONEMES = {
    'a', 'e', 'i', 'o', 'u',
    'ɑ', 'æ', 'ɛ', 'ɪ', 'ɔ', 'ʊ', 'ʌ', 'ə', 'ɚ',
    'aː', 'eː', 'iː', 'oː', 'uː',
    'ai', 'ei', 'oi', 'au', 'ou',
    # Japanese vowels
    'あ', 'い', 'う', 'え', 'お',
}

def _is_sibilant(phoneme: str) -> bool:
    """Check if a phoneme is a sibilant/fricative that produces high-frequency noise."""
    ph = phoneme.lower().strip()
    # Direct match
    if ph in SIBILANT_PHONEMES:
        return True
    # Check if the phoneme ends with a sibilant (e.g., 'os' -> ends with 's')
    for sib in ('s', 'z', 'sh', 'zh', 'ch', 'ts', 'dz'):
        if ph.endswith(sib) and len(ph) > len(sib):
            return True
    return False

def _is_vowel_like(phoneme: str) -> bool:
    """Check if a phoneme is vowel-like (has harmonic structure)."""
    ph = phoneme.lower().strip()
    if ph in VOWEL_PHONEMES:
        return True
    # Single character vowels
    if len(ph) == 1 and ph in 'aeiou':
        return True
    # Nasals and liquids also have harmonic structure
    if ph in ('m', 'n', 'ŋ', 'l', 'r', 'ɾ', 'w', 'j', 'y'):
        return True
    # Check if phoneme contains a vowel (e.g. 'ka', 'to', 'no')
    for v in 'aeiou':
        if v in ph:
            return True
    return False

def refine_sibilant_boundaries(
    waveform: torch.Tensor,
    sr: int,
    segments: List[Dict[str, Any]],
    search_window_ms: float = 80.0,
    stft_window_ms: float = 10.0,
    stft_hop_ms: float = 2.0,
    hf_threshold_hz: float = 3000.0,
) -> List[Dict[str, Any]]:
    """
    Refine alignment boundaries where a voiced phoneme transitions to a sibilant.

    Uses spectral analysis to detect the exact point where:
    1. Low-frequency harmonics disappear
    2. High-frequency noise energy increases
    3. Spectral centroid shifts upward

    Args:
        waveform: Audio waveform tensor (1, N) at sample rate sr
        sr: Sample rate (expected 16000)
        segments: List of alignment segments with 'start' (ms), 'end' (ms), 'label'
        search_window_ms: How far before/after the CTC boundary to search (ms)
        stft_window_ms: STFT analysis window size (ms)
        stft_hop_ms: STFT hop size (ms)
        hf_threshold_hz: Frequency threshold to separate low/high bands (Hz)

    Returns:
        Refined segments list (modified in-place and returned)
    """
    if len(segments) < 2:
        return segments

    audio = waveform.squeeze().numpy().astype(np.float64)
    n_samples = len(audio)

    # STFT parameters
    win_samples = int(stft_window_ms * sr / 1000.0)
    hop_samples = int(stft_hop_ms * sr / 1000.0)
    n_fft = max(256, 1 << (win_samples - 1).bit_length())  # Next power of 2

    # Frequency bin indices
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    hf_bin = np.searchsorted(freqs, hf_threshold_hz)

    # Hanning window
    window = np.hanning(win_samples)

    refined_count = 0

    for i in range(len(segments) - 1):
        current_seg = segments[i]
        next_seg = segments[i + 1]

        current_label = current_seg["label"]
        next_label = next_seg["label"]

        # Only refine: vowel-like -> sibilant transitions
        if not (_is_vowel_like(current_label) and _is_sibilant(next_label)):
            continue

        boundary_ms = current_seg["end"]  # = next_seg["start"]
        boundary_sample = int(boundary_ms * sr / 1000.0)

        # Define search region: look before and after the CTC boundary
        search_start_sample = max(0, int((boundary_ms - search_window_ms) * sr / 1000.0))
        search_end_sample = min(n_samples, int((boundary_ms + search_window_ms) * sr / 1000.0))

        # Also clamp to segment boundaries (don't cross into other segments)
        seg_start_sample = int(current_seg["start"] * sr / 1000.0)
        seg_end_sample = min(n_samples, int(next_seg["end"] * sr / 1000.0))
        search_start_sample = max(search_start_sample, seg_start_sample)
        search_end_sample = min(search_end_sample, seg_end_sample)

        if search_end_sample - search_start_sample < win_samples:
            continue

        # Compute frame-by-frame spectral features
        frame_starts = list(range(search_start_sample, search_end_sample - win_samples + 1, hop_samples))
        if not frame_starts:
            continue

        n_frames = len(frame_starts)
        hf_ratios = np.zeros(n_frames)
        centroids = np.zeros(n_frames)
        lf_energies = np.zeros(n_frames)

        for fi, fs in enumerate(frame_starts):
            frame = audio[fs:fs + win_samples] * window
            spectrum = np.abs(np.fft.rfft(frame, n=n_fft)) ** 2
            total_energy = np.sum(spectrum) + 1e-12

            # High-frequency energy ratio (sibilants have high ratio)
            hf_energy = np.sum(spectrum[hf_bin:])
            hf_ratios[fi] = hf_energy / total_energy

            # Spectral centroid (sibilants have higher centroid)
            centroids[fi] = np.sum(freqs * spectrum) / total_energy

            # Low-frequency energy (harmonics, present in vowels)
            lf_energies[fi] = np.sum(spectrum[:hf_bin])

        # Normalize features to [0, 1] range
        def normalize(arr):
            mn, mx = arr.min(), arr.max()
            if mx - mn < 1e-12:
                return np.zeros_like(arr)
            return (arr - mn) / (mx - mn)

        norm_hf = normalize(hf_ratios)
        norm_centroid = normalize(centroids)
        norm_lf = normalize(lf_energies)

        # Composite "sibilant-ness" score:
        # High when HF ratio is high, centroid is high, and LF energy is low
        # The score transitions from ~0 (vowel) to ~1 (sibilant)
        sibilant_score = 0.4 * norm_hf + 0.3 * norm_centroid + 0.3 * (1.0 - norm_lf)

        # Find the transition point: maximum gradient (steepest rise) in sibilant score
        # Use a smoothed version to avoid noise
        kernel_size = max(3, n_frames // 10)
        if kernel_size % 2 == 0:
            kernel_size += 1
        smoothed = np.convolve(sibilant_score, np.ones(kernel_size) / kernel_size, mode='same')

        # Compute gradient
        gradient = np.gradient(smoothed)

        # Find the frame with the steepest positive gradient
        # (this is where the transition from vowel to sibilant happens)
        best_frame = np.argmax(gradient)

        # Verify the transition is significant:
        # The score should genuinely go from low to high
        left_region = smoothed[:max(1, best_frame)]
        right_region = smoothed[min(best_frame + 1, n_frames):]

        if len(left_region) == 0 or len(right_region) == 0:
            continue

        left_mean = np.mean(left_region)
        right_mean = np.mean(right_region)

        # Only adjust if there's a clear transition (right side is notably more "sibilant")
        if right_mean - left_mean < 0.15:
            continue

        # Convert frame index back to time
        new_boundary_sample = frame_starts[best_frame] + win_samples // 2
        new_boundary_ms = new_boundary_sample * 1000.0 / sr

        # Sanity check: don't move the boundary too far
        shift_ms = abs(new_boundary_ms - boundary_ms)
        if shift_ms > search_window_ms:
            continue

        # Apply the refined boundary
        old_boundary_ms = boundary_ms
        new_boundary_ms = round(new_boundary_ms, 2)

        # Make sure the new boundary doesn't create zero-length or negative-length segments
        min_seg_ms = 20.0  # Minimum segment duration
        if new_boundary_ms - current_seg["start"] < min_seg_ms:
            continue
        if next_seg["end"] - new_boundary_ms < min_seg_ms:
            continue

        current_seg["end"] = new_boundary_ms
        next_seg["start"] = new_boundary_ms

        refined_count += 1
        logger.info(
            f"  Sibilant boundary refined: '{current_label}' -> '{next_label}' "
            f"moved {old_boundary_ms:.1f}ms -> {new_boundary_ms:.1f}ms "
            f"(shifted {new_boundary_ms - old_boundary_ms:+.1f}ms)"
        )

    if refined_count > 0:
        logger.info(f"Refined {refined_count} vowel->sibilant boundaries using spectral analysis.")

    return segments


# --- Emission-Based Boundary Refinement ---
# Uses the neural network's own CTC emission probabilities to refine boundaries.
# This is universal — it works for ALL phoneme transitions without enumerating types.

def refine_boundaries_from_emissions(
    emissions: torch.Tensor,
    token_ids: List[List[int]],
    segments: List[Dict[str, Any]],
    phonemes: List[str],
    search_frames: int = 4,
    min_segment_ms: float = 20.0,
) -> List[Dict[str, Any]]:
    """
    Refine alignment boundaries using the model's own emission probabilities.

    For each boundary between phoneme[i] and phoneme[i+1], looks at the
    per-frame token probabilities and finds the frame where the probability
    mass shifts from the left phoneme's tokens to the right phoneme's tokens.

    This is more principled than spectral analysis because it uses the same
    neural features that the CTC model already computed.

    Args:
        emissions: Raw model emissions tensor of shape (T, C) — logits per frame per token
        token_ids: List of lists — token indices for each phoneme
        segments: Alignment segments with 'start' (ms), 'end' (ms), 'label'
        phonemes: Original phoneme labels
        search_frames: How many frames before/after the CTC boundary to search
        min_segment_ms: Minimum allowed segment duration after refinement

    Returns:
        Refined segments (modified in-place)
    """
    if len(segments) < 2 or len(token_ids) != len(segments):
        return segments

    # Convert emissions to log-probabilities
    log_probs = torch.nn.functional.log_softmax(emissions, dim=-1)  # (T, C)
    T = log_probs.shape[0]

    # The blank token is index 0 in CTC
    BLANK_IDX = 0

    refined_count = 0

    for i in range(len(segments) - 1):
        left_seg = segments[i]
        right_seg = segments[i + 1]

        # Get token sets for left and right phonemes
        left_tokens = token_ids[i]   # list of token indices for phoneme i
        right_tokens = token_ids[i + 1]  # list of token indices for phoneme i+1

        if not left_tokens or not right_tokens:
            continue

        # Current boundary in frames
        boundary_ms = left_seg["end"]
        boundary_frame = int(boundary_ms / (FRAME_DURATION_S * 1000.0))

        # Define search window (in frames)
        search_start = max(0, boundary_frame - search_frames)
        search_end = min(T, boundary_frame + search_frames + 1)

        if search_end - search_start < 2:
            continue

        # Also don't search beyond the segments' own outer boundaries
        left_start_frame = int(left_seg["start"] / (FRAME_DURATION_S * 1000.0))
        right_end_frame = min(T, int(right_seg["end"] / (FRAME_DURATION_S * 1000.0)))
        search_start = max(search_start, left_start_frame + 1)  # keep at least 1 frame for left
        search_end = min(search_end, right_end_frame)  # keep at least 1 frame for right

        if search_end - search_start < 2:
            continue

        # For each frame in the search window, compute:
        # left_score: sum of log-probs for left phoneme's tokens
        # right_score: sum of log-probs for right phoneme's tokens
        best_frame = boundary_frame
        best_diff_score = float('-inf')

        scores = []
        for f in range(search_start, search_end):
            frame_lp = log_probs[f]  # (C,)

            # Log-sum-exp of left phoneme token probabilities
            left_score = torch.logsumexp(frame_lp[left_tokens], dim=0).item()
            # Log-sum-exp of right phoneme token probabilities
            right_score = torch.logsumexp(frame_lp[right_tokens], dim=0).item()

            scores.append((f, left_score, right_score))

        # Find the transition: the frame where right_score - left_score changes sign
        # (i.e., right phoneme becomes more likely than left phoneme)
        # We want the boundary at the crossover point

        # Compute delta = right_score - left_score for each frame
        deltas = [(f, rs - ls) for f, ls, rs in scores]

        # Find the first frame where delta goes from negative to positive
        # (left phoneme dominant -> right phoneme dominant)
        crossover_frame = None
        for j in range(len(deltas) - 1):
            f_curr, d_curr = deltas[j]
            f_next, d_next = deltas[j + 1]
            if d_curr <= 0 and d_next > 0:
                # Crossover between these two frames
                # Pick the one closest to zero-crossing
                crossover_frame = f_curr if abs(d_curr) < abs(d_next) else f_next
                break

        if crossover_frame is None:
            # No clean crossover found — try finding the frame with the steepest
            # transition (largest jump in delta)
            if len(deltas) >= 2:
                max_jump = float('-inf')
                max_jump_frame = None
                for j in range(len(deltas) - 1):
                    f_curr, d_curr = deltas[j]
                    f_next, d_next = deltas[j + 1]
                    jump = d_next - d_curr
                    if jump > max_jump:
                        max_jump = jump
                        max_jump_frame = f_next
                # Only use if the jump is significant
                if max_jump > 0.5 and max_jump_frame is not None:
                    crossover_frame = max_jump_frame

        if crossover_frame is None or crossover_frame == boundary_frame:
            continue

        # Convert to ms
        new_boundary_ms = round(crossover_frame * FRAME_DURATION_S * 1000.0, 2)

        # Safety checks
        if new_boundary_ms - left_seg["start"] < min_segment_ms:
            continue
        if right_seg["end"] - new_boundary_ms < min_segment_ms:
            continue

        old_boundary_ms = boundary_ms
        left_seg["end"] = new_boundary_ms
        right_seg["start"] = new_boundary_ms

        refined_count += 1
        shift = new_boundary_ms - old_boundary_ms
        logger.debug(
            f"  Emission boundary refined: '{phonemes[i]}' -> '{phonemes[i+1]}' "
            f"{old_boundary_ms:.1f}ms -> {new_boundary_ms:.1f}ms "
            f"(shifted {shift:+.1f}ms)"
        )

    if refined_count > 0:
        logger.info(
            f"Emission-based refinement: adjusted {refined_count}/{len(segments)-1} "
            f"boundaries using token probability crossover."
        )

    return segments

# --- MFA Hybrid Boundary Refinement ---
# Optionally calls the MFA service to get a second alignment opinion,
# then merges MFA boundaries with MMS boundaries for improved precision.

MFA_SERVICE_URL = os.environ.get("MFA_SERVICE_URL", "http://mfa-service:8001")
MFA_HYBRID_ENABLED = os.environ.get("MFA_HYBRID_ENABLED", "true").lower() in ("1", "true", "yes")
MFA_TIMEOUT_S = int(os.environ.get("MFA_TIMEOUT_S", "60"))

def _call_mfa_align(wav_bytes: bytes, romanji_lyrics: str, model: str = "japanese_mfa") -> Optional[str]:
    """Call MFA service to align audio. Returns raw text response or None on failure."""
    import requests as req
    try:
        url = f"{MFA_SERVICE_URL}/align"
        files = {"wav": ("audio.wav", wav_bytes, "audio/wav")}
        data = {
            "phonemes": romanji_lyrics,
            "romanji_lyrics": romanji_lyrics,
        }
        params = {"model": model, "tier_type": "phones"}
        resp = req.post(url, files=files, data=data, params=params, timeout=MFA_TIMEOUT_S)
        if resp.status_code == 200:
            return resp.text
        else:
            logger.warning(f"MFA service returned status {resp.status_code}: {resp.text[:200]}")
            return None
    except req.exceptions.ConnectionError:
        logger.info("MFA service not available (connection refused). Skipping MFA hybrid refinement.")
        return None
    except req.exceptions.Timeout:
        logger.warning(f"MFA service timed out after {MFA_TIMEOUT_S}s. Skipping MFA hybrid refinement.")
        return None
    except Exception as e:
        logger.warning(f"MFA call failed: {e}")
        return None

def _parse_mfa_output(mfa_text: str) -> List[Dict[str, Any]]:
    """Parse MFA alignment output into segment list with confidence scores."""
    segments = []
    for line in mfa_text.strip().split('\n'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            # MFA ticks are in 100-nanosecond units (1e-7 seconds)
            start_tick = int(parts[0])
            end_tick = int(parts[1])
            label = parts[2]
            confidence = float(parts[3]) if len(parts) >= 4 else 0.0

            start_ms = start_tick / 10000.0  # 100ns -> ms
            end_ms = end_tick / 10000.0

            segments.append({
                "start": round(start_ms, 2),
                "end": round(end_ms, 2),
                "label": label,
                "confidence": confidence,
            })
        except (ValueError, IndexError):
            continue
    return segments

def refine_with_mfa(
    mms_segments: List[Dict[str, Any]],
    mfa_segments: List[Dict[str, Any]],
    merge_tolerance_ms: float = 50.0,
    confidence_threshold: float = -80.0,
    min_segment_ms: float = 20.0,
) -> List[Dict[str, Any]]:
    """
    Merge MFA boundaries into MMS alignment results.

    For each MMS boundary, finds the nearest MFA boundary. If:
    - The MFA boundary is within tolerance range
    - The MFA segments around that boundary have acceptable confidence
    Then nudges the MMS boundary toward the MFA boundary.

    This is phoneme-label-agnostic — it works purely on boundary proximity.
    """
    if not mfa_segments or not mms_segments:
        return mms_segments

    # Collect all MFA boundary times (each segment end = next segment start)
    mfa_boundaries = []
    for i in range(len(mfa_segments) - 1):
        boundary_ms = mfa_segments[i]["end"]
        # Average confidence of the two segments sharing this boundary
        left_conf = mfa_segments[i].get("confidence", 0.0)
        right_conf = mfa_segments[i + 1].get("confidence", 0.0)
        avg_conf = (left_conf + right_conf) / 2.0
        mfa_boundaries.append((boundary_ms, avg_conf))

    if not mfa_boundaries:
        return mms_segments

    refined_count = 0

    for i in range(len(mms_segments) - 1):
        mms_boundary = mms_segments[i]["end"]

        # Find nearest MFA boundary
        best_mfa = None
        best_dist = float('inf')
        for mfa_b, mfa_conf in mfa_boundaries:
            dist = abs(mfa_b - mms_boundary)
            if dist < best_dist:
                best_dist = dist
                best_mfa = (mfa_b, mfa_conf)

        if best_mfa is None or best_dist > merge_tolerance_ms:
            continue

        mfa_b, mfa_conf = best_mfa

        # Skip if MFA confidence is too low (unreliable boundary)
        if mfa_conf < confidence_threshold:
            continue

        # Weighted merge: higher MFA confidence = trust MFA more
        # Normalize confidence: MFA scores are negative log-likelihood, typically -5 to -30
        # -5 = very confident, -30 = less confident
        # Map to weight: clamp to [0.2, 0.7] range for MFA weight
        conf_normalized = max(0.0, min(1.0, (mfa_conf + 30.0) / 25.0))  # -30->0, -5->1
        mfa_weight = 0.2 + 0.5 * conf_normalized  # range [0.2, 0.7]
        mms_weight = 1.0 - mfa_weight

        new_boundary = mms_weight * mms_boundary + mfa_weight * mfa_b
        new_boundary = round(new_boundary, 2)

        # Safety checks
        if new_boundary - mms_segments[i]["start"] < min_segment_ms:
            continue
        if mms_segments[i + 1]["end"] - new_boundary < min_segment_ms:
            continue

        old_boundary = mms_boundary
        mms_segments[i]["end"] = new_boundary
        mms_segments[i + 1]["start"] = new_boundary

        refined_count += 1
        logger.debug(
            f"  MFA hybrid: boundary {old_boundary:.1f}ms -> {new_boundary:.1f}ms "
            f"(MFA={mfa_b:.1f}ms, conf={mfa_conf:.1f}, weight={mfa_weight:.2f})"
        )

    if refined_count > 0:
        logger.info(
            f"MFA hybrid refinement: adjusted {refined_count}/{len(mms_segments)-1} "
            f"boundaries using MFA cross-reference."
        )

    return mms_segments


def align_audio_to_phonemes(
    waveform: torch.Tensor,
    sr: int,
    phonemes: List[str],
    romanji_lyrics: Optional[str] = None,
    wav_path: Optional[str] = None,
    mfa_model: Optional[str] = None,
    refinement_mode: int = 1,
) -> List[Dict[str, Any]]:
    """Align waveform with phonemes sequence using the loaded model.

    Args:
        waveform: Audio tensor
        sr: Sample rate
        phonemes: List of phoneme labels
        romanji_lyrics: Optional romaji lyrics for MFA hybrid refinement
        wav_path: Optional path to WAV file on disk (for MFA, avoids re-encoding)
        mfa_model: Optional MFA acoustic model name (default: japanese_mfa)
        refinement_mode: 1=Landmark only, 2=Landmark+MFA, 3=Landmark+MFA+FFT
    """
    if waveform.size(0) > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sr != 16000:
        waveform = torchaudio.functional.resample(waveform, sr, 16000)

    cleaned_phonemes = []
    phoneme_to_clean_map = []
    for ph in phonemes:
        ph_clean = "".join(c for c in ph.lower() if c in dictionary)
        if ph_clean:
            cleaned_phonemes.append(ph_clean)
            phoneme_to_clean_map.append(ph)

    if not cleaned_phonemes:
        return []

    token_ids = tokenizer(cleaned_phonemes)

    with model_lock:
        training_head_backup = None
        is_training_active = False
        with training_lock:
            if training_state["status"] in ("training", "paused"):
                is_training_active = True

        if is_training_active:
            # Training is active: backup training weights and load stable weights from CPU cache
            training_head_backup = {k: v.cpu().clone() for k, v in model.model.aux.state_dict().items()}
            if stable_head_state_dict is not None:
                model.model.aux.load_state_dict({k: v.to(device) for k, v in stable_head_state_dict.items()})
            else:
                model.model.aux.load_state_dict({k: v.to(device) for k, v in base_head_state_dict.items()})
        else:
            # Training is NOT active: stable weights are already loaded. No disk load or state modification needed!
            pass

        model.eval()
        torch.cuda.empty_cache()

        # Try running on GPU first
        run_on_gpu_success = False
        if "cuda" in str(device):
            try:
                dev_waveform = waveform.to(device)
                try:
                    with torch.inference_mode():
                        # Run in float32 without autocast to avoid OOM fallback bugs on laptop GPUs
                        outputs = model(dev_waveform)

                    gpu_emissions = outputs[0]
                    emissions = gpu_emissions.float().cpu().detach().clone()
                    run_on_gpu_success = True
                finally:
                    # Clean up GPU references explicitly before garbage collection and cache clearing
                    if 'outputs' in locals():
                        del outputs
                    if 'gpu_emissions' in locals():
                        del gpu_emissions
                    if 'dev_waveform' in locals():
                        del dev_waveform
                    import gc
                    gc.collect()
                    torch.cuda.empty_cache()
            except RuntimeError as gpu_e:
                if "out of memory" in str(gpu_e).lower():
                    logger.warning("CUDA Out of Memory during alignment inference. Falling back to CPU...")
                    import gc
                    gc.collect()
                    torch.cuda.empty_cache()
                else:
                    raise gpu_e

        if not run_on_gpu_success:
            logger.info("Running alignment inference on CPU...")
            model.to("cpu")
            try:
                with torch.inference_mode():
                    # Run CPU in float32, converting emissions to float32 to avoid CTC aligner type errors
                    outputs = model(waveform.to("cpu"))
                cpu_emissions = outputs[0]
                emissions = cpu_emissions.float().cpu().detach().clone()
            except Exception as cpu_e:
                logger.error(f"CPU Fallback alignment failed: {cpu_e}")
                raise cpu_e
            finally:
                if 'outputs' in locals():
                    del outputs
                if 'cpu_emissions' in locals():
                    del cpu_emissions
                if "cuda" in str(device):
                    model.to(device)
                    import gc
                    gc.collect()
                    torch.cuda.empty_cache()

        if training_head_backup is not None:
            model.model.aux.load_state_dict({k: v.to(device) for k, v in training_head_backup.items()})

    # Release model_lock before running CTC aligner on CPU
    spans = aligner(emissions[0], token_ids)

    final_segs = []
    for i, word_spans in enumerate(spans):
        ph_label = phoneme_to_clean_map[i]
        if word_spans:
            start_frame = min(s.start for s in word_spans)
            end_frame = max(s.end for s in word_spans)
            start_ms = start_frame * FRAME_DURATION_S * 1000.0
            end_ms = end_frame * FRAME_DURATION_S * 1000.0
            final_segs.append({
                "start": round(start_ms, 2),
                "end": round(end_ms, 2),
                "label": ph_label
            })
        else:
            prev_end = final_segs[-1]["end"] if final_segs else 0.0
            final_segs.append({
                "start": round(prev_end, 2),
                "end": round(prev_end + 100.0, 2),
                "label": ph_label
            })

    for i in range(len(final_segs) - 1):
        final_segs[i]["end"] = final_segs[i+1]["start"]

    # === Layer 1: Landmark-based boundary refinement (PanPhon + Auto-Landmark) ===
    # Uses IPA articulatory features to classify each transition type,
    # then detects acoustic landmarks (frication onset, voicing offset, etc.)
    # via 6-band spectral energy analysis. Language-independent, no manual rules.
    if refinement_mode >= 1:
        waveform_np = waveform.squeeze().numpy()
        final_segs = refine_boundaries_with_landmarks(waveform_np, 16000, final_segs)

    # === Layer 2: MFA hybrid refinement (cross-reference with HMM-based aligner) ===
    if refinement_mode >= 2 and MFA_HYBRID_ENABLED and romanji_lyrics:
        logger.info(f"Attempting MFA hybrid refinement (romaji: '{romanji_lyrics[:50]}...')")
        try:
            # Get WAV bytes for MFA call
            wav_bytes = None
            if wav_path and os.path.exists(wav_path):
                with open(wav_path, "rb") as f:
                    wav_bytes = f.read()
            else:
                # Encode waveform to WAV bytes in memory
                import io
                buf = io.BytesIO()
                torchaudio.save(buf, waveform, 16000, format="wav")
                wav_bytes = buf.getvalue()

            mfa_text = _call_mfa_align(
                wav_bytes, romanji_lyrics,
                model=mfa_model or "japanese_mfa"
            )
            if mfa_text and "STATUS: SUCCESS" in mfa_text:
                mfa_segments = _parse_mfa_output(mfa_text)
                if mfa_segments:
                    logger.info(f"MFA returned {len(mfa_segments)} segments. Merging with MMS result...")
                    final_segs = refine_with_mfa(final_segs, mfa_segments)
                else:
                    logger.warning("MFA returned no parseable segments.")
            elif mfa_text:
                logger.warning(f"MFA alignment did not succeed: {mfa_text[:100]}")
        except Exception as e:
            logger.warning(f"MFA hybrid refinement failed (non-critical): {e}")

    # === Layer 3: FFT sibilant refinement (targeted, DSP-based) ===
    if refinement_mode >= 3:
        final_segs = refine_sibilant_boundaries(waveform, 16000, final_segs)

    return final_segs

@app.post("/upload")
async def upload_training_pair(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    lyrics: str = Form(...),
    epochs: Optional[int] = Form(20),
    lr: Optional[float] = Form(1e-3)
):
    """Uploads a WAV + Lyrics (phonemes sequence) pair for training. Queues/runs background training."""
    if not audio.filename.lower().endswith(".wav"):
        raise HTTPException(status_code=400, detail="Only WAV audio files are supported.")

    phonemes = parse_lyrics_to_phonemes(lyrics)
    if not phonemes:
        raise HTTPException(status_code=400, detail="No valid phonemes provided in lyrics.")

    # Generate unique pairing ID
    pair_id = uuid.uuid4().hex
    wav_path = TRAIN_DATA_DIR / f"{pair_id}.wav"
    lab_path = TRAIN_DATA_DIR / f"{pair_id}.lab"

    # Save audio file
    try:
        with wav_path.open("wb") as buffer:
            shutil.copyfileobj(audio.file, buffer)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save audio file: {e}")

    # Save phonemes file
    try:
        with lab_path.open("w", encoding="utf-8") as f:
            f.write(" ".join(phonemes))
    except Exception as e:
        if wav_path.exists():
            wav_path.unlink()
        raise HTTPException(status_code=500, detail=f"Failed to save lyrics file: {e}")

    # Trigger training in background if idle
    start_training = False
    with training_lock:
        if training_state["status"] == "idle":
            start_training = True

    if start_training:
        background_tasks.add_task(run_training_loop, epochs, lr)
        return {
            "message": "Files uploaded successfully. Automatic fine-tuning started in the background.",
            "pair_id": pair_id,
            "phonemes": phonemes,
            "training_status": "started"
        }
    else:
        return {
            "message": "Files uploaded successfully. Added to dataset queue. A training session is currently active.",
            "pair_id": pair_id,
            "phonemes": phonemes,
            "training_status": "queued"
        }

@app.post("/train")
async def trigger_training(
    background_tasks: BackgroundTasks,
    epochs: Optional[int] = Form(20),
    lr: Optional[float] = Form(1e-3)
):
    """Manually triggers background fine-tuning."""
    with training_lock:
        if training_state["status"] in ("training", "paused"):
            return JSONResponse(
                status_code=400,
                content={"message": "Training is already in progress or paused.", "status": training_state}
            )

    background_tasks.add_task(run_training_loop, epochs, lr)
    return {"message": "Fine-tuning queued in the background.", "status": training_state}

@app.get("/status")
async def get_status():
    """Queries the current training status."""
    with training_lock:
        return training_state

@app.post("/align")
def align(
    audio: UploadFile = File(...),
    lyrics: str = Form(...)
):
    """Aligned audio to lyrics using the latest available fine-tuned (or pretrained) model."""
    global active_align_requests
    with align_counter_lock:
        active_align_requests += 1

    try:
        if not audio.filename.lower().endswith(".wav"):
            raise HTTPException(status_code=400, detail="Only WAV audio files are supported.")

        phonemes = parse_lyrics_to_phonemes(lyrics)
        if not phonemes:
            raise HTTPException(status_code=400, detail="No valid phonemes provided in lyrics.")

        temp_id = uuid.uuid4().hex
        temp_wav = DATA_DIR / f"temp_{temp_id}.wav"

        try:
            with temp_wav.open("wb") as buffer:
                shutil.copyfileobj(audio.file, buffer)

            waveform, sr = torchaudio.load(str(temp_wav))

            alignment = align_audio_to_phonemes(waveform, sr, phonemes)

            return {
                "filename": audio.filename,
                "phonemes": phonemes,
                "alignment": alignment
            }
        except Exception as e:
            logger.error(f"Alignment failed: {e}")
            raise HTTPException(status_code=500, detail=f"Alignment failed: {e}")
        finally:
            if temp_wav.exists():
                temp_wav.unlink()
    finally:
        with align_counter_lock:
            active_align_requests -= 1

@app.post("/align_batch")
def align_batch(
    wavs: List[UploadFile] = File(...),
    lyrics_json: str = Form(...),
    romanji_json: Optional[str] = Form(None),
    mfa_model: Optional[str] = Form(None),
    refinement_mode: Optional[int] = Form(1),
):
    """Aligns a batch of wav files to their respective lyrics/phonemes list.

    Optional: provide romanji_json (same format as lyrics_json but with original
    romaji words) to enable MFA hybrid refinement.
    """
    global active_align_requests
    with align_counter_lock:
        active_align_requests += 1

    try:
        try:
            lyrics_dict = json.loads(lyrics_json)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid lyrics_json: {e}")

        # Parse optional romaji lyrics for MFA hybrid
        romanji_dict = {}
        if romanji_json:
            try:
                romanji_dict = json.loads(romanji_json)
            except Exception as e:
                logger.warning(f"Failed to parse romanji_json, MFA hybrid disabled: {e}")

        results = {}
        tasks = []

        # 1. Save all uploaded files to temp paths sequentially (fast IO)
        for wav_file in wavs:
            filename = wav_file.filename
            if filename not in lyrics_dict:
                results[filename] = f"ERROR: Missing lyrics for {filename}"
                continue

            lyrics_str = lyrics_dict[filename]
            phonemes = parse_lyrics_to_phonemes(lyrics_str)
            if not phonemes:
                results[filename] = "ERROR: No valid phonemes provided in lyrics."
                continue

            temp_id = uuid.uuid4().hex
            temp_wav = DATA_DIR / f"temp_batch_{temp_id}.wav"

            try:
                with temp_wav.open("wb") as buffer:
                    shutil.copyfileobj(wav_file.file, buffer)
                romanji = romanji_dict.get(filename)
                tasks.append((filename, temp_wav, phonemes, romanji))
            except Exception as e:
                logger.error(f"Failed to save {filename}: {e}")
                results[filename] = f"ERROR: Failed to save file: {e}"
                if temp_wav.exists():
                    temp_wav.unlink()

        # 2. Process alignment tasks in parallel
        active_mfa_model = mfa_model  # capture for closure
        active_refinement_mode = refinement_mode or 3  # capture for closure
        def process_single_file(filename, temp_wav_path, phonemes_list, romanji_lyrics=None):
            try:
                waveform, sr = torchaudio.load(str(temp_wav_path))
                alignment = align_audio_to_phonemes(
                    waveform, sr, phonemes_list,
                    romanji_lyrics=romanji_lyrics,
                    wav_path=str(temp_wav_path),
                    mfa_model=active_mfa_model,
                    refinement_mode=active_refinement_mode,
                )

                # Format in the HTK-like format with times in 100ns (1e-7 s)
                lines = []
                for seg in alignment:
                    start_100ns = int(seg["start"] * 10000)
                    end_100ns = int(seg["end"] * 10000)
                    lines.append(f"{start_100ns} {end_100ns} {seg['label']}")
                lines.append("# STATUS: SUCCESS")
                return filename, "\n".join(lines)
            except Exception as e:
                logger.error(f"Alignment failed for {filename}: {e}")
                return filename, f"ERROR: {e}"
            finally:
                if temp_wav_path.exists():
                    temp_wav_path.unlink()

        # Limit the number of parallel workers to save memory and avoid CPU/GPU contention.
        # Default is 4, but can be overridden by environment variable MAX_ALIGN_WORKERS.
        env_max_workers = os.environ.get("MAX_ALIGN_WORKERS")
        if env_max_workers:
            try:
                max_workers = int(env_max_workers)
            except ValueError:
                max_workers = 4
        else:
            max_workers = min(4, max(1, (os.cpu_count() or 4) - 2))

        max_workers = min(len(tasks), max_workers)
        if max_workers > 0:
            with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = [executor.submit(process_single_file, fname, twav, phs, rmj) for fname, twav, phs, rmj in tasks]
                for future in concurrent.futures.as_completed(futures):
                    fname, res = future.result()
                    results[fname] = res

        return results
    finally:
        with align_counter_lock:
            active_align_requests -= 1

@app.get("/health")
async def health():
    """Standard health check query."""
    return {
        "status": "ok",
        "device": str(device),
        "fine_tuned_weights_exist": MODEL_WEIGHTS_PATH.exists()
    }

@app.get("/dictionary")
async def get_dictionary():
    """Returns the vocabulary dictionary keys of the MMS-FA model."""
    return list(dictionary.keys())

@app.delete("/model")
async def delete_model():
    """Deletes the fine-tuned model and restores base weights."""
    with model_lock:
        if MODEL_WEIGHTS_PATH.exists():
            MODEL_WEIGHTS_PATH.unlink()
            logger.info("Fine-tuned weights deleted.")
            model.model.aux.load_state_dict({k: v.to(device) for k, v in base_head_state_dict.items()})
            return {"status": "success", "message": "Fine-tuned model deleted and base weights restored."}
        else:
            return {"status": "success", "message": "No fine-tuned model found."}

@app.post("/model/reload")
async def reload_model():
    """Reloads the fine-tuned model weights from disk."""
    load_latest_weights()
    return {"status": "success", "message": "Model weights reloaded."}

@app.post("/train/stop")
async def stop_training():
    """Stops the active training loop."""
    global training_should_stop
    with training_lock:
        if training_state["status"] in ("training", "paused"):
            training_should_stop = True
            return {"status": "success", "message": "Training stop requested."}
        else:
            return {"status": "success", "message": "No active training session to stop."}
