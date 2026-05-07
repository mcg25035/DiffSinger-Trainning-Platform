import requests
import json

wav_path = 'upload_segments/002.wav'
lyrics = 'shi ra zu shi na tsu no u chi ni ki tsu tsu ke te shi ma ta ri'

with open('dictionaries/jp-romanji.json', 'r') as f:
    phonemes = json.load(f)

url = "http://localhost:8001/align?model=japanese_mfa&tier_type=phones"

files = {
    'wav': open(wav_path, 'rb')
}
data = {
    'romanji_lyrics': lyrics,
    'phonemes': json.dumps(phonemes)
}

try:
    print(f"Sending request to {url}...")
    response = requests.post(url, files=files, data=data)
    print(f"Status Code: {response.status_code}")
    print("Response Body:")
    try:
        print(json.dumps(response.json(), indent=2, ensure_ascii=False))
    except:
        print(response.text)
except Exception as e:
    print(f"Error: {e}")
finally:
    files['wav'].close()
