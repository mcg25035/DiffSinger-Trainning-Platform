import sys
import re
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess
import pykakasi

def convert_text(text):
    kks = pykakasi.kakasi()
    result = kks.convert(text)
    
    # 1. Process Hiragana
    hira = "".join([item['hira'] for item in result])
    hira = re.sub(r'[^\u3040-\u309F]', '', hira)
    
    # 2. Process Romaji into syllables
    # 羅馬拼音音拍 lattice(Trie/FSM 分支窮舉,保守解在前;與 mms romanizer 同規則)
    # 轉移規則:onset+(y?)V 先試(含 n+母音=保守結合);n → 'N'(撥音,與 n+母音歧義);
    # 子音無母音可接 → 促音(tte → t+te;保留原慣例:吐單一子音字元)
    def split_romaji(s):
        ONSETS = ["sh", "ch", "ts"] + list("bcdfghjklmnprstvwzy")
        VOWELS = "aiueo"
        res = []
        for word in s.split():
            w = re.sub(r'[^\w]', '', word).lower()
            parses = []
            def dfs(i, acc):
                if len(parses) >= 8:
                    return
                if i == len(w):
                    parses.append(list(acc))
                    return
                c = w[i]
                matched = False
                for on in ONSETS:
                    if not w.startswith(on, i):
                        continue
                    j = i + len(on)
                    if j >= len(w):
                        break
                    if w[j] == 'y' and j + 1 < len(w) and w[j+1] in VOWELS:
                        matched = True
                        acc.append(on + 'y' + w[j+1]); dfs(j + 2, acc); acc.pop()
                    if w[j] in VOWELS:
                        matched = True
                        acc.append(on + w[j]); dfs(j + 1, acc); acc.pop()
                if c in VOWELS:
                    matched = True
                    acc.append(c); dfs(i + 1, acc); acc.pop()
                if c == 'n':
                    acc.append('N'); dfs(i + 1, acc); acc.pop()
                if not matched and c not in VOWELS and c != 'n':
                    acc.append(c); dfs(i + 1, acc); acc.pop()
            dfs(0, [])
            res.extend(parses[0] if parses else [])
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
