import requests
import json
import os

# 拿一個有效的日語音檔
wav_path = 'upload_segments/2001.wav'
# 給它一個完全對不上的英文歌詞（但需要是字典裡有的單字，或者模型能處理的）
# 為了確保 MFA 能跑，我們用日語模型支援的羅馬字，但隨機組合
mismatched_lyrics = "o i f u k u r o o i f u k u r o o i f u k u r o" # 重複很多次，但跟原音檔完全無關

with open('dictionaries/jp-romanji.json', 'r') as f:
    phonemes = json.load(f)

url = "http://localhost:8001/align?model=japanese_mfa&tier_type=phones"

files = {'wav': open(wav_path, 'rb')}
data = {
    'romanji_lyrics': mismatched_lyrics,
    'phonemes': json.dumps(phonemes)
}

try:
    print(f"--- Stress Test: Mismatched Audio & Lyrics ---")
    print(f"Audio: {wav_path}")
    print(f"Fake Lyrics: {mismatched_lyrics}")
    
    response = requests.post(url, files=files, data=data)
    print(f"Status Code: {response.status_code}")
    
    if response.status_code == 200:
        print("Response Body (with confidence scores):")
        lines = response.text.strip().split('\n')
        scores = []
        for line in lines:
            print(f"  {line}")
            parts = line.split()
            if len(parts) == 4:
                scores.append(float(parts[3]))
        
        if scores:
            print(f"\nSummary for Mismatched Data:")
            print(f"  Min Score: {min(scores):.4f}")
            print(f"  Max Score: {max(scores):.4f}")
            print(f"  Avg Score: {sum(scores)/len(scores):.4f}")
    else:
        print(f"Error: {response.text}")

except Exception as e:
    print(f"Error: {e}")
finally:
    files['wav'].close()
