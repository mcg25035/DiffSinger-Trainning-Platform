// Song Session Service v2 — 「歌詞先行 + 全域 mora 游標」錄音流程
// 設計文件: docs/training-inference-design.md §1
//
// 核心概念:整首歌是一條連續 mora 序列,游標指向下一個還沒唱的 mora。
// 每次錄音(take)可以橫跨句界、停在任意 mora;系統:
//   1. SenseVoice /transcribe → 粗 mora 序列
//   2. DP 掃描全域序列,定位這次唱了哪一段 [start, end]
//   3. 該段 mora 當歌詞送 MMS 對齊 → .lab 音素時間
//   4. 從 .lab 推每個 mora 的結束時間(切點)
//   5. 使用者確認(可微調起訖)→ 依句界切成訓練 segment(wav/txt/lab)
//
// 狀態機(take):
//   asr → aligning → confirm → confirmed
//                  ↘ error ↗(隨時可 reset)

const { splitRomajiToMorae } = require('./romaji-mora');
const { readWav, writeWav, clipSeconds } = require('./wav-clip');

// .lab 中可能出現的靜音音素,與 mora 對應時要剔除
const SILENCE_PHONES = new Set(['sil', 'sp', 'pau', 'spn', 'br', '']);

function createSongSessionService({
    fs,
    path,
    rootDir,
    segmentsDir,
    mappingsDir,
    lyricsService,
    submitAlignment,
    jobs,
    mapRomajiToPhonemes,
    aligner = 'mms',
    matchWarnThreshold = 0.7, // DP 定位品質低於此值時在 UI 顯示警示
}) {
    const sessionsDir = path.join(rootDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

    // 預載 mora → 音素 mapping(japanese_mfa)
    let phonemeMapping = null;
    try {
        const mp = path.join(mappingsDir, 'japanese_mfa.json');
        if (fs.existsSync(mp)) phonemeMapping = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    } catch (e) {
        console.warn('[SESSION] 無法載入 japanese_mfa mapping,mora 邊界將用比例估算:', e.message);
    }

    const sessions = {};

    // ────────────────────────── 基本 CRUD ──────────────────────────

    function sessionPath(id) { return path.join(sessionsDir, `${id}.json`); }

    function save(id) {
        fs.writeFileSync(sessionPath(id), JSON.stringify(sessions[id], null, 2));
    }

    function load(id) {
        if (sessions[id]) return sessions[id];
        const p = sessionPath(id);
        if (!fs.existsSync(p)) return null;
        sessions[id] = JSON.parse(fs.readFileSync(p, 'utf-8'));
        // 舊格式(v1, lines[].status)不相容;若沒有 morae 視為無效
        if (!sessions[id].morae) return null;
        return sessions[id];
    }

    function lineProgress(session) {
        const perLine = session.lines.map(() => ({ total: 0, covered: 0 }));
        session.morae.forEach((m, i) => {
            perLine[m.line].total++;
            if (session.covered[i]) perLine[m.line].covered++;
        });
        return perLine;
    }

    function cursorOf(session) {
        const idx = session.covered.findIndex(c => !c);
        return idx === -1 ? session.morae.length : idx;
    }

    function listSessions() {
        return fs.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const s = load(f.replace(/\.json$/, ''));
                    if (!s) return null;
                    const covered = s.covered.filter(Boolean).length;
                    const pending = s.takes.filter(t => t.status === 'confirm').length;
                    return {
                        id: s.id, name: s.name, createdAt: s.createdAt,
                        totalMorae: s.morae.length, coveredMorae: covered,
                        totalLines: s.lines.length,
                        doneLines: lineProgress(s).filter(l => l.covered === l.total && l.total > 0).length,
                        pendingTakes: pending,
                    };
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    function createSession(name, rawLyrics, opts = {}) {
        const lines = String(rawLyrics).split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return { error: '歌詞為空' };

        const nonAscii = lines.find(l => /[^\x00-\x7F]/.test(l));
        if (nonAscii) {
            return { error: `歌詞必須是羅馬拼音,偵測到非羅馬字元:「${nonAscii.slice(0, 20)}…」` };
        }

        const id = `song-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const morae = [];
        const lineObjs = lines.map((lyric, index) => {
            const m = splitRomajiToMorae(lyric);
            if (m.length === 0) return null;
            m.forEach(text => morae.push({ line: index, text }));
            return { index, lyric, moraeCount: m.length };
        });
        if (lineObjs.some(l => !l)) return { error: '存在無法切成音節的行' };

        sessions[id] = {
            id,
            name: name || `未命名歌曲 ${new Date().toLocaleString()}`,
            createdAt: Date.now(),
            lines: lineObjs,
            morae,
            covered: morae.map(() => false),
            takes: [],
            dictionaryId: opts.dictionaryId || null,
            aligner: opts.aligner || 'mms',
        };
        save(id);
        return sessions[id];
    }

    // ─────────────────────── DP 定位(跨句掃描)───────────────────────

    /**
     * 把 ASR 粗 mora 序列對到全域 mora 序列的一段最佳區間。
     * 搜尋範圍從 cursor 前 2 個 mora 開始(容忍使用者重唱一點),到 cursor + 粗長度 + 8。
     * 回傳 { start, end (含, global index), distance, quality(0~1) }
     */
    function locateWindow(session, roughMorae) {
        const G = session.morae.map(m => m.text);
        const cursor = cursorOf(session);
        const base = Math.max(0, cursor - 2);
        const limit = Math.min(G.length, cursor + roughMorae.length + 8);
        const W = G.slice(base, limit);
        const M = roughMorae.length;

        if (M === 0 || W.length === 0) return null;

        // dp[i][j]: rough 前 i 個 對齊到 W 前 j 個 的最短距離;j 起點免費跳過
        const N = W.length;
        const dp = Array.from({ length: M + 1 }, (_, i) => {
            const row = new Array(N + 1).fill(0);
            row[0] = i;
            return row;
        });
        for (let i = 1; i <= M; i++) {
            for (let j = 1; j <= N; j++) {
                const cost = roughMorae[i - 1] === W[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost
                );
            }
        }
        let bestJ = N;
        for (let j = N; j >= 1; j--) if (dp[M][j] < dp[M][bestJ]) bestJ = j;

        // 回溯找對齊起點(第一次用到 i=0 的 j)
        let i = M, j = bestJ, startJ = 0;
        while (i > 0) {
            const cost = roughMorae[i - 1] === W[j - 1] ? 0 : 1;
            if (j > 0 && dp[i][j] === dp[i - 1][j - 1] + cost) { i--; j--; startJ = j; }
            else if (dp[i][j] === dp[i - 1][j] + 1) { i--; }
            else { j--; }
        }

        const distance = dp[M][bestJ];
        return {
            start: base + startJ,
            end: base + bestJ - 1, // 含
            distance,
            quality: 1 - distance / Math.max(M, 1),
        };
    }

    // ─────────────────────── mora 邊界時間 ───────────────────────

    /** 從 .lab + romaji mapping 計算每個 mora 的結束時間(秒,take 內時間軸)
     *  MMS 的 lab 單位是 100ns tick(舊 MFA 是秒),用 wav 長度自動判斷。 */
    function computeMoraEnds(moraList, labPath, wavDurationSec) {
        let phones = fs.readFileSync(labPath, 'utf-8')
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(l => {
                const p = l.split(/\s+/);
                return { start: parseFloat(p[0]), end: parseFloat(p[1]), phone: p[2] || '' };
            })
            .filter(p => !isNaN(p.start) && !isNaN(p.end));

        // 單位偵測:最大時間超過音檔長度 10 倍 → tick(1e7 tick = 1s)
        const maxEnd = phones.length > 0 ? Math.max(...phones.map(p => p.end)) : 0;
        if (wavDurationSec > 0 && maxEnd > wavDurationSec * 10) {
            phones = phones.map(p => ({ ...p, start: p.start / 1e7, end: p.end / 1e7 }));
        }

        const contentPhones = phones.filter(p => !SILENCE_PHONES.has(p.phone.toLowerCase()));

        // 每個 mora 預期幾個音素
        const perMora = moraList.map(m => {
            if (!phonemeMapping) return 1;
            const str = mapRomajiToPhonemes(m, phonemeMapping);
            return Math.max(1, str.split(/\s+/).filter(Boolean).length);
        });

        const moraEnds = {};
        const totalExpected = perMora.reduce((a, b) => a + b, 0);

        if (contentPhones.length === totalExpected) {
            // 精確對上:依音素累積
            let pi = 0;
            for (let g = 0; g < perMora.length; g++) {
                pi += perMora[g];
                moraEnds[g] = contentPhones[pi - 1].end;
            }
        } else {
            // 對不上(MMS 多吐/少吐音素):按比例分配,標記 approximated
            console.warn(`[SESSION] 音素數不符(預期 ${totalExpected},實際 ${contentPhones.length}),mora 邊界改為比例估算`);
            const totalDur = contentPhones.length > 0
                ? contentPhones[contentPhones.length - 1].end
                : (phones.length > 0 ? phones[phones.length - 1].end : 0);
            let cum = 0;
            moraList.forEach((_, gi) => {
                cum += perMora[gi];
                moraEnds[gi] = totalDur * (cum / totalExpected);
            });
        }
        return moraEnds;
    }

    // ─────────────────────── 起點候選偵測(母音 DP) ───────────────────────

    /** mora → 母音(cl/N 沒有母音,pitch 名不準的話也回 null) */
    function vowelOf(moraText) {
        if (!moraText) return null;
        const last = moraText[moraText.length - 1];
        return 'aiueo'.includes(last) ? last : null;
    }

    /** mora → 子音頭(沒有回 null;輔助分用,筆電麥不穩所以權重低) */
    function consOf(moraText) {
        if (!moraText || !vowelOf(moraText)) return null;
        return moraText.slice(0, -1) || null;
    }

    /**
     * 把 ASR 粗辨識的母音序列 V 滑過剩餘歌詞的母音序列 R(從 cursor 起),
     * 對每個起點 s 做 DP 對齊(母音相同 +2 / 不同 -3 / 缺音 -2),
     * 回傳 top-N 個 {start, end, score(0~1)}。
     * 只用母音打分:筆電麥子音常聽錯,母音穩得多。
     */
    function estimateStartCandidates(session, detectedMorae, cursor, maxCandidates = 5) {
        const R = session.morae;
        // 保留「(母音, 子音)」對:主分看母音,子音當弱輔助分(對了 +0.5,錯了 -0.2)
        const Rp = R.map(m => ({ v: vowelOf(m.text), c: consOf(m.text) }));
        const V = detectedMorae.map(m => ({ v: vowelOf(m), c: consOf(m) })).filter(p => p.v);
        if (V.length === 0) return [];

        const candidates = [];
        for (let s = cursor; s < R.length; s++) {
            const maxWin = Math.min(R.length - s, V.length + 8);
            if (maxWin < Math.min(3, V.length)) break;
            const n = V.length;
            // S[i][j]: V[i-1] 對齊到 R[s+j-1]
            const S = Array.from({ length: n + 1 }, () => new Float64Array(maxWin + 1).fill(-1e9));
            S[0][0] = 0;
            for (let i = 1; i <= n; i++) S[i][0] = -2 * i;
            for (let i = 1; i <= n; i++) {
                for (let j = 1; j <= maxWin; j++) {
                    const rv = Rp[s + j - 1];
                    let match = -3;
                    if (rv.v && rv.v === V[i - 1].v) {
                        match = 2 + (rv.c && rv.c === V[i - 1].c ? 0.5 : -0.2);
                    }
                    match += S[i - 1][j - 1];
                    const del = S[i - 1][j] - 2;   // V 有但歌詞沒對上
                    const ins = S[i][j - 1] - 1;   // 歌詞多一個 mora(輕罰)
                    S[i][j] = Math.max(match, del, ins);
                }
            }
            let bestJ = 0;
            for (let j = 1; j <= maxWin; j++) if (S[n][j] > S[n][bestJ]) bestJ = j;
            if (bestJ === 0) continue;
            const pct = Math.max(0, Math.min(1, S[n][bestJ] / (2 * n)));
            candidates.push({ start: s, end: s + bestJ - 1, score: pct });
        }

        // 排序:分數接近時,優先起點貼近 cursor 的(使用者十之八九從進度接著唱)
        candidates.forEach(c => {
            c.prior = c.score + (Math.abs(c.start - cursor) <= 1 ? 0.05 : 0);
        });
        candidates.sort((a, b) => b.prior - a.prior);
        const picked = [];
        for (const c of candidates) {
            if (picked.some(p => Math.abs(p.start - c.start) < 2)) continue;
            picked.push(c);
            if (picked.length >= maxCandidates) break;
        }
        return picked;
    }

    // ─────────────────────── take 背景管線 ───────────────────────

    async function runTakePipeline(sessionId, takeId) {
        const session = load(sessionId);
        if (!session) return;
        const take = session.takes.find(t => t.id === takeId);
        if (!take) return;

        const wavPath = path.join(segmentsDir, take.filename);

        try {
            // 1. ASR + 歌詞比對(用現有 SenseVoice /transcribe_with_lyrics 管線:
            //    ASR 粗辨識會對「剩餘未唱」的歌詞全文做 DP,直接回傳最吻合的歌詞窗)
            take.status = 'asr';
            save(sessionId);
            const cursor = cursorOf(session);
            const remainingLyrics = session.morae.slice(cursor).map(m => m.text).join(' ');
            const data = await lyricsService.transcribeWithLyrics(wavPath, remainingLyrics);
            if (!data || !data.matched_romaji) throw new Error('SenseVoice 無回應或比對失敗');
            take.rough = data.rough_romaji || data.matched_romaji;

            // 2. 起點偵測:用 ASR 粗辨識的母音對剩餘歌詞做 DP,
            //    產生多個候選起點(含 %)。不再寫死從 cursor 開始。
            const detectedMorae = splitRomajiToMorae(data.rough_romaji || data.matched_romaji);
            const matchScore = typeof data.match_score === 'number' ? data.match_score : 0;
            if (matchScore < 0.3 || detectedMorae.length === 0) {
                throw new Error(`比對分數過低 (${(matchScore * 100).toFixed(0)}%),請重錄;或檢查麥克風`);
            }
            const candidates = estimateStartCandidates(session, detectedMorae, cursor);
            if (candidates.length > 0) {
                take.candidates = candidates;
                take.start = candidates[0].start;
                take.end = candidates[0].end;
            } else {
                // ASR 母音全聽不到(cl/N):退回 cursor + SenseVoice 窗長
                const matchedMorae = splitRomajiToMorae(data.matched_romaji);
                take.candidates = [];
                take.start = cursor;
                take.end = Math.min(cursor + matchedMorae.length - 1, session.morae.length - 1);
            }
            take.score = matchScore;

            // 3. 待使用者確認。MMS 對齊移到「使用者按下確認後」才跑
            //    (人一定會修範圍,先跑只會浪費);confirm 裡會 alignTakeRange。
            take.status = 'confirm';
            save(sessionId);
        } catch (err) {
            take.status = 'error';
            take.error = err.message;
            save(sessionId);
        }
    }

    /**
     * 對 take 的 [start,end] 區間跑 MMS 對齊,輪詢到完成,
     * 寫回 take.start/end/moraEnds。confirm 時使用者改動範圍也會經這裡重跑。
     * opts.dictionaryId / opts.aligner 未帶時用 session 存的(建立 session 時寫入)。
     */
    async function alignTakeRange(sessionId, takeId, start, end, opts = {}, onDone) {
        const session = load(sessionId);
        if (!session) throw new Error('Session not found');
        const take = session.takes.find(t => t.id === takeId);
        if (!take) throw new Error('Take not found');

        const dictionaryId = opts.dictionaryId || session.dictionaryId || null;
        const useAligner = opts.aligner || session.aligner || aligner;
        // dictionaryId/aligner 存回 session(舊 session 沒存的自動補上;之後重跑都用同一份)
        if (session.dictionaryId !== dictionaryId || session.aligner !== useAligner) {
            session.dictionaryId = dictionaryId;
            session.aligner = useAligner;
            save(sessionId);
        }

        const wavPath = path.join(segmentsDir, take.filename);
        const windowMorae = session.morae.slice(start, end + 1).map(m => m.text);
        fs.writeFileSync(wavPath.replace(/\.wav$/, '.txt'), windowMorae.join(' '));

        const { jobId, error } = submitAlignment({ filename: take.filename, dictionaryId, aligner: useAligner });
        if (error) throw new Error(error);

        // 等 job 完成(最多 5 分鐘)
        await new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const poll = setInterval(() => {
                const job = jobs[jobId];
                if (!job) return;
                if (job.status === 'completed') { clearInterval(poll); resolve(); }
                else if (job.status === 'error') { clearInterval(poll); reject(new Error(job.error || 'MMS 對齊失敗')); }
                else if (Date.now() - startedAt > 300000) { clearInterval(poll); reject(new Error('MMS 對齊逾時')); }
            }, 2000);
        });

        // 對齊完成 → 算 mora 邊界,寫回 take
        const current = load(sessionId);
        const t = current && current.takes.find(x => x.id === takeId);
        if (!t) throw new Error('Take 已被移除');

        const labPath = wavPath.replace(/\.wav$/, '.lab');
        let wavDur = 0;
        try {
            const w = readWav(wavPath);
            wavDur = w.data.length / (w.sampleRate * w.channels * 2);
        } catch {}
        const moraEnds = computeMoraEnds(windowMorae, labPath, wavDur);

        t.start = start;
        t.end = end;
        t.moraEnds = moraEnds;
        t.realigned = true;
        save(sessionId);
        if (onDone) onDone(t);
        return moraEnds;
    }

    // ─────────────────────── 確認與切割 ───────────────────────

    /**
     * 確認一個 take:依句界把 [start,end] 切成每句一個 segment。
     * opts.dictionaryId / opts.aligner 會存回 session(舊 session 沒存的自動補上)。
     * 若 take 已用同範圍對齊過(對齊處理分頁選取時已跑 MMS),不重跑,直接切。
     * 回傳建立的 segment 檔名列表。
     */
    async function confirmTake(sessionId, takeId, start, end, opts = {}) {
        const session = load(sessionId);
        if (!session) return { error: 'Session not found' };
        const take = session.takes.find(t => t.id === takeId);
        if (!take) return { error: 'Take not found' };
        if (take.status !== 'ready' && take.status !== 'aligning') return { error: `Take 狀態不可確認:${take.status}` };

        start = Math.max(0, Math.min(start, session.morae.length - 1));
        end = Math.max(start, Math.min(end, session.morae.length - 1));

        // dictionaryId/aligner 存回 session(之後重跑對齊都用同一份)
        const dictionaryId = opts.dictionaryId || session.dictionaryId || null;
        const useAligner = opts.aligner || session.aligner || aligner;
        if (session.dictionaryId !== dictionaryId || session.aligner !== useAligner) {
            session.dictionaryId = dictionaryId;
            session.aligner = useAligner;
            save(sessionId);
        }

        // 同範圍已對齊(對齊處理分頁選取時已跑 MMS)→ 不重跑 MMS。
        // 使用者可能在 Visual Labeler 改過邊界:以現有 .lab 重算 mora 邊界,讓編輯生效。
        const alreadyAligned = !!(take.realigned && take.start === start && take.end === end && take.moraEnds);
        if (!alreadyAligned) {
            // 使用者確認後才跑 MMS 對齊(這裡是唯一的對齊呼叫點)
            await alignTakeRange(sessionId, takeId, start, end, { dictionaryId, aligner: useAligner });
        } else {
            const wavPath = path.join(segmentsDir, take.filename);
            let wavDur = 0;
            try {
                const w = readWav(wavPath);
                wavDur = w.data.length / (w.sampleRate * w.channels * 2);
            } catch {}
            const windowMorae = session.morae.slice(start, end + 1).map(m => m.text);
            take.moraEnds = computeMoraEnds(windowMorae, wavPath.replace(/\.wav$/, '.lab'), wavDur);
            save(sessionId);
        }
        // 重讀(alignTakeRange 可能改了 take)
        const session2 = load(sessionId);
        const take2 = session2.takes.find(t => t.id === takeId);
        if (!take2 || !take2.moraEnds) return { error: '缺少 mora 邊界,請重試' };
        return doCut(sessionId, take2, start, end);
    }

    /** 依 take 的 moraEnds 把 [start,end] 切成每句一個 segment */
    function doCut(sessionId, take, start, end) {
        const session = load(sessionId);
        if (!session) return { error: 'Session not found' };

        const wavPath = path.join(segmentsDir, take.filename);
        const labPath = wavPath.replace(/\.wav$/, '.lab');
        if (!take.moraEnds) return { error: '缺少 mora 邊界,請重跑對齊' };

        const wav = readWav(wavPath);
        const wavDur = wav.data.length / (wav.sampleRate * wav.channels * 2);
        let labEntries = fs.existsSync(labPath)
            ? fs.readFileSync(labPath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean)
            : [];
        // MMS lab 是 100ns tick:若最大值遠大於音檔秒數,先轉成秒
        const labMax = labEntries.reduce((m, l) => {
            const p = l.split(/\s+/); const e = parseFloat(p[1]);
            return isNaN(e) ? m : Math.max(m, e);
        }, 0);
        if (labMax > wavDur * 10) {
            labEntries = labEntries.map(l => {
                const p = l.split(/\s+/);
                return `${(parseFloat(p[0]) / 1e7).toFixed(6)} ${(parseFloat(p[1]) / 1e7).toFixed(6)} ${p.slice(2).join(' ')}`;
            });
        }

        // 相對 take 起點的時間:gg 是 global idx,key 是相對 window 的 offset
        const rel = gi => gi - take.start;
        const endTimeOf = gi => take.moraEnds[String(rel(gi))] ?? take.moraEnds[rel(gi)];
        const startTimeOf = gi => (gi === take.start ? 0 : endTimeOf(gi - 1));
        const takeEndTime = endTimeOf(take.end);

        // 依句分組
        const byLine = {};
        for (let gi = start; gi <= end; gi++) {
            const line = session.morae[gi].line;
            (byLine[line] = byLine[line] || []).push(gi);
        }

        const created = [];
        for (const [lineStr, gis] of Object.entries(byLine)) {
            const lineIdx = parseInt(lineStr, 10);
            // 找下一個檔號
            const nums = fs.readdirSync(segmentsDir)
                .filter(f2 => /^\d+\.wav$/.test(f2))
                .map(f2 => parseInt(f2.split('.')[0], 10));
            const next = (nums.length > 0 ? Math.max(...nums) : 0) + 1;
            const segName = String(next).padStart(3, '0') + '.wav';

            const t0 = startTimeOf(gis[0]);
            const t1 = endTimeOf(gis[gis.length - 1]);
            const clip = clipSeconds(wav, t0, t1);
            writeWav(path.join(segmentsDir, segName), { sampleRate: wav.sampleRate, channels: wav.channels, data: clip });

            // .txt:這句的 mora
            fs.writeFileSync(
                path.join(segmentsDir, segName.replace(/\.wav$/, '.txt')),
                gis.map(gi => session.morae[gi].text).join(' ')
            );

            // .lab:時間平移成 segment local,寫 100ns HTK tick(與 corpus/Labeler 慣例一致,train-mgr prepare_ds.py 期望此格式)
            const segLab = labEntries
                .map(l => {
                    const p = l.split(/\s+/);
                    const s = parseFloat(p[0]), e = parseFloat(p[1]), ph = p.slice(2).join(' ');
                    if (isNaN(s) || isNaN(e)) return null;
                    if (e <= t0 || s >= t1) return null;
                    const cs = Math.round((Math.max(s, t0) - t0) * 1e7);
                    const ce = Math.round((Math.min(e, t1) - t0) * 1e7);
                    return `${cs} ${ce} ${ph}`;
                })
                .filter(Boolean)
                .join('\n');
            fs.writeFileSync(path.join(segmentsDir, segName.replace(/\.wav$/, '.lab')), segLab);

            // .checked:人工確認過的 take(訓練管理只顯示人工確認過的段)
            fs.writeFileSync(
                path.join(segmentsDir, segName.replace(/\.wav$/, '.checked')),
                gis.map(gi => session.morae[gi].text).join(' ')
            );

            gis.forEach(gi => { session.covered[gi] = true; });
            created.push({ filename: segName, line: lineIdx, morae: gis.length });
        }

        take.start = start;
        take.end = end;
        take.createdSegmentFiles = created.map(c => c.filename);
        take.status = 'confirmed';
        save(sessionId);
        return { success: true, created };
    }

    /**
     * 反悔重切:把 confirmed 的 take 退回待審。
     * 刪掉它切出的訓練段、un-cover 該區間的 mora(其他 confirmed take 也涵蓋的不動);
     * take 原始檔保留(重新審核用)。
     */
    function revertTake(sessionId, takeId) {
        const session = load(sessionId);
        if (!session) return { error: 'Session not found' };
        const take = session.takes.find(t => t.id === takeId);
        if (!take) return { error: 'Take not found' };
        if (take.status !== 'confirmed') return { error: `Take 狀態不可反悔:${take.status}` };
        if (!Array.isArray(take.createdSegmentFiles) || take.createdSegmentFiles.length === 0) {
            return { error: '這段是舊流程切的,不知道切了哪些檔,無法反悔' };
        }

        for (const filename of take.createdSegmentFiles) {
            for (const ext of ['.wav', '.txt', '.lab', '.checked', '.conf']) {
                const p = path.join(segmentsDir, filename.replace(/\.wav$/, ext));
                if (fs.existsSync(p)) {
                    try { fs.unlinkSync(p); } catch (e) { console.warn('[SESSION] 反悔刪段失敗:', e.message); }
                }
            }
        }

        // un-cover 該區間:其他 confirmed take 也涵蓋的 mora 不動
        if (typeof take.start === 'number' && typeof take.end === 'number') {
            const otherCovered = new Set();
            for (const t of session.takes) {
                if (t.id === take.id || t.status !== 'confirmed') continue;
                if (typeof t.start === 'number' && typeof t.end === 'number') {
                    for (let gi = t.start; gi <= t.end; gi++) otherCovered.add(gi);
                }
            }
            for (let gi = take.start; gi <= take.end && gi < session.covered.length; gi++) {
                if (!otherCovered.has(gi)) session.covered[gi] = false;
            }
        }

        take.status = 'confirm';
        take.createdSegmentFiles = [];
        save(sessionId);
        return { success: true };
    }

    function updateTake(sessionId, takeId, patch) {
        const session = load(sessionId);
        if (!session) return null;
        const take = session.takes.find(t => t.id === takeId);
        if (!take) return null;
        Object.assign(take, patch);
        save(sessionId);
        return take;
    }

    /** 標記/取消 [start,end] 區間的 covered(唱歌進度:送審標綠,反悔或對齊失敗退回) */
    function setCoveredRange(sessionId, start, end, value) {
        const session = load(sessionId);
        if (!session) return;
        for (let gi = Math.max(0, start); gi <= end && gi < session.covered.length; gi++) {
            session.covered[gi] = value;
        }
        save(sessionId);
    }

    function addTake(sessionId, filename) {
        const session = load(sessionId);
        if (!session) return null;
        const take = {
            id: `take-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            filename,
            status: 'asr',
            rough: null,
            start: null,
            end: null,
            score: null,
            jobId: null,
            moraEnds: null,
            error: null,
            createdAt: Date.now(),
        };
        session.takes.push(take);
        save(sessionId);
        return take;
    }

    return {
        listSessions,
        load,
        createSession,
        addTake,
        updateTake,
        runTakePipeline,
        confirmTake,
        alignTakeRange,
        revertTake,
        setCoveredRange,
        cursorOf,
        lineProgress,
        splitRomajiToMorae,
        matchWarnThreshold,
        estimateStartCandidates,
    };
}

module.exports = createSongSessionService;
