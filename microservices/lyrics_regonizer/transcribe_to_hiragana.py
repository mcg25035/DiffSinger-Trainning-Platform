import sys
import re
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess
import pykakasi

from romaji_lattice import romaji_parses

def convert_text(text):
    kks = pykakasi.kakasi()
    result = kks.convert(text)
    
    # 1. Process Hiragana
    hira = "".join([item['hira'] for item in result])
    hira = re.sub(r'[^\u3040-\u309F]', '', hira)
    
    # 2. Process Romaji into syllables
    # 羅馬拼音音拍 lattice(Trie/FSM 分支窮舉,保守解在前;與 mms romanizer 同規則)
    # DFS 引擎與轉移規則在 romaji_lattice.py;這裡只給本腳本的細項條件:
    # 音節原樣輸出(無 alias)、撥音 'N'、促音 fallback 吐原子音字元
    def split_romaji(s):
        res = []
        for word in s.split():
            w = re.sub(r'[^\w]', '', word).lower()
            res.extend(romaji_parses(w, n_token='N')[0])
        return res

    all_syllables = []
    for item in result:
        r = item['hepburn']
        all_syllables.extend(split_romaji(r))
    
    romaji_text = " ".join(all_syllables)
    return hira, romaji_text

def main():
    audio_path = "01 (1).wav"
    model_dir = "FunAudioLLM/SenseVoiceSmall"
    
    print(f"Loading SenseVoice model: {model_dir}...", file=sys.stderr)
    model = AutoModel(
        model=model_dir,
        hub="hf",
        trust_remote_code=True,
        device="cuda:0",
    )

    print(f"Transcribing: {audio_path}...", file=sys.stderr)
    res = model.generate(
        input=audio_path,
        language="ja",
        use_itn=True,
        batch_size_s=60,
        merge_vad=True,
    )

    if not res:
        print("No transcription result.", file=sys.stderr)
        return

    item = res[0]
    raw_text = rich_transcription_postprocess(item["text"])
    print(f"Raw transcription: {raw_text}", file=sys.stderr)
    
    hiragana_text, romaji_text = convert_text(raw_text)
    print(f"Hiragana: {hiragana_text}")
    print(f"Romaji: {romaji_text}")

if __name__ == "__main__":
    main()
