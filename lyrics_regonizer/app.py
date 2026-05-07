import os
import re
import sys
import uvicorn
import shutil
import pykakasi
from fastapi import FastAPI, UploadFile, File, HTTPException
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess

app = FastAPI(title="SenseVoice Hiragana API")

# Global model variable
model = None

def convert_text(text):
    kks = pykakasi.kakasi()
    result = kks.convert(text)
    
    # 1. Process Hiragana
    hira = "".join([item['hira'] for item in result])
    hira = re.sub(r'[^\u3040-\u309F]', '', hira)
    
    # 2. Process Romaji into syllables
    def split_romaji(s):
        res = []
        i = 0
        while i < len(s):
            # Skip spaces and common punctuation
            if s[i].isspace() or s[i] in ".,!?;:\"'-":
                i += 1
                continue
                
            # Nasal 'n' (ん)
            if s[i] == 'n':
                is_nasal = False
                if i + 1 == len(s):
                    is_nasal = True
                elif s[i+1] not in 'aiueo' and s[i+1] != 'y':
                    is_nasal = True
                
                if is_nasal:
                    res.append('N')
                    i += 1
                    continue

            # Consonant(s) + vowel (e.g., 'ka', 'kyu', 'shi', 'chi', 'tsu')
            match = re.match(r'^([bdfghjklmnprstvwzy]*[aiueo])', s[i:])
            if match:
                syll = match.group(1)
                res.append(syll)
                i += len(syll)
            else:
                # Doubled consonants (っ) or individual characters
                if i + 1 < len(s) and s[i] == s[i+1] and s[i] not in 'aiueo':
                    res.append(s[i])
                    i += 1
                else:
                    res.append(s[i])
                    i += 1
        return res

    all_syllables = []
    for item in result:
        # Use hepburn romaji
        r = item['hepburn']
        all_syllables.extend(split_romaji(r))
    
    romaji_text = " ".join(all_syllables)
    return hira, romaji_text

@app.on_event("startup")
async def load_model():
    global model
    model_dir = "FunAudioLLM/SenseVoiceSmall"
    print(f"Loading model: {model_dir}...", file=sys.stderr)
    model = AutoModel(
        model=model_dir,
        hub="hf",
        trust_remote_code=True,
        device="cuda:0" if os.environ.get("USE_CUDA", "1") == "1" else "cpu",
    )
    print("Model loaded successfully.", file=sys.stderr)

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    # Save uploaded file temporarily
    temp_path = f"temp_{file.filename}"
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    try:
        res = model.generate(
            input=temp_path,
            language="ja",
            use_itn=True,
            merge_vad=True,
        )
        
        if not res:
            raise HTTPException(status_code=500, detail="Transcription failed")

        raw_text = rich_transcription_postprocess(res[0]["text"])
        hiragana_text, romaji_text = convert_text(raw_text)
        
        return {
            "raw_text": raw_text,
            "hiragana": hiragana_text,
            "romaji": romaji_text
        }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
