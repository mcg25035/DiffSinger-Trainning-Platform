"""
Landmark-Based Boundary Refinement Module
==========================================
Uses Stevens' Landmark Theory (implemented via Auto-Landmark methodology)
combined with PanPhon IPA feature database to automatically refine
phoneme boundaries without manually enumerating rules.

Architecture:
  1. PanPhon classifies each phoneme pair's transition type via IPA features
  2. Landmark detector finds acoustic events (frication onset, voicing offset, etc.)
  3. Boundary is moved to the nearest relevant landmark

This is language-independent — works for any phoneme expressible in IPA.
"""

import numpy as np
import logging
from typing import List, Dict, Any, Optional, Tuple, Set

logger = logging.getLogger("mms_service")

# ============================================================================
# Part 1: DiffSinger Label → IPA Mapping
# ============================================================================
# Inverted from japanese_mfa.json reverse_mapping.
# This is the canonical map used by the MFA workflow.
# For multi-language support, extend this dict or load from config.

DIFFSINGER_TO_IPA = {
    "a": "a", "i": "i", "u": "ɯ", "e": "e", "o": "o",
    "k": "k", "ky": "c", "g": "ɡ", "gy": "ɟ",
    "s": "s", "sh": "ɕ", "z": "dz", "j": "dʑ",
    "t": "t", "ch": "tɕ", "ts": "ts", "d": "d",
    "n": "n", "ny": "ɲ", "h": "h", "hy": "ç", "f": "ɸ",
    "b": "b", "by": "bʲ", "p": "p", "py": "pʲ",
    "m": "m", "my": "mʲ", "y": "j", "r": "ɾ", "ry": "ɾʲ",
    "w": "w", "cl": "ʔ", "pau": "sil", "AP": "sp",
    # Additional common labels
    "SP": "sp", "br": "sp", "-": "sp",
}

# ============================================================================
# Part 2: PanPhon-Based Transition Classifier
# ============================================================================
# Instead of requiring the panphon pip package (heavy dependency),
# we embed the essential IPA → articulatory features for the phonemes
# we actually encounter. This avoids adding a large dependency to Docker.
#
# Features used (from PanPhon's 21-dimensional vector):
#   syl: syllabic (vowels)
#   son: sonorant
#   cons: consonantal
#   cont: continuant (fricatives, vowels = +; stops = -)
#   nas: nasal
#   voi: voiced
#   strid: strident (high-energy fricatives like s, z, ʃ, ʒ)
#   lat: lateral
#   del_rel: delayed release (affricates)

# Feature vectors: {ipa: {feature: +1/0/-1}}
# +1 = present, -1 = absent, 0 = unspecified
IPA_FEATURES = {
    # Vowels
    "a":  {"syl": 1, "son": 1, "cons": -1, "cont": 1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "i":  {"syl": 1, "son": 1, "cons": -1, "cont": 1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "ɯ":  {"syl": 1, "son": 1, "cons": -1, "cont": 1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "e":  {"syl": 1, "son": 1, "cons": -1, "cont": 1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "o":  {"syl": 1, "son": 1, "cons": -1, "cont": 1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    # Voiceless stops
    "k":  {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    "t":  {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    "p":  {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    "c":  {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    # Voiced stops
    "ɡ":  {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "d":  {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "b":  {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "ɟ":  {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "bʲ": {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "pʲ": {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    # Voiceless fricatives
    "s":  {"syl": -1, "son": -1, "cons": 1, "cont": 1, "nas": -1, "voi": -1, "strid": 1, "del_rel": -1},
    "ɕ":  {"syl": -1, "son": -1, "cons": 1, "cont": 1, "nas": -1, "voi": -1, "strid": 1, "del_rel": -1},
    "h":  {"syl": -1, "son": -1, "cons": -1, "cont": 1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    "ç":  {"syl": -1, "son": -1, "cons": -1, "cont": 1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    "ɸ":  {"syl": -1, "son": -1, "cons": 1, "cont": 1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    # Voiced fricatives / affricates
    "dz": {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": 1, "del_rel": 1},
    "dʑ": {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": 1, "del_rel": 1},
    # Voiceless affricates
    "tɕ": {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": -1, "strid": 1, "del_rel": 1},
    "ts": {"syl": -1, "son": -1, "cons": 1, "cont": -1, "nas": -1, "voi": -1, "strid": 1, "del_rel": 1},
    # Nasals
    "n":  {"syl": -1, "son": 1, "cons": 1, "cont": -1, "nas": 1, "voi": 1, "strid": -1, "del_rel": -1},
    "ɲ":  {"syl": -1, "son": 1, "cons": 1, "cont": -1, "nas": 1, "voi": 1, "strid": -1, "del_rel": -1},
    "m":  {"syl": -1, "son": 1, "cons": 1, "cont": -1, "nas": 1, "voi": 1, "strid": -1, "del_rel": -1},
    "mʲ": {"syl": -1, "son": 1, "cons": 1, "cont": -1, "nas": 1, "voi": 1, "strid": -1, "del_rel": -1},
    "ɴ":  {"syl": -1, "son": 1, "cons": 1, "cont": -1, "nas": 1, "voi": 1, "strid": -1, "del_rel": -1},
    # Approximants / glides
    "j":  {"syl": -1, "son": 1, "cons": -1, "cont": 1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "w":  {"syl": -1, "son": 1, "cons": -1, "cont": 1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "ɾ":  {"syl": -1, "son": 1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    "ɾʲ": {"syl": -1, "son": 1, "cons": 1, "cont": -1, "nas": -1, "voi": 1, "strid": -1, "del_rel": -1},
    # Glottal stop
    "ʔ":  {"syl": -1, "son": -1, "cons": -1, "cont": -1, "nas": -1, "voi": -1, "strid": -1, "del_rel": -1},
    # Silence
    "sil": None,
    "sp":  None,
}


def get_ipa(label: str) -> Optional[str]:
    """Convert a DiffSinger phoneme label to IPA."""
    return DIFFSINGER_TO_IPA.get(label)


def get_features(label: str) -> Optional[Dict[str, int]]:
    """Get articulatory features for a DiffSinger phoneme label."""
    ipa = get_ipa(label)
    if ipa is None:
        return None
    return IPA_FEATURES.get(ipa)


# Transition type enum
TRANSITION_VOICED_TO_FRICATIVE = "voiced→fricative"
TRANSITION_FRICATIVE_TO_VOICED = "fricative→voiced"
TRANSITION_VOICED_TO_STOP = "voiced→stop"
TRANSITION_STOP_TO_VOICED = "stop→voiced"
TRANSITION_VOICED_TO_NASAL = "voiced→nasal"
TRANSITION_NASAL_TO_VOICED = "nasal→voiced"
TRANSITION_VOICED_TO_UNVOICED = "voiced→unvoiced"
TRANSITION_UNVOICED_TO_VOICED = "unvoiced→voiced"
TRANSITION_SILENCE_BOUNDARY = "silence_boundary"
TRANSITION_OTHER = "other"


def classify_transition(left_label: str, right_label: str) -> str:
    """Classify the acoustic transition type between two phonemes using features."""
    left_feat = get_features(left_label)
    right_feat = get_features(right_label)

    if left_feat is None or right_feat is None:
        return TRANSITION_SILENCE_BOUNDARY

    l_voi = left_feat.get("voi", 0)
    r_voi = right_feat.get("voi", 0)
    l_cont = left_feat.get("cont", 0)
    r_cont = right_feat.get("cont", 0)
    l_strid = left_feat.get("strid", 0)
    r_strid = right_feat.get("strid", 0)
    l_son = left_feat.get("son", 0)
    r_son = right_feat.get("son", 0)
    l_nas = left_feat.get("nas", 0)
    r_nas = right_feat.get("nas", 0)
    l_syl = left_feat.get("syl", 0)
    r_syl = right_feat.get("syl", 0)

    # Voiced/sonorant → voiceless fricative (the N001.wav 'o'→'s' case)
    if l_voi == 1 and r_voi == -1 and (r_cont == 1 or r_strid == 1):
        return TRANSITION_VOICED_TO_FRICATIVE

    # Voiceless fricative → voiced/sonorant
    if l_voi == -1 and (l_cont == 1 or l_strid == 1) and r_voi == 1:
        return TRANSITION_FRICATIVE_TO_VOICED

    # Voiced → voiceless stop
    if l_voi == 1 and r_voi == -1 and r_cont == -1:
        return TRANSITION_VOICED_TO_STOP

    # Voiceless stop → voiced
    if l_voi == -1 and l_cont == -1 and r_voi == 1:
        return TRANSITION_STOP_TO_VOICED

    # Vowel/sonorant → nasal
    if l_syl == 1 and r_nas == 1:
        return TRANSITION_VOICED_TO_NASAL

    # Nasal → vowel/sonorant
    if l_nas == 1 and r_syl == 1:
        return TRANSITION_NASAL_TO_VOICED

    # Generic voiced → unvoiced
    if l_voi == 1 and r_voi == -1:
        return TRANSITION_VOICED_TO_UNVOICED

    # Generic unvoiced → voiced
    if l_voi == -1 and r_voi == 1:
        return TRANSITION_UNVOICED_TO_VOICED

    return TRANSITION_OTHER


# ============================================================================
# Part 3: Acoustic Landmark Detector (Stevens / Auto-Landmark methodology)
# ============================================================================
# Detects acoustic events by analyzing energy changes across frequency bands.
# Based on the 6-band decomposition from Liu (1996) / Auto-Landmark.
#
# Two-pass strategy: coarse filter (wide window) + fine filter (narrow window)
# for noise-robust detection.

# Frequency bands (Hz) - from Liu 1996 / Auto-Landmark
LANDMARK_BANDS = [
    (0, 400),       # Band 1: Glottal vibration / voicing bar (F0)
    (800, 1500),    # Band 2: Low-frequency sonorant energy
    (1200, 2000),   # Band 3: Low-frequency sonorant energy
    (2000, 3500),   # Band 4: High-frequency frication energy
    (3500, 5000),   # Band 5: High-frequency frication energy
    (5000, 8000),   # Band 6: Silence/stop detection, high-freq noise
]

# Energy change threshold (dB) - universal threshold from Auto-Landmark
ENERGY_CHANGE_THRESHOLD_DB = 6.0

# Band group indices (for readability)
BAND_VOICING = 0          # Band 1: voicing detection
BANDS_LOW = [1, 2]        # Bands 2-3: sonorant energy
BANDS_HIGH = [3, 4, 5]    # Bands 4-6: frication energy
BANDS_ALL_EXCEPT_VOICING = [1, 2, 3, 4, 5]  # Bands 2-6


def compute_band_energies(
    waveform_np: np.ndarray,
    sr: int,
    hop_ms: float = 2.0,
    win_ms: float = 10.0,
) -> np.ndarray:
    """
    Compute energy in each frequency band over time using STFT.

    Returns: array of shape (n_frames, n_bands) with energy in dB.
    """
    hop_samples = int(sr * hop_ms / 1000.0)
    win_samples = int(sr * win_ms / 1000.0)
    n_fft = max(256, 2 ** int(np.ceil(np.log2(win_samples))))

    # Hanning window
    window = np.hanning(win_samples)

    n_frames = (len(waveform_np) - win_samples) // hop_samples + 1
    if n_frames <= 0:
        return np.zeros((1, len(LANDMARK_BANDS)))

    n_bands = len(LANDMARK_BANDS)
    band_energies = np.zeros((n_frames, n_bands))
    freq_resolution = sr / n_fft

    # Precompute band bin ranges
    band_bins = []
    for low_hz, high_hz in LANDMARK_BANDS:
        low_bin = max(0, int(low_hz / freq_resolution))
        high_bin = min(n_fft // 2, int(high_hz / freq_resolution))
        band_bins.append((low_bin, high_bin))

    for frame_idx in range(n_frames):
        start = frame_idx * hop_samples
        segment = waveform_np[start:start + win_samples] * window

        # Zero-pad to n_fft
        padded = np.zeros(n_fft)
        padded[:len(segment)] = segment
        spectrum = np.abs(np.fft.rfft(padded)) ** 2

        for band_idx, (low_bin, high_bin) in enumerate(band_bins):
            if high_bin > low_bin:
                energy = np.mean(spectrum[low_bin:high_bin])
                band_energies[frame_idx, band_idx] = 10 * np.log10(energy + 1e-12)

    return band_energies


def find_landmark_in_region(
    band_energies: np.ndarray,
    start_frame: int,
    end_frame: int,
    transition_type: str,
    hop_ms: float = 2.0,
) -> Optional[float]:
    """
    Search for the most prominent acoustic landmark within a frame region.
    Uses Auto-Landmark criteria (Liu 1996 / Stevens):
      - Frication (f+): ≥6dB rise in ≥3 of 3 high-freq bands + drop in low bands
      - Burst (b+): ≥6dB rise in ≥3 of 5 bands (2-6)
      - Voicing (g-): Energy valley in band 1

    Args:
        band_energies: (n_frames, n_bands) energy array in dB
        start_frame: start of search region
        end_frame: end of search region
        transition_type: output of classify_transition()
        hop_ms: time step per frame in ms

    Returns:
        Absolute time in ms where the landmark is detected,
        or None if no clear landmark found.
    """
    if end_frame <= start_frame or start_frame < 0:
        return None
    end_frame = min(end_frame, band_energies.shape[0])
    if end_frame - start_frame < 3:
        return None

    region = band_energies[start_frame:end_frame]  # (N, 6)
    n_frames = region.shape[0]

    # Apply two-pass smoothing (coarse: 5-frame avg, fine: 3-frame avg)
    def smooth(arr, k):
        if len(arr) < k:
            return arr
        kernel = np.ones(k) / k
        return np.convolve(arr, kernel, mode='same')

    # Per-band frame-to-frame energy deltas (smoothed)
    # delta[i] = energy[i] - energy[i-1] for each band
    def band_deltas(band_idx):
        raw = region[:, band_idx]
        smoothed = smooth(raw, 3)
        deltas = np.diff(smoothed, prepend=smoothed[0])
        return deltas

    threshold = ENERGY_CHANGE_THRESHOLD_DB

    best_frame = -1
    onset_frame = -1
    scores = np.zeros(n_frames)
    raw_scores = np.zeros(n_frames)

    if transition_type in (TRANSITION_VOICED_TO_FRICATIVE, TRANSITION_VOICED_TO_UNVOICED):
        # f+ landmark: high bands rise, low bands drop
        high_deltas = [band_deltas(b) for b in BANDS_HIGH]
        low_deltas = [band_deltas(b) for b in BANDS_LOW]
        voicing_delta = band_deltas(BAND_VOICING)

        for i in range(1, n_frames):
            high_rises = sum(1 for d in high_deltas if d[i] >= threshold)
            low_drops = sum(1 for d in low_deltas if d[i] <= 0)
            voi_drop = -voicing_delta[i] if voicing_delta[i] < 0 else 0

            if high_rises >= 2 and low_drops >= 1:
                scores[i] = high_rises * 2.0 + low_drops + voi_drop * 0.5

        best_frame = np.argmax(scores)
        if scores[best_frame] > 0:
            onset_frame = best_frame

    elif transition_type in (TRANSITION_FRICATIVE_TO_VOICED, TRANSITION_UNVOICED_TO_VOICED):
        # f- / g+ landmark: low bands rise
        high_deltas = [band_deltas(b) for b in BANDS_HIGH]
        low_deltas = [band_deltas(b) for b in BANDS_LOW]
        voicing_delta = band_deltas(BAND_VOICING)

        for i in range(1, n_frames):
            high_drops = sum(1 for d in high_deltas if d[i] <= -threshold)
            low_rises = sum(1 for d in low_deltas if d[i] >= 0)
            voi_rise = voicing_delta[i] if voicing_delta[i] > 0 else 0

            if high_drops >= 2 and low_rises >= 1:
                scores[i] = high_drops * 2.0 + low_rises + voi_rise * 0.5

        best_frame = np.argmax(scores)
        if scores[best_frame] > 0:
            # Backtrack using low-frequency energy (voicing onset)
            low_energy = np.mean(region[:, BANDS_LOW], axis=1)
            low_energy_smoothed = smooth(low_energy, 3)
            peak_val = low_energy_smoothed[best_frame]
            search_start = max(0, best_frame - 50)
            if search_start < best_frame:
                baseline_val = np.min(low_energy_smoothed[search_start:best_frame])
                target_val = baseline_val + 0.2 * (peak_val - baseline_val)
                onset_frame = best_frame
                while onset_frame > search_start and low_energy_smoothed[onset_frame] > target_val:
                    onset_frame -= 1
            else:
                onset_frame = best_frame

    elif transition_type == TRANSITION_VOICED_TO_STOP:
        # g- / closure: energy drop in all bands.
        # Note: drop means peak is a minimum. We want to find when the drop STARTED.
        all_deltas = [band_deltas(b) for b in BANDS_ALL_EXCEPT_VOICING]
        voicing_delta = band_deltas(BAND_VOICING)

        for i in range(1, n_frames):
            drops = sum(1 for d in all_deltas if d[i] <= -threshold)
            voi_drop = -voicing_delta[i] if voicing_delta[i] < 0 else 0

            if drops >= 3:
                scores[i] = drops * 2.0 + voi_drop

        best_frame = np.argmax(scores)
        if scores[best_frame] > 0:
            # Total energy is dropping. best_frame is max rate of drop.
            total_energy = np.mean(region, axis=1)
            total_energy_smoothed = smooth(total_energy, 3)
            trough_val = total_energy_smoothed[best_frame]
            search_start = max(0, best_frame - 50)
            onset_frame = best_frame

    elif transition_type == TRANSITION_STOP_TO_VOICED:
        # b+ / s+ landmark: sudden energy rise
        all_deltas = [band_deltas(b) for b in BANDS_ALL_EXCEPT_VOICING]
        voicing_delta = band_deltas(BAND_VOICING)

        for i in range(1, n_frames):
            rises = sum(1 for d in all_deltas if d[i] >= threshold)
            voi_rise = voicing_delta[i] if voicing_delta[i] > 0 else 0

            if rises >= 3:
                scores[i] = rises * 2.0 + voi_rise

        best_frame = np.argmax(scores)
        if scores[best_frame] > 0:
            onset_frame = best_frame

    elif transition_type in (TRANSITION_VOICED_TO_NASAL, TRANSITION_NASAL_TO_VOICED):
        # Nasal: mid/high energy redistribution. Just backtrack a bit visually
        all_deltas = [band_deltas(b) for b in BANDS_ALL_EXCEPT_VOICING]

        for i in range(1, n_frames):
            scores[i] = sum(abs(d[i]) for d in all_deltas)

        best_frame = np.argmax(scores)
        if scores[best_frame] >= threshold * 2:
            onset_frame = best_frame

    # Fallback for TRANSITION_OTHER: max spectral discontinuity
    if onset_frame == -1 and transition_type == TRANSITION_OTHER:
        all_deltas = [band_deltas(b) for b in range(len(LANDMARK_BANDS))]

        for i in range(1, n_frames):
            scores[i] = sum(abs(d[i]) for d in all_deltas)

        best_frame = np.argmax(scores)
        if scores[best_frame] >= threshold * 2:
            onset_frame = best_frame

    if onset_frame != -1:
        return (start_frame + onset_frame) * hop_ms

    return None


# ============================================================================
# Part 4: Main Refinement Function
# ============================================================================

def refine_boundaries_with_landmarks(
    waveform_np: np.ndarray,
    sr: int,
    segments: List[Dict[str, Any]],
    search_radius_ms: float = 40.0,
    hop_ms: float = 2.0,
    win_ms: float = 10.0,
    min_segment_ms: float = 20.0,
) -> List[Dict[str, Any]]:
    """
    Refine all phoneme boundaries using acoustic landmark detection.

    For each boundary:
      1. PanPhon classifies the transition type (voiced→fricative, etc.)
      2. Landmark detector searches for the relevant acoustic event
      3. Boundary is moved to the detected landmark position

    Args:
        waveform_np: 1D numpy array of audio samples
        sr: sample rate (expected 16000)
        segments: list of {"start": ms, "end": ms, "label": str}
        search_radius_ms: how far before/after boundary to search
        hop_ms: STFT hop size in ms
        win_ms: STFT window size in ms
        min_segment_ms: minimum segment duration after refinement

    Returns:
        Refined segments (modified in-place)
    """
    if len(segments) < 2:
        return segments

    # Compute band energies for entire audio
    band_energies = compute_band_energies(waveform_np, sr, hop_ms, win_ms)

    refined_count = 0
    transition_stats = {}

    for i in range(len(segments) - 1):
        left_seg = segments[i]
        right_seg = segments[i + 1]
        left_label = left_seg["label"]
        right_label = right_seg["label"]

        # Step 1: Classify transition type
        transition_type = classify_transition(left_label, right_label)

        if transition_type == TRANSITION_SILENCE_BOUNDARY:
            continue

        # Step 2: Define search region around current boundary
        boundary_ms = left_seg["end"]
        search_start_ms = max(left_seg["start"] + min_segment_ms, boundary_ms - search_radius_ms)
        search_end_ms = min(right_seg["end"] - min_segment_ms, boundary_ms + search_radius_ms)

        if search_end_ms <= search_start_ms:
            continue

        # Convert to landmark frames
        search_start_frame = int(search_start_ms / hop_ms)
        search_end_frame = int(search_end_ms / hop_ms)

        # Step 3: Find the acoustic landmark
        landmark_ms = find_landmark_in_region(
            band_energies, search_start_frame, search_end_frame,
            transition_type, hop_ms
        )

        if landmark_ms is None:
            continue

        # Step 4: Move boundary to landmark
        new_boundary_ms = round(landmark_ms, 2)

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
            f"Landmark [{transition_type}]: "
            f"{left_label}→{right_label} | "
            f"{old_boundary_ms:.1f}ms → {new_boundary_ms:.1f}ms "
            f"({shift:+.1f}ms)"
        )

    if refined_count > 0:
        stats_str = ", ".join(f"{k}: {v}" for k, v in sorted(transition_stats.items()))
        logger.info(
            f"Landmark refinement: adjusted {refined_count}/{len(segments)-1} "
            f"boundaries. Transitions: {stats_str}"
        )

    return segments
