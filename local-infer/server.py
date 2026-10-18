#!/usr/bin/env python3
"""本機推論常駐服務(容器內)。
掛載:/repo-root(= host ~/.cache/train-mgr/diffsinger,ro:checkpoints+artifacts)、/jobs(= host ~/.cache/train-mgr/infer,rw)
API:
  GET  /health              → {ok:true, busy:bool}
  POST /run {dir, exp, ckpt?, ds, title?, steps?} → 202 {ok, dir}(背景跑;busy 時 409)
  GET  /jobs/<dir>          → {status:running|done|failed, progress, logTail, error, wavs:[檔名]}
單一推論同時只跑一張(CPU 本來就一張);stage 邏輯與雲端 VM command 同構:
exp 小檔(config.yaml/spk_map/lang_map/dictionary-default.txt)← checkpoints/<exp>/;
train.yaml 生成 config ← artifacts 最新日期/<exp>/train.yaml(set_hparams 寫 expDir/config.yaml);
ckpt 保留原檔名(load_ckpt 找 model_ckpt_steps_*.ckpt)。wavs 寫 /jobs/<dir>/out/。
"""
import json
import os
import re
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_ROOT = '/repo-root'
JOBS_ROOT = '/jobs'
WORK_DIR = '/work/DiffSinger'
OUT_NAME = 'out'
LOG_NAME = 'run.log'

_lock = threading.Lock()
_jobs = {}   # dir → {status, progress, logTail, error, wavs, proc}
_busy = {'flag': False}


def find_train_yaml(exp):
    art = os.path.join(REPO_ROOT, 'artifacts')
    try:
        for d in sorted(os.listdir(art), reverse=True):
            p = os.path.join(art, d, exp, 'train.yaml')
            if os.path.isfile(p):
                return p
    except OSError:
        pass
    return None


def newest_ckpt(exp_dir, named=None):
    if named:
        p = os.path.join(exp_dir, named)
        if os.path.isfile(p):
            return p
    cands = [f for f in os.listdir(exp_dir) if re.fullmatch(r'model_ckpt_steps_\d+\.ckpt', f)] if os.path.isdir(exp_dir) else []
    if not cands:
        return None
    cands.sort(key=lambda f: os.path.getmtime(os.path.join(exp_dir, f)), reverse=True)
    return os.path.join(exp_dir, cands[0])


def tail_of(text, limit=200):
    lines = [l.strip() for l in re.split(r'[\r\n]+', text) if l.strip()]
    for l in reversed(lines):
        if re.search(r'Error|Exception|AssertionError', l, re.I):
            return l[:limit]
    return (lines[-1][:limit] if lines else None)


def parse_progress(line):
    seg = re.search(r'infer segments[^%]*?(\d+(?:\.\d+)?)%', line)
    if seg:
        return min(100, round(float(seg.group(1))))
    step = re.search(r'sample time step[^%]*?(\d+(?:\.\d+)?)%', line)
    if step:
        return min(100, round(float(step.group(1))))
    return None


def run_job(dir_name, exp, ckpt_name, ds, title, steps):
    rec = _jobs[dir_name]
    log_path = os.path.join(JOBS_ROOT, dir_name, LOG_NAME)
    try:
        # ---- stage(與雲端 VM command 同構)----
        exp_dir_src = os.path.join(REPO_ROOT, 'checkpoints', exp)
        exp_dir = os.path.join(WORK_DIR, 'checkpoints', exp)
        out_dir = os.path.join(JOBS_ROOT, dir_name, OUT_NAME)
        os.makedirs(exp_dir, exist_ok=True)
        os.makedirs(out_dir, exist_ok=True)
        ckpt = newest_ckpt(exp_dir_src, ckpt_name)
        if not ckpt:
            raise RuntimeError(f'checkpoint not found: {exp_dir_src}/{ckpt_name or "model_ckpt_steps_*.ckpt"}')
        shutil.copy2(ckpt, os.path.join(exp_dir, os.path.basename(ckpt)))
        for f in ('config.yaml', 'spk_map.json', 'lang_map.json', 'dictionary-default.txt'):
            src = os.path.join(exp_dir_src, f)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(exp_dir, f))
        with open(os.path.join(JOBS_ROOT, dir_name, 'input.ds'), 'w', encoding='utf-8') as fh:
            json.dump(ds, fh, ensure_ascii=False)
        train_yaml = find_train_yaml(exp)
        if train_yaml:
            stage_train = os.path.join(JOBS_ROOT, dir_name, 'train.yaml')
            shutil.copy2(train_yaml, stage_train)
            # dictionary 在 train.yaml 旁 → 同 VM 上傳語意放進 exp dir(dictionary-default.txt)
            dict_src = os.path.join(os.path.dirname(train_yaml), 'dictionary.txt')
            if os.path.isfile(dict_src):
                shutil.copy2(dict_src, os.path.join(exp_dir, 'dictionary-default.txt'))
        if not os.path.isfile(os.path.join(exp_dir, 'config.yaml')) and not train_yaml:
            raise RuntimeError(f'no config.yaml in {exp_dir_src} and no artifacts train.yaml for {exp}')

        # ---- config 生成(train.yaml 路徑指 stage 位置)----
        if not os.path.isfile(os.path.join(exp_dir, 'config.yaml')):
            gen = (f"import sys; sys.argv=['x','--config','{os.path.join(JOBS_ROOT, dir_name, 'train.yaml')}',"
                   f"'--exp_name','{exp}']; from utils.hparams import set_hparams; set_hparams()")
            r = subprocess.run(['python', '-c', gen], cwd=WORK_DIR, capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                raise RuntimeError(f'set_hparams failed: {tail_of(r.stdout + r.stderr)}')

        # ---- 跑推論(串流解析進度)----
        cmd = ['python', 'scripts/infer.py', 'acoustic', os.path.join(JOBS_ROOT, dir_name, 'input.ds'),
               '--exp', exp, '--out', out_dir]
        if steps:
            cmd += ['--ckpt', str(steps)]
        if title:
            cmd += ['--title', title]
        env = dict(os.environ, COLUMNS='1000', PYTHONUNBUFFERED='1')
        with open(log_path, 'w', encoding='utf-8', buffering=1) as logf:
            proc = subprocess.Popen(cmd, cwd=WORK_DIR, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1)
            rec['proc'] = proc
            for line in proc.stdout:
                logf.write(line)
                l = line.strip()
                if not l:
                    continue
                p = parse_progress(l)
                if p is not None:
                    rec['progress'] = p
                rec['logTail'] = tail_of(l) or rec.get('logTail')
            rc = proc.wait()
        if rc != 0:
            err = ''
            try:
                with open(log_path, encoding='utf-8') as fh:
                    err = tail_of(fh.read(), 300) or ''
            except OSError:
                pass
            raise RuntimeError(f'infer.py rc={rc}' + (f': {err}' if err else ''))
        wavs = sorted(f for f in os.listdir(out_dir) if f.endswith('.wav'))
        if not wavs:
            raise RuntimeError(f'no wav in {out_dir}')
        rec['wavs'] = wavs
        rec['status'] = 'done'
        rec['progress'] = 100
    except Exception as e:  # noqa: BLE001 — 全部轉成 job 失敗
        rec['status'] = 'failed'
        rec['error'] = str(e)
        rec['logTail'] = str(e)[:300]
    finally:
        rec.pop('proc', None)
        _busy['flag'] = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # 安靜
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {'ok': True, 'busy': _busy['flag'], 'jobs': len(_jobs)})
        m = re.fullmatch(r'/jobs/([A-Za-z0-9._-]+)', self.path)
        if m:
            rec = _jobs.get(m.group(1))
            if rec is None:
                return self._json(404, {'error': 'job not found(容器可能重啟過)'})
            return self._json(200, {k: rec.get(k) for k in ('status', 'progress', 'logTail', 'error', 'wavs')})
        return self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/run':
            return self._json(404, {'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception as e:  # noqa: BLE001
            return self._json(400, {'error': f'bad json: {e}'})
        dir_name = str(body.get('dir') or '')
        exp = str(body.get('exp') or '')
        ds = body.get('ds')
        if not re.fullmatch(r'[A-Za-z0-9._-]+', dir_name) or not exp or not isinstance(ds, (list, dict)):
            return self._json(400, {'error': '需要 dir(安全字元)/exp/ds'})
        if _busy['flag']:
            return self._json(409, {'error': '本機推論忙碌中,等當前 job 完成'})
        if os.path.isdir(os.path.join(JOBS_ROOT, dir_name)):
            return self._json(400, {'error': f'job dir 已存在: {dir_name}'})
        os.makedirs(os.path.join(JOBS_ROOT, dir_name), exist_ok=True)
        _busy['flag'] = True
        _jobs[dir_name] = {'status': 'running', 'progress': None, 'logTail': None,
                           'error': None, 'wavs': []}
        threading.Thread(target=run_job, daemon=True,
                         args=(dir_name, exp, body.get('ckpt'), ds, body.get('title'), body.get('steps'))).start()
        return self._json(202, {'ok': True, 'dir': dir_name})


if __name__ == '__main__':
    os.makedirs(JOBS_ROOT, exist_ok=True)
    print(f'local-infer service listening :8791 (repo={REPO_ROOT} jobs={JOBS_ROOT})', flush=True)
    ThreadingHTTPServer(('0.0.0.0', 8791), Handler).serve_forever()
