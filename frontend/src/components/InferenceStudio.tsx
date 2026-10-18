// 推理工作室 — Piano Roll 音符編輯器（移植自 svs-note-editor）+ ckpt 選擇 + 推理
// 後端:POST /api/inference/synthesize（背景跑）→ 輪詢 GET /api/inference/jobs/:id → wav 串流
// VM 前置:colab runtime create -a T4（手動）；無待命 VM 時 infer 等 180s 後報錯
import { useCallback, useEffect, useRef, useState } from 'react';
import NoteEditorApp from './note-editor/NoteEditorApp.jsx';
import { exportDS } from './note-editor/lib/project.js';

interface Ckpt { file: string; name: string; sizeBytes: number; mtime: number; }
interface ModelEntry { exp: string; ckpts: Ckpt[]; latest: Ckpt; }
interface DictEntry { id: string; name: string; phonemes?: string[]; mfa_model?: string; }
interface MappingEntry { id: string; model?: string; dictionary?: Record<string, string>; reverse_mapping?: Record<string, string> | null; }
interface UploadInfo { name: string; sizeBytes: number; }
interface UploadPhase { startedFiles: number; totalFiles: number; currentFile: string | null; completedFiles: number; completedBytes: number; totalBytes: number; booting: boolean; booted: boolean; }
interface InferJob {
  id: number;
  kind?: 'infer' | 'warmup' | null;
  engine?: 'cloud' | 'local' | null;
  status: 'starting' | 'running' | 'done' | 'failed';
  wavs: string[];
  error: string | null;
  note?: string | null;
  exp: string | null;
  clusterJobId: number | null;
  clusterStatus?: 'queued' | 'provisioning' | 'running' | 'done' | 'failed' | 'cancelled' | null;
  clusterProgress?: string | null;
  uploadPhase?: UploadPhase | null;
  wavFetch?: { count: number; bytes: number } | null;
  runningSince?: number | null;
  started?: number;
  uploads?: UploadInfo[] | null;
  shellTail?: string | null;
  progress?: number | null;
}

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${(b / 1024).toFixed(0)} KB`;

  const jobStatusText = (j: InferJob, now: number): string => {
    const warm = j.kind === 'warmup';
    const local = j.engine === 'local';
    if (j.status === 'starting') {
      if (local) return '本機推論…（stage 輸入 / 啟動容器）';
      return warm ? '暖機準備中…（驗證檔案 / 派工）' : '準備中…（驗證檔案 / 派工）';
    }
    if (j.status === 'running') {
      if (local) {
        const t = `本機推論中（CPU）${j.runningSince ? fmtDur(now - j.runningSince) : ''}`;
        return j.progress != null ? `${t} · ${j.progress}%` : t;
      }
      if (j.clusterStatus === 'running') {
        // 暖機:VM 開跑 = 在準備環境(clone/patch/venv/vocoder);推理:才叫推論中
        let t = warm
          ? `準備環境中 ${j.runningSince ? fmtDur(now - j.runningSince) : ''}（clone / venv / vocoder）`
          : `推論中 ${j.runningSince ? fmtDur(now - j.runningSince) : ''}`;
        if (!warm && j.wavFetch && j.wavFetch.count > 0) t += ` · 收 wav 中（${j.wavFetch.count} 檔 ${fmtSize(j.wavFetch.bytes)}）`;
        return t;
      }
      const up = j.uploadPhase;
      const elapsed = `已耗時 ${fmtDur(now - (j.started ?? now))}`;
      if (up && up.startedFiles > 0) {
        const pct = up.totalBytes > 0 ? Math.floor((up.completedBytes / up.totalBytes) * 100) : 0;
        return `上傳${warm ? '環境檔' : '模型'}中 ${pct}%（第 ${Math.min(up.startedFiles, up.totalFiles)}/${up.totalFiles} 檔：${up.currentFile ?? ''}）· ${elapsed}`;
      }
      if (up && up.booting && !up.booted) return `開機中…（VM 建立）· ${elapsed}`;
      return `排隊中…（等 VM 配對）· ${elapsed}`;
    }
    if (j.status === 'done') return warm ? '✓ 暖機完成（環境就緒，合成免等 VM 開機+環境準備）' : '✓ 合成完成';
    return warm ? '暖機失敗' : (local ? '本機推論失敗' : '推理失敗');
  };
  const engineOf = (j: InferJob | null): 'cloud' | 'local' =>
    j == null || j.kind === 'warmup' ? 'cloud' : (j.engine ?? 'cloud');

export function InferenceStudio() {
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dicts, setDicts] = useState<DictEntry[] | null>(null);
  const [dictIdx, setDictIdx] = useState(0);
  const [mappings, setMappings] = useState<MappingEntry[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const [engineOpen, setEngineOpen] = useState(false);
  const engineRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!engineOpen) return;
    const h = (e: MouseEvent) => { if (!engineRef.current?.contains(e.target as Node)) setEngineOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setEngineOpen(false); };
    window.addEventListener('mousedown', h, true);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h, true); window.removeEventListener('keydown', k); };
  }, [engineOpen]);
  useEffect(() => {
    if (!settingsOpen) return;
    const h = (e: MouseEvent) => { if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('mousedown', h, true);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h, true); window.removeEventListener('keydown', k); };
  }, [settingsOpen]);
  const [vm, setVm] = useState<{ idle: string[]; busy: string[] } | null>(null);
  const [job, setJob] = useState<InferJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [engine, setEngine] = useState<'cloud' | 'local'>('local');
  const [now, setNow] = useState(Date.now());
  const jobRef = useRef<number | null>(null);

  // 秒錶:job 進行中每秒跳(驅動已耗時/%)
  const jobActive = submitting || (job != null && (job.status === 'starting' || job.status === 'running'));
  useEffect(() => {
    if (!jobActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [jobActive]);

  useEffect(() => {
    fetch('/api/train/models')
      .then((r) => r.json())
      .then((d) => setModels(Array.isArray(d?.models) ? d.models : []))
      .catch(() => setModels([]));
    fetch('/api/dictionaries')
      .then((r) => r.json())
      .then((d) => setDicts(Array.isArray(d) ? d : []))
      .catch(() => setDicts([]));
    fetch('/api/mappings')
      .then((r) => r.json())
      .then((d) => setMappings(Array.isArray(d) ? d : []))
      .catch(() => setMappings([]));
    // 復原最近一次推理 job（頁面重整用）
    fetch('/api/inference/jobs')
      .then((r) => r.json())
      .then((d) => {
        const latest = d?.jobs?.[0];
        if (latest && latest.status !== 'failed') {
          jobRef.current = latest.id;
          setJob(latest);
        }
      })
      .catch(() => {});
  }, []);

  // 輪詢推理 job（starting/running 時 3s 一次；done/failed 停）
  useEffect(() => {
    const id = jobRef.current;
    if (id == null) return;
    if (job && (job.status === 'done' || job.status === 'failed')) return;
    let alive = true;
    let fails = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/inference/jobs/${id}`);
        if (r.ok) {
          const j: InferJob = await r.json();
          if (alive) setJob(j);
          if (alive && (j.status === 'starting' || j.status === 'running')) { setTimeout(tick, 3000); return; }
          return; // done/failed:setJob 會觸發 effect 重跑收尾
        }
      } catch { /* 瞬斷 — 繼續輪詢(原本 catch 不重排程,一次網路抖動就讓輪詢靜默死掉) */ }
      if (alive && ++fails < 60) { setTimeout(tick, 3000); return; }
      if (alive) setJob((cur) => (cur && cur.status !== 'done' ? { ...cur, status: 'failed', error: '輪詢中斷(後端可能重啟過,job 記錄消失)' } : cur));
    };
    const t = setTimeout(tick, 1000);
    return () => { alive = false; clearTimeout(t); };
  }, [job?.status, jobRef.current]);

  // VM 待命狀態（10s 一次）
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch('/api/inference/vm');
        if (r.ok && alive) setVm(await r.json());
      } catch { /* ignore */ }
    };
    tick();
    const t = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const projectRef = useRef<any>(null);
  const allCkpts: (Ckpt & { exp: string })[] =
    models?.flatMap((m) => m.ckpts.map((c) => ({ ...c, exp: m.exp }))) ?? [];
  const ckpt = allCkpts.find((c) => c.file === selectedKey) ?? allCkpts[0] ?? null;
  const dict = dicts?.[dictIdx] ?? null;
  // MFA mapping:選中辭典的 mfa_model 對到 mappings 的 model → phMap/phRev/音素清單(從 mapping 收集,同 Toolbar 匯入)
  const mapping = (dict?.mfa_model && mappings.find((m) => m.model === dict.mfa_model)) || null;
  const injected = mapping?.dictionary
    ? {
        phonemes: [...new Set(Object.values(mapping.dictionary).flatMap((v) => String(v).split(/\s+/).filter(Boolean)))],
        phMap: mapping.dictionary,
        phRev: mapping.reverse_mapping ?? null,
      }
    : { phonemes: dict?.phonemes ?? null, phMap: null, phRev: null };

  const submitJob = useCallback(async (endpoint: string, body: Record<string, unknown>) => {
    if (!ckpt || submitting) return;
    setSubmitting(true);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data: any = null;
      try { data = await resp.json(); } catch { /* 非 JSON（後端無此 route） */ }
      if (!resp.ok || !data?.jobId) {
        setJob({
          id: -1, status: 'failed', wavs: [],
          error: data?.error ?? `送出失敗 HTTP ${resp.status}`,
          exp: null, clusterJobId: null,
          engine: (body as any)?.engine === 'local' ? 'local' : null,
        });
      } else {
        jobRef.current = data.jobId;
        setJob({ id: data.jobId, status: 'starting', wavs: [], error: null, exp: data.exp ?? null, clusterJobId: null, engine: data.engine ?? null });
      }
    } catch (e: any) {
      setJob({ id: -1, status: 'failed', wavs: [], error: e?.message ?? String(e), exp: null, clusterJobId: null });
    } finally {
      setSubmitting(false);
    }
  }, [ckpt, submitting]);

  const runInference = useCallback(() => {
    if (!projectRef.current) return;
    const proj = projectRef.current;
    const ds = exportDS(proj);
    // 臨時 debug:送了什麼一清二楚(診斷「送出的 ds 沒照我的更新」;穩定後拆)
    const notesEnd = proj.notes.length ? Math.max(...proj.notes.map((n: any) => n.start + n.dur)) : 0;
    const dbg = {
      notes: proj.notes.length,
      notesEnd: Number(notesEnd.toFixed(2)),
      phCount: String(ds[0]?.ph_seq ?? '').trim().split(/\s+/).length,
      head: String(ds[0]?.text ?? '').split(/\s+/).slice(0, 12).join(' '),
      refIsLive: (window as any).__editorProject === undefined ? 'n/a' : (window as any).__editorProject === proj,
    };
    console.log('[Infer] 送出 ds:', JSON.stringify(dbg));
    console.log('[Infer] 音符明細:', proj.notes.map((n: any) => `${n.word}@${n.start.toFixed(2)}+${n.dur.toFixed(2)}`).join(' ') || '(無)');
    submitJob('/api/inference/synthesize', { checkpointId: ckpt?.file, ckptPath: ckpt?.file, ds, engine, dbg });
    setSubmitTick((v) => v + 1); // 通知編輯器拍樂句快照(wav 基準=送出當下狀態)
  }, [submitJob, ckpt, engine]);

  // 暖機:只準備環境(開 VM+clone/patch+venv+vocoder),不上傳 ckpt、不跑推論 → 之後合成免等環境
  const runWarmup = useCallback(() => {
    submitJob('/api/inference/warmup', { ckptPath: ckpt?.file });
  }, [submitJob, ckpt]);

  const [submitTick, setSubmitTick] = useState(0); // 每次送出合成 +1:編輯器據此拍「wav 基準」樂句快照

  return (
    <div style={{
      ...(fullscreen
        ? { position: 'fixed', inset: 0, zIndex: 2000, background: '#0f0f0f', padding: '12px', boxSizing: 'border-box' as const }
        : {}),
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }}>
      {/* 即時狀態列:壓縮成一行,放頂欄下、編輯器上 */}
      <div style={{
        background: '#101018',
        border: '1px solid #2a2a34',
        borderRadius: '10px',
        padding: '4px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexShrink: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        minHeight: '32px',
      }}>
        <span style={{
          fontSize: '12px', padding: '1px 9px', borderRadius: '10px', flexShrink: 0,
          background: vm && vm.idle.length > 0 ? '#1d3a2a' : '#3a2a1d',
          color: vm && vm.idle.length > 0 ? '#7fd89a' : '#d8b87f',
          border: `1px solid ${vm && vm.idle.length > 0 ? '#2e7d5b' : '#846a3a'}`,
        }}>
          VM {vm ? `${vm.idle.length} idle / ${vm.busy.length} busy` : '…'}
        </span>

        {job && job.id > 0 && (
          <span style={{ color: '#c9cede', fontSize: '13px', fontWeight: 600, flexShrink: 0 }}>
            job #{job.id}{job.engine === 'local' ? '（本機 CPU）' : job.clusterJobId != null ? `（cluster ${job.clusterJobId}）` : ''}
          </span>
        )}

        {job && job.status !== 'done' && (
          <span title={job.status === 'failed' ? job.error ?? '' : undefined}
            style={{
              color: job.status === 'failed' ? '#ff7a7a' : '#d5d9e6',
              fontSize: '13px',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}>
            {job.status === 'failed' ? `${jobStatusText(job, now)}：${job.error ?? ''}` : jobStatusText(job, now)}
          </span>
        )}
        {job && job.note && job.status === 'running' && (
          <span style={{ color: '#ecc98f', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{job.note}</span>
        )}
        {job && job.status === 'running' && !job.clusterProgress && job.shellTail && (
          <span title={job.engine === 'local' ? '本機容器輸出最後一行' : 'VM 端 shell 最後一行(3 秒更新)'}
            style={{ color: '#93a0b8', fontSize: '12px', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
            {job.shellTail}
          </span>
        )}
        {job && job.status === 'done' && job.kind === 'warmup' && (
          <span style={{ color: '#8fe0a0', fontSize: '13px', fontWeight: 600 }}>{jobStatusText(job, now)}</span>
        )}
        {job && job.status === 'running' && job.clusterProgress && (
          <span style={{ color: '#7ab8ff', fontSize: '12px', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
            {job.clusterProgress.replace(/\r.*/g, '').slice(-100)}
          </span>
        )}

        {job && job.status === 'done' && job.wavs.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto', flexShrink: 0 }}>
            {job.wavs.map((_w, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ color: '#8fe0a0', fontSize: '13px', fontWeight: 600 }}>#{i + 1}</span>
                <audio controls src={`/api/inference/jobs/${job.id}/wav/${i}?v=${job.started ?? job.id}`} style={{ height: '28px' }} />
              </span>
            ))}
          </span>
        )}
      </div>

      <div style={{
        flex: 1,
        minHeight: 0,
        background: '#14141c',
        border: '1px solid #333',
        borderRadius: '28px',
        overflow: 'hidden',
      }}>
        <NoteEditorApp
          submitTick={submitTick}
          phonemes={injected.phonemes}
          phMap={injected.phMap}
          phRev={injected.phRev}
          actions={(<>
            <span ref={engineRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                onClick={() => setEngineOpen((v) => !v)}
                title="切換推理引擎（點選切換）"
                style={{
                  fontSize: '13px', padding: '4px 11px', borderRadius: '10px', cursor: 'pointer',
                  background: engine === 'local' ? '#1d3a2a' : '#22304a',
                  color: engine === 'local' ? '#7fd89a' : '#8fb4e8',
                  border: `1px solid ${engine === 'local' ? '#2e7d5b' : '#44608e'}`,
                }}
              >
                {engine === 'local' ? '本機 CPU ▾' : '雲端 GPU ▾'}
              </button>
              {engineOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 70, minWidth: '170px',
                  background: '#1d1d26', border: '1px solid #3e3e4e', borderRadius: '9px', padding: '6px',
                  display: 'flex', flexDirection: 'column', gap: '2px', boxShadow: '0 10px 28px rgba(0,0,0,.55)',
                }}>
                  {([['local', '本機 CPU', '這台機器的 CPU docker（免上傳、不受網路影響）'], ['cloud', '雲端 GPU', 'Colab VM（慢但強）']] as const).map(([val, label, desc]) => (
                    <button
                      key={val}
                      onClick={() => { setEngine(val as 'cloud' | 'local'); setEngineOpen(false); }}
                      title={desc}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1px',
                        background: engine === val ? '#2c3a58' : 'transparent',
                        border: 'none', borderRadius: '6px', padding: '7px 10px', fontSize: '13px',
                        color: engine === val ? '#fff' : '#c6cbdc', textAlign: 'left',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{label}{engine === val ? ' ✓' : ''}</span>
                      <span style={{ fontSize: '11px', color: '#8a93a8' }}>{desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
            <button
              onClick={runInference}
              disabled={submitting || (engineOf(job) === engine && job != null && (job.status === 'starting' || job.status === 'running')) || !ckpt}
              title="跑推論合成(可先到 ⚙ 設定選模型/辭典/引擎)"
              style={{
                background: engine === 'local' ? '#2e6b4d' : '#3d5a99',
                borderColor: engine === 'local' ? '#6ab892' : '#6a8cd8',
                color: '#fff', fontWeight: 600, padding: '4px 16px',
              }}
            >
              {submitting || (engineOf(job) === engine && job != null && job.kind !== 'warmup' && (job.status === 'starting' || job.status === 'running')) ? '推理中…' : '▶ 合成'}
            </button>
            <button
              onClick={() => setFullscreen((v) => !v)}
              title="全螢幕編輯（蓋過平台其他區塊）"
              style={{ gap: '6px' }}
            >
              {fullscreen ? (
                <><svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M5 2v3H2M12 5H9V2M9 12V9h3M2 9h3v3" /></svg>離開全螢幕</>
              ) : (
                <><svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" /></svg>全螢幕</>
              )}
            </button>
          </>)}
          settingsExtra={(<>
            <label className="row" title="選要用的聲學模型 checkpoint">
              <span>模型</span>
              <select
                value={ckpt?.file ?? ''}
                onChange={(e) => setSelectedKey(e.target.value)}
                style={{ maxWidth: '250px' }}
              >
                {models == null && <option>載入中…</option>}
                {models != null && allCkpts.length === 0 && <option value="">（還沒有訓練好的模型 — 先到訓練管理頁訓練）</option>}
                {models?.map((m) => (
                  <optgroup key={m.exp} label={m.exp}>
                    {m.ckpts.map((c) => {
                      const steps = c.name.match(/steps_(\d+)/)?.[1] ?? c.name;
                      return (
                        <option key={c.file} value={c.file}>
                          {m.exp} · steps {steps}（{(c.sizeBytes / (1024 * 1024)).toFixed(0)} MiB）
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="row" title="MFA 辭典(決定 word→phoneme 切法)">
              <span>辭典</span>
              <select
                value={dictIdx}
                onChange={(e) => setDictIdx(Number(e.target.value))}
                style={{ maxWidth: '220px' }}
              >
                {dicts == null && <option>載入中…</option>}
                {dicts?.map((d, i) => (
                  <option key={d.id} value={i}>{d.name}</option>
                ))}
              </select>
            </label>
            <div className="row sep" title="預熱推理環境：開 VM + repo/venv/vocoder，不上傳模型、不跑推論；之後按合成免等環境準備">
              <span>暖機</span>
              <button
                onClick={runWarmup}
                disabled={submitting || (engineOf(job) === 'cloud' && job != null && (job.status === 'starting' || job.status === 'running')) || !ckpt}
              >
                {submitting || (engineOf(job) === 'cloud' && job != null && job.kind === 'warmup' && (job.status === 'starting' || job.status === 'running')) ? '暖機中…' : '暖機（預熱環境）'}
              </button>
            </div>
          </>)}
          wavs={job && job.status === 'done' && job.kind !== 'warmup'
            ? job.wavs.map((_w: string, i: number) => `/api/inference/jobs/${job.id}/wav/${i}?v=${job.started ?? job.id}`)
            : []}
          inferring={!!(job && job.kind !== 'warmup' && (job.status === 'starting' || job.status === 'running'))}
          onProjectChange={(p: any) => { projectRef.current = p; }}
        />
      </div>
    </div>
  );
}
