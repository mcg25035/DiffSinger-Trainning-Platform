// 本機(CPU)推論 client — 對常駐服務容器(diffsinger-local-infer,127.0.0.1:8791)
// 服務由 local-infer/run-service.sh 一次性啟動(--restart unless-stopped),之後不再需要 docker-gate auth。
// 容器掛載:repoRoot(ro:checkpoints+artifacts)、~/.cache/train-mgr/infer(rw:job dir/wavs)
// 進度:輪詢 GET /jobs/<dir>(解析已在容器端做:tqdm infer segments/sample time step)
const http = require('http');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.DIFFSINGER_LOCAL_PORT || 8791);
const JOBS_ROOT = path.join(os.homedir(), '.cache', 'train-mgr', 'infer');

function request(method, urlPath, body, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const data = body != null ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1', port: PORT, method, path: urlPath,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
            timeout: timeoutMs,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => {
                let j = null;
                try { j = JSON.parse(buf); } catch { /* 非 JSON */ }
                if (res.statusCode >= 400) return reject(new Error((j && j.error) || `HTTP ${res.statusCode}`));
                resolve(j);
            });
        });
        req.on('timeout', () => { req.destroy(new Error(`本機推論服務逾時(${method} ${urlPath})`)); });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function serviceAvailable() {
    try {
        const j = await request('GET', '/health', null, 3000);
        return !!(j && j.ok);
    } catch {
        return false;
    }
}

function notRunningError(context) {
    return new Error(
        `本機推論服務沒有在跑(${context})— 到 local-infer/ 執行「./run-service.sh start」啟動(需要一次 docker-gate auth,之後常駐)`
    );
}

/**
 * 送一張本機推論到常駐服務。回傳 { wavs:[絕對路徑], logFile, stageDir }。
 * onTick({ phase:'starting'|'running', progress, logTail }) — 進度回報(輪詢 1s)
 */
async function runLocalInfer({ localId, exp, dsPath, ckptPath, title, steps, onTick }) {
    const pid = process.pid;
    const dir = `local-job-${Date.now()}-${pid}`;
    // ds 內容直接給服務(容器端寫檔);ckpt 給 basename(容器從掛載的 checkpoints/ 找)
    const ds = JSON.parse(await (await import('node:fs/promises')).readFile(dsPath, 'utf8'));
    const ckptName = path.basename(ckptPath);
    onTick?.({ phase: 'starting', progress: null, logTail: null });
    try {
        await request('POST', '/run', { dir, exp, ckpt: ckptName, ds, title, steps });
    } catch (e) {
        if (!(await serviceAvailable())) throw notRunningError('送出時服務無回應');
        throw e;
    }
    const logFile = path.join(JOBS_ROOT, dir, 'run.log');
    const outDir = path.join(JOBS_ROOT, dir, 'out');
    // 輪詢直到 done/failed(上限 30 分鐘)
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        let j;
        try {
            j = await request('GET', `/jobs/${dir}`, null, 5000);
        } catch (e) {
            if (Date.now() > deadline) throw new Error(`本機推論輪詢失敗:${e.message}`);
            continue; // 瞬斷重試
        }
        if (j.progress != null || j.logTail) {
            onTick?.({ phase: 'running', progress: j.progress, logTail: j.logTail });
        }
        if (j.status === 'done') {
            const fsp = await import('node:fs/promises');
            const names = (j.wavs ?? []).filter((n) => n.endsWith('.wav')).sort();
            if (!names.length) throw new Error(`本機推論完成但沒有 wav(dir: ${dir})`);
            return { wavs: names.map((n) => path.join(outDir, n)), logFile, stageDir: path.join(JOBS_ROOT, dir) };
        }
        if (j.status === 'failed') throw new Error(`本機推論失敗${j.error ? `: ${j.error}` : ''}(log: ${logFile})`);
        if (Date.now() > deadline) throw new Error(`本機推論逾時(30 分鐘,job dir: ${dir})`);
    }
}

module.exports = { runLocalInfer, serviceAvailable, notRunningError, PORT };
