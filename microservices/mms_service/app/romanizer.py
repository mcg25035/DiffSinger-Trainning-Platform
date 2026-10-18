"""
romanizer.py — 漢字×羅馬拼音 DP 消歧引擎

設計: docs/training-inference-design.md §1(歌詞先行流程)
目的: 產生 mora-exact romaji 給 MMS 用(shi N ai vs shi na i 是不同音素序列)

原理:
  - 日文原文提供「候選讀音 lattice」:
      * Sudachi 三種 split mode 的 token 讀音(強候選,成本低)
      * KANJIDIC2 每個漢字的音讀/訓讀(弱候選,成本高)
      * 既有假名原樣通過(成本 0)
  - 使用者輸入的 romaji 轉成假名 mora 序列
  - DP 在「字元位置 × romaji mora 位置」上對齊,找最小編輯距離路徑
  - 漢字多義讀法由 romaji 選出唯一解(例: 明日 + "ashita" → あした)

輸出: mora-exact romaji(空白分隔,ん→N,っ→雙子音前綴),MMS 可直接吃。
"""
import gzip
import os
import re
import unicodedata
import xml.etree.ElementTree as ET

from romaji_lattice import romaji_parses

# ──────────────────────────── kana ↔ romaji ────────────────────────────

# 基本假名(清音/濁音/半濁音/拗音),hepburn
_BASE = [
    ("あ", "a"), ("い", "i"), ("う", "u"), ("え", "e"), ("お", "o"),
    ("か", "ka"), ("き", "ki"), ("く", "ku"), ("け", "ke"), ("こ", "ko"),
    ("さ", "sa"), ("し", "shi"), ("す", "su"), ("せ", "se"), ("そ", "so"),
    ("た", "ta"), ("ち", "chi"), ("つ", "tsu"), ("て", "te"), ("と", "to"),
    ("な", "na"), ("に", "ni"), ("ぬ", "nu"), ("ね", "ne"), ("の", "no"),
    ("は", "ha"), ("ひ", "hi"), ("ふ", "fu"), ("へ", "he"), ("ほ", "ho"),
    ("ま", "ma"), ("み", "mi"), ("む", "mu"), ("め", "me"), ("も", "mo"),
    ("や", "ya"), ("ゆ", "yu"), ("よ", "yo"),
    ("ら", "ra"), ("り", "ri"), ("る", "ru"), ("れ", "re"), ("ろ", "ro"),
    ("わ", "wa"), ("を", "wo"), ("ん", "N"),
    ("が", "ga"), ("ぎ", "gi"), ("ぐ", "gu"), ("げ", "ge"), ("ご", "go"),
    ("ざ", "za"), ("じ", "ji"), ("ず", "zu"), ("ぜ", "ze"), ("ぞ", "zo"),
    ("だ", "da"), ("ぢ", "ji"), ("づ", "zu"), ("で", "de"), ("ど", "do"),
    ("ば", "ba"), ("び", "bi"), ("ぶ", "bu"), ("べ", "be"), ("ぼ", "bo"),
    ("ぱ", "pa"), ("ぴ", "pi"), ("ぷ", "pu"), ("ぺ", "pe"), ("ぽ", "po"),
    ("きゃ", "kya"), ("きゅ", "kyu"), ("きょ", "kyo"),
    ("しゃ", "sha"), ("しゅ", "shu"), ("しょ", "sho"),
    ("ちゃ", "cha"), ("ちゅ", "chu"), ("ちょ", "cho"),
    ("にゃ", "nya"), ("にゅ", "nyu"), ("にょ", "nyo"),
    ("ひゃ", "hya"), ("ひゅ", "hyu"), ("ひょ", "hyo"),
    ("みゃ", "mya"), ("みゅ", "myu"), ("みょ", "myo"),
    ("りゃ", "rya"), ("りゅ", "ryu"), ("りょ", "ryo"),
    ("ぎゃ", "gya"), ("ぎゅ", "gyu"), ("ぎょ", "gyo"),
    ("じゃ", "ja"), ("じゅ", "ju"), ("じょ", "jo"),
    ("びゃ", "bya"), ("びゅ", "byu"), ("びょ", "byo"),
    ("ぴゃ", "pya"), ("ぴゅ", "pyu"), ("ぴょ", "pyo"),
    ("ふぁ", "fa"), ("ふぃ", "fi"), ("ふぇ", "fe"), ("ふぉ", "fo"),
    ("うぃ", "wi"), ("うぇ", "we"), ("うぉ", "wo"),
    ("ゔぁ", "va"), ("ゔぃ", "vi"), ("ゔ", "vu"), ("ゔぇ", "ve"), ("ゔぉ", "vo"),
    ("てぃ", "ti"), ("でぃ", "di"), ("とぅ", "tu"), ("どぅ", "du"),
    ("しぇ", "she"), ("じぇ", "je"), ("ちぇ", "che"),
    ("つぁ", "tsa"), ("つぃ", "tsi"), ("つぇ", "tse"), ("つぉ", "tso"),
]

KANA_TO_ROMAJI = dict(_BASE)
ROMAJI_TO_KANA = {}
for k, r in _BASE:
    ROMAJI_TO_KANA.setdefault(r, k)  # 常見拼法優先(shi > si)

def norm_kana(c):
    """比對用正規化:ぢ/づ 歸併為 じ/ず(現代仮名遣い vs 歷史的や音樂寫法對 DP 無意義)"""
    return {"ぢ": "じ", "づ": "ず"}.get(c, c)

def _hira(ch):
    """片假名 → 平假名"""
    o = ord(ch)
    if 0x30A1 <= o <= 0x30F6:
        return chr(o - 0x60)
    return ch

def kata_to_hira(s):
    return "".join(_hira(c) for c in s)

SMALL_TO_BIG = {"ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お", "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "ゎ": "わ"}

# 長音的獨立母音 kana(ー 佔自己的 mora;日語長音 = 2 拍)
_LONG_VOWEL_KANA = {"a": "あ", "i": "い", "u": "う", "e": "え", "o": "お"}

def kana_to_morae(kana: str):
    """假名字串 → [假名 mora](處理拗音兩字一 mora;っ 獨立成節拍音符)
    ー = 長音符號:重複前一個 mora 的母音成獨立 mora(のー → の+お、きゅー → きゅ+う、
    しー → し+い)。字串開頭/っ/ん 後面的 ー 無母音可重複,略過。"""
    kana = kata_to_hira(kana)
    out, i = [], 0
    while i < len(kana):
        c = kana[i]
        if c == "ー":
            if out and out[-1] != "っ":
                v = _LONG_VOWEL_KANA.get(KANA_TO_ROMAJI.get(out[-1], "")[-1:])
                if v:
                    out.append(v)
            i += 1; continue
        if c == "っ":
            out.append("っ"); i += 1; continue
        if i + 1 < len(kana) and (kana[i] + kana[i + 1]) in KANA_TO_ROMAJI and kana[i + 1] in SMALL_TO_BIG:
            out.append(kana[i] + kana[i + 1]); i += 2; continue
        # 獨立出現的小書字(如「ネェ」的 ぇ):還原成對應母音
        if c in SMALL_TO_BIG:
            c = SMALL_TO_BIG[c]
        out.append(c)
        i += 1
    return [m for m in out if m.strip()]

def morae_to_romaji(morae):
    """假名 mora list → mora-exact romaji。
    っ 用 'cl'(與 japanese_mfa mapping 的音素 token 慣例一致),
    ん 用 'N'。"""
    out = []
    for m in morae:
        if m == "っ":
            out.append("cl")
            continue
        out.append(KANA_TO_ROMAJI.get(m, m))
    return out

# 常見拼法別名 → 正規形(hepburn)。讓使用者打 sya / sha 都得到一樣結果。
ROMAJI_ALIASES = {
    "sya": "sha", "syu": "shu", "syo": "sho",
    "zya": "ja", "zyu": "ju", "zyo": "jo",
    "jya": "ja", "jyu": "ju", "jyo": "jo",
    "tya": "cha", "tyu": "chu", "tyo": "cho",
    "cya": "cha", "cyu": "chu", "cyo": "cho",
    "si": "shi", "ti": "chi", "tu": "tsu", "hu": "fu",
    "di": "ji", "du": "zu", "dyu": "ju",
}

# 連濁變體(句中訓讀可能濁化,如 つ→づ)
DAKUTEN = str.maketrans("かきくけこさしすせそたちつてとはひふへほ",
                        "がぎぐげござじずぜぞだぢづでどばびぶべぼ")

def with_rendaku(reading: str):
    """產生一個濁化變體:只把首個可濁字濁化"""
    for i, ch in enumerate(reading):
        daku = ch.translate(DAKUTEN)
        if daku != ch:
            return reading[:i] + daku + reading[i + 1:]
    return None


# ── 羅馬拼音音拍 lattice ─────────────────────────────────────────────
# DFS 窮舉引擎與轉移規則(onset+(y?)V → 純母音 → ん → 促音/長音兩解)在
# romaji_lattice.py;這裡只提供本服務的細項條件(音節→假名表)

def _syllable_to_kana(syll: str):
    canon = ROMAJI_ALIASES.get(syll, syll)
    return ROMAJI_TO_KANA.get(canon)

def _long_vowel_kana_for(prev_kana):
    """前一個 kana mora → 其長音母音 kana(は→あ);查不到回 None。"""
    r = morae_to_romaji([prev_kana])
    return _LONG_VOWEL_KANA.get(r[0][-1:]) if r else None

def enumerate_romaji_parses(text: str, max_parses: int = 16):
    """羅馬拼音 → 所有可能的假名 mora 序列(Trie 分支窮舉,保守解在前)。
    現成庫(pykakasi 等)只給單一貪婪解;這裡每個歧義點都分支出多條路徑,
    全部交給 DP 由漢字/歌詞選邊。"""
    word_parse_lists = []
    for word in re.split(r"\s+", text.strip().lower()):
        w = re.sub(r"[^\w\-ー−―–—]", "", word)
        if not w:
            continue
        # 細項條件:音節 → 假名(查不到丟分支)、撥音 'ん'、促音 'っ'、長音符兩解
        parses = romaji_parses(
            w,
            syllable_fn=_syllable_to_kana,
            n_token="ん",
            geminate_fn=lambda c: "っ",
            long_marks=True,
            prev_vowel_fn=_long_vowel_kana_for,
        )
        word_parse_lists.append(parses or [[]])

    # 各詞的 parse 做笛卡兒組合(第一個 = 全保守解),cap max_parses
    import itertools
    out = []
    for combo in itertools.product(*word_parse_lists):
        out.append([m for p in combo for m in p])
        if len(out) >= max_parses:
            break
    return out

def romaji_to_morae(text: str, n_split: bool = False):
    """使用者 romaji → 保守 parse(n+母音盡量結合)。
    n_split 參數保留相容(已無作用);歧義由 enumerate_romaji_parses 窮舉 + DP 選邊。"""
    parses = enumerate_romaji_parses(text)
    return parses[0] if parses else []

# ──────────────────────────── KANJIDIC2 候選 ────────────────────────────

_KANJI_READINGS = None

def load_kanjidic(path=None):
    global _KANJI_READINGS
    if _KANJI_READINGS is not None:
        return _KANJI_READINGS
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "resources", "kanjidic2.xml.gz")
    readings = {}
    with gzip.open(path, "rb") as f:
        tree = ET.parse(f)
    for ch in tree.getroot().iter("character"):
        literal = ch.findtext("literal")
        if not literal:
            continue
        rs = set()
        for rm in ch.iter("rmgroup"):
            for r in rm.iter("reading"):
                if r.attrib.get("r_type") in ("ja_on", "ja_kun") and r.text:
                    # 去掉 okurigana 標記「.」與詞性標記「-」
                    v = r.text.split(".")[0].replace("-", "")
                    if v:
                        rs.add(kata_to_hira(v))
        if rs:
            readings[literal] = sorted(rs)
    _KANJI_READINGS = readings
    return readings

# ──────────────────────────── Sudachi 分詞(可選)────────────────────────────

_sudachi = None

_pykakasi = None

def pykakasi_edges(text):
    """pykakasi 有自己的分詞字典(熟語讀法常和 sudachi 不同,如 明日→あした),當補充候選"""
    global _pykakasi
    if _pykakasi is None:
        try:
            import pykakasi
            _pykakasi = pykakasi.kakasi()
        except Exception:
            _pykakasi = False
    if not _pykakasi:
        return []
    edges = []
    try:
        pos = 0
        for item in _pykakasi.convert(text):
            orig = item["orig"]
            hira = item["hira"]
            s = text.find(orig, pos)
            if s < 0 or not hira or orig == hira:
                if s >= 0:
                    pos = s + len(orig)
                continue
            pos = s + len(orig)
            edges.append((s, s + len(orig), kata_to_hira(hira), 0.1))
    except Exception:
        pass
    return edges


def sudachi_tokens(text):
    """三種 split mode 的 token (begin, end, reading),讀音轉平假名"""
    global _sudachi
    if _sudachi is None:
        try:
            from sudachipy import dictionary
            _sudachi = dictionary.Dictionary().create()
        except Exception:
            _sudachi = False
    if not _sudachi:
        return []
    from sudachipy import SplitMode
    edges = []
    seen_edges = set()
    for mode in (SplitMode.A, SplitMode.B, SplitMode.C):
        try:
            toks = _sudachi.tokenize(text, mode)
            pos = 0
            for t in toks:
                s = text.find(t.surface(), pos)
                if s < 0:
                    continue
                pos = s + len(t.surface())
                r = t.reading_form()
                if r:
                    key = (s, s + len(t.surface()), kata_to_hira(r))
                    if key in seen_edges:
                        continue
                    seen_edges.add(key)
                    edges.append((s, s + len(t.surface()), kata_to_hira(r), 0))
        except Exception:
            pass
    return edges

# ──────────────────────────── DP 對齊 ────────────────────────────

KANJI_RE = re.compile(r"[一-龯々]")

# 已知「表記冗餘」詞:表面寫法 → 實際讀音(歌詞常見的裝飾性漢字)
PHRASE_OVERRIDES = {
    "言こと": "こと",  # 「いい言こと」= いいこと
}

# 括號 ruby:漢字/片假名詞後面直接接（かな） → 兩種解讀交給 DP 競爭:
#   a) 括號內容 = 前面那個詞的讀音(ruby,如 易々（いい）→ いい)→ 這裡加一條覆蓋整個詞+括號的 edge
#   b) 括號內容 = 之後要唱的新音 → 本來就成立(括號被當標點跳過、內容照讀)
BRACKET_RUBY_RE = re.compile(r"([一-龯々ァ-ヶー]+)（([ぁ-んァ-ンー]+)）")
# 方括號注音(歌詞網站慣用 漢字[かな] 標讀音)
BRACKET_RUBY_SQ_RE = re.compile(r"([一-龯々ァ-ヶー]+)\[([ぁ-んァ-ンー]+)\]")

def build_edges(text):
    """建立 lattice edges:(charStart, charEnd, 假名讀音, 成本權重)"""
    # 半形括號統一成全形,讓 ruby 偵測與標點跳過都能處理
    text = text.replace("(", "（").replace(")", "）")
    kanjidic = load_kanjidic()
    edges = []
    n = len(text)
    # 助詞特殊讀法(歌詞中 は/へ/を 絕大多數當助詞)
    PARTICLE = {"は": "わ", "へ": "え", "を": "お"}
    for i, c in enumerate(text):
        if KANJI_RE.match(c):
            readings = kanjidic.get(c, [])
            if not readings:
                # 々 等辭典沒有的記號:略過但給高權重 —
                # 免費的話 DP 會走「前字偷吃 romaji 音」的便宜路(易→い),
                # 高權重讓 DP 寧願用整詞讀音(sudachi 的 やすやす)當 extra
                edges.append((i, i + 1, "", 5.0))
            for r in readings:
                cands = [(r, 0.3)]
                rd = with_rendaku(r)
                if rd:
                    cands.append((rd, 0.35))  # 連濁變體(例: つ→づ,如 気付けば)
                for reading, w0 in cands:
                    edges.append((i, i + 1, reading, w0))  # 單字候選,小額權重(只當 tie-breaker)
                    # KANJIDIC 的訓讀只有「語幹」(ある.く→ある),接續的送り仮名不在內
                    # 例如 歩いて=ある+い+て:補上「讀音+接續假名」候選(最多 2 個假名)
                    ext = ""
                    for j in range(i + 1, min(i + 3, len(text))):
                        cj = text[j]
                        if not ("ぁ" <= cj <= "ん"):
                            break
                        ext += cj
                        edges.append((i, i + 1, reading + ext, w0))
        elif c in PARTICLE:
            edges.append((i, i + 1, PARTICLE[c], 0))
            edges.append((i, i + 1, c, 0.1))  # 保留原讀,權重略高
        elif c == "ー":
            # 長音符號:略過但給小成本 — 免費的話逐字路徑(ー 跳過)會與整詞讀音
            # (はーと → は+あ+と)平手,邊順序在前的逐字路徑贏,長音就被吃掉
            edges.append((i, i + 1, "", 0.05))
        elif "ぁ" <= c <= "ん" or "ァ" <= c <= "ヶ" or c == "っ":
            edges.append((i, i + 1, kata_to_hira(c), 0))
        else:
            edges.append((i, i + 1, "", 0))  # 標點等不發音,直接略過
    edges.extend(sudachi_tokens(text))
    edges.extend(pykakasi_edges(text))

    # 表記冗餘詞(言こと → こと)
    for surface, reading in PHRASE_OVERRIDES.items():
        start = 0
        while True:
            s = text.find(surface, start)
            if s < 0:
                break
            edges.append((s, s + len(surface), reading, 0.05))
            start = s + 1

    # 括號 ruby(解讀 a:內容 = 前面詞的讀音;DP 會跟解讀 b 比成本)
    # kanji run 的每個「後綴」都加一條 edge:ruby 可能只讀最靠近括號的詞
    # (一度嘲笑(わら) = いちど + わら,不是「一度嘲笑」整個讀 わら),由 DP 選
    for m in BRACKET_RUBY_RE.finditer(text):
        word = m.group(1)
        close_end = m.end(2)
        ruby = kata_to_hira(m.group(2))
        for L in range(1, len(word) + 1):
            edges.append((m.start(1) + len(word) - L, close_end, ruby, 0.05))

    # 方括號注音(涙流[なみだなが]):同括號 ruby,兩種解讀交給 DP —
    #   a) 括號內容 = 前面詞的讀音(ruby)
    #   b) 括號內容 = 之後要唱的新音(本來就成立,括號當標點略過)
    for m in BRACKET_RUBY_SQ_RE.finditer(text):
        word = m.group(1)
        close_end = m.end(2)
        ruby = kata_to_hira(m.group(2))
        for L in range(1, len(word) + 1):
            edges.append((m.start(1) + len(word) - L, close_end, ruby, 0.05))

    return edges, n

def align_romanize(text: str, romaji: str, progress_cb=None):
    """核心 DP:romaji 的所有 parse(Trie 窮舉)都餵 DP,取分數最高者。
    progress_cb(frac):每個 parse 完成回報(0~1),真進度用。
    lattice 只依賴 kanji text、與 target 無關 → 每行只建一次
    (原本每個 parse 重跑一次 Sudachi×3+pykakasi,整批歌詞跑幾十分鐘的元兇)。"""
    targets = enumerate_romaji_parses(romaji, max_parses=16)
    # 相同 mora 序列只對一次(對齊只依賴 target 序列,重複結果必然相同)
    seen = set()
    unique = []
    for t in targets:
        key = tuple(t)
        if key not in seen:
            seen.add(key)
            unique.append(t)
    targets = unique

    edges, n = build_edges(text)
    edge_morae = [[norm_kana(m) for m in kana_to_morae(e[2])] for e in edges]
    edges_by_start = {}
    for ei, e in enumerate(edges):
        edges_by_start.setdefault(e[0], []).append(ei)

    best = None
    for i, target in enumerate(targets):
        r = _align_with_target(text, target, edges=edges, n=n,
                               edge_morae=edge_morae, edges_by_start=edges_by_start)
        if progress_cb:
            progress_cb((i + 1) / len(targets))
        if r and (best is None or r["score"] > best["score"]):
            best = r
        if best and best["score"] >= 0.999:
            break
    return best


def _align_with_target(text: str, target, edges=None, n=None,
                       edge_morae=None, edges_by_start=None):
    """核心對齊:lattice edges 展開成 mora 級 DAG,對 target romaji mora 序列做
    Dijkstra 編輯對齊(match 0 / mismatch 1 / skip 1,edge 權重另計)。
    edges/edge_morae/edges_by_start 可傳入預建:lattice 與 target 無關,
    同一行多個 parse 共用,省重複的 Sudachi/pykakasi 與索引建置。
    edge_morae 已預先 norm_kana(target 也先正規化),內迴圈純字串比較。"""
    import heapq

    if edges is None or n is None or edge_morae is None or edges_by_start is None:
        edges, n = build_edges(text)
        edge_morae = [[norm_kana(m) for m in kana_to_morae(e[2])] for e in edges]
        edges_by_start = {}
        for ei, e in enumerate(edges):
            edges_by_start.setdefault(e[0], []).append(ei)

    INF = float("inf")
    # state: ('B', charPos) 字界；('E', edgeIdx, moraIdx) edge 內部
    dist = {}   # state, rp -> total cost(含權重)
    align = {}  # state, rp -> 純編輯距離
    prev = {}

    target_norm = [norm_kana(t) for t in target]

    start = (('B', 0), 0)
    dist[start] = 0.0
    align[start] = 0
    pq = [(0.0, start)]

    T = len(target)
    best_end = None  # (total, state, rp)

    while pq:
        d, (node, rp) = heapq.heappop(pq)
        if d > dist.get((node, rp), INF):
            continue

        # 精確剪枝:所有弧成本 ≥ 0,任何 state 的完成總成本 ≥ d;
        # d 已 ≥ 目前最佳終點 → 不可能再改進(不改變結果,只砍探索尾巴)
        if best_end is not None and d >= best_end[0]:
            break

        if node[0] == 'B' and node[1] == n:
            # 收斂:允許 target 尾巴未用(每格 1)
            total_end = d + (T - rp)
            if best_end is None or total_end < best_end[0]:
                best_end = (total_end, node, rp)
            continue

        # 弧 1: skip target 一個 mora (insertion)
        if rp < T:
            ns = (node, rp + 1)
            nd = d + 1
            na = align[(node, rp)] + 1
            if nd < dist.get(ns, INF):
                dist[ns] = nd; align[ns] = na; prev[ns] = ((node, rp), None)
                heapq.heappush(pq, (nd, ns))

        # 弧 2: 從字界出發走 edge
        if node[0] == 'B':
            cp = node[1]
            for ei in edges_by_start.get(cp, ()):
                ce = edges[ei][1]
                w = edges[ei][3]
                mors = edge_morae[ei]
                if len(mors) == 0:  # 空白/無讀
                    ns = (('B', ce), rp)
                    nd = d + w
                    if nd < dist.get(ns, INF):
                        dist[ns] = nd; align[ns] = align[(node, rp)]; prev[ns] = ((node, rp), ei)
                        heapq.heappush(pq, (nd, ns))
                else:
                    emit = mors[0]
                    cost_sub = 0 if rp < T and emit == target_norm[rp] else 1
                    # 消耗一個 target mora
                    if rp < T:
                        ns = (('E', ei, 1) if len(mors) > 1 else ('B', ce), rp + 1)
                        nd = d + cost_sub + (0 if len(mors) > 1 else w)
                        na = align[(node, rp)] + cost_sub
                        if nd < dist.get(ns, INF):
                            dist[ns] = nd; align[ns] = na; prev[ns] = ((node, rp), ei if len(mors) <= 1 else ('enter', ei))
                            heapq.heappush(pq, (nd, ns))
                    # 不消耗 target(deletion:edge 多出的 mora)
                    ns = (('E', ei, 1) if len(mors) > 1 else ('B', ce), rp)
                    nd = d + 1 + (0 if len(mors) > 1 else w)
                    na = align[(node, rp)] + 1
                    if nd < dist.get(ns, INF):
                        dist[ns] = nd; align[ns] = na; prev[ns] = ((node, rp), ei if len(mors) <= 1 else ('enter', ei))
                        heapq.heappush(pq, (nd, ns))
        else:
            # edge 內部
            _, ei, k = node
            mors = edge_morae[ei]
            ce = edges[ei][1]
            w = edges[ei][3]
            emit = mors[k]
            last = (k + 1 == len(mors))
            nxt = ('B', ce) if last else ('E', ei, k + 1)
            wcost = w if last else 0
            if rp < T:
                cost_sub = 0 if emit == target_norm[rp] else 1
                ns = (nxt, rp + 1)
                nd = d + cost_sub + wcost
                na = align[(node, rp)] + cost_sub
                if nd < dist.get(ns, INF):
                    dist[ns] = nd; align[ns] = na; prev[ns] = ((node, rp), ei if last else None)
                    heapq.heappush(pq, (nd, ns))
            ns = (nxt, rp)
            nd = d + 1 + wcost
            na = align[(node, rp)] + 1
            if nd < dist.get(ns, INF):
                dist[ns] = nd; align[ns] = na; prev[ns] = ((node, rp), ei if last else None)
                heapq.heappush(pq, (nd, ns))

    if best_end is None:
        return None

    total_cost, end_node, end_rp = best_end
    # 回溯蒐集採用的 edge
    used_edges = []
    cur = (end_node, end_rp)
    seen = set()
    while cur in prev:
        pcur, tag = prev[cur]
        if isinstance(tag, int):
            used_edges.append(tag)
        if cur in seen:
            break
        seen.add(cur)
        cur = pcur
    used_edges = list(dict.fromkeys(reversed(used_edges)))

    # align cost 要加上尾巴
    align_cost = align.get((end_node, end_rp), 0) + (T - end_rp)

    chosen = [edges[ei] for ei in used_edges]
    kana = "".join(r for _, _, r, _ in chosen if r)
    kana_morae = kana_to_morae(kana)
    morae = kana_morae
    romaji_out = morae_to_romaji(morae)

    # 每個 mora 的來源字(漢字歸屬,前端標示「哪個漢字對不上」用)
    edge_spans = []
    pos = 0
    for (cs, ce, r, _w) in chosen:
        if r:
            edge_spans.append((pos, pos + len(r), text[cs:ce]))
            pos += len(r)
    mora_sources = []
    # 位置走訪要跟 kana_to_morae 同規則:ー 當不存在跳過、小書字還原,
    # 否則 mora 的 kana 位置會位移,歸屬全錯
    def kana_morae_with_positions(k):
        """kana → [(mora, start, end)](與 kana_to_morae 同規則,含 kana 位置)"""
        k = kata_to_hira(k)
        out, i = [], 0
        while i < len(k):
            c = k[i]
            if c == "ー":
                if out and out[-1][0] != "っ":
                    v = _LONG_VOWEL_KANA.get(KANA_TO_ROMAJI.get(out[-1][0], "")[-1:])
                    if v:
                        out.append((v, i, i + 1))
                i += 1; continue
            if c == "っ":
                out.append(("っ", i, i + 1)); i += 1; continue
            if i + 1 < len(k) and k[i + 1] in SMALL_TO_BIG and (c + k[i + 1]) in KANA_TO_ROMAJI:
                out.append((c + k[i + 1], i, i + 2)); i += 2; continue
            if c in SMALL_TO_BIG:
                c = SMALL_TO_BIG[c]
            out.append((c, i, i + 1)); i += 1
        return out

    for (m, ms, me_) in kana_morae_with_positions(kana):
        src = ""
        for (s0, e0, chars) in edge_spans:
            if s0 < me_ and ms < e0:
                src = chars
                break
        mora_sources.append(src)

    max_len = max(T, len(morae), 1)
    score = max(0.0, 1.0 - align_cost / max_len)
    return {
        "kana": kana,
        "mora_romaji": " ".join(romaji_out),
        "morae": romaji_out,
        "mora_sources": mora_sources,
        "score": round(score, 3),
        "cost": align_cost,
    }

def romanize_line(kanji: str, romaji: str, progress_cb=None):
    """單行消歧。kanji 可為空,此時直接把 romaji 轉 mora 格式。
    NFKC 正規化:康熙部首變體字(⼆⼈⼀)→ 正字、全形英數/括號/半角カナ → 標準形,
    讓 lattice 與 mora_sources 用同一份文字(位置歸屬不位移)。"""
    kanji = unicodedata.normalize("NFKC", kanji or "").strip()
    romaji = unicodedata.normalize("NFKC", romaji or "").strip()
    if not romaji:
        return {"error": "Empty romaji"}
    if not kanji:
        morae = romaji_to_morae(romaji)
        out = morae_to_romaji(morae)
        return {"kana": None, "mora_romaji": " ".join(out), "morae": out,
                "score": None, "note": "no kanji provided; romaji split by rules only"}
    result = align_romanize(kanji, romaji, progress_cb=progress_cb)
    if not result:
        morae = romaji_to_morae(romaji)
        out = morae_to_romaji(morae)
        return {"kana": None, "mora_romaji": " ".join(out), "morae": out,
                "score": 0.0, "warning": "DP 找不到吻合路徑,已退回規則切分"}
    return result
