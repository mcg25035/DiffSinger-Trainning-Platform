// 推理整合:train-mgr Inferer(submit/wait)
// POST synthesize → 背景直接 submit(跳過 idle VM 前檢;daemon 會自動開 VM)→ 回 local jobId
// 前端輪詢 GET jobs/:id(帶 clusterStatus:queued/provisioning=開機中)→ wav 用 GET jobs/:id/wav/:idx 串流
const express = require('express');
const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { getMgr, TRAIN_MGR_DIST } = require('../services/train-mgr');
const { runLocalInfer, serviceAvailable, notRunningError } = require('../services/local-infer');

const TRAIN_MGR_ERROR_NAMES = new Set([
    'TrainMgrError', 'ColabError', 'PoolError', 'PrepError',
    'BuildError', 'RepoError', 'InferError', 'VmError', 'BudgetError',
]);

// localId → { status: starting|running|done|failed, wavs[], error, exp, ckptPath, clusterJobId, started }
const inferJobs = new Map();
let inferSeq = 1;

function isHttpErrorDetail(e) {
    return e instanceof Error && TRAIN_MGR_ERROR_NAMES.has(e.name);
}

function publicJob(localId) {
    const j = inferJobs.get(localId);
    if (!j) return null;
    return {
        id: localId,
        kind: j.kind ?? 'infer',
        engine: j.engine ?? 'cloud',
        status: j.status,
        wavs: j.wavs,
        error: j.error,
        note: j.note ?? null,
        exp: j.exp,
        clusterJobId: j.clusterJobId,
        started: j.started,
        uploads: j.uploads ?? null,
        runningSince: j.runningSince ?? null,
        progress: j.progress ?? null,
        logTail: j.logTail ?? null,
        dbg: j.dbg ?? null,
    };
}

// 進行中 job 的引擎(分開計數:雲端和本機可同時各跑一張)
function activeEngineOf(j) {
    return j.kind === 'warmup' ? 'cloud' : (j.engine ?? 'cloud');
}

// ---- 階段進度輔助:從 daemon log 尾抓該 job 的上傳行,交叉比對 submit 時存的 manifest ----
const DAEMON_LOG = path.join(os.homedir(), '.config', 'colab-cli', 'cluster', 'daemon.log');
const CKPT_MIRROR_DIR = path.join(os.homedir(), '.config', 'colab-cli', 'cluster', 'checkpoints');
const MIRROR_LOG_DIR = path.join(os.homedir(), '.config', 'colab-cli', 'cluster', 'logs');

async function uploadPhaseFor(clusterId, rec, clusterStatus) {
    const manifest = rec.uploads ?? [];
    const totalFiles = manifest.length;
    const totalBytes = manifest.reduce((a, u) => a + (u.sizeBytes || 0), 0);
    let startedFiles = 0;
    let currentFile = null;
    let booting = false;   // 已開始建 VM(daemon:provisioning runtime)還沒好
    let booted = false;    // VM 建好了(provisioned)
    try {
        const st = await fsp.stat(DAEMON_LOG);
        const len = Math.min(st.size, 65536); // 尾端 64KB 足夠覆蓋近幾次上傳行
        const fh = await fsp.open(DAEMON_LOG, 'r');
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        await fh.close();
        const lines = buf.toString('utf8').split('\n');
        const upLines = lines.filter((l) => l.includes(`job ${clusterId}: uploading `));
        startedFiles = upLines.length;
        if (upLines.length) {
            const src = upLines[upLines.length - 1].split(' uploading ')[1]?.split(' -> ')[0] ?? '';
            currentFile = path.basename(src);
        }
        booting = lines.some((l) => l.includes(`job ${clusterId}: no idle VM; provisioning runtime`));
        booted = lines.some((l) => l.includes(`job ${clusterId}: provisioned `));
    } catch { /* daemon.log 不存在 */ }
    // 完成數:最後一顆是 in-flight;shell 開跑(running)後全部完成
    const completedFiles = clusterStatus === 'running' || rec.status === 'done' ? startedFiles : Math.max(0, startedFiles - 1);
    const completedBytes = manifest.slice(0, completedFiles).reduce((a, u) => a + (u.sizeBytes || 0), 0);
    return { startedFiles, totalFiles, currentFile, completedFiles, completedBytes, totalBytes, booting, booted };
}

async function wavFetchFor(clusterId) {
    try {
        const dir = path.join(CKPT_MIRROR_DIR, `job-${clusterId}`);
        const names = (await fsp.readdir(dir)).filter((n) => !n.startsWith('.'));
        let bytes = 0;
        for (const n of names) {
            try { bytes += (await fsp.stat(path.join(dir, n))).size; } catch { /* 檔案消失 */ }
        }
        return { count: names.length, bytes };
    } catch { return { count: 0, bytes: 0 }; }
}

// ---- ckpt 部署位置記憶(平台端)----
// 輕量版(ckptReuse)只在「確定這顆模型已部署在當前 idle 的 VM」時才送,
// 避免 fresh VM 上白跑一輪(假推理兩分鐘+失敗+重來的割裂體驗)。
// VM 名從 daemon.log "job N running on <email> <vmname> shell k" 抓(與 vmStandby().idle 同格式);
// JSON 持久化(後端重啟不丢)。VM 被回收也無妨 — 送輕量前先對 idle 清單過濾,沒對上就送完整版。
const CKPT_VM_FILE = path.join(os.homedir(), '.cache', 'train-mgr', 'infer', 'platform-ckpt-vms.json');
const ckptVmMemo = (() => {
    try {
        return new Map(Object.entries(JSON.parse(fs.readFileSync(CKPT_VM_FILE, 'utf8')))
            .map(([k, v]) => [k, new Set(v)]));
    } catch { return new Map(); }
})();
function saveCkptVmMemo() {
    try {
        const obj = {};
        for (const [k, v] of ckptVmMemo) obj[k] = [...v];
        fs.writeFileSync(CKPT_VM_FILE, JSON.stringify(obj, null, 1));
    } catch { /* best effort */ }
}
function vmNameFromLog(clusterId) {
    try {
        const st = fs.statSync(DAEMON_LOG);
        const len = Math.min(st.size, 262144);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(DAEMON_LOG, 'r');
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const m = lines[i].match(new RegExp(`job ${clusterId} running on \\S+ (\\S+) shell`));
            if (m) return m[1];
        }
    } catch { /* no log */ }
    return null;
}
function memoCkptVm(ckptPath, clusterId) {
    const vm = vmNameFromLog(clusterId);
    if (!vm) return;
    const set = ckptVmMemo.get(ckptPath) ?? new Set();
    if (set.has(vm)) return;
    set.add(vm);
    ckptVmMemo.set(ckptPath, set);
    saveCkptVmMemo();
}
async function ckptDeployedOnIdleVm(ckptPath) {
    try {
        const mgr = await getMgr();
        const idle = (await mgr.vmStandby()).idle ?? [];
        const known = ckptVmMemo.get(ckptPath);
        return !!(known && [...known].some((vm) => idle.includes(vm)));
    } catch { return false; }
}

// ---- 音素預檢:ds 的 ph_seq 必須 ⊆ 模型字典(缺音素要等推理 subprocess 跑起來才 KeyError,太晚)----
// 字典來源與實際 stage/上傳一致:expDir/dictionary-default.txt → artifacts 最新日期 dictionary.txt
// 沒有字典可驗 → 放行(維持現狀);SP/AP 是結構性靜默 token,一律允許
function phonemesFromDictFile(p) {
    const set = new Set();
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith('#')) continue;
        const [left, right] = l.split('\t');
        for (const t of (right ?? left ?? '').split(/\s+/)) if (t) set.add(t);
        if (right != null && left) set.add(left);
    }
    return set;
}

async function expPhonemeSet(mgr, exp) {
    try {
        const repoRoot = await mgr.repoRoot();
        let dictPath = path.join(repoRoot, 'checkpoints', exp, 'dictionary-default.txt');
        if (!fs.existsSync(dictPath)) {
            const artRoot = path.join(repoRoot, 'artifacts');
            for (const d of fs.readdirSync(artRoot).sort().reverse()) {
                const p = path.join(artRoot, d, exp, 'dictionary.txt');
                if (fs.existsSync(p)) { dictPath = p; break; }
            }
        }
        if (!fs.existsSync(dictPath)) return null;
        return phonemesFromDictFile(dictPath);
    } catch {
        return null; // 檢查本身失敗不擋 job
    }
}

async function validatePhonemes(mgr, exp, ds) {
    const phSet = await expPhonemeSet(mgr, exp);
    if (!phSet) return null;
    const items = Array.isArray(ds) ? ds : [ds];
    const missing = new Set();
    for (const it of items) {
        const seq = String(it?.ph_seq ?? '').trim();
        if (!seq) continue;
        for (const t of seq.split(/\s+/)) {
            if (t && t !== 'SP' && t !== 'AP' && !phSet.has(t)) missing.add(t);
        }
    }
    return missing.size ? [...missing].sort() : null;
}

module.exports = function createInferenceRouter() {
    const router = express.Router();

    // ---- 送推理(背景跑,馬上回 local jobId;engine=cloud|local)----
    router.post('/api/inference/synthesize', express.json(), async (req, res) => {
        try {
            const { ckptPath, ds, title, engine = 'cloud', dbg = null } = req.body ?? {};
            if (!['cloud', 'local'].includes(engine)) return res.status(400).json({ error: `engine 只能是 cloud|local(拿到 ${engine})` });
            if (!ckptPath || !ds) return res.status(400).json({ error: '需要 ckptPath 和 ds(.ds 內容)' });
            // 同引擎只跑一張(雲端防 daemon 開第二台 VM;本機防 CPU 搶爆)— 不同引擎互不擋
            for (const [id, j] of inferJobs) {
                if (j.status !== 'starting' && j.status !== 'running') continue;
                if ((engine === 'local') !== (activeEngineOf(j) === 'local')) continue;
                const label = activeEngineOf(j) === 'local' ? '本機推論' : '推理/暖機';
                return res.status(409).json({ error: `已有${label}進行中(job #${id}),等它完成再送` });
            }
            // 本機引擎前置檢查(服務沒跑就直接 400,不收 job)
            if (engine === 'local') {
                if (!(await serviceAvailable())) return res.status(400).json({ error: notRunningError('前置檢查').message });
            }
            // exp 從 ckpt 路徑抽:.../checkpoints/<exp>/model_ckpt_...
            const m = String(ckptPath).match(/[\\/]checkpoints[\\/]([^\\/]+)[\\/]/);
            if (!m) return res.status(400).json({ error: `ckptPath 認不出 exp:${ckptPath}` });
            const exp = m[1];
            // 音素預檢(兩個引擎都擋):ds 音素 ⊆ 模型字典,缺 → 400 帶清單
            const mgr = await getMgr();
            const missing = await validatePhonemes(mgr, exp, ds);
            if (missing) {
                return res.status(400).json({
                    error: `模型 ${exp} 的字典沒有這些音素:${missing.join('、')} — 換模型再送(日語 romaji 歌用 exp0903-ger-25m;exp1007/exp1008 的字典只有 16 音素,沒 h/s/y/g/j)`,
                });
            }
            // ds JSON 寫成 .ds 檔(Inferer.check 防呆吃檔案)
            const dsDir = path.join(os.homedir(), '.cache', 'train-mgr', 'infer');
            await fsp.mkdir(dsDir, { recursive: true });
            const dsPath = path.join(dsDir, `platform-${Date.now()}.ds`);
            await fsp.writeFile(dsPath, JSON.stringify(ds));
            const localId = inferSeq++;
            inferJobs.set(localId, {
                kind: 'infer',
                engine,
                status: 'starting', wavs: [], error: null,
                exp, ckptPath, clusterJobId: null, started: Date.now(),
                dbg, // 臨時 debug:送出時前端報的專案摘要(notes/phCount/head/refIsLive)
            });
            res.json({ jobId: localId, exp, dsPath, engine });
            if (engine === 'local') {
                // 本機 docker 推理:stage → run → wavs 落 staging out(絕對路徑直接給 wav 路由)
                (async () => {
                    const rec = inferJobs.get(localId);
                    try {
                        const { wavs } = await runLocalInfer({
                            exp, dsPath, ckptPath, title,
                            onTick: (t) => {
                                if (t.phase === 'running' && rec.status === 'starting') {
                                    rec.status = 'running';
                                    rec.runningSince = Date.now();
                                }
                                if (t.progress != null) rec.progress = t.progress;
                                if (t.logTail) rec.logTail = t.logTail;
                            },
                        });
                        rec.status = 'done';
                        rec.wavs = wavs;
                    } catch (e) {
                        rec.status = 'failed';
                        rec.error = e?.message ?? String(e);
                    }
                })();
                return;
            }
            // 背景跑:直接 submit(daemon 無 idle VM 會自動開)→ wait 收 wavs
            // ckpt 重傳解法(見 REPORT-train-mgr-ckpt-reuse.md):先送輕量版(不上傳 ckpt,VM 端比對 md5),
            // VM 上已有同顆 → 直接推理;沒有 → fail fast(幾秒)→ 自動 fallback 完整版(順便部署,之後的 job 都走輕量)
            (async () => {
                const rec = inferJobs.get(localId);
                const md5Import = import(path.join(path.dirname(TRAIN_MGR_DIST), 'infer.js'));
                const buildManifest = async (spec) => {
                    const out = [];
                    for (const up of spec?.uploads ?? []) {
                        let sizeBytes = 0;
                        try { sizeBytes = (await fsp.stat(up.src)).size; } catch { /* 檔案消失 */ }
                        out.push({ name: path.basename(up.src), sizeBytes });
                    }
                    return out;
                };
                try {
                    const mgr = await getMgr();
                    const { Inferer } = await import(TRAIN_MGR_DIST);
                    const { INFER_CKPT_MISSING } = await md5Import;
                    const inferer = new Inferer({ repoRoot: await mgr.repoRoot() });
                    // 輕量版只在「模型已部署在 idle VM」時送(避免 fresh VM 上的假推理割裂);
                    // 否則直接完整版。fallback 仍是安全網(VM 記憶失準時兜底)。
                    const canReuse = await ckptDeployedOnIdleVm(ckptPath);
                    let res = await inferer.submit({ exp, dsPath, ckptPath, title, ...(canReuse ? { ckptReuse: true } : {}) });
                    rec.clusterJobId = res.jobId;
                    rec.status = 'running';
                    rec.uploads = await buildManifest(res.spec);
                    try {
                        const { wavs } = await inferer.wait(res.jobId);
                        rec.status = 'done';
                        rec.note = null;
                        rec.wavs = wavs;
                        memoCkptVm(ckptPath, res.jobId);
                    } catch (e) {
                        if (!String(e?.message ?? '').includes(INFER_CKPT_MISSING)) throw e;
                        // VM 上沒這顆(記憶失準/新 VM/換檔)→ fallback 完整版(部署,之後的 job 都走輕量)
                        rec.status = 'starting';
                        // note 留到 job 結束才清 — 讓使用者知道為什麼又出現一輪上傳
                        rec.note = 'VM 上沒有這顆模型,改送完整版(含模型上傳;部署完成後,同模型的合成就不會再重傳)';
                        // 計時器重設:已耗時/推論秒錶只算完整版這張,不要把輕量嘗試的時間算進來
                        rec.started = Date.now();
                        rec.runningSince = null;
                        res = await inferer.submit({ exp, dsPath, ckptPath, title });
                        rec.clusterJobId = res.jobId;
                        rec.status = 'running';
                        rec.uploads = await buildManifest(res.spec);
                        const { wavs } = await inferer.wait(res.jobId);
                        rec.status = 'done';
                        rec.note = null;
                        rec.wavs = wavs;
                        memoCkptVm(ckptPath, res.jobId);
                    }
                } catch (e) {
                    rec.status = 'failed';
                    rec.error = e?.message ?? String(e);
                }
            })();
        } catch (e) {
            res.status(isHttpErrorDetail(e) ? 400 : 500).json({ error: e?.message ?? String(e) });
        }
    });

    // ---- 暖機(環境預熱:開 VM + clone/patch + venv + vocoder,不上傳 ckpt、不跑 infer.py)----
    // 做法:沿用 Inferer.check/makeSpec 組出的 spec,砍掉 infer.py 段與大檔上傳,直接 Cluster.submit
    // → 之後的合成免等 VM 開機+環境準備(cold run ~2.5min 的部分),ckpt 反正沒 hash-skip 本來就會重傳
    router.post('/api/inference/warmup', express.json(), async (req, res) => {
        try {
            for (const [id, j] of inferJobs) {
                if (j.status === 'starting' || j.status === 'running') {
                    return res.status(409).json({ error: `已有推理/暖機進行中(job #${id}),等它完成再送` });
                }
            }
            const { ckptPath } = req.body ?? {};
            if (!ckptPath) return res.status(400).json({ error: '需要 ckptPath' });
            const m = String(ckptPath).match(/[\\/]checkpoints[\\/]([^\\/]+)[\\/]/);
            if (!m) return res.status(400).json({ error: `ckptPath 認不出 exp:${ckptPath}` });
            const exp = m[1];
            // 暖機不跑推論,但 Inferer.check 防呆要求 ds 檔存在 → 寫一個固定名的小 ds(不會被上傳/執行)
            const dsDir = path.join(os.homedir(), '.cache', 'train-mgr', 'infer');
            await fsp.mkdir(dsDir, { recursive: true });
            const dsPath = path.join(dsDir, 'warmup.ds');
            const f0 = Array(50).fill('261.6').join(' ');
            await fsp.writeFile(dsPath, JSON.stringify([{
                offset: 0, text: 'a', ph_seq: 'a', ph_dur: '0.5', note_seq: 'C4',
                note_dur: '0.5', is_slur: '0', f0_seq: f0, f0_timestep: '0.01', input_type: 'word',
            }]));
            const localId = inferSeq++;
            inferJobs.set(localId, {
                kind: 'warmup',
                status: 'starting', wavs: [], error: null,
                exp, ckptPath, clusterJobId: null, started: Date.now(),
            });
            res.json({ jobId: localId, exp });
            (async () => {
                const rec = inferJobs.get(localId);
                try {
                    const mgr = await getMgr();
                    const { Inferer, Cluster } = await import(TRAIN_MGR_DIST);
                    const inferer = new Inferer({ repoRoot: await mgr.repoRoot() });
                    const files = await inferer.check({ exp, dsPath, ckptPath });
                    const spec = await inferer.makeSpec({ exp, dsPath, ckptPath, outName: `warmup-${exp}` }, files);
                    spec.name = `warmup-${exp}-${Date.now().toString(16)}`;
                    // 不上傳大檔(ckpt/vocoder ckpt/ds)— 暖機只熱環境
                    spec.uploads = (spec.uploads ?? []).filter((u) =>
                        !/\.ckpt$/i.test(String(u.dest)) && !String(u.dest).endsWith('input.ds'));
                    // 砍掉 infer.py 段(cp ckpt 的指令一併拿掉,否則 set -e 會炸)
                    let cmd = String(spec.command)
                        .replace(/cp -f \/content\/in_upload\/\S+\.ckpt \S+; /g, '');
                    const cut = cmd.indexOf('COLUMNS=1000');
                    if (cut < 0) throw new Error('warmup: Inferer spec.command 格式不如預期(找不到 infer.py 段)');
                    spec.command = cmd.slice(0, cut) + 'echo "[warmup] environment ready"';
                    // spec 檔 + setup_uv.sh 旁檔(daemon 相對 spec 目錄解析 setup_file)
                    const specFile = path.join(dsDir, 'warmup-spec.json');
                    await fsp.writeFile(specFile, JSON.stringify(spec, null, 2));
                    const assetsDir = path.join(path.dirname(TRAIN_MGR_DIST), '..', 'assets');
                    await fsp.copyFile(path.join(assetsDir, 'setup_uv.sh'), path.join(dsDir, 'setup_uv.sh'));
                    // Cluster.submit 回傳「數字」(不是 {jobId})— 解構會變 undefined,clusterJobId 掉欄、wait 永遠等不到
                    const jobId = await new Cluster().submit(spec, { name: spec.name, specFile });
                    if (!Number.isInteger(jobId)) throw new Error(`warmup: submit 沒回 job id(拿到 ${JSON.stringify(jobId)})`);
                    rec.clusterJobId = jobId;
                    rec.status = 'running';
                    rec.uploads = [];
                    for (const up of spec.uploads) {
                        let sizeBytes = 0;
                        try { sizeBytes = (await fsp.stat(up.src)).size; } catch { /* 檔案消失 */ }
                        rec.uploads.push({ name: path.basename(up.src), sizeBytes });
                    }
                    // 等環境準備完成(不收 wav)
                    const deadline = Date.now() + 30 * 60_000;
                    for (;;) {
                        await new Promise((r) => setTimeout(r, 5000));
                        const rows = await mgr.cluster.list();
                        const row = rows.filter((r) => r.id === jobId).sort((a, b) => b.id - a.id)[0];
                        if (row) {
                            if (row.status === 'done') break;
                            if (row.status === 'failed') {
                                let detail = '';
                                try {
                                    const text = await fsp.readFile(mgr.cluster.logFile(jobId), 'utf8');
                                    const ls = text.split('\n').filter((l) => /Error|Exception/i.test(l));
                                    if (ls.length) detail = ls[ls.length - 1].trim().slice(0, 200);
                                } catch { /* no log */ }
                                throw new Error(`暖機 job ${jobId} 失敗${detail ? `: ${detail}` : ''}`);
                            }
                        }
                        if (Date.now() > deadline) throw new Error(`暖機逾時(job ${jobId})`);
                    }
                    rec.status = 'done';
                } catch (e) {
                    rec.status = 'failed';
                    rec.error = e?.message ?? String(e);
                }
            })();
        } catch (e) {
            res.status(isHttpErrorDetail(e) ? 400 : 500).json({ error: e?.message ?? String(e) });
        }
    });

    // ---- job 清單(新→舊,最近 20 筆)----
    router.get('/api/inference/jobs', (req, res) => {
        const ids = [...inferJobs.keys()].sort((a, b) => b - a).slice(0, 20);
        res.json({ jobs: ids.map(publicJob) });
    });

    router.get('/api/inference/jobs/:id', async (req, res) => {
        const rec = inferJobs.get(Number(req.params.id));
        const j = publicJob(Number(req.params.id));
        if (!j) return res.status(404).json({ error: 'job 不存在(後端可能重啟過)' });
        // peek cluster job 狀態+progress 行(infer.py 的 | Model 進度條)
        let clusterStatus = null;
        let clusterProgress = null;
        if (j.clusterJobId != null && (j.status === 'running' || j.status === 'starting')) {
            try {
                const mgr = await getMgr();
                const row = (await mgr.cluster.list()).find((r) => r.id === j.clusterJobId);
                clusterStatus = row?.status ?? null;
                clusterProgress = row?.progress ?? null;
            } catch { /* daemon 沒起來,略過 */ }
        }
        if (clusterStatus === 'running' && !rec.runningSince) rec.runningSince = Date.now();
        const uploadPhase = j.clusterJobId != null
            ? await uploadPhaseFor(j.clusterJobId, rec, clusterStatus) : null;
        const wavFetch = j.clusterJobId != null ? await wavFetchFor(j.clusterJobId) : null;
        // shell 尾行:daemon 持續鏡像 running 中 job 的 shell 輸出到本地 log,
        // 抓最後一行(剝 \r 進度段與 ANSI)給前端放在狀態列旁 — 準備環境/推理時的即時訊號
        let shellTail = null;
        if (j.clusterJobId != null && j.status === 'running') {
            try {
                const logPath = path.join(MIRROR_LOG_DIR, `job-${j.clusterJobId}.log`);
                const st = await fsp.stat(logPath);
                const len = Math.min(st.size, 4096);
                const fh = await fsp.open(logPath, 'r');
                const buf = Buffer.alloc(len);
                await fh.read(buf, 0, len, st.size - len);
                await fh.close();
                const lastLine = buf.toString('utf8').split('\n').filter((l) => l.trim()).pop() ?? '';
                shellTail = lastLine.split('\r').pop()
                    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
                    .trim().slice(-100) || null;
            } catch { /* 鏡像 log 還沒出來 */ }
        }
        // 本機引擎:tail 已由 runner onTick 更新在 rec,直接帶上
        if (shellTail == null && activeEngineOf(j) === 'local') shellTail = rec?.logTail ?? null;
        res.json({ ...j, clusterStatus, clusterProgress, uploadPhase, wavFetch, shellTail });
    });

    // ---- wav 串流(audio player 用)----
    router.get('/api/inference/jobs/:id/wav/:idx', async (req, res) => {
        const j = inferJobs.get(Number(req.params.id));
        if (!j) return res.status(404).send('job 不存在');
        const i = Number(req.params.idx);
        if (!Number.isInteger(i) || i < 0 || i >= j.wavs.length) return res.status(404).send('wav 不存在');
        try {
            await fsp.access(j.wavs[i]);
            // dotfiles:'allow' — 路徑含 ~/.cache dotfile 目錄,send 預設 ignore 會 404
            res.sendFile(j.wavs[i], { dotfiles: 'allow' });
        } catch {
            res.status(404).send('wav 檔案已遺失');
        }
    });

    // ---- VM 待命狀態(送推理前先看;idle 的 VM 才接 infer job)----
    router.get('/api/inference/vm', async (req, res) => {
        try {
            const mgr = await getMgr();
            const { idle, busy } = await mgr.vmStandby();
            res.json({ idle, busy });
        } catch (e) {
            res.status(isHttpErrorDetail(e) ? 400 : 500).json({ error: e?.message ?? String(e) });
        }
    });

    return router;
};
