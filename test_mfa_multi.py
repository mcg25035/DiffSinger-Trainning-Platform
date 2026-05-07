import requests
import json
import os

files_to_test = ['001', '002', '003']
url = "http://localhost:8001/align?model=japanese_mfa&tier_type=phones"

with open('dictionaries/jp-romanji.json', 'r') as f:
    phonemes = json.load(f)

for fid in files_to_test:
    wav_path = f'upload_segments/{fid}.wav'
    lab_path = f'upload_segments/{fid}.lab'
    
    if not os.path.exists(wav_path) or not os.path.exists(lab_path):
        print(f"Skipping {fid}: File not found")
        continue
        
    with open(lab_path, 'r') as f:
        lyrics = f.read().strip()

    print(f"\n--- Testing Segment {fid} ---")
    print(f"Lyrics: {lyrics}")
    
    files = {'wav': open(wav_path, 'rb')}
    data = {
        'romanji_lyrics': lyrics,
        'phonemes': json.dumps(phonemes)
    }

    try:
        response = requests.post(url, files=files, data=data)
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            print("Response (first 5 lines):")
            lines = response.text.strip().split('\n')
            for line in lines[:5]:
                print(f"  {line}")
            if len(lines) > 5:
                print(f"  ... total {len(lines)} lines")
        else:
            print(f"Error: {response.text}")
    except Exception as e:
        print(f"Request failed: {e}")
    finally:
        files['wav'].close()
