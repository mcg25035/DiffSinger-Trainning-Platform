const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { splitRomajiToMorae } = require('../services/romaji-mora');

// 歌詞先行 + 全域 mora 游標 錄音流程 API v2
// 設計: docs/training-inference-design.md §1
module.exports = function createSongSessionRouter({ sessionService, segmentsDir, mmsService }) {
    const router = express.Router();

    // take 的 wav 暫存到 upload_segments(確認切割前放在這,以 _take 為前綴避免被當訓練資料)
    const TAKE_PREFIX = 'take-';
    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, segmentsDir),
        filename: (req, file, cb) => {
            cb(null, `${TAKE_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1000)}.wav`);
        },
    });
    const upload = multer({ storage });

    // POST /api/sessions { name, lyrics, dictionaryId?, aligner? } — 建立歌詞 session(整首,一行一句,羅馬拼音)
    // dictionaryId/aligner 存進 session,take 對齊時用(MMS 需 dictionary 才會做 mora→phoneme 轉換)
    router.post('/api/sessions', express.json(), (req, res) => {
        const { name, lyrics, dictionaryId, aligner } = req.body;
        if (!lyrics) return res.status(400).json({ error: 'Missing lyrics' });
        const session = sessionService.createSession(name, lyrics, { dictionaryId, aligner });
        if (session.error) return res.status(400).json(session);
        res.json(decorate(session));
    });

    // POST /api/romanize_mora { lines: [{kanji, romaji}] } — 消歧預覽(建立 session 前)
    // 走 async job:回 jobId,前端輪詢 /api/romanize_mora/:jobId 拿真進度(%)
    // 撥音 N → n 正規化(使用者端 pipeline 統一用 'n';MMS mapping 兩者等價)
    router.post('/api/romanize_mora', express.json(), async (req, res) => {
        if (!mmsService) return res.status(503).json({ error: 'MMS service 未設定' });
        try {
            const { jobId } = await mmsService.romanizeMoraAsync(req.body.lines || []);
            res.json({ jobId });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/romanize_mora/:jobId — 輪詢消歧 job(進度 + 結果)
    router.get('/api/romanize_mora/:jobId', async (req, res) => {
        try {
            const job = await mmsService.romanizeMoraStatus(req.params.jobId);
            if (job.status === 'completed' && job.result) {
                const normTok = (s) => s.split(' ').map(t => (t === 'N' ? 'n' : t)).join(' ');
                for (const r of job.result.results || []) {
                    if (r.mora_romaji) r.mora_romaji = normTok(r.mora_romaji);
                    if (Array.isArray(r.morae)) r.morae = r.morae.map(t => (t === 'N' ? 'n' : t));
                }
            }
            res.json(job);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/sessions — session 清單
    router.get('/api/sessions', (req, res) => {
        res.json(sessionService.listSessions());
    });

    // GET /api/sessions/:id — 完整狀態(前端輪詢用)
    router.get('/api/sessions/:id', (req, res) => {
        const session = sessionService.load(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        res.json(decorate(session));
    });

    // POST /api/sessions/:id/takes — 上傳一段錄音,啟動 定位→對齊 管線
    router.post('/api/sessions/:id/takes', upload.single('audio'), async (req, res) => {
        const session = sessionService.load(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (!req.file) return res.status(400).json({ error: 'No audio' });

        const take = sessionService.addTake(session.id, req.file.filename);
        sessionService.runTakePipeline(session.id, take.id); // 背景執行
        res.json({ takeId: take.id, status: 'asr' });
    });

    // POST /api/sessions/:id/takes/:takeId/confirm { start?, end?, dictionaryId?, aligner? } — 確認並切割
    // 注意:若使用者調的範圍超出原本的 ASR 對齊窗,後端會重新跑 MMS 對齊再切,可能要等十幾秒
    router.post('/api/sessions/:id/takes/:takeId/confirm', express.json(), async (req, res) => {
        try {
            const session = sessionService.load(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const take = session.takes.find(t => t.id === req.params.takeId);
            if (!take) return res.status(404).json({ error: 'Take not found' });

            const result = await sessionService.confirmTake(
                session.id, take.id,
                req.body.start ?? take.start,
                req.body.end ?? take.end,
                { aligner: 'mms' } // 新流程鎖定 MMS(dictionaryId 用 session 存的)
            );
            if (result.error) return res.status(400).json(result);
            markTakeArtifacts(session.id, take, true);
            res.json(result);
        } catch (err) {
            console.error('[SESSION] confirm 失敗:', err);
            res.status(500).json({ error: err.message || 'confirm 失敗' });
        }
    });

    // POST /api/sessions/:id/takes/:takeId/submit-range { start, end, dictionaryId?, aligner? } — 唱歌錄音:使用者選好範圍送審
    // take 狀態 confirm(調整中)→ aligning:立刻在背景跑 MMS 對齊,完成後 → ready(待審)才進對齊處理
    router.post('/api/sessions/:id/takes/:takeId/submit-range', express.json(), (req, res) => {
        const session = sessionService.load(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        const take = session.takes.find(t => t.id === req.params.takeId);
        if (!take) return res.status(404).json({ error: 'Take not found' });
        if (take.status !== 'confirm') return res.status(400).json({ error: `Take 狀態不可送審:${take.status}` });

        const start = Math.max(0, Math.min(req.body.start ?? take.start ?? 0, session.morae.length - 1));
        const end = Math.max(start, Math.min(req.body.end ?? take.end ?? 0, session.morae.length - 1));
        if (take.realigned && (take.start !== start || take.end !== end)) {
            take.realigned = false;
            take.moraEnds = null;
        }
        sessionService.updateTake(session.id, take.id, { start, end, status: 'aligning' });
        // 送審 = 唱歌進度確認:標 covered(歌詞進度條變綠)
        sessionService.setCoveredRange(session.id, start, end, true);

        // MMS 對齊在唱歌錄音跑,完成後才進對齊處理(狀態 → ready)
        // 新流程鎖定 MMS + 用 session 存的 dictionaryId(phoneme 轉換需要 mapping)
        sessionService.alignTakeRange(session.id, take.id, start, end, { aligner: 'mms' })
            .then(() => sessionService.updateTake(session.id, take.id, { status: 'ready' }))
            .catch(err => {
                console.error('[SESSION] 送審對齊失敗:', err);
                sessionService.updateTake(session.id, take.id, { status: 'error', error: err.message });
                sessionService.setCoveredRange(session.id, start, end, false); // 對齊失敗 → 進度退回
            });
        res.json({ success: true, status: 'aligning' });
    });

    // POST /api/sessions/:id/takes/:takeId/align { start?, end?, dictionaryId?, aligner? } — 對齊處理分頁:選取 take 觸發 MMS 對齊(背景執行)
    // take 狀態 → aligning(黃色);完成後 .lab/moraEnds 就緒,等使用者按確定完成
    router.post('/api/sessions/:id/takes/:takeId/align', express.json(), async (req, res) => {
        const session = sessionService.load(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        const take = session.takes.find(t => t.id === req.params.takeId);
        if (!take) return res.status(404).json({ error: 'Take not found' });

        const start = req.body.start ?? take.start;
        const end = req.body.end ?? take.end;
        // 一次只審一段:其他 aligning 的 take 重設回 confirm
        session.takes.forEach(t => { if (t.status === 'aligning' && t.id !== take.id) t.status = 'confirm'; });
        sessionService.updateTake(session.id, take.id, { status: 'aligning' });

        sessionService.alignTakeRange(session.id, take.id, start, end, {
            dictionaryId: req.body.dictionaryId,
            aligner: req.body.aligner,
        })
            .catch(err => {
                console.error('[SESSION] align 失敗:', err);
                sessionService.updateTake(session.id, take.id, { status: 'error', error: err.message });
            });
        res.json({ takeId: take.id, status: 'aligning' });
    });

    // GET /api/alignment-takes — 對齊處理分頁:跨 session 的 take 清單(狀態 + 窗口歌詞)
    router.get('/api/alignment-takes', (req, res) => {
        const rows = [];
        for (const s of sessionService.listSessions()) {
            const session = sessionService.load(s.id);
            if (!session) continue;
            for (const t of session.takes) {
                if (t.status === 'discarded' || t.status === 'asr' || t.status === 'confirm') continue;
                // 舊流程 confirm 會清原始檔:confirmed 但檔案已不在 = 無法審的遺留狀態,不列出
                if (t.status === 'confirmed' && !fs.existsSync(path.join(segmentsDir, t.filename))) continue;
                const hasRange = typeof t.start === 'number' && typeof t.end === 'number';
                rows.push({
                    sessionId: session.id,
                    sessionName: session.name,
                    takeId: t.id,
                    status: t.status,
                    filename: t.filename,
                    start: t.start,
                    end: t.end,
                    score: t.score ?? null,
                    realigned: !!t.realigned,
                    hasFiles: fs.existsSync(path.join(segmentsDir, t.filename)),
                    error: t.error || null,
                    lyrics: hasRange
                        ? session.morae.slice(t.start, t.end + 1).map(m => m.text).join(' ')
                        : '',
                    createdAt: t.createdAt,
                });
            }
        }
        res.json(rows);
    });

    // POST /api/sessions/:id/takes/:takeId/discard — 丟棄這段錄音(不進資料集)
    router.post('/api/sessions/:id/takes/:takeId/discard', (req, res) => {
        const session = sessionService.load(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        const take = session.takes.find(t => t.id === req.params.takeId);
        if (!take) return res.status(404).json({ error: 'Take not found' });
        sessionService.updateTake(session.id, take.id, { status: 'discarded' });
        markTakeArtifacts(session.id, take, false);
        res.json({ success: true });
    });

    // POST /api/sessions/:id/takes/:takeId/revert — 反悔重切:退回待審、刪掉切出的訓練段、un-cover
    router.post('/api/sessions/:id/takes/:takeId/revert', (req, res) => {
        const result = sessionService.revertTake(req.params.id, req.params.takeId);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    });

    // 回應前給 session 加上 cursor 與每句進度
    function decorate(session) {
        return {
            ...session,
            cursor: sessionService.cursorOf(session),
            lineProgress: sessionService.lineProgress(session),
        };
    }

    // take 結案後處理暫存檔:確認 → 保留(源音檔+對齊留在 take- 前綴下,不會進訓練集,完成的 take 還能回看);
    // 丟棄 → 全部刪除
    function markTakeArtifacts(sessionId, take, keep) {
        if (keep) return;
        for (const ext of ['.wav', '.txt', '.lab', '.conf']) {
            const p = path.join(segmentsDir, take.filename.replace(/\.wav$/, ext));
            if (fs.existsSync(p)) {
                try { fs.unlinkSync(p); } catch (e) { console.warn('[SESSION] 清理暫存失敗:', e.message); }
            }
        }
    }

    return router;
};
