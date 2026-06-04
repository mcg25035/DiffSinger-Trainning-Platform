import os
import re
import sys
import uvicorn
import shutil
import pykakasi
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
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

def match_romaji_to_lyrics(rough_romaji: str, full_lyrics_romaji: str):
    def clean_and_split(text):
        words = text.split()
        cleaned_words = []
        for w in words:
            cw = re.sub(r'[^\w]', '', w).lower()
            cleaned_words.append(cw)
        return words, cleaned_words

    orig_r, seq_r = clean_and_split(rough_romaji)
    orig_f, seq_f = clean_and_split(full_lyrics_romaji)

    if not seq_r or not seq_f:
        return rough_romaji, 0.0

    M = len(seq_r)
    N = len(seq_f)

    dp = [[0] * (N + 1) for _ in range(M + 1)]

    for j in range(N + 1):
        dp[0][j] = 0
    for i in range(1, M + 1):
        dp[i][0] = i

    for i in range(1, M + 1):
        for j in range(1, N + 1):
            cost = 0 if seq_r[i - 1] == seq_f[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,       # deletion
                dp[i][j - 1] + 1,       # insertion
                dp[i - 1][j - 1] + cost # substitution
            )

    min_dist = M + 1
    best_j = 0
    for j in range(1, N + 1):
        if dp[M][j] < min_dist:
            min_dist = dp[M][j]
            best_j = j

    curr_i = M
    curr_j = best_j
    while curr_i > 0:
        val = dp[curr_i][curr_j]
        cost = 0 if seq_r[curr_i - 1] == seq_f[curr_j - 1] else 1
        if curr_j > 0 and dp[curr_i - 1][curr_j - 1] + cost == val:
            curr_i -= 1
            curr_j -= 1
        elif dp[curr_i - 1][curr_j] + 1 == val:
            curr_i -= 1
        elif curr_j > 0 and dp[curr_i][curr_j - 1] + 1 == val:
            curr_j -= 1
        else:
            curr_i -= 1

    start_j = curr_j
    end_j = best_j

    matched_words = orig_f[start_j:end_j]
    matched_romaji = " ".join(matched_words)
    
    score = max(0.0, 1.0 - (min_dist / M)) if M > 0 else 0.0
    return matched_romaji, score

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

@app.post("/transcribe_with_lyrics")
async def transcribe_with_lyrics(file: UploadFile = File(...), full_lyrics: str = Form(...)):
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
        
        matched_romaji, match_score = match_romaji_to_lyrics(romaji_text, full_lyrics)
        
        # If match score is too low, fall back to rough romaji
        final_romaji = matched_romaji if match_score >= 0.3 else romaji_text
        
        return {
            "raw_text": raw_text,
            "hiragana": hiragana_text,
            "rough_romaji": romaji_text,
            "matched_romaji": final_romaji,
            "match_score": match_score
        }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
