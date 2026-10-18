import { useCallback, useEffect, useRef, useState } from 'react';
import type { Recording } from '../hooks/useAudioMonitor';

// ─── train-mgr(Colab 多帳號)整合:帳號管理 → prepare → submit → watcher → 收 ckpt ───

interface Account {
  email: string;
  name?: string;
  tier?: string;
  ccuRemaining?: number;
  ccuRefillAt?: string;
  expired: boolean;
  consumptionRateHourly?: number;
}

interface PrepJob {
  id: string;
  name: string;
  files: number;
  skipped: number;
  status: 'submitting' | 'waiting' | 'done' | 'error';
  exp: string | null;
  items?: number;
  phonemes?: number;
  error?: string | null;
  startedAt: number;
}

interface ClusterJob {
  id: number;
  status: string;
  progress: number | null;
  total?: number;
  name: string;
  account: string;
  endpoint: string;
  note?: string;
}

interface TickSummary {
  done: string[];
  active: string[];
  retryable: string[];
  permafail: string[];
  missing: string[];
  actions: string[];
  allDone: boolean;
  at?: number;
  error?: string;
}

interface ModelCkpt {
  file: string;
  name: string;
  sizeBytes: number;
  mtime: number;
}

interface TrainedModel {
  exp: string;
  ckpts: ModelCkpt[];
  latest: ModelCkpt;
}

interface TrainState {
  repoRoot: string | null;
  repoReady: boolean | null;
  prepJobs: PrepJob[];
  jobs: ClusterJob[];
  watch: { running: boolean } | null;
  lastTick: TickSummary | null;
}

const PREP_LABEL: Record<PrepJob['status'], string> = {
  submitting: '打包上傳中',
  waiting: 'VM 準備中…',
  done: '完成',
  error: '失敗',
};

const PREP_COLOR: Record<PrepJob['status'], string> = {
  submitting: '#eab308',
  waiting: '#eab308',
  done: '#22c55e',
  error: '#ef4444',
};

const JOB_COLOR: Record<string, string> = {
  queued: '#eab308',
  provisioning: '#eab308',
  dispatching: '#eab308',
  running: '#3b82f6',
  done: '#22c55e',
  failed: '#ef4444',
  cancelled: '#ef4444',
};

const JOB_LABEL: Record<string, string> = {
  queued: '排隊中',
  provisioning: '開 VM 中',
  dispatching: '派送中',
  running: '訓練中',
  done: '完成',
  failed: '失敗',
  cancelled: '已取消',
};

const panelStyle: React.CSSProperties = {
  background: '#0f0f0f',
  borderRadius: '28px',
  border: '1px solid #333',
  padding: '24px',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflowY: 'auto',
};

function btnStyle(bg: string, disabled = false): React.CSSProperties {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 14px',
    fontSize: '13px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap',
  };
}

const badge = (color: string, text: string) => (
  <span style={{
    fontSize: '11px',
    padding: '2px 8px',
    borderRadius: '999px',
    background: color + '22',
    color,
    border: `1px solid ${color}55`,
    whiteSpace: 'nowrap',
  }}>{text}</span>
);

interface Props {
  recordings?: Recording[];
}

export function TrainingManager({ recordings }: Props) {
  const files = recordings && recordings.length > 0 ? recordings.map((r) => r.filename) : [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [datasetName, setDatasetName] = useState('');
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [totalCcu, setCcuTotal] = useState(0);
  const [state, setState] = useState<TrainState | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [logView, setLogView] = useState<{ id: number; text: string } | null>(null);
  const [hiddenJobs, setHiddenJobs] = useState<Set<number>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('train-hidden-jobs') ?? '[]')); }
    catch { return new Set(); }
  });
  const [destroying, setDestroying] = useState(false);
  const [models, setModels] = useState<TrainedModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshAccounts = useCallback(async (force = false) => {
    try {
      const r = await fetch(`/api/train/accounts${force ? '?force=1' : ''}`);
      const j = await r.json();
      if (j.accounts) { setAccounts(j.accounts); setCcuTotal(j.totalCcu ?? 0); }
    } catch { /* backend 未就緒 */ }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const r = await fetch('/api/train/state');
      const j: TrainState = await r.json();
      setState(j);
    } catch { /* backend 未就緒 */ }
    try {
      const r = await fetch('/api/train/models');
      const j = await r.json();
      if (j.models) setModels(j.models);
    } catch { /* backend 未就緒 */ }
  }, []);

  useEffect(() => {
    refreshAccounts();
    refreshState();
    const t = setInterval(refreshState, 5000);
    return () => clearInterval(t);
  }, [refreshAccounts, refreshState]);

  const toggle = (f: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === files.length ? new Set() : new Set(files)));
  };

  const startLogin = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/train/auth/login', { method: 'POST' });
      const j = await r.json();
      if (j.url) {
        setLoginUrl(j.url);
        window.open(j.url, '_blank');
        void waitAndRefresh();
      } else {
        alert(`登入失敗:${j.error ?? '?'}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const waitAndRefresh = async (email?: string) => {
    try {
      if (email) await fetch(`/api/train/auth/wait/${encodeURIComponent(email)}`);
      else await new Promise((r) => setTimeout(r, 30_000));
    } catch { /* timeout */ }
    await refreshAccounts(true);
    setLoginUrl(null);
  };

  const switchAccount = async (email: string) => {
    setBusy(true);
    try {
      await fetch('/api/train/auth/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      await refreshAccounts(true);
    } finally {
      setBusy(false);
    }
  };

  const logoutAccount = async (email: string) => {
    if (!confirm(`確定登出並撤銷 ${email} 的 token?`)) return;
    setBusy(true);
    try {
      await fetch('/api/train/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      await refreshAccounts(true);
    } finally {
      setBusy(false);
    }
  };

  const startPrepare = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/train/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: datasetName.trim() || 'dataset', files: [...selected] }),
      });
      const j = await r.json();
      if (!r.ok) { alert(`prepare 失敗:${j.error ?? '?'}`); return; }
      setSelected(new Set());
      setDatasetName('');
      refreshState();
    } finally {
      setBusy(false);
    }
  };

  const submitTraining = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/train/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) { alert(`submit 失敗:${j.error ?? '?'}`); return; }
      refreshState();
    } finally {
      setBusy(false);
    }
  };

  const stopWatch = async () => {
    await fetch('/api/train/watch/stop', { method: 'POST' });
    refreshState();
  };

  const destroyVms = async () => {
    if (!confirm('確定關掉所有帳號的 VM?(idle 也燒 CCU)')) return;
    setDestroying(true);
    try {
      const r = await fetch('/api/train/vm/destroy', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) {
        alert(`無法關閉:${j.error ?? '?'}`);
      } else {
        alert(j.destroyed?.length ? `已關閉 ${j.destroyed.length} 台 VM` : '沒有活著的 VM');
      }
      await refreshAccounts(true);
      refreshState();
    } finally {
      setDestroying(false);
    }
  };

  const cancelJob = async (id: number) => {
    if (!confirm(`確定取消 job ${id}?`)) return;
    await fetch(`/api/train/jobs/${id}/cancel`, { method: 'POST' });
    setTimeout(refreshState, 2000);
  };

  // 死亡 job(完成/失敗/取消)的隱藏:cluster list 是永久歷史(沒有 delete 指令),
  // 後端刪不掉 → 前端本地隱藏(localStorage 記住)。TODO: 之後叫別的 agent 補 colab 端清除
  const dismissJob = (id: number) => {
    setHiddenJobs(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem('train-hidden-jobs', JSON.stringify([...next]));
      return next;
    });
  };

  const showLog = async (id: number) => {
    setLogView({ id, text: '載入中…' });
    try {
      const r = await fetch(`/api/train/jobs/${id}/log`);
      setLogView({ id, text: await r.text() });
    } catch (e) {
      setLogView({ id, text: String(e) });
    }
  };

  const prepJobs = state?.prepJobs ?? [];
  const clusterJobs = (state?.jobs ?? [])
    .filter(j => !hiddenJobs.has(j.id))
    .slice()
    .sort((a, b) => b.id - a.id);
  const donePreps = prepJobs.filter((j) => j.status === 'done');
  const tick = state?.lastTick;

  // 防呆:Colab 帳號載入中 或 關 VM 進行中 → 其他板塊灰掉不給按
  const loading = accounts === null;
  const guarded = (style: React.CSSProperties): React.CSSProperties =>
    (loading || destroying) ? { ...style, opacity: 0.35, pointerEvents: 'none' } : style;

  return (
    <div style={{ display: 'flex', gap: '24px', height: '100%', minHeight: 0 }}>
      {/* 左:帳號管理 + 訓練音檔 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0 }}>
        {/* 帳號 / CCU */}
        <div style={{ ...panelStyle, flex: 1, position: 'relative' }}>
          {loading && <div className="coltrain-shimmer-overlay" />}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h2 style={{ margin: 0, fontSize: '18px' }}>Colab 帳號</h2>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {badge('#3b82f6', `總 CCU ${totalCcu.toFixed(1)}`)}
              <button onClick={startLogin} disabled={busy || loading || destroying} style={btnStyle('#2563eb', busy || loading || destroying)}>+ 登入新帳號</button>
              <button onClick={() => refreshAccounts(true)} disabled={loading || destroying} style={btnStyle('#333', loading || destroying)}>↻</button>
            </div>
          </div>
          {loginUrl && (
            <div style={{
              background: '#1a2a1a', border: '1px solid #22c55e55', borderRadius: '8px',
              padding: '8px 12px', marginBottom: '8px', fontSize: '12px', color: '#22c55e',
            }}>
              <a href={loginUrl} target="_blank" rel="noreferrer" style={{ color: '#22c55e' }}>點此完成 Google 登入</a>
              {' '}(瀏覽器授權後自動註冊)
            </div>
          )}
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 10px' }}>
              <div style={{
                width: 20, height: 20, border: '3px solid #2a2a2a',
                borderTopColor: '#93c5fd', borderRightColor: '#60a5fa', borderRadius: '50%',
                animation: 'spin 0.8s linear infinite', flexShrink: 0,
              }} />
              <span style={{ fontSize: '16px', color: '#93c5fd', fontWeight: 700, textShadow: '0 0 12px rgba(96,165,250,0.5)' }}>Colab 帳號載入中…</span>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {accounts !== null && accounts.length === 0 && <p style={{ color: '#666', fontSize: '13px' }}>尚無帳號。按「+ 登入新帳號」用 Google OAuth 登入。</p>}
            {(accounts ?? []).map((a) => (
              <div key={a.email} style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '6px 10px', borderRadius: '8px', marginBottom: '3px',
                background: a.expired ? '#2a1515' : 'transparent',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.email}{a.tier ? ` · ${a.tier}` : ''}
                  </div>
                </div>
                {a.expired ? badge('#ef4444', '憑證過期') : badge('#22c55e', `CCU ${a.ccuRemaining?.toFixed(1) ?? '?'}`)}
                <button onClick={() => switchAccount(a.email)} disabled={busy} style={{ ...btnStyle('#333'), padding: '4px 8px', fontSize: '11px' }}>切換</button>
                <button onClick={() => logoutAccount(a.email)} disabled={busy} style={{ ...btnStyle('#333'), padding: '4px 8px', fontSize: '11px' }}>登出</button>
              </div>
            ))}
          </div>
        </div>

        {/* 訓練音檔 */}
        <div style={guarded({ ...panelStyle, flex: 1 })}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h2 style={{ margin: 0, fontSize: '18px' }}>選擇訓練音檔</h2>
            {files.length > 0 && (
              <button onClick={toggleAll} style={btnStyle('#333')}>
                {selected.size === files.length ? '取消全選' : '全選'}
              </button>
            )}
          </div>
          {files.length === 0 && (
            <p style={{ color: '#666', fontSize: '13px' }}>尚無已確認(.checked)的訓練段。到對齊處理完成審核後會出現在這裡。</p>
          )}
          <div style={{ flex: 1, overflowY: 'auto', marginBottom: '12px' }}>
            {files.map((f) => (
              <label key={f} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '8px 12px', borderRadius: '8px',
                background: selected.has(f) ? '#1a2a1a' : 'transparent',
                cursor: 'pointer', marginBottom: '4px',
              }}>
                <input type="checkbox" checked={selected.has(f)} onChange={() => toggle(f)} />
                <span style={{ fontSize: '13px', color: '#ddd' }}>{f}</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <input
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              placeholder="資料集名稱(如 cheesege-cantabile-30m)"
              style={{
                flex: 1, background: '#1a1a1a', border: '1px solid #444',
                borderRadius: '8px', color: '#fff', padding: '8px 12px', fontSize: '13px',
              }}
            />
            <button onClick={startPrepare} disabled={selected.size === 0 || busy} style={btnStyle(selected.size === 0 || busy ? '#333' : '#2563eb', selected.size === 0 || busy)}>
              ① prepare ({selected.size})
            </button>
          </div>
        </div>
      </div>

      {/* 右:prepare 狀態 + 訓練任務 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0 }}>
        {/* prepare jobs */}
        {prepJobs.length > 0 && (
          <div style={guarded({ ...panelStyle, flexShrink: 0, maxHeight: '35%' })}>
            <h2 style={{ margin: '0 0 12px', fontSize: '18px' }}>資料準備</h2>
            {prepJobs.map((j) => (
              <div key={j.id} style={{
                background: '#161616', border: '1px solid #2a2a2a',
                borderRadius: '12px', padding: '12px 16px', marginBottom: '8px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: '14px' }}>{j.name}</strong>
                  {badge(PREP_COLOR[j.status], PREP_LABEL[j.status])}
                </div>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '6px' }}>
                  {j.files} 個檔案{j.skipped ? ` · ${j.skipped} 缺 lab` : ''}
                  {j.status === 'done' && j.exp ? ` · exp: ${j.exp} · ${j.items} items / ${j.phonemes} phonemes` : ''}
                  {new Date(j.startedAt).toLocaleTimeString()}
                </div>
                {j.status === 'error' && <div style={{ fontSize: '12px', color: '#ef4444', marginTop: '4px' }}>{j.error}</div>}
              </div>
            ))}
          </div>
        )}

        {/* 訓練任務 */}
        <div style={loading ? guarded({ ...panelStyle, flex: 1 }) : { ...panelStyle, flex: 1, position: 'relative' }}>
          {destroying && <div className="coltrain-shimmer-overlay" />}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h2 style={{ margin: 0, fontSize: '18px' }}>訓練任務</h2>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {state?.watch?.running && badge('#3b82f6', 'watcher 運行中')}
              {state?.watch?.running && <button onClick={stopWatch} style={btnStyle('#333')}>停止 watcher</button>}
              <button onClick={submitTraining} disabled={donePreps.length === 0 || busy} style={btnStyle(donePreps.length === 0 || busy ? '#333' : '#2563eb', donePreps.length === 0 || busy)}>
                ② 開始訓練
              </button>
              <button onClick={destroyVms} disabled={busy || destroying} style={btnStyle('#333', busy || destroying)}>收工關 VM</button>
            </div>
          </div>
          {destroying && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 10px' }}>
              <div style={{
                width: 20, height: 20, border: '3px solid #2a2a2a',
                borderTopColor: '#f87171', borderRightColor: '#fca5a5', borderRadius: '50%',
                animation: 'spin 0.8s linear infinite', flexShrink: 0,
              }} />
              <span style={{ fontSize: '16px', color: '#fca5a5', fontWeight: 700, textShadow: '0 0 12px rgba(248,113,113,0.5)' }}>關 VM 中…(可能要幾秒到幾分鐘)</span>
            </div>
          )}

          {tick?.error && (
            <div style={{ background: '#2a1515', border: '1px solid #ef444455', borderRadius: '8px', padding: '8px 12px', marginBottom: '8px', fontSize: '12px', color: '#ef4444' }}>
              {tick.error}
            </div>
          )}
          {tick && !tick.error && (
            <div style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
              done {tick.done.length} · active {tick.active.length} · 重丟 {tick.retryable.length} · 永久失敗 {tick.permafail.length}
              {tick.allDone && <span style={{ color: '#22c55e' }}> · 全部完成 ✓</span>}
              {tick.at && <span> · {new Date(tick.at).toLocaleTimeString()}</span>}
              {tick.actions.length > 0 && (
                <div style={{ marginTop: '4px', color: '#eab308' }}>
                  {tick.actions.slice(-3).map((a, i) => <div key={i}>→ {a}</div>)}
                </div>
              )}
            </div>
          )}

          {clusterJobs.length === 0 && (
            <p style={{ color: '#666', fontSize: '13px' }}>
              {state === null ? '載入中…' : '尚無訓練任務。prepare 完成後按「② 開始訓練」。'}
            </p>
          )}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {clusterJobs.map((job) => {
              const isPrep = job.name.startsWith('prep-');
              const statusKey = (job.status || '').split(/\s+/)[0];
              const total = job.total ?? 9000;
              const statusText = `${isPrep && (statusKey === 'running' || statusKey === 'provisioning' || statusKey === 'dispatching') ? '準備中' : (JOB_LABEL[statusKey] ?? job.status)}${job.progress != null ? ` step ${job.progress}/${total}` : ''}`;
              const dead = statusKey === 'done' || statusKey === 'failed' || statusKey === 'cancelled';
              return (
              <div key={job.id} style={{
                background: '#161616', border: '1px solid #2a2a2a',
                borderRadius: '12px', padding: '12px 16px', marginBottom: '10px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <strong style={{ fontSize: '14px' }}>{job.name}</strong>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {badge(JOB_COLOR[statusKey] ?? '#666', statusText)}
                    <button onClick={() => showLog(job.id)} style={{ ...btnStyle('#333'), padding: '3px 8px', fontSize: '11px' }}>log</button>
                    {dead
                      ? <button onClick={() => dismissJob(job.id)} title="隱藏(cluster 歷史刪不掉,前端本地隱藏)" style={{ ...btnStyle('#333'), padding: '3px 8px', fontSize: '11px' }}>✕</button>
                      : <button onClick={() => cancelJob(job.id)} style={{ ...btnStyle('#333'), padding: '3px 8px', fontSize: '11px' }}>取消</button>}
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: '#666' }}>
                  job {job.id} · {job.account} @ {job.endpoint}
                </div>
                {job.progress != null && (
                  <div style={{ background: '#222', borderRadius: '4px', height: '6px', overflow: 'hidden', marginTop: '8px' }}>
                    <div style={{
                      width: `${Math.min(100, (job.progress / total) * 100)}%`,
                      height: '100%',
                      background: JOB_COLOR[statusKey] ?? '#3b82f6',
                      transition: 'width 0.5s',
                    }} />
                  </div>
                )}
                {job.note && <div style={{ fontSize: '12px', color: JOB_COLOR[statusKey] ?? '#eab308', marginTop: '4px' }}>{job.note}</div>}
              </div>
              );
            })}
          </div>
        </div>

        {/* 已訓練模型 */}
        <div style={guarded({ ...panelStyle, flexShrink: 0, maxHeight: '32%' })}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h2 style={{ margin: 0, fontSize: '18px' }}>已訓練模型</h2>
            {models !== null && models.length > 0 && badge('#22c55e', `${models.length} 個 exp`)}
          </div>
          {models === null && <p style={{ color: '#666', fontSize: '13px' }}>載入中…</p>}
          {models !== null && models.length === 0 && (
            <p style={{ color: '#666', fontSize: '13px' }}>尚無模型。訓練完成 + watcher 收回 ckpt 後會出現在這裡。</p>
          )}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {(models ?? []).map((m) => (
              <div key={m.exp} style={{
                background: '#161616', border: '1px solid #2a2a2a',
                borderRadius: '12px', padding: '12px 16px', marginBottom: '8px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: '14px', color: '#22c55e' }}>{m.exp}</strong>
                  {badge('#22c55e', `${m.ckpts.length} 個 ckpt`)}
                </div>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '6px', fontFamily: 'monospace' }}>
                  {m.latest.name} · {(m.latest.sizeBytes / (1024 * 1024)).toFixed(0)} MiB · {new Date(m.latest.mtime).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* log 檢視 modal */}
      {logView && (
        <div onClick={() => setLogView(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: '#0f0f0f', border: '1px solid #333', borderRadius: '16px',
            width: '80%', maxWidth: '900px', maxHeight: '80%', display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #2a2a2a' }}>
              <strong style={{ fontSize: '14px' }}>job {logView.id} log</strong>
              <button onClick={() => setLogView(null)} style={btnStyle('#333')}>關閉</button>
            </div>
            <pre style={{ flex: 1, overflow: 'auto', margin: 0, padding: '12px 16px', fontSize: '12px', color: '#ccc', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {logView.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
