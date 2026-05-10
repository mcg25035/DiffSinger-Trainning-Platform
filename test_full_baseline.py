import requests
import json
import os

# 取得所有 wav/txt 對
wav_dir = 'upload_segments'
all_files = os.listdir(wav_dir)
wav_files = sorted([f for f in all_files if f.endswith('.wav')])

print(f"Found {len(wav_files)} WAV files.")

# 每次處理 50 個，避免請求太大
batch_size = 50
url = "http://localhost:8001/align_batch?model=japanese_mfa&tier_type=phones"

all_stats = []

for i in range(0, len(wav_files), batch_size):
    batch = wav_files[i : i + batch_size]
    print(f"\nProcessing batch {i//batch_size + 1} ({len(batch)} files)...")
    
    lyrics_data = {}
    files = []
    
    for wav_name in batch:
        base_name = os.path.splitext(wav_name)[0]
        txt_path = os.path.join(wav_dir, f"{base_name}.txt")
        
        if os.path.exists(txt_path):
            with open(txt_path, 'r', encoding='utf-8') as f:
                lyrics = f.read().strip()
            lyrics_data[wav_name] = lyrics
            files.append(('wavs', (wav_name, open(os.path.join(wav_dir, wav_name), 'rb'), 'audio/wav')))
    
    if not files:
        continue
        
    data = {'lyrics_json': json.dumps(lyrics_data)}
    
    try:
        response = requests.post(url, files=files, data=data)
        if response.status_code == 200:
            results = response.json()
            for filename, output in results.items():
                if "ERROR" in output:
                    print(f"  {filename}: {output[:50]}...")
                    continue
                
                # 解析 metadata
                meta = {}
                for line in output.split('\n'):
                    if line.startswith('#'):
                        key, val = line[1:].split(':', 1)
                        meta[key.strip()] = val.strip()
                
                if meta:
                    min_s = float(meta.get('MIN_SCORE', 0))
                    avg_s = float(meta.get('AVG_SCORE', 0))
                    status = meta.get('STATUS', 'UNKNOWN')
                    retry = meta.get('RETRY_USED', 'False')
                    
                    all_stats.append({
                        'file': filename,
                        'min': min_s,
                        'avg': avg_s,
                        'status': status,
                        'retry': retry
                    })
                    print(f"  {filename}: Min={min_s:.2f}, Avg={avg_s:.2f}, Status={status}, Retry={retry}")
        else:
            print(f"  Batch failed: {response.status_code} {response.text[:100]}")
    except Exception as e:
        print(f"  Error: {e}")
    finally:
        for _, f_tuple in files:
            f_tuple[1].close()

# 最終總結
if all_stats:
    print("\n" + "="*50)
    print("FINAL SUMMARY (NORMAL DATA)")
    print("="*50)
    mins = [s['min'] for s in all_stats]
    avgs = [s['avg'] for s in all_stats]
    
    print(f"Total files processed: {len(all_stats)}")
    print(f"Average of Min Scores: {sum(mins)/len(mins):.4f}")
    print(f"Average of Avg Scores: {sum(avgs)/len(avgs):.4f}")
    print(f"Overall Min: {min(mins):.4f}")
    print(f"Overall Max: {max(avgs):.4f}")
    
    warnings = [s for s in all_stats if s['status'] == 'WARNING_LOW_CONFIDENCE']
    print(f"Files with WARNING: {len(warnings)}")
    for w in warnings[:10]:
        print(f"  - {w['file']} (Min: {w['min']:.2f}, Retry: {w['retry']})")
    if len(warnings) > 10:
        print(f"  ... and {len(warnings)-10} more")
