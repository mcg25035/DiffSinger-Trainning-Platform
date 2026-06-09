import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:32"
import uuid
import shutil
import logging
import threading
import json
import time
from pathlib import Path
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
import torch
import torchaudio

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
DATA_DIR = Path("/app/data")
TRAIN_DATA_DIR = DATA_DIR / "training_data"
WEIGHTS_DIR = DATA_DIR / "weights"
MODEL_WEIGHTS_PATH = WEIGHTS_DIR / "mms_fine_tuned_head.pth"

TRAIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

# Device Configuration
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
logger.info(f"Using device: {device}")

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

def load_latest_weights():
    """Load latest fine-tuned weights if available, protecting model weights update with a lock."""
    with model_lock:
        if MODEL_WEIGHTS_PATH.exists():
            try:
                state_dict = torch.load(MODEL_WEIGHTS_PATH, map_location=device)
                model.model.aux.load_state_dict(state_dict)
                logger.info("Successfully loaded latest fine-tuned weights.")
                return True
            except Exception as e:
                logger.error(f"Failed to load fine-tuned weights: {e}")
        else:
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
                    
                    with torch.autocast(device_type="cuda" if "cuda" in str(device) else "cpu", dtype=torch.float16):
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

def align_audio_to_phonemes(waveform: torch.Tensor, sr: int, phonemes: List[str]) -> List[Dict[str, Any]]:
    """Align waveform with phonemes sequence using the loaded model."""
    if waveform.size(0) > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sr != 16000:
        waveform = torchaudio.functional.resample(waveform, sr, 16000)
        
    waveform = waveform.to(device)
    
    cleaned_phonemes = []
    for ph in phonemes:
        ph_clean = "".join(c for c in ph.lower() if c in dictionary)
        if not ph_clean:
            ph_clean = "-"
        cleaned_phonemes.append(ph_clean)
        
    token_ids = tokenizer(cleaned_phonemes)
    
    with model_lock:
        training_head_backup = None
        is_training_active = False
        with training_lock:
            if training_state["status"] in ("training", "paused"):
                is_training_active = True
                
        if is_training_active:
            # Training is active: backup training weights and load stable weights
            training_head_backup = {k: v.cpu().clone() for k, v in model.model.aux.state_dict().items()}
            if MODEL_WEIGHTS_PATH.exists():
                try:
                    state_dict = torch.load(MODEL_WEIGHTS_PATH, map_location=device)
                    model.model.aux.load_state_dict(state_dict)
                except Exception as e:
                    logger.error(f"Failed to load stable weights during training pause: {e}")
            else:
                model.model.aux.load_state_dict({k: v.to(device) for k, v in base_head_state_dict.items()})
        else:
            # Training is NOT active: load stable weights (just in case they changed on disk)
            if MODEL_WEIGHTS_PATH.exists():
                try:
                    state_dict = torch.load(MODEL_WEIGHTS_PATH, map_location=device)
                    model.model.aux.load_state_dict(state_dict)
                except Exception as e:
                    logger.error(f"Failed to load stable weights: {e}")

        model.eval()
        torch.cuda.empty_cache()
        with torch.inference_mode():
            with torch.autocast(device_type="cuda" if "cuda" in str(device) else "cpu", dtype=torch.float16):
                emissions, _ = model(waveform)
            
        if training_head_backup is not None:
            model.model.aux.load_state_dict({k: v.to(device) for k, v in training_head_backup.items()})
            
        spans = aligner(emissions[0], token_ids)
        
    final_segs = []
    for i, word_spans in enumerate(spans):
        ph_label = phonemes[i]
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
async def align(
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
async def align_batch(
    wavs: List[UploadFile] = File(...),
    lyrics_json: str = Form(...)
):
    """Aligns a batch of wav files to their respective lyrics/phonemes list."""
    global active_align_requests
    with align_counter_lock:
        active_align_requests += 1

    try:
        try:
            lyrics_dict = json.loads(lyrics_json)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid lyrics_json: {e}")
            
        results = {}
        
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
                    
                waveform, sr = torchaudio.load(str(temp_wav))
                
                alignment = align_audio_to_phonemes(waveform, sr, phonemes)
                
                # Format in the HTK-like format with times in 100ns (1e-7 s)
                lines = []
                for seg in alignment:
                    # seg["start"] is in ms. Convert to 100ns: ms * 10000
                    start_100ns = int(seg["start"] * 10000)
                    end_100ns = int(seg["end"] * 10000)
                    lines.append(f"{start_100ns} {end_100ns} {seg['label']}")
                lines.append("# STATUS: SUCCESS")
                results[filename] = "\n".join(lines)
                
            except Exception as e:
                logger.error(f"Alignment failed for {filename}: {e}")
                results[filename] = f"ERROR: {e}"
            finally:
                if temp_wav.exists():
                    temp_wav.unlink()
                    
        return results
    finally:
        with align_counter_lock:
            active_align_requests -= 1
                
    return results

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
