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
