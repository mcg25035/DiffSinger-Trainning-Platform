import requests
import json
import os
import sys

# 取得前 10 個音檔進行測試
wav_files = sorted([f for f in os.listdir('upload_segments') if f.endswith('.wav')])[:10]
url = "http://localhost:8001/align_batch?model=japanese_mfa&tier_type=phones"

lyrics_data = {}
files = []

for wav_name in wav_files:
    base_name = os.path.splitext(wav_name)[0]
    lab_path = os.path.join('upload_segments', f"{base_name}.lab")
    
    # 這裡的 .lab 檔案內容可能是標註好的，我們需要轉換成文字
    # 假設我們只是測試，可以用一個固定的歌詞或者嘗試解析
    # 但剛才看到 .lab 是數字，我們需要尋找正確的歌詞來源
    # 如果沒有歌詞，我們用之前 test_mfa.py 的測試歌詞
    lyrics = "ta bu n jo u zu ta ta bu n ge de i i ne" 
    
    lyrics_data[wav_name] = lyrics
    files.append(('wavs', (wav_name, open(os.path.join('upload_segments', wav_name), 'rb'), 'audio/wav')))

data = {
    'lyrics_json': json.dumps(lyrics_data)
}

try:
    print(f"Sending batch request for {len(wav_files)} files...")
    response = requests.post(url, files=files, data=data)
    print(f"Status Code: {response.status_code}")
    
    if response.status_code == 200:
        results = response.json()
        for filename, output in results.items():
            print(f"\n--- Result for {filename} ---")
            lines = output.strip().split('\n')
            for line in lines[:5]:
                print(f"  {line}")
            if len(lines) > 5:
                print(f"  ... total {len(lines)} lines")
            
            # 計算該檔案的平均分數
            try:
                scores = [float(l.split()[-1]) for l in lines if len(l.split()) == 4]
                if scores:
                    avg_score = sum(scores) / len(scores)
                    print(f"  Average Confidence: {avg_score:.4f}")
            except:
                pass
    else:
        print(f"Error: {response.text}")

except Exception as e:
    print(f"Error: {e}")
finally:
    for _, f_tuple in files:
        f_tuple[1].close()
