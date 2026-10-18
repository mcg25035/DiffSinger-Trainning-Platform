import { useEffect, useRef, useState } from 'react';
import { exportDS, importDS } from '../lib/project.js';
import { reconcileF0 } from '../lib/f0hybrid.js';

/* SVG 線性圖示(14px,currentColor) */
const Svg = (props) => <svg className="ic" viewBox="0 0 14 14" width="15" height="15" aria-hidden="true" {...props} />;
const IcPlay = () => <Svg><path d="M4 2.2v9.6L12 7z" fill="currentColor" /></Svg>;
const IcPause = () => <Svg><path d="M4 2.5h2.4v9H4zM8.6 2.5H11v9H8.6z" fill="currentColor" /></Svg>;
const IcStop = () => <Svg><rect x="3.2" y="3.2" width="7.6" height="7.6" rx="1.2" fill="currentColor" /></Svg>;
const IcUndo = () => <Svg fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 3 3 5.5 5.5 8" /><path d="M3 5.5h5a3.2 3.2 0 0 1 0 6.4H7" /></Svg>;
const IcRedo = () => <Svg fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 3 11 5.5 8.5 8" /><path d="M11 5.5H6a3.2 3.2 0 0 0 0 6.4h1" /></Svg>;
const IcPen = () => <Svg fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M2.8 11.2l.7-2.9 6-6a1.55 1.55 0 0 1 2.2 2.2l-6 6z" /><path d="M8.6 3.2l2.2 2.2" /></Svg>;
const IcX = () => <Svg fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l6 6M10 4l-6 6" /></Svg>;
const IcExport = () => <Svg fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 2v7M4 6.2 7 9.2l3-3M2.8 11.6h8.4" /></Svg>;
const IcImport = () => <Svg fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9V2M4 4.8 7 1.8l3 3M2.8 11.6h8.4" /></Svg>;
const IcSettings = () => (
  <Svg fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M1.8 3.6h2.1M6.6 3.6h5.6M1.8 7h5.1M9.6 7h2.6M1.8 10.4h1.1M5.6 10.4h6.6" />
    <circle cx="5.2" cy="3.6" r="1.65" /><circle cx="8.2" cy="7" r="1.65" /><circle cx="4.2" cy="10.4" r="1.65" />
  </Svg>
);

/**
 * Toolbar：
 * - 主列:播放/停止、工具(選取/F0 畫筆)、復原重做、面板開關、匯入匯出
 * - ⚙ 設定選單(收合):琴音音量、BPM、格線、磁吸、吸音符邊緣、縮放、ph 表
 */
export default function Toolbar({ project, setProject, tool, setTool, showPhoneme, setShowPhoneme, showF0, setShowF0, undo, redo, canUndo, canRedo, playback = null, actions = null, settingsExtra = null }) {
  const fileRef = useRef(null);
  const phRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const tempoBaseRef = useRef(null); // BPM 編輯基準:聚焦時鎖定,打字過渡值不污染縮放
  const [tempoDraft, setTempoDraft] = useState(null); // 打字中 = 草稿(不動專案);null = 顯示 project.tempo
  const tempoDraftRef = useRef(null);
  tempoDraftRef.current = tempoDraft;

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    const k = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', h, true);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h, true); window.removeEventListener('keydown', k); };
  }, [menuOpen]);

  const fmt = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;

  const doExport = () => {
    const data = exportDS(project);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'untitled.ds';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onImport = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((txt) => {
      try {
        const proj = importDS(JSON.parse(txt));
        setProject((p) => ({ ...proj, tempo: p.tempo, gridDiv: p.gridDiv, snap: p.snap, ppb: p.ppb }));
      } catch (err) {
        alert('匯入失敗：' + err.message);
      }
    });
    e.target.value = '';
  };

  const zoom = (k) => setProject((p) => ({ ...p, ppb: Math.max(24, Math.min(480, Math.round(p.ppb * k))) }));
  const g = project.glide || { pre: 0.65, ratio: 0.35 };

  // BPM commit(離開框/Enter/停手 600ms):音符錨定「拍」,縮放秒長度 × 舊/新 → 拍數小節不變、播放速度跟著 BPM
  const commitTempo = () => {
    const raw = tempoDraftRef.current;
    setTempoDraft(null);
    if (raw == null || raw === '') return;
    const nt = Math.max(30, Math.min(300, Math.round(Number(raw))));
    if (!Number.isFinite(nt) || nt <= 0) return;
    const base = tempoBaseRef.current;
    tempoBaseRef.current = null;
    if (!base || nt === base || nt / base > 8 || nt / base < 1 / 8) {
      setProject((p) => ({ ...p, tempo: nt })); // 基準外亂值:只改 tempo,不動音符
      return;
    }
    const k = base / nt;
    setProject((p) => {
      const notes = p.notes.map((n) => ({ ...n, start: n.start * k, dur: n.dur * k, phDurs: (n.phDurs || []).map((d) => d * k) }));
      const f0 = (p.f0 || []).map((pt) => (
        pt.manual && Number.isFinite(pt.off) ? { ...pt, off: pt.off * k } : { ...pt, t: pt.t * k }
      ));
      return { ...p, tempo: nt, notes, f0: reconcileF0(notes, f0, p.glide) };
    });
  };

  // 匯入 phoneme 表。支援三種 JSON：
  // 1) MFA mapping：{ dictionary: { wa: 'w a', ... } } → phMap + 自動收集音素清單
  // 2) { phonemes: [...] }（Platform dictionaries/*.json）
  // 3) 純 string[]
  // 整合 Platform 時改由外部直接塞 project.phonemes / project.phMap
  const onImportPhonemes = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((txt) => {
      try {
        const d = JSON.parse(txt);
        if (d && typeof d === 'object' && !Array.isArray(d) &&
          d.dictionary && typeof d.dictionary === 'object') {
          const inv = [...new Set(Object.values(d.dictionary).flatMap((v) => String(v).split(/\s+/).filter(Boolean)))];
          setProject((p) => ({ ...p, phMap: d.dictionary, phonemes: inv, phRev: d.reverse_mapping ?? null }));
          return;
        }
        const list = Array.isArray(d) ? d : d.phonemes;
        if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
          throw new Error('格式需為 string[]、{ phonemes: [...] } 或 { dictionary: {...} }');
        }
        setProject((p) => ({ ...p, phonemes: list, phMap: null, phRev: null }));
      } catch (err) {
        alert('phoneme 表匯入失敗：' + err.message);
      }
    });
    e.target.value = '';
  };

  return (
    <div className="toolbar">
      {playback && (
        <span className="grp play-ctl" title="播放最新推論結果;播放時指針到頁尾自動換頁">
          <button className="ic-btn" disabled={!playback.canPlay} onClick={playback.onToggle} title="播放/暫停(空白鍵)">
            {playback.playing ? <IcPause /> : <IcPlay />}
          </button>
          <button className="ic-btn" disabled={!playback.canPlay} onClick={playback.onStop} title="停止(回開頭)"><IcStop /></button>
          <span className="time">{fmt(playback.t)} / {fmt(playback.dur)}</span>
        </span>
      )}
      <span className="vr" />
      <span className="grp">
        <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')} title="快捷鍵 V">選取</button>
        <button className={tool === 'pen' ? 'active' : ''} onClick={() => setTool('pen')} title="快捷鍵 B：在 piano roll 上直接畫 F0；右鍵拖曳擦除"><IcPen />F0 畫筆</button>
      </span>
      <span className="vr" />
      <span className="grp">
        <button className="ic-btn" onClick={undo} disabled={!canUndo} title="復原 (Ctrl+Z)"><IcUndo /></button>
        <button className="ic-btn" onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Shift+Z / Ctrl+Y)"><IcRedo /></button>
      </span>
      {actions && (<><span className="vr" />{actions}</>)}
      <span className="vr" />
      <button className={showPhoneme ? 'active' : ''} onClick={() => setShowPhoneme(!showPhoneme)} title="快捷鍵 P">Phoneme</button>
      <button className={showF0 ? 'active' : ''} onClick={() => setShowF0(!showF0)} title="快捷鍵 T">F0</button>
      <span className="vr" />
      <button onClick={doExport} title="匯出 .ds 檔"><IcExport />匯出</button>
      <button onClick={() => fileRef.current.click()} title="匯入 .ds / JSON 檔"><IcImport />匯入</button>
      <input ref={fileRef} type="file" accept=".ds,.json" hidden onChange={onImport} />
      <span className="spacer" />
      <span className="menu-wrap" ref={menuRef}>
        <button className={`ic-btn${menuOpen ? ' active' : ''}`} onClick={() => setMenuOpen(!menuOpen)} title="設定(琴音/BPM/格線/磁吸/縮放/ph 表)"><IcSettings /></button>
        {menuOpen && (
          <div className="menu-pop">
            {settingsExtra}
            {settingsExtra && <div className="row sep" />}
            {playback && (
              <label className="row" title="琴音(合成預覽/琴鍵)音量;沒有渲染結果時播放就是這個聲音">
                <span>琴音音量</span>
                <input type="range" min={0} max={100} value={project.keyVol ?? 50}
                  onChange={(e) => setProject((p) => ({ ...p, keyVol: Number(e.target.value) }))} />
              </label>
            )}
            <label className="row">
              <span>BPM</span>
              <input type="number" min={30} max={300}
                value={tempoDraft ?? project.tempo}
                onFocus={() => { tempoBaseRef.current = project.tempo; }}
                onChange={(e) => {
                  const v = e.target.value;
                  setTempoDraft(v === '' ? '' : Number(v)); // 打字中只改草稿,什麼都不觸發
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                onBlur={() => commitTempo()} />
            </label>
            <label className="row">
              <span>格線 1/</span>
              <select value={project.gridDiv} onChange={(e) => setProject((p) => ({ ...p, gridDiv: Number(e.target.value) }))}>
                {[1, 2, 4, 8, 12, 16].map((d) => <option key={d * 4} value={d * 4}>{d * 4}</option>)}
              </select>
            </label>
            <label className="row" title="快捷鍵 S；拖曳時按住 Alt 可暫時反向">
              <span>磁吸 <kbd>S</kbd></span>
              <input type="checkbox" checked={project.snap}
                onChange={(e) => setProject((p) => ({ ...p, snap: e.target.checked }))} />
            </label>
            <label className="row" title="關閉後只吸格線，不吸其他音符邊緣">
              <span>吸音符邊緣</span>
              <input type="checkbox" checked={project.snapNotes}
                onChange={(e) => setProject((p) => ({ ...p, snapNotes: e.target.checked }))} />
            </label>
            <div className="row sep" title="音符之間的自動滑音(portamento)">
              <span>滑音位置 <b>{Math.round(g.pre * 100)}%</b></span>
              <input type="range" min={0} max={100} value={Math.round(g.pre * 100)}
                title="100% = 前一音還沒結束就開始滑(音尾內滑完) · 0% = 下一音起點才開始滑"
                onChange={(e) => setProject((p) => ({ ...p, glide: { ...(p.glide || { ratio: 0.35 }), pre: Number(e.target.value) / 100 } }))} />
            </div>
            <div className="row" title="滑音時長(佔較短音符的比):越小滑得越快,越大越慢越綿">
              <span>滑音長度 <b>{Math.round(g.ratio * 100)}%</b></span>
              <input type="range" min={10} max={80} value={Math.round(g.ratio * 100)}
                onChange={(e) => setProject((p) => ({ ...p, glide: { ...(p.glide || { pre: 0.65 }), ratio: Number(e.target.value) / 100 } }))} />
            </div>
            <div className="row" title="網格密度(音符顯示寬度)">
              <span>縮放</span>
              <span className="grp">
                <button className="ic-btn" onClick={() => zoom(1 / 1.25)} title="縮小">−</button>
                <button className="ic-btn" onClick={() => zoom(1.25)} title="放大">＋</button>
              </span>
            </div>
            <div className="row sep" title="phoneme 表（JSON）：word 無空白時按此表貪婪最長匹配切 phoneme">
              <span>ph 表{project.phonemes?.length ? ` · ${project.phonemes.length}` : ''}</span>
              <span className="grp">
                <button onClick={() => phRef.current.click()}>{project.phonemes?.length ? '更換' : '載入 JSON'}</button>
                {project.phonemes?.length > 0 && (
                  <button onClick={() => setProject((p) => ({ ...p, phonemes: [], phMap: null, phRev: null }))} title="移除 phoneme 表">移除</button>
                )}
              </span>
              <input ref={phRef} type="file" accept=".json" hidden onChange={onImportPhonemes} />
            </div>
          </div>
        )}
      </span>
    </div>
  );
}
