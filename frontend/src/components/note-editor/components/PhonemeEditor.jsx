// Word 編輯面板：word 以空白拆成 phonemes；各 phoneme 的長度（秒）可調（邊界滑桿）
import { memo } from 'react';
import { notePhSplit, phDisplay } from '../lib/project.js';

// 每個 phoneme 最小時長（秒，避免擠沒了）
const PH_MIN = 0.02;
const r3 = (x) => Math.round(x * 1000) / 1000;

function PhonemeEditorInner({ note, onChange, onClose, phonemes, phMap, phRev }) {
  if (!note) return null;

  const set = (patch) => onChange({ ...note, ...patch });
  const split = notePhSplit(note, phonemes, phMap, phRev); // token 已是羅馬；show 僅為保險
  const show = (ph) => phDisplay(ph, phRev);
  const durs = split.map((p) => p.dur);
  // 邊界位置（距 note 起點的累積秒數），共 n-1 條
  const bounds = [];
  for (let i = 0; i < durs.length - 1; i++) bounds.push((bounds[i - 1] ?? 0) + durs[i]);

  // 拖第 k 條邊界到 t 秒（夾在相鄰邊界之間）；其餘不動
  const moveBound = (k, t) => {
    const lo = (bounds[k - 1] ?? 0) + PH_MIN;
    const hi = (bounds[k + 1] ?? note.dur) - PH_MIN;
    const b = [...bounds];
    b[k] = Math.min(hi, Math.max(lo, t));
    const nd = [];
    for (let i = 0; i < durs.length; i++) nd.push((b[i] ?? note.dur) - (b[i - 1] ?? 0));
    set({ phDurs: nd.map(r3) });
  };

  const custom = Array.isArray(note.phDurs);

  return (
    <div className="phoneme-editor">
      <div className="ph-head">
        <strong>Word</strong>
        <button className="close-btn" onClick={onClose} title="關閉面板 (P)">×</button>
      </div>

      <input className="word-input" value={note.word} autoFocus={false}
        placeholder="輸入 word（自動切聲母+韻母；空白 = 手動指定）"
        onChange={(e) => set({ word: e.target.value, phDurs: undefined, phRatios: undefined })} />

      <div className="muted" style={{ margin: '6px 0' }}>
        → phonemes：{split.map((p) => show(p.ph)).join(' ') || '（空）'}
        <br />音符 {note.dur.toFixed(3)}s
      </div>

      {/* phoneme 長度條 */}
      <div className="ph-split-bar">
        {split.map((p, i) => (
          <div key={i} className="ph-seg" style={{ width: `${(durs[i] / note.dur) * 100}%` }}
            title={show(p.ph) + (show(p.ph) !== p.ph ? '（IPA: ' + p.ph + '）' : '') + '  ' + durs[i].toFixed(3) + 's'}>
            {durs[i] / note.dur > 0.08 ? show(p.ph) : ''}
          </div>
        ))}
      </div>
      {split.map((p, i) => (
        <div key={i} className="muted" style={{ fontSize: 11 }}>
          {show(p.ph)}：{durs[i].toFixed(3)}s
        </div>
      ))}

      {/* 邊界滑桿（2 個以上 phoneme 才有） */}
      {bounds.length > 0 && (
        <div style={{ margin: '8px 0' }}>
          {bounds.map((t, k) => (
            <div key={k} className="ph-bound">
              <span className="muted" style={{ fontSize: 11 }}>
                {show(split[k].ph)}｜{show(split[k + 1].ph)}
              </span>
              <input type="range" min="0" max={note.dur} step="0.005" value={t}
                onChange={(e) => moveBound(k, Number(e.target.value))} />
              <span className="muted" style={{ fontSize: 11 }}>{t.toFixed(3)}s</span>
            </div>
          ))}
        </div>
      )}

      <label><input type="checkbox" checked={note.slur} onChange={(e) => set({ slur: e.target.checked })} /> is_slur</label>

      <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
        {custom && (
          <button onClick={() => set({ phDurs: undefined })}
            title="恢復預設：子音固定 0.1s，母音分剩餘">
            重置長度
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(PhonemeEditorInner);
