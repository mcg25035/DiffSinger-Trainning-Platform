import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:32"
import re
import sys
import uvicorn
import shutil
import pykakasi
import gc
import torch
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess

app = FastAPI(title="SenseVoice Hiragana API")

# Global model variable
model = None

# kana mora → romaji 對照表(純資料;與 mms romanizer 的 KANA_TO_ROMAJI、
# Node romaji-mora.js 的 trie 輸出慣例同步:ん→'n'、促音→'cl')
KANA_MORA_TO_ROMAJI = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "を": "wo", "ん": "n",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo",
    "しゃ": "sha", "しゅ": "shu", "しょ": "sho",
    "ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho",
    "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
    "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo",
    "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
    "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo",
    "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
    "じゃ": "ja", "じゅ": "ju", "じょ": "jo",
    "びゃ": "bya", "びゅ": "byu", "びょ": "byo",
    "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
    "ふぁ": "fa", "ふぃ": "fi", "ふぇ": "fe", "ふぉ": "fo",
    "うぃ": "wi", "うぇ": "we", "うぉ": "wo",
    "てぃ": "ti", "でぃ": "di", "とぅ": "tu", "どぅ": "du",
    "しぇ": "she", "じぇ": "je", "ちぇ": "che",
}
_SMALL_TO_BIG = {"ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
                 "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "ゎ": "わ"}

def kana_to_morae(kana: str):
    """kana → romaji mora 序列。kana 的切分(ゃゅょ/っ)完全無歧義,
    不需要 romaji 切分器(hepburn 連續字串的歧義是它自己造成的)。"""
    out, i = [], 0
    while i < len(kana):
        c = kana[i]
        if c == "ー":
            i += 1; continue  # 長音符號併入前音
        if c == "っ":
            out.append("cl"); i += 1; continue
        if i + 1 < len(kana) and kana[i + 1] in _SMALL_TO_BIG and (c + kana[i + 1]) in KANA_MORA_TO_ROMAJI:
            out.append(KANA_MORA_TO_ROMAJI[c + kana[i + 1]]); i += 2; continue
        if c in _SMALL_TO_BIG:  # 獨立小書字(如「ネェ」的 ぇ)
            c = _SMALL_TO_BIG[c]
        out.append(KANA_MORA_TO_ROMAJI.get(c, c))
        i += 1
    return out

def convert_text(text):
    """ASR 輸出(日文/混漢字)→ (hiragana, romaji morae text)。
    pykakasi 拿 item['hira'](kana)→ trivial mora 切分 → 資料表轉回
    mora 序列(與歌詞側 Node 產生的 token 同慣例)。"""
    kks = pykakasi.kakasi()
    result = kks.convert(text)

    # 1. Hiragana(顯示/除錯用)
    hira = "".join([item['hira'] for item in result])
    hira = re.sub(r'[^\u3040-\u309F]', '', hira)

    # 2. kana → mora → romaji(空白分隔,直接就是 mora 序列)
    morae = []
    for item in result:
        morae.extend(kana_to_morae(item['hira']))

    return hira, " ".join(morae)

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
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
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
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if os.path.exists(temp_path):
            os.remove(temp_path)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
