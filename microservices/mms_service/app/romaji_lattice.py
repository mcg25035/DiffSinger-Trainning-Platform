# romaji_lattice.py — 泛用 DFS lattice 窮舉引擎 + 羅馬拼音音拍共用規則
# 共用者:mms_service/app/romanizer.py、lyrics_regonizer/transcribe_to_hiragana.py
# 注意:兩個服務是獨立 docker build context,此檔在兩邊各放一份,內容保持同步
# (frontend/src/lib/romaji-mora.js 是同規則的 JS 版,無法跨語言共用)

_ROMAJI_ONSETS = ["sh", "ch", "ts"] + list("bcdfghjklmnprstvwzy")
_ROMAJI_VOWELS = "aiueo"
_ROMAJI_LONG_MARKS = "-ー−―–—"


def enumerate_parses(s, transitions, cap=8):
    """泛用字串 lattice DFS 窮舉。

    transitions(pos, s, acc) -> [(tokens, next_pos), ...]
      tokens: 該分支推入的 token 序列(可為空 = 只前進不推)
      順序 = 保守解優先序,由 transitions 決定
    超過 cap 條 parse 後停止擴展(與舊實作相同:每層進入時檢查)。"""
    parses = []

    def dfs(i, acc):
        if len(parses) >= cap:
            return
        if i == len(s):
            parses.append(list(acc))
            return
        for tokens, j in transitions(i, s, acc):
            n = len(tokens)
            if n:
                acc.extend(tokens)
                dfs(j, acc)
                del acc[-n:]
            else:
                dfs(j, acc)

    dfs(0, [])
    return parses


def romaji_transitions(w, *, syllable_fn=None, n_token="N", geminate_fn=None,
                       long_marks=False, prev_vowel_fn=None):
    """羅馬拼音音拍規則 → transitions 函數。細項條件(輸出長相)全用傳參:

    syllable_fn:   音節字串 → 輸出 token;回傳 None/空 = 丟棄該分支。預設原樣輸出
    n_token:       撥音 token('N' / 'ん' / 'n')
    geminate_fn:   促音 fallback(c)→ token(子音後面沒有母音/y 可接時)。預設吐原字元
    long_marks:    長音符(- / ー)分支:重複前一 mora 的母音、或當分隔符跳過
    prev_vowel_fn: 長音用;acc[-1](前一 token)→ 長音母音 token(無則 None)"""
    if syllable_fn is None:
        syllable_fn = lambda syl: syl
    if geminate_fn is None:
        geminate_fn = lambda c: c

    def transitions(i, s, acc):
        out = []
        matched = False
        c = s[i]
        if long_marks and c in _ROMAJI_LONG_MARKS:
            if acc and prev_vowel_fn:
                v = prev_vowel_fn(acc[-1])
                if v:
                    out.append(([v], i + 1))
            out.append(([], i + 1))
            return out
        # onset + (y?)V(含 n+母音 = 保守結合,先試)
        for on in _ROMAJI_ONSETS:
            if not w.startswith(on, i):
                continue
            j = i + len(on)
            if j >= len(w):
                break
            if w[j] == "y" and j + 1 < len(w) and w[j + 1] in _ROMAJI_VOWELS:
                tok = syllable_fn(on + "y" + w[j + 1])
                if tok:
                    matched = True
                    out.append(([tok], j + 2))
            if w[j] in _ROMAJI_VOWELS:
                tok = syllable_fn(on + w[j])
                if tok:
                    matched = True
                    out.append(([tok], j + 1))
        # 純母音
        if c in _ROMAJI_VOWELS:
            tok = syllable_fn(c)
            if tok:
                matched = True
                out.append(([tok], i + 1))
        # 撥音(n+母音 時與 onset 分支形成歧義,兩條都走)
        if c == "n":
            out.append(([n_token], i + 1))
        # 促音 fallback
        if not matched and c not in _ROMAJI_VOWELS and c != "n":
            out.append(([geminate_fn(c)], i + 1))
        return out

    return transitions


def romaji_parses(w, cap=8, **kw):
    """羅馬拼音字串 → 所有可能的音拍 parse(保守解在前;唯一 parse = 無歧義)。"""
    return enumerate_parses(w, romaji_transitions(w, **kw), cap=cap)
