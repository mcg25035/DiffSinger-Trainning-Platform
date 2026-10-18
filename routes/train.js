// 訓練管理:train-mgr(Colab 多帳號)整合
// 帳號/CCU 盤點 + 登入管理 + prepare(checked 段 → CPU VM)+ build+submit + watcher(自動重丟+收 ckpt)
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { getMgr } = require('../services/train-mgr');

function createTrainRouter({ segmentsDir }) {
    const router = express.Router();

    // ---- in-memory 狀態 ----
    const prepJobs = new Map();          // id → { id, name, files, status, exp?, items?, phonemes?, error?, startedAt }
    let watcher = null;                  // train-mgr Watcher(背景輪詢)
    let lastTick = null;                 // 最後一輪 tick 摘要
    let specs = new Map();               // exp → job spec(watcher 重丟用)
    let specPaths = new Map();           // exp → spec 檔路徑
    let repoRootCache = null;
    let jobsCache = null;                // cluster list 快取(避免 UI 輪詢狂打 CLI)
    let jobsCacheAt = 0;

    const ymd = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

    async function repoRoot() {
        if (!repoRootCache) repoRootCache = await (await getMgr()).repoRoot();
        return repoRootCache;
    }

    async function clusterJobs(force = false) {
        if (!force && jobsCache && Date.now() - jobsCacheAt < 10_000) return jobsCache;
        const mgr = await getMgr();
        const rows = await mgr.cluster.list();
        jobsCache = rows;
        jobsCacheAt = Date.now();
        return rows;
    }

    // active job 的目前 step:daemon 的 PROGRESS 欄常常是 "-",直接從鏡像 log 尾抓最後 STEP
    async function stepProgress(row) {
        const st = String(row.status || '').split(/\s+/)[0];
        if (!['running', 'queued', 'provisioning', 'dispatching'].includes(st)) return null;
        try {
            const mgr = await getMgr();
            const file = mgr.cluster.logFile(row.id);
            const fh = await fsp.open(file, 'r');
            const size = (await fh.stat()).size;
            const len = Math.min(size, 262144);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, size - len);
            await fh.close();
            const matches = [...buf.toString('utf8').matchAll(/^\s*\|?\s*STEP\s+(\d+)/gm)];
            return matches.length ? Number(matches[matches.length - 1][1]) : null;
        } catch { return null; }
    }

    // 訓練總步數(進度條用):從 spec 的 command 抓 max_updates
    function maxUpdatesOf(name) {
        const spec = specs.get(name);
        if (!spec) return 9000;
        const m = String(spec.command ?? '').match(/max_updates=(\d+)/);
        return m ? Number(m[1]) : 9000;
    }

    // ---- 帳號/CCU 盤點(pool 有 5 分鐘快取)----
    router.get('/api/train/accounts', async (req, res) => {
        try {
            const mgr = await getMgr();
            const accounts = await mgr.accounts(req.query.force === '1');
            const totalCcu = mgr.pool.totalCcu(accounts);
            res.json({ accounts, totalCcu });
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // ---- 帳號登入管理 ----
    // 開始登入:拿 OAuth 連結(UI 開瀏覽器;colab 背景 daemon 自動完成 token 交換+註冊)
    router.post('/api/train/auth/login', async (req, res) => {
        try {
            const mgr = await getMgr();
            res.json(await mgr.auth.beginLogin());
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    router.post('/api/train/auth/switch', express.json(), async (req, res) => {
        try {
            const mgr = await getMgr();
            res.json({ ok: await mgr.auth.switch(req.body.email) });
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    router.post('/api/train/auth/logout', express.json(), async (req, res) => {
        try {
            const mgr = await getMgr();
            res.json({ ok: await mgr.auth.logout(req.body.email) });
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // 等帳號註冊出現(OAuth 完成後 colab daemon 會註冊)
    router.get('/api/train/auth/wait/:email', async (req, res) => {
        try {
            const mgr = await getMgr();
            const ok = await mgr.auth.waitLoggedIn(decodeURIComponent(req.params.email), 20_000, 3_000);
            res.json({ loggedIn: ok });
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // ---- prepare:checked 段(wav+lab)組 src dir → CPU VM prepare(背景,等 done 可能數分鐘)----
    router.post('/api/train/prepare', express.json(), async (req, res) => {
        const { name, files } = req.body ?? {};
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'files required(勾選的訓練段)' });
        }
        const safe = String(name ?? 'dataset').trim().replace(/[^a-zA-Z0-9._-]+/g, '-') || 'dataset';
        try {
            const src = path.join(segmentsDir, '.train-datasets', safe);
            const wavDir = path.join(src, 'wav');
            const labDir = path.join(src, 'lab');
            await fsp.mkdir(wavDir, { recursive: true });
            await fsp.mkdir(labDir, { recursive: true });
            let count = 0, missing = [];
            for (const f of files) {
                const base = String(f).replace(/\.wav$/i, '');
                const wavSrc = path.join(segmentsDir, base + '.wav');
                const labSrc = path.join(segmentsDir, base + '.lab');
                if (fs.existsSync(wavSrc) && fs.existsSync(labSrc)) {
                    await fsp.copyFile(wavSrc, path.join(wavDir, base + '.wav'));
                    await fsp.copyFile(labSrc, path.join(labDir, base + '.lab'));
                    count++;
                } else {
                    missing.push(base);
                }
            }
            if (count === 0) {
                return res.status(400).json({ error: `沒有 wav+lab 成對的段(缺:${missing.slice(0, 5).join(', ')})` });
            }

            const jobId = `prep-${Date.now()}`;
            const job = { id: jobId, name: safe, files: count, skipped: missing.length, status: 'submitting', startedAt: Date.now(), exp: null, error: null };
            prepJobs.set(jobId, job);
            res.json(job);

            (async () => {
                try {
                    const mgr = await getMgr();
                    job.status = 'waiting';
                    // testN:驗證段數(test_prefixes 會扣掉不訓)— 約 20% 封頂 5,至少留 1 段訓練
                    const testN = Math.min(5, Math.max(1, Math.floor(count / 5)));
                    const result = await mgr.prepare({ src, date: ymd(), testN });
                    job.status = 'done';
                    job.exp = result.exp;
                    job.items = result.items;
                    job.phonemes = result.phonemes;
                } catch (e) {
                    console.error('[TRAIN] prepare 失敗:', e);
                    job.status = 'error';
                    job.error = e.message ?? String(e);
                }
            })();
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // ---- build + submit(prepared exps → bundle+spec → cluster;完成自動開 watcher)----
    router.post('/api/train/submit', express.json(), async (req, res) => {
        const exps = Array.isArray(req.body?.exps) && req.body.exps.length
            ? req.body.exps
            : [...prepJobs.values()].filter(j => j.status === 'done' && j.exp).map(j => j.exp);
        if (exps.length === 0) return res.status(400).json({ error: '沒有可 submit 的 exp(先 prepare)' });
        try {
            const mgr = await getMgr();
            const root = await repoRoot();
            res.json({ ok: true, exps });

            // 背景:build(bundle+spec,首次觸發 repo clone ~50MB)+ submit + watcher
            (async () => {
                try {
                    const built = await mgr.build({ date: ymd() }, exps);
                    specs = new Map();
                    specPaths = new Map();
                    for (const b of built) {
                        const spec = JSON.parse(await fsp.readFile(b.specPath, 'utf8'));
                        specs.set(b.exp, spec);
                        specPaths.set(b.exp, b.specPath);
                        await mgr.submit(spec, { name: b.exp, specFile: b.specPath });
                    }
                    // 自動開 watcher(自動重丟 + 收 ckpt)
                    if (watcher) watcher.stop();
                    lastTick = null;
                    watcher = await mgr.watch(specs, {
                        specPaths,
                        intervalMs: 30_000,
                        onTick: s => { lastTick = { ...s, at: Date.now() }; },
                    });
                    lastTick = { done: [], active: [...specs.keys()], retryable: [], permafail: [], missing: [], actions: [], allDone: false, at: Date.now() };
                } catch (e) {
                    console.error('[TRAIN] submit 失敗:', e);
                    lastTick = { error: e.message ?? String(e), at: Date.now() };
                }
            })();
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // ---- 狀態:prep jobs + cluster jobs + watcher ----
    router.get('/api/train/state', async (req, res) => {
        try {
            let rows = [];
            try { rows = await clusterJobs(); } catch (e) { rows = []; }
            // 只顯示平台送的 job(訓練 exp<MMDD>-* / prep-exp*),同名取最新(id 最大)
            const byName = new Map();
            for (const r of rows) {
                if (!/^exp\d{4}-|^prep-exp\d{4}-/.test(r.name)) continue;
                const cur = byName.get(r.name);
                if (!cur || r.id > cur.id) byName.set(r.name, r);
            }
            const jobs = [...byName.values()].sort((a, b) => b.id - a.id);
            // 補上目前 step(鏡像 log)+ 總步數(進度條用)
            for (const j of jobs) {
                const step = await stepProgress(j);
                if (step != null) j.progress = step;
                j.total = maxUpdatesOf(j.name);
            }
            const repoReady = repoRootCache ? true : null;
            res.json({
                repoRoot: repoRootCache,
                repoReady,
                prepJobs: [...prepJobs.values()],
                jobs,
                watch: watcher ? { running: true } : null,
                lastTick,
            });
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // ---- 模型清單:掃 checkpoints/<exp>/(watcher 收回的 ckpt)----
    router.get('/api/train/models', async (req, res) => {
        try {
            const os = require('os');
            const ckptRoot = repoRootCache
                ? path.join(repoRootCache, 'checkpoints')
                : path.join(os.homedir(), '.cache', 'train-mgr', 'diffsinger', 'checkpoints');
            const models = [];
            let dirs = [];
            try {
                dirs = (await fsp.readdir(ckptRoot, { withFileTypes: true })).filter(x => x.isDirectory());
            } catch { /* checkpoints 目錄不存在 */ }
            for (const d of dirs) {
                const full = path.join(ckptRoot, d.name);
                let files = [];
                try { files = await fsp.readdir(full); } catch { continue; }
                const ckptNames = files.filter(f => /^model_ckpt_steps_\d+\.ckpt$/.test(f));
                if (ckptNames.length === 0) continue;
                const ckpts = await Promise.all(ckptNames.map(async f => {
                    const st = await fsp.stat(path.join(full, f));
                    return { file: path.join(full, f), name: f, sizeBytes: st.size, mtime: st.mtimeMs };
                }));
                ckpts.sort((a, b) => b.mtime - a.mtime);
                models.push({ exp: d.name, ckpts, latest: ckpts[0] });
            }
            models.sort((a, b) => (a.exp < b.exp ? 1 : -1));
            res.json({ models, ckptRoot });
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // ---- job log(本機鏡像檔,比 cluster logs 快、不被 daemon 堵)----
    router.get('/api/train/jobs/:id/log', async (req, res) => {
        try {
            const mgr = await getMgr();
            const file = mgr.cluster.logFile(Number(req.params.id));
            let text = '';
            try { text = await fsp.readFile(file, 'utf8'); } catch { text = '(鏡像 log 不存在,job 可能剛送出)'; }
            res.type('text/plain').send(text);
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // ---- watcher 控制 ----
    router.post('/api/train/watch/stop', async (req, res) => {
        if (watcher) { watcher.stop(); watcher = null; }
        res.json({ ok: true });
    });

    // ---- 收工:關掉所有帳號的 VM(先確認訓練結束+ckpt 檔案到位)----
    router.post('/api/train/vm/destroy', async (req, res) => {
        try {
            const mgr = await getMgr();
            // 驗證:每個追蹤中的訓練 job 都 done 且 ckpt 已收回
            if (specs.size > 0) {
                const rows = await clusterJobs(true);
                const latest = new Map();
                for (const r of rows) { const cur = latest.get(r.name); if (!cur || r.id > cur.id) latest.set(r.name, r); }
                for (const [name] of specs) {
                    const row = latest.get(name);
                    const st = row ? String(row.status).split(/\s+/)[0] : null;
                    if (st !== 'done') {
                        return res.status(400).json({ error: `訓練還沒結束:${name}(${st ?? '找不到 job'})` });
                    }
                    if (repoRootCache) {
                        const dir = path.join(repoRootCache, 'checkpoints', name);
                        let has = false;
                        try { has = (await fsp.readdir(dir)).some(f2 => /^model_ckpt_steps_\d+\.ckpt$/.test(f2)); } catch { /* 目錄不存在 */ }
                        if (!has) {
                            return res.status(400).json({ error: `ckpt 還沒收回:${name}(${dir} 沒有 model_ckpt_steps_*.ckpt)` });
                        }
                    }
                }
            }
            const emails = (await mgr.accounts(true)).map(a => a.email);
            const destroyed = await mgr.vm.destroyAll(emails);
            res.json({ destroyed });
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    // ---- 取消 job ----
    router.post('/api/train/jobs/:id/cancel', async (req, res) => {
        try {
            const mgr = await getMgr();
            res.json({ ok: await mgr.cluster.cancel(Number(req.params.id)) });
        } catch (e) {
            res.status(500).json({ error: e.message ?? String(e) });
        }
    });

    return router;
}

module.exports = createTrainRouter;
