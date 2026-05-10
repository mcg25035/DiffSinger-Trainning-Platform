import requests
import json
import os

# 實際的音檔 2001.wav (歌詞應該是 ta bu n jo u zu...)
wav_path = 'upload_segments/2001.wav'
# 實際的另一段歌詞 5011.txt (歌詞是 shi n ji te ne...)
with open('upload_segments/5011.txt', 'r', encoding='utf-8') as f:
    mismatched_lyrics = f.read().strip()

with open('dictionaries/jp-romanji.json', 'r') as f:
    phonemes = json.load(f)

url = "http://localhost:8001/align?model=japanese_mfa&tier_type=phones"

files = {'wav': open(wav_path, 'rb')}
data = {
    'romanji_lyrics': mismatched_lyrics,
    'phonemes': json.dumps(phonemes)
}

try:
    print(f"--- Real-world Mismatch Test ---")
    print(f"Audio File: {wav_path} (Actual content: ta bu n jo u zu...)")
    print(f"Mismatched Lyrics: {mismatched_lyrics}")
    
    response = requests.post(url, files=files, data=data)
    print(f"Status Code: {response.status_code}")
    
    if response.status_code == 200:
        lines = response.text.strip().split('\n')
        scores = []
        print("\nAlignment Results:")
        for line in lines:
            print(f"  {line}")
            parts = line.split()
            if len(parts) == 4:
                scores.append(float(parts[3]))
        
        if scores:
            print(f"\nSummary for Real Mismatch:")
            print(f"  Min Score: {min(scores):.4f}")
            print(f"  Max Score: {max(scores):.4f}")
            print(f"  Avg Score: {sum(scores)/len(scores):.4f}")
            
            # 找出最低分的音素
            min_idx = scores.index(min(scores))
            print(f"  Worst matched phone: {lines[min_idx]}")
    else:
        print(f"Error: {response.text}")

except Exception as e:
    print(f"Error: {e}")
finally:
    files['wav'].close()
