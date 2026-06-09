import os
import glob
import requests
import librosa
import numpy as np

SEGMENTS_DIR = "upload_segments"
MMS_URL = "http://localhost:8002/align"

def process_file(wav_path, txt_path):
    with open(txt_path, 'r', encoding='utf-8') as f:
        lyrics = f.read().strip()
        
    if not lyrics:
        print(f"Skipping {wav_path}, no lyrics.")
        return
        
    print(f"Aligning {wav_path}...")
    
    with open(wav_path, 'rb') as f:
        files = {'audio': (os.path.basename(wav_path), f, 'audio/wav')}
        data = {'lyrics': lyrics}
        try:
            resp = requests.post(MMS_URL, files=files, data=data)
            resp.raise_for_status()
            alignment = resp.json().get('alignment', [])
        except Exception as e:
            print(f"Failed to align {wav_path}: {e}")
            return
            
    if not alignment:
        print(f"No alignment returned for {wav_path}")
        return

    y, sr = librosa.load(wav_path, sr=None)
    duration = len(y) / sr
    
    intervals = librosa.effects.split(y, top_db=40)
    if len(intervals) > 0:
        true_start = intervals[0][0] / sr
        true_end = intervals[-1][1] / sr
    else:
        true_start = 0.0
        true_end = duration

    for seg in alignment:
        seg['start'] /= 1000.0
        seg['end'] /= 1000.0

    if alignment[0]['start'] > true_start:
        alignment[0]['start'] = true_start
    if alignment[-1]['end'] < true_end:
        alignment[-1]['end'] = true_end

    final_segs = []
    
    def classify_gap(start_s, end_s):
        if end_s <= start_s: return None
        start_samp = int(start_s * sr)
        end_samp = int(end_s * sr)
        if start_samp >= end_samp or start_samp >= len(y): return "pau"
        segment = y[start_samp:end_samp]
        rms = librosa.feature.rms(y=segment)[0]
        if len(rms) > 0 and np.max(rms) > 0.005:
            return "br"
        return "pau"

    if alignment[0]['start'] > 0:
        gap_label = classify_gap(0.0, alignment[0]['start'])
        if gap_label:
            final_segs.append({"start": 0.0, "end": alignment[0]['start'], "label": gap_label})

    for i in range(len(alignment)):
        seg = alignment[i]
        if len(final_segs) > 0:
            prev_end = final_segs[-1]['end']
            if seg['start'] > prev_end + 0.01:
                gap_label = classify_gap(prev_end, seg['start'])
                if gap_label:
                    final_segs.append({"start": prev_end, "end": seg['start'], "label": gap_label})
            elif seg['start'] < prev_end:
                seg['start'] = prev_end
        final_segs.append(seg)

    last_end = final_segs[-1]['end']
    if last_end < duration - 0.01:
        gap_label = classify_gap(last_end, duration)
        if gap_label:
            final_segs.append({"start": last_end, "end": duration, "label": gap_label})

    lab_path = wav_path.replace('.wav', '.lab')
    lines = []
    for seg in final_segs:
        start_100ns = int(seg['start'] * 10_000_000)
        end_100ns = int(seg['end'] * 10_000_000)
        if end_100ns < start_100ns: end_100ns = start_100ns
        lines.append(f"{start_100ns} {end_100ns} {seg['label']}\n")
        
    with open(lab_path, 'w', encoding='utf-8') as f:
        f.writelines(lines)

def main():
    wav_files = sorted(glob.glob(os.path.join(SEGMENTS_DIR, "*.wav")))
    count = 0
    for wav_path in wav_files:
        lab_path = wav_path.replace('.wav', '.lab')
        if not os.path.exists(lab_path):
            txt_path = wav_path.replace('.wav', '.txt')
            if os.path.exists(txt_path):
                process_file(wav_path, txt_path)
                count += 1
            else:
                print(f"No .txt for {wav_path}")
    print(f"Processed {count} new files.")

if __name__ == "__main__":
    main()
