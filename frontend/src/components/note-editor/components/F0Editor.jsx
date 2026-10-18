import { memo, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { secToBeats, midiToFreq, freqToMidi, midiToName } from '../lib/music.js';
import { sortNotes, ensureF0Id } from '../lib/project.js';
import { activeF0, reconcileF0, coverNoteId } from '../lib/f0hybrid.js';
import { genAutoF0, splitSegments } from '../lib/f0auto.js';
import { buildF0Path } from '../lib/f0path.js';
import { useHud, Hint, IcMouseL, IcMouseR, IcHoriz } from './HudKit.jsx';

const H = 180;
const LOW = 36, HIGH = 84; // 與 PianoRoll 同範圍(C2~C6);實際顯示窗跟隨 roll 可視列
const BARS = 64;

/**
 * F0 曲線編輯(點級混合模式):
 * - ●自動點(粉):系統從音符產生,音符變動跟著重算;拖曳它 = 變手動
 * - ◉手動點(深粉實心):你調過的,永不自動重算,掛在音符上跟著走
 * - ✗ 已刪的自動點(灰):曲線跳過它;右鍵恢復 = 回自動原狀
 * - 雙擊空白:新手動點;雙擊點:切換直線/圓曲;Alt+拖:水平微調;Del:刪除選取點
 */
function F0EditorInner({ project, setProject, selRef }) {
  const svgRef = useRef(null);
  const f0ScrollRef = useRef(null);
  const rollScrollRef = useRef(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [selId, setSelId] = useState(null);      // 選取的控制點 id(Del 用)
  // 選取 id 同步給 NoteEditorApp(Del 優先權:點選中 → 刪點不刪音符);卸載時清掉
  useEffect(() => {
    if (selRef) selRef.current = selId;
    return () => { if (selRef) selRef.current = null; };
  }, [selId, selRef]);
  const [menu, setMenu] = useState(null);        // 右鍵選單 {x, y, id}
  // 音高窗 = 固定全音域(使用者裁定:內容不長,垂直不換頁不跟隨 → 垂直捲動零重渲染)
  const { tempo, ppb, kh } = project;
  const W = BARS * 4 * ppb;

  // ---- 與 PianoRoll 的 roll-scroll 聯動 ----
  // 左右:f0-scroll.scrollLeft = roll-scroll.scrollLeft(兩者內容同寬、同 48px 左距,可像素級對齊)
  // 上下:不聯動(固定全音域,見 pitchWin 註解)
  const syncFromRoll = useCallback(() => {
    const rs = rollScrollRef.current, fs = f0ScrollRef.current;
    if (!rs) return;
    if (fs && fs.scrollLeft !== rs.scrollLeft) fs.scrollLeft = rs.scrollLeft;
  }, []);

  useEffect(() => {
    const rs = f0ScrollRef.current?.closest('.note-editor-root')?.querySelector('.roll-scroll');
    rollScrollRef.current = rs;
    if (!rs) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; syncFromRoll(); });
    };
    rs.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    syncFromRoll(); // 掛上時+縮放(ppb/kh 變)先對齊一次
    return () => {
      rs.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [syncFromRoll, ppb]);

  // 展開動畫(轉勾淡入 .25s + 浮起 .3s)結束後 clientHeight 才正常,等 .6s 再對齊(scrollLeft+音高窗)
  useEffect(() => {
    if (collapsed) return undefined;
    const t = setTimeout(syncFromRoll, 600);
    return () => clearTimeout(t);
  }, [collapsed, syncFromRoll]);

  // ---- 工具列提示即時 HUD:實體按鍵/滑鼠狀態點燈(共用 HudKit) ----
  // 滑鼠:點在曲線區才收得到(工具列不算,點在控制點上由 onPointDown 手動觸發 — 它有 stopPropagation)
  const hud = useHud();
  const [rHover, setRHover] = useState(false); // hover 控制點 = 白圈亮
  const onRootDown = (e) => {
    if (e.button === 0) { hud.click(); setSelId(null); } // 點空白 = 取消選取點
  };

  const yOf = (f) => {
    if (f <= 0) return H - 1;
    const m = freqToMidi(f);
    return H - ((m - LOW) / (HIGH - LOW)) * H;
  };
  const fOf = (y) => midiToFreq(LOW + ((H - y) / H) * (HIGH - LOW));
  const xOf = (t) => secToBeats(t, tempo) * ppb;

  const toXY = useCallback((e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  // 分段畫線（只按 seg 斷:樂句斷開/衝突挖洞;靜默區間直線橋接）;曲線跳過 muted(✗),控制點全顯示
  const segments = useMemo(() => splitSegments(activeF0(project.f0), project.notes), [project.f0, project.notes]);
  const ctrlPoints = useMemo(
    () => project.f0.map((p, i) => ({ p, origIdx: i })),
    [project.f0],
  );
  // 曲線依控制點類型連接：直線點直線、圓曲點讓半段做圓角（與匯出採樣同一套幾何）
  const segPaths = useMemo(() => segments.map((seg) => buildF0Path(seg, xOf, yOf)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [segments, tempo, ppb]);

  const refNotes = useMemo(() => sortNotes(project.notes), [project.notes]);

  const onDblClick = (e) => {
    const { x, y } = toXY(e);
    // F0 控制點不吸格：磁吸是給音符的；控制點吸格會一直撞上現有點（使用者在中間點卻被擋）
    const t = Math.max(0, (x / ppb) * (60 / tempo));
    // 只擋「真正同一時間點」（密集筆畫點會讓寬容度失效，誤擋所有新增）
    if (project.f0.some((p) => Math.abs(p.t - t) < 1e-4)) {
      console.log('[F0] 雙擊加入被擋：該時間已有控制點 t=' + t.toFixed(3));
      return;
    }
    const anchorId = coverNoteId(project.notes, t);
    const an = anchorId ? project.notes.find((n) => n.id === anchorId) : null;
    const off = an ? t - an.start : undefined;
    const f0 = [...project.f0, { t, f: fOf(y), kind: 'curve', manual: true, anchorId, off, fp: an ? fOf(y) / midiToFreq(an.midi) : undefined, v2: true, id: Math.random().toString(36).slice(2) }].sort((a, b) => a.t - b.t);
    setProject((p) => ({ ...p, f0 }));
  };

  const dragRef = useRef(null);          // { id, t, f } 拖曳起點
  const rafRef = useRef(0);
  const pendingRef = useRef(null);
  const [dragMode, setDragMode] = useState(null); // 'v' | 'h'（游標提示用）
  // 收尾：務必把 rafRef 歸零，否則 cancel 後 rafRef 卡著舊值，之後拖曳全被 `if (rafRef.current) return` 擋死
  const clearDrag = useCallback(() => {
    dragRef.current = null;
    pendingRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    setDragIdx(null);
    setDragMode(null);
  }, []);
  useEffect(() => {
    window.addEventListener('mouseup', clearDrag);
    return () => window.removeEventListener('mouseup', clearDrag);
  }, [clearDrag]);
  // 點 F0 面板外(roll/工具列/任何地方)→ 取消控制點選取
  // 不然 selId 幽靈存留:Del 被 NoteEditorApp 判「點還選著」跳過、F0 又拿過期 id 刪空氣 = 兩邊都被吃
  useEffect(() => {
    const out = (e) => {
      if (!e.target.closest || !e.target.closest('.f0-editor')) setSelId(null);
    };
    window.addEventListener('pointerdown', out, true);
    return () => window.removeEventListener('pointerdown', out, true);
  }, []);
  // Del/Backspace 刪除選取點 + Escape 取消選取
  // ⚠ 註冊一次、邏輯走 ref — 不能用無 deps effect 每次重掛:
  //   按 Del 時 HUD kd 的 setHud 會在「同一個 keydown 派發中途」觸發 flush → 舊 h 被拆(removed 旗標)
  //   → 派發輪到舊 h 時被瀏覽器跳過 = Del 永遠被吃
  const delActionRef = useRef(null);
  useEffect(() => {
    const h = (e) => delActionRef.current?.(e);
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  const onPointDown = (e, i) => {
    e.stopPropagation();
    if (e.button === 2) { hud.flashR(); return; }
    hud.click();
    const pt = project.f0[i];
    setSelId(ensureF0Id(pt));
    // 臨時診斷:點選點 + 前後鄰居完整資料(斷點診斷用,診斷完拆)
    const fmt = (q, tag) => q
      ? `${tag} ${q.id ?? '-'} t=${q.t.toFixed(3)} f=${Math.round(q.f)} manual=${!!q.manual} muted=${!!q.muted} 錨=${q.anchorId ?? '-'} off=${Number.isFinite(q.off) ? q.off.toFixed(3) : '-'} fp=${Number.isFinite(q.fp) ? q.fp.toFixed(3) : '-'} src=${q.srcAnchorId ?? '-'}/${q.role ?? '-'}`
      : `${tag} (無)`;
    console.log(`[F0DBG] 點了#${i}/${project.f0.length}\n  ${fmt(pt, '這顆:')}\n  ${fmt(project.f0[i - 1], '前一顆:')}\n  ${fmt(project.f0[i + 1], '後一顆:')}`);
    if (pt.muted) return; // ✗ 不可拖(右鍵恢復)
    dragRef.current = { id: ensureF0Id(pt), t: pt.t, f: pt.f };
    setDragIdx(i);
  };

  const onContextMenu = (e, i) => {
    e.preventDefault();
    hud.flashR();
    setSelId(ensureF0Id(project.f0[i]));
    setMenu({ x: e.clientX, y: e.clientY, id: ensureF0Id(project.f0[i]) });
  };

  // 刪除語義:手動點=移除;自動點=靜音(✗);✗=復原
  // 動完立即 reconcile:轉自動/恢復當場吸附骨架新值(選單一觸發就一定套用,不等下次音符變動)
  const applyF0 = (fn) => setProject((p) => ({ ...p, f0: reconcileF0(p.notes, fn(p.f0), project.glide) }));
  const deletePoint = (id) => {
    applyF0((f0) => f0.flatMap((pt) => {
      if (ensureF0Id(pt) !== id) return [pt];
      if (pt.muted) { const { muted, ...rest } = pt; return [rest]; } // ✗ 刪除 = 復原自動點
      if (pt.manual) return [];                                       // 手動點 = 真的刪掉
      return [{ ...pt, muted: true }];                                // 自動點 = 靜音標記
    }));
  };
  // 每次 render 更新邏輯(stable listener 的本體);刪除語義:手動=移除/自動=✗/✗=復原
  delActionRef.current = (e) => {
    if (e.key === 'Escape') { setSelId(null); return; }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const ae = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ae)) return;
    if (selId == null || dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    deletePoint(selId);
    setSelId(null);
  };
  const convertPoint = (id, toManual) => {
    applyF0((f0) => f0.map((pt) => {
      if (ensureF0Id(pt) !== id) return pt;
      if (toManual) return { ...pt, manual: true, muted: undefined, seg: undefined };
      const { manual, ...rest } = pt; return rest; // 轉自動:立即吸附骨架值
    }));
  };
  // 點外/Escape 關選單
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const esc = (e) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [menu]);

  // 雙擊點：切換 直線點（方）/ 圓曲點（圓）
  const onPointDblClick = (e, i) => {
    e.stopPropagation();
    setProject((p) => ({
      ...p,
      f0: p.f0.map((pt, j) => (j === i ? { ...pt, kind: pt.kind === 'line' ? 'curve' : 'line', manual: true, seg: undefined } : pt)),
    }));
  };

  // 拖曳：預設垂直（改音高，時間固定）；Alt+拖曳 = 水平（改時間，音高固定），不吸格；Ctrl = 微調(位移×0.15)
  const onMove = (e) => {
    if (!dragRef.current) return;
    pendingRef.current = { x: e.clientX, y: e.clientY, alt: e.altKey, ctrl: e.ctrlKey };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!dragRef.current || !pendingRef.current) return;
      const { x: cx, y: cy, alt, ctrl } = pendingRef.current;
      const r = svgRef.current.getBoundingClientRect();
      const x = cx - r.left, y = cy - r.top;
      const drag = dragRef.current;
      const loF = midiToFreq(LOW), hiF = midiToFreq(HIGH);
      const fCur = fOf(y), tCur = Math.max(0, (x / ppb) * (60 / tempo));
      let f, t;
      if (ctrl) {
        // 微調:從按下位置起算,游標位移 ×0.15(軸向規則不變:Alt 鎖水平,預設鎖垂直)
        f = alt ? drag.f : Math.min(hiF, Math.max(loF, drag.f + (fCur - drag.f) * 0.15));
        t = alt ? Math.max(0, drag.t + (tCur - drag.t) * 0.15) : drag.t;
      } else {
        // 垂直：f 跟游標，t 固定；水平：t 跟游標，f 固定
        f = alt ? drag.f : Math.min(hiF, Math.max(loF, fCur));
        t = alt ? tCur : drag.t;
      }
      setDragMode(alt ? 'h' : 'v');
      const dragId = drag.id;
      setProject((p) => {
        // 拖曳點剛拿到骨架身份 → 同身份或同位(±1ms)的舊點讓位(使用者剛拖的贏,否則去重會殺掉新拖的)
        const dragPt = p.f0.find((pt) => ensureF0Id(pt) === dragId);
        const ident = dragPt && dragPt.srcAnchorId && dragPt.role ? dragPt.srcAnchorId + '|' + dragPt.role : null;
        const f0 = p.f0.filter((pt) => {
          if (ensureF0Id(pt) === dragId) return true;
          if (!pt.muted && Math.abs(pt.t - t) < 1e-3) return false; // 拖到同位的舊點讓位
          if (ident && !pt.muted && pt.srcAnchorId && pt.role && pt.srcAnchorId + '|' + pt.role === ident) return false; // 同身份讓位
          return true;
        }).map((pt) => {
          if (ensureF0Id(pt) !== dragId) return pt;
          if (!pt.manual) console.log('[F0 Drag] 手動化:', JSON.stringify({ role: pt.role, anchorId: pt.anchorId ?? coverNoteId(p.notes, t), t: +t.toFixed(3), f: +f.toFixed(1) }));
          // 錨:**保留骨架原 anchorId+role**(那顆點本來就是骨架的,歸你管 → 孿生壓制才對得上);
          // 沒有(雙擊新增在縫隙)才用幾何涵蓋。off=對錨「起點」的秒偏移(全檔唯一基準,任何 role 都一樣)
          const anchorId = pt.anchorId ?? coverNoteId(p.notes, t);
          const an = anchorId ? p.notes.find((n) => n.id === anchorId) : null;
          const off = an ? t - an.start : undefined;
          // ⚠ fp 必須同步更新(音高比 = f / 錨音符頻率)— 只改 f 不改 fp,下一次 reconcile 會用舊 fp 把音高算回去
          const fp = an ? f / midiToFreq(an.midi) : undefined;
          return { ...pt, t, f, manual: true, anchorId, off, fp, seg: undefined, rel: undefined, v2: true };
        });
        f0.sort((a, b) => a.t - b.t);
        return { ...p, f0 };
      });
    });
  };
  const onUp = clearDrag;

  const gridY = useMemo(() => {
    const a = [];
    for (let m = Math.ceil(LOW / 12) * 12; m <= HIGH; m += 12) a.push(m);
    return a;
  }, []);

  return (
      <div className="f0-editor">
      <div className="f0-toolbar">
        <span className="f0-toggle" title={collapsed ? '展開 F0 面板' : '摺疊 F0 面板'}
          onClick={() => setCollapsed((v) => !v)}>
          <svg width="15" height="9" viewBox="0 0 28 16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform .25s ease' }}>
            <path d="M2 2 14 14 26 2" />
          </svg>
        </span>
        <strong>F0 曲線</strong>
        <span className={'f0-tools' + (collapsed ? ' off' : '')}>
          <span className="legend">
            <span><i className="dot auto" />自動</span>
            <span><i className="dot man" />手動</span>
            <span><i className="cross">✗</i>已刪(右鍵恢復)</span>
          </span>
          <span className="hints">
            <Hint on={hud.combo === 2} title="雙擊空白處新增手動點">
              <span className={'mic' + (hud.l ? ' lit' : '')}><IcMouseL /></span><i className="x2">×2</i>新增
              <i className="combo" data-c={hud.combo} />
            </Hint>
              <Hint on={hud.r || menu} title="右鍵點控制點：控制點選單(刪除/轉自動/恢復)">
                <span className={'rdot' + (rHover ? ' lit' : '')}><IcMouseR marker="dot" /></span>控制點選單
              </Hint>
            <Hint on={hud.keys.alt} title="Alt+拖曳：鎖定水平方向(改時間，音高固定)"><kbd>Alt</kbd><IcHoriz />水平</Hint>
            <Hint on={hud.keys.ctrl} title="Ctrl+拖曳：微調(游標位移×0.15)"><kbd>Ctrl</kbd>微調</Hint>
            <Hint on={hud.keys.del} title="刪除選取點(手動=移除/自動=標 ✗)"><kbd>Del</kbd>刪除選取</Hint>
          </span>
          <button onClick={() => setProject((p) => ({ ...p, f0: [] }))}>清除全部</button>
          <button title="移除所有手動點、復原所有已刪自動點 → 整條回到自動骨架"
            onClick={() => setProject((p) => ({ ...p, f0: p.f0.filter((pt) => !pt.manual).map(({ manual, muted, ...rest }) => rest) }))}>
            清除手動點
          </button>
        </span>
      </div>
      <div className={'f0-scroll' + (collapsed ? ' closed' : '')} ref={f0ScrollRef}>
        <svg ref={svgRef} width={W} height={H} style={{ marginLeft: 48 }}
          onDoubleClick={onDblClick} onMouseDown={onRootDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
          {gridY.map((m) => (
            <g key={m}>
              <line x1={0} x2={W} y1={yOf(midiToFreq(m))} y2={yOf(midiToFreq(m))} stroke="#22222c" />
              <text x={4} y={yOf(midiToFreq(m)) - 3} fontSize={9} fill="#666">{midiToName(m)}</text>
            </g>
          ))}
          {refNotes.map((n) => (
            <rect key={n.id} x={xOf(n.start)} y={yOf(midiToFreq(n.midi)) - 2}
              width={Math.max(2, xOf(n.start + n.dur) - xOf(n.start))} height={4}
              fill="#4fa3ff33" />
          ))}
          {segPaths.map((d, si) => (
            <path key={si} d={d} fill="none" stroke="#ff7ab8" strokeWidth={2} />
          ))}
          {ctrlPoints.map(({ p, origIdx }) => {
            const hot = origIdx === dragIdx || selId === ensureF0Id(p);
            const fill = hot ? '#ffd166' : p.manual ? '#e0418c' : '#ff7ab8';
            return (
              <g key={origIdx}
                style={{ cursor: p.muted ? 'pointer' : dragMode === 'h' ? 'ew-resize' : dragMode === 'v' ? 'ns-resize' : 'grab' }}
                onMouseDown={(e) => onPointDown(e, origIdx)}
                onMouseEnter={() => setRHover(true)}
                onMouseLeave={() => setRHover(false)}
                onDoubleClick={(e) => onPointDblClick(e, origIdx)}
                onContextMenu={(e) => onContextMenu(e, origIdx)}>
                {/* 隱形大 hit area：8px 小點不好點，r=10 提升命中率 */}
                <circle cx={xOf(p.t)} cy={yOf(p.f)} r={10} fill="transparent" />
                {p.muted ? (
                  <g pointerEvents="none" stroke={hot ? '#ffd166' : '#8a8a96'} strokeWidth={1.6}>
                    <line x1={xOf(p.t) - 4} y1={yOf(p.f) - 4} x2={xOf(p.t) + 4} y2={yOf(p.f) + 4} />
                    <line x1={xOf(p.t) - 4} y1={yOf(p.f) + 4} x2={xOf(p.t) + 4} y2={yOf(p.f) - 4} />
                  </g>
                ) : p.kind === 'line' ? (
                  <rect x={xOf(p.t) - 4} y={yOf(p.f) - 4} width={8} height={8}
                    fill={fill} stroke="#fff" strokeWidth={0.6} pointerEvents="none" />
                ) : (
                  <circle cx={xOf(p.t)} cy={yOf(p.f)} r={4.5}
                    fill={fill} stroke="#fff" strokeWidth={0.6} pointerEvents="none" />
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {menu && (() => {
        const pt = project.f0.find((q) => ensureF0Id(q) === menu.id);
        if (!pt) return null;
        const items = pt.muted
          ? [{ label: '恢復自動點', act: () => deletePoint(menu.id) }]
          : pt.manual
            ? [{ label: '刪除手動點', act: () => deletePoint(menu.id) }, { label: '轉自動(交回骨架)', act: () => convertPoint(menu.id, false) }]
            : [{ label: '刪除(標記 ✗,曲線跳過)', act: () => deletePoint(menu.id) }, { label: '轉手動(固定不重算)', act: () => convertPoint(menu.id, true) }];
        return (
          <div className="f0-ctxmenu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            {items.map((it) => (
              <button key={it.label} onClick={() => { it.act(); setMenu(null); }}>{it.label}</button>
            ))}
          </div>
        );
      })()}
      <div className="playhead-overlay"><div className="playhead-line" /></div>
    </div>
  );
}

export default memo(F0EditorInner);
