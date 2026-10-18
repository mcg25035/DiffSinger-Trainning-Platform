import { memo, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import {
  midiToName, isBlackKey, beatsToSec, secToBeats, midiToFreq, nextId,
} from '../lib/music.js';
import { snapPosition } from '../lib/snap.js';
import { applyStroke, eraseAround, pushStrokePoint } from '../lib/f0edit.js';
import { splitSegments } from '../lib/f0auto.js';
import { buildF0Path } from '../lib/f0path.js';
import { wordVowel } from '../lib/project.js';
import { activeF0, reconcileF0 } from '../lib/f0hybrid.js';
import { keySoundDown, keySoundGlide, keySoundUp, keySoundPreload, keySoundSetVolume, keySoundDebug } from '../lib/keySound.js';
import WaveOverlay from './WaveOverlay.jsx';

const LOW = 36, HIGH = 84; // C2 ~ C6
const ROWS = HIGH - LOW + 1;
const BARS = 64;
const EDGE_PX = 5;

// 音高→Y 對到 row 中心（音符 rect 畫在 y+1~y+kh-1，中心 = y+kh/2）；畫筆反算在 startPen/continuePen 同步 +kh/2
const midiToF0Y = (f, kh) => (HIGH - (69 + 12 * Math.log2(f / 440))) * kh + kh / 2;

/**
 * Piano Roll
 * - 空白左鍵拖曳：框選（Shift=加選）；雙擊空白：建音符
 * - 點音符磁吸移動/左右緣拉伸；多選音符一起拖；拖曳時顯示磁吸參考線（吸到音符邊緣=橘、格線=藍）
 * - Alt：弱磁吸（只吸音符邊緣）
 * - 雙擊音符：inline 改 word；筆工具：直接畫 F0（右鍵擦除）
 * - 手動調過 F0（f0Manual）後搬移/縮放音符：掛在該音符上的 F0 點跟著變換（線跟著動）
 * - 重疊的音符顯示灰+紅框;選取+重疊 = 橙褐+紅框(同時表達兩種狀態)
 */
function PianoRollInner({
  project, setProject, selectedIds, setSelectedIds, tool, wave = null, inferring = false, seekTo = null,
  onDeleteNotes = null, onNoteProps = null, onCopySel = null, onCutSel = null,
}) {
  const svgRef = useRef(null);
  const keysRef = useRef(null);   // 音名欄:跟 roll 的 scrollTop 同步(否則垂直捲動時標籤錯位)
  const rollRef = useRef(null);
  const [drag, setDrag] = useState(null);        // {mode:'move'|'edge'|'resize-l'|'resize-r'|'marquee', ...}
  const [penStroke, setPenStroke] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [snapGuide, setSnapGuide] = useState(null); // {beat, kind:'edge'|'grid'}
  const [pressedKey, setPressedKey] = useState(null); // 琴鍵按下的 midi(視覺回饋)
  const pressedMidiRef = useRef(null);
  const selBeforeEdgeRef = useRef(null); // 邊界拖前的選取(放開還原)
  const [noteMenu, setNoteMenu] = useState(null); // {clientX, clientY, svgX, noteId}

  // 琴音取樣預載(首次互動前先解碼好)+ 音量接線;__keySound 給 e2e 對照(臨時 debug,之後拆)
  useEffect(() => { keySoundPreload(); window.__keySound = keySoundDebug; }, []);
  useEffect(() => { keySoundSetVolume(project.keyVol ?? 50); }, [project.keyVol]);
  // 按住琴鍵滑過換音、放開收音(pointerup/pointercancel/blur/mouseup 全收:放開就停,不管游標在哪)
  useEffect(() => {
    const up = (why) => {
      if (pressedMidiRef.current == null) {
        if (why === 'pointercancel' || why === 'blur') console.log('[Roll] 收音事件(沒按住):', why);
        return;
      }
      console.log('[Roll] 琴鍵 UP midi=', pressedMidiRef.current, midiToName(pressedMidiRef.current), '來源=', why || '?');
      pressedMidiRef.current = null;
      setPressedKey(null);
      keySoundUp();
    };
    const hUp = () => up('pointerup'), hCancel = () => up('pointercancel'),
      hBlur = () => up('blur'), hMouseUp = () => up('mouseup');
    window.addEventListener('pointerup', hUp);
    window.addEventListener('pointercancel', hCancel);
    window.addEventListener('blur', hBlur);
    window.addEventListener('mouseup', hMouseUp);
    return () => {
      window.removeEventListener('pointerup', hUp);
      window.removeEventListener('pointercancel', hCancel);
      window.removeEventListener('blur', hBlur);
      window.removeEventListener('mouseup', hMouseUp);
    };
  }, []);

  const { tempo, gridDiv, snap, snapNotes, ppb, kh } = project;
  const totalW = BARS * 4 * ppb;
  const totalH = ROWS * kh;

  // 縮放時自動細分部格線
  // 視覺密度固定：每級格子間距 ≥ 18px 才畫；zoom in 才補更細層，zoom out 收起來
  const levels = useMemo(() => {
    const lv = [];
    for (let step = 4; step * ppb >= 18; step /= 2) lv.push(step);
    return lv;
  }, [ppb]);
  const finestStep = levels[levels.length - 1]; // 拍
  const snapDiv = Math.max(gridDiv, Math.round(1 / finestStep)); // 吸附用最細層

  // ---------- 同時重疊偵測（回傳 Set<noteId>：所有重疊中的音符都標，使用者才看得出哪裡故障） ----------
  const conflictIds = useMemo(() => {
    const ids = new Set();
    const sorted = [...project.notes].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        // 與 conflictRanges 同一套容差:吸附往返的 1e-16 級漂移不算重疊(否則磁吸在一起的音符被標紅)
        if (sorted[j].start >= sorted[i].start + sorted[i].dur - 1e-6) break;
        // 重疊 → 兩顆都標（原本只標音低的；但低音可能在畫面外，上面的音符看起來完全正常）
        ids.add(sorted[i].id);
        ids.add(sorted[j].id);
      }
    }
    if (ids.size) console.log('[Roll] conflicts:', [...ids].join(','));
    return ids;
  }, [project.notes]);

  // ---------- 座標 ----------
  const toXY = useCallback((e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);
  const secToX = useCallback((sec) => secToBeats(sec, tempo) * ppb, [tempo, ppb]);
  const xToSec = useCallback((x) => beatsToSec(x / ppb, tempo), [tempo, ppb]);
  const midiToY = (midi) => (HIGH - midi) * kh;

  const snapHere = useCallback((beat, excludeIds, e) => {
    const out = snapPosition(beat, {
      gridDiv: snapDiv, snap, snapNotes: snapNotes || !!e?.altKey, ppb, tempo,
      notes: project.notes, excludeIds, altMode: !!e?.altKey, list: true,
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, snapDiv, snapNotes, ppb, tempo, project.notes]);

  const noteGeom = useCallback((n) => ({
    x: secToX(n.start), y: midiToY(n.midi), w: Math.max(secToX(n.start + n.dur) - secToX(n.start), 4),
  }), [secToX, kh]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 畫筆 ----------
  const startPen = (x, y, e) => {
    const t = xToSec(x);
    const f = midiToFreq(HIGH - (y - kh / 2) / kh);
    if (e.button === 2) {
      setProject((p) => ({ ...p, f0: eraseAround(p.f0, t, 12 / ppb / tempo * 60), f0Manual: true }));
      setPenStroke({ erase: true });
      return;
    }
    setPenStroke({ erase: false, s: [strokePoint(t, f)] });
  };
  const strokePoint = (t, f) => ({ t, f, kind: 'curve' });
  const continuePen = (x, y) => {
    if (!penStroke) return;
    const t = xToSec(x);
    const f = midiToFreq(HIGH - (y - kh / 2) / kh);
    if (penStroke.erase) {
      setProject((p) => ({ ...p, f0: eraseAround(p.f0, t, 12 / ppb / tempo * 60), f0Manual: true }));
    } else {
      pushStrokePoint(penStroke.s, strokePoint(t, f));
      setPenStroke({ ...penStroke });
    }
  };
  const endPen = () => {
    if (penStroke && !penStroke.erase && penStroke.s.length) {
      setProject((p) => {
        // 筆觸點 = 手動點,並立即 reconcile 正規化成 anchor/off/fp
        // (不然這些點沒有 manual 旗標:複製不會帶走,下一次 reconcile 還會被當 auto 點丟掉)
        const f0 = reconcileF0(p.notes, applyStroke(p.f0, penStroke.s.map((pt) => ({ ...pt, manual: true }))), project.glide);
        return { ...p, f0, f0Manual: true };
      });
    }
    setPenStroke(null);
  };

  // ---------- 建音符（雙擊空白） ----------
  const createNoteAt = (x, y) => {
    const res = snapHere(x / ppb, [], null);
    const startSec = beatsToSec(res.beat, tempo);
    const midi = Math.max(LOW, Math.min(HIGH, HIGH - Math.floor(y / kh)));
    const durSec = beatsToSec(4 / snapDiv, tempo); // 一格(原 1/snapDiv 只有格線的 1/4,格線細時音符小到抓不住)
    const id = nextId();
    console.log('[Roll] 雙擊建音符', id, 'start=' + startSec.toFixed(3), 'dur=' + durSec.toFixed(3), 'midi=' + midi);
    setProject((p) => ({
      ...p,
      notes: [...p.notes, { id, start: startSec, dur: durSec, midi, word: 'a', slur: false }],
    }));
    setSelectedIds([id]);
    setEditingId(id);
  };

  const startMoveOrResize = (e, n, mode) => {
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ } // 拖音符出 svg/視窗不中斷
    console.log('[Roll] mousedown 音符', n.id, 'mode=' + mode, 'sel=', JSON.stringify(selectedIds));
    // 邊界綁定:resize 緣旁有時間接近的音符(端點差≤8px,跨音也算)→ 一次動兩顆(共用邊界,永不互撞)
    if (mode === 'resize-l' || mode === 'resize-r') {
      const tol = (60 / (tempo || 120)) / ppb * 8;
      const end = mode === 'resize-l' ? n.start : n.start + n.dur;
      const partner = project.notes.find((o) => o.id !== n.id &&
        Math.abs((mode === 'resize-l' ? o.start + o.dur : o.start) - end) < tol);
      if (partner) {
        const left = mode === 'resize-l' ? partner : n;
        const right = mode === 'resize-l' ? n : partner;
        console.log('[Roll] 邊界綁定', left.id, '|', right.id);
        selBeforeEdgeRef.current = selectedIds; // 暫時選兩顆,放開還原原本選取
        const origs = { [left.id]: { ...left }, [right.id]: { ...right } };
        setSelectedIds([left.id, right.id]);
        const { x, y } = toXY(e);
        setDrag({
          mode: 'edge', ids: [left.id, right.id], origs, leftId: left.id, rightId: right.id,
          grabOffsetBeat: x / ppb - secToBeats(n.start, tempo),
          row0: Math.floor(y / kh), refMidi: n.midi, refId: n.id,
        });
        setEditingId(null);
        return;
      }
    }
    let ids = selectedIds.includes(n.id) ? selectedIds : [n.id];
    if (mode === 'move' && e.shiftKey && !selectedIds.includes(n.id)) {
      ids = [...selectedIds, n.id];
    }
    if (mode !== 'move') ids = [n.id];
    setSelectedIds(ids);
    const { x, y } = toXY(e);
    const origs = {};
    project.notes.forEach((m) => { if (ids.includes(m.id)) origs[m.id] = { ...m }; });
    setDrag({
      mode, ids, origs,
      grabOffsetBeat: x / ppb - secToBeats(n.start, tempo),
      row0: Math.floor(y / kh), refMidi: n.midi, refId: n.id,
    });
    setEditingId(null);
  };

  const startMarquee = (x, y, additive) => {
    setDrag({ mode: 'marquee', x0: x, y0: y, x1: x, y1: y, additive: !!additive });
    if (!panRef.current.raf) panRef.current.raf = requestAnimationFrame(panTick);
  };

  // 框選自動捲動:指標接近可視邊緣就開始往那邊捲(越貼越快),滑出後用最後速度繼續捲,放開才停
  const panRef = useRef({ vx: 0, vy: 0, cx: null, cy: null, raf: 0 });
  const panFeed = (e) => {
    const el = rollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const Z = 44, MAX = 12; // 邊緣感應帶 44px;最快 12px/幀
    const sp = (d) => (d >= Z ? 0 : Math.max(2, Math.round(MAX * Math.min(1, (Z - Math.max(d, 0)) / Z))));
    const dL = e.clientX - r.left, dR = r.right - e.clientX;
    const dT = e.clientY - r.top, dB = r.bottom - e.clientY;
    panRef.current.vx = dL < Z ? -sp(dL) : dR < Z ? sp(dR) : 0;
    panRef.current.vy = dT < Z ? -sp(dT) : dB < Z ? sp(dB) : 0;
    panRef.current.cx = e.clientX;
    panRef.current.cy = e.clientY;
  };
  const panTick = () => {
    const p = panRef.current;
    p.raf = 0;
    const el = rollRef.current;
    if (el && p.cx != null && (p.vx || p.vy)) {
      el.scrollLeft += p.vx;
      el.scrollTop += p.vy;
      // 捲動後把凍結的指標位置換算回內容座標 → 框選終點跟著長(放開前一直延續)
      const r = el.getBoundingClientRect();
      setDrag((d) => (d && d.mode === 'marquee' ? { ...d, x1: el.scrollLeft + (p.cx - r.left), y1: el.scrollTop + (p.cy - r.top) } : d));
    }
    p.raf = requestAnimationFrame(panTick);
  };

  // 吸附結果 → 秒:吸到音符邊緣用對方的精確秒值(免 beats 往返);格線才換算
  const resSec = (res) => (res.sec != null ? res.sec : beatsToSec(res.beat, tempo));

  const applyDrag = (e) => {
    if (!drag) return;
    const { x, y } = toXY(e);
    if (drag.mode === 'marquee') {
      panFeed(e);
      setDrag({ ...drag, x1: x, y1: y });
      return;
    }
    const refOrig = drag.origs[drag.refId];
    let newPos = null; // id → { start, midi, dur }（拖曳後位置；以 origs 為基準，逐帧重算冪等）
    if (drag.mode === 'move') {
      const res = snapHere(x / ppb - drag.grabOffsetBeat, drag.ids, e);
      const dSec = resSec(res) - refOrig.start;
      const dRow = Math.floor(y / kh) - drag.row0;
      setSnapGuide(res.snappedTo ? { beat: res.beat, kind: res.snappedTo } : null);
      newPos = {};
      for (const id of drag.ids) {
        const o = drag.origs[id];
        newPos[id] = {
          start: Math.max(0, o.start + dSec),
          midi: Math.max(LOW, Math.min(HIGH, o.midi - dRow)),
          dur: o.dur,
        };
      }
      // 拖曳跨列發聲:換列平滑滑頻到新音高(不重觸發;同列不動)
      const nm = newPos[drag.refId]?.midi;
      if (nm != null && nm !== drag.soundedMidi) {
        drag.soundedMidi = nm;
        console.log('[Roll] 拖曳滑頻 → midi=', nm, midiToName(nm), 'freq=', midiToFreq(nm).toFixed(1));
        keySoundGlide(midiToFreq(nm));
      }
    } else if (drag.mode === 'edge') {
      // a|b 共用邊界一起動:往右 b 縮 a 長、往左 a 縮 b 長;同一個 tar 永不互撞
      // 極限=縮到 1px 寬(眼睛看不出來);吸附排除這兩顆(不然會吸到自己的邊界)
      const res = snapHere(x / ppb, drag.ids, e);
      const minDur = Math.max(0.004, 60 / (tempo || 120) / ppb);
      const a = drag.origs[drag.leftId], b = drag.origs[drag.rightId];
      const t = Math.min(Math.max(resSec(res), a.start + minDur), b.start + b.dur - minDur);
      setSnapGuide(res.snappedTo ? { beat: secToBeats(t, tempo), kind: res.snappedTo } : null);
      newPos = {
        [drag.leftId]: { start: a.start, midi: a.midi, dur: t - a.start },
        [drag.rightId]: { start: t, midi: b.midi, dur: b.start + b.dur - t },
      };
    } else if (drag.mode === 'resize-r') {
      const res = snapHere(x / ppb, drag.ids, e);
      const tar = resSec(res);
      setSnapGuide(res.snappedTo ? { beat: res.beat, kind: res.snappedTo } : null);
      newPos = {};
      for (const id of drag.ids) {
        const o = drag.origs[id];
        if (!o) continue;
        newPos[id] = { start: o.start, midi: o.midi, dur: Math.max(tar - o.start, 0.01) };
      }
    } else if (drag.mode === 'resize-l') {
      const res = snapHere(x / ppb, drag.ids, e);
      const tar = resSec(res);
      setSnapGuide(res.snappedTo ? { beat: res.beat, kind: res.snappedTo } : null);
      newPos = {};
      for (const id of drag.ids) {
        const o = drag.origs[id];
        if (!o) continue;
        const end = o.start + o.dur;
        const s = Math.min(Math.max(0, tar), end - 0.01);
        newPos[id] = { start: s, midi: o.midi, dur: end - s };
      }
    }
    if (!newPos) return;
    if (!drag.logged) { drag.logged = true; console.log('[Roll] applyDrag 首幀', drag.mode, JSON.stringify(newPos)); }
    setProject((p) => {
      const notes = p.notes.map((n) => (newPos[n.id] ? { ...n, ...newPos[n.id] } : n));
      return {
        ...p,
        notes,
        // F0 原子共更(手動點存 rel 推導):拖曳中不會出現「音符已動、點還沒動」的壞線幀
        f0: reconcileF0(notes, p.f0, project.glide),
      };
    });
  };

  const finishDrag = () => {
    if (panRef.current.raf) { cancelAnimationFrame(panRef.current.raf); panRef.current.raf = 0; }
    panRef.current.cx = null; panRef.current.cy = null;
    // keySoundUp 只在真的有音符拖曳時收(svg-mouseleave 亂殺 = 按住琴鍵滑進 roll 再滑回來,琴音被砍又重響 = 爆)
    if (drag) { console.log('[Roll] finishDrag mode=', drag.mode, '→ keySoundUp'); keySoundUp(); }
    if (drag?.mode === 'marquee') {
      const [a, b] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
      const [c, d] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
      const ids = project.notes.filter((n) => {
        const g = noteGeom(n);
        return g.x < b && g.x + g.w > a && g.y < d && g.y + kh > c;
      }).map((n) => n.id);
      console.log('[Roll] 框選結果', ids.length ? ids.join(',') : '(空)');
      setSelectedIds(drag.additive ? [...new Set([...selectedIds, ...ids])] : ids);
    } else if (drag) {
      if (drag.mode === 'edge' && selBeforeEdgeRef.current) {
        setSelectedIds(selBeforeEdgeRef.current); // 放開:還原本來選的那個
      }
      selBeforeEdgeRef.current = null;
      console.log('[Roll] mouseup(拖曳收尾)', drag.mode);
    }
    setDrag(null);
    setSnapGuide(null);
  };

  // ---------- 事件 ----------
  const onBgDown = (e) => {
    if (e.target.closest('[data-note]')) return;
    // 指標捕獲:拖出 svg/視窗外仍持續收到 move/up(在外放開也能正常收尾,滑出去不再中斷)
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    if (tool === 'pen') { const { x, y } = toXY(e); startPen(x, y, e); return; }
    const { x, y } = toXY(e);
    if (e.button !== 0) return;
    console.log('[Roll] mousedown 空白(框選起點)');
    // 左鍵拖空白 = 框選（Shift=加選）；沒拖成框（純點擊）在 finishDrag 清空選取
    startMarquee(x, y, e.shiftKey);
  };
  // rAF 節流：一帧只處理一次 mousemove
  const moveRafRef = useRef(0);
  const pendingMoveRef = useRef(null);
  const onMove = (e) => {
    pendingMoveRef.current = e;
    if (moveRafRef.current) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = 0;
      const ev = pendingMoveRef.current;
      if (!ev) return;
      const { x, y } = toXY(ev);
      if (penStroke) { continuePen(x, y); return; }
      applyDrag(ev);
    });
  };
  const onUp = (reason) => {
    if (drag) console.log('[Roll] svg onUp 原因=', reason || '?');
    cancelAnimationFrame(moveRafRef.current); moveRafRef.current = 0; pendingMoveRef.current = null; endPen(); finishDrag();
  };

  const onDblClickNote = (e, n) => {
    e.stopPropagation();
    setEditingId(n.id);
    setSelectedIds([n.id]);
  };

  // ---------- split(select 工具右鍵點音符 = 在游標處切成兩顆) ----------
  // 選取段整體放慢/變快:從區段開頭等比拉伸(位置+長度),後面的音符留在原地(可能疊)
  // F0:掛在選取音符上的手動點 off 跟著縮(相對位置不變);區間內的絕對/✗ 點對 t0 等比縮
  const stretchNotes = (ids, k) => {
    const sel = project.notes.filter((q) => ids.includes(q.id));
    if (!sel.length) return;
    const t0 = Math.min(...sel.map((q) => q.start));
    const t1 = Math.max(...sel.map((q) => q.start + q.dur));
    const idset = new Set(ids);
    setProject((p) => {
      const notes = p.notes.map((q) => (!idset.has(q.id) ? q : {
        ...q, start: t0 + (q.start - t0) * k, dur: Math.max(0.01, q.dur * k),
        phDurs: (q.phDurs || []).map((d) => d * k),
      }));
      const f0 = (p.f0 || []).map((pt) => {
        if (pt.manual && Number.isFinite(pt.off)) return idset.has(pt.anchorId) ? { ...pt, off: pt.off * k } : pt;
        return (pt.t >= t0 - 1e-6 && pt.t <= t1 + 1e-6) ? { ...pt, t: t0 + (pt.t - t0) * k } : pt;
      });
      return { ...p, notes, f0: reconcileF0(notes, f0, p.glide) };
    });
  };

  const splitNoteAt = (n, x) => {
    const res = snapHere(x / ppb, [n.id], null); // 排除自己:不然游標近自己起點會吸回邊界
    const minDur = Math.max(0.004, 60 / (tempo || 120) / ppb); // 1px
    const s = Math.min(Math.max(resSec(res), n.start + minDur), n.start + n.dur - minDur);
    if (s - n.start < minDur || n.start + n.dur - s < minDur) { console.log('[Roll] split 太貼邊,不切'); return; }
    const r = (s - n.start) / n.dur;
    const scale = (arr) => (Array.isArray(arr) ? arr.map((d) => d * r) : undefined);
    const id2 = nextId();
    console.log('[Roll] split', n.id, '@', s.toFixed(3), '→ 前顆', (s - n.start).toFixed(3), 's + 後顆', id2, 'word=', wordVowel(n.word));
    setProject((p) => ({
      ...p,
      notes: p.notes.flatMap((m) => (m.id !== n.id ? [m] : [
        // 前顆:保 word,ph 切分按時間比例縮
        { ...m, dur: s - m.start, phDurs: scale(m.phDurs), phRatios: scale(m.phRatios) },
        // 後顆:取母音(to→o),預設切分
        { ...m, id: id2, start: s, dur: m.start + m.dur - s, word: wordVowel(m.word), phDurs: undefined, phRatios: undefined },
      ])),
    }));
    setSelectedIds([n.id, id2]);
  };
  const commitEdit = (id, text) => {
    const w = text.trim() || 'a';
    console.log(`[F0W] commitEdit note=${id} word=${JSON.stringify(w)} 手動點前=`, JSON.stringify((project.f0 || []).filter((x) => x.manual).map((x) => ({ id: x.id, t: +x.t.toFixed(3), f: +x.f.toFixed(1), a: x.anchorId, off: x.off == null ? null : +x.off.toFixed(3), fp: x.fp == null ? null : +x.fp.toFixed(3) }))));
    setProject((p) => {
      // 空格分割多音節:依時間序從這顆 note 起逐一覆蓋後續音符的 word
      // (ex「to o ku to mo su yo zo ra ni」→ 依序填進後面每顆;token 多於音符就丟棄,ph 切分重置為預設)
      const toks = w.split(/\s+/).filter(Boolean);
      if (toks.length <= 1) {
        return { ...p, notes: p.notes.map((n) => (n.id === id ? { ...n, word: w, phDurs: undefined, phRatios: undefined } : n)) };
      }
      const sorted = [...p.notes].sort((a, b) => a.start - b.start);
      const idx = sorted.findIndex((n) => n.id === id);
      if (idx < 0) return p;
      const targets = sorted.slice(idx, idx + toks.length);
      const assign = new Map(targets.map((n, i) => [n.id, toks[i]]));
      return {
        ...p,
        notes: p.notes.map((n) => (assign.has(n.id)
          ? { ...n, word: assign.get(n.id), phDurs: undefined, phRatios: undefined }
          : n)),
      };
    });
    setEditingId(null);
  };

  // ---------- 背景 ----------
  // 格線依層級遞減亮度：母級最亮，每往下一級 opacity 減半
  const gridLines = useMemo(() => {
    const lines = [];
    const totalBeats = BARS * 4;
    levels.forEach((step, lv) => {
      const opacity = Math.pow(0.55, lv + 0); // 0.55, 0.30, 0.17, ...
      const col = `#c8c8e0`;
      const w = lv === 0 ? 1.6 : 1;
      const n = Math.round(totalBeats / step);
      for (let i = 0; i <= n; i++) {
        const b = i * step;
        // 跳過已被上一（更粗）層級畫過的線
        if (lv > 0 && Math.abs(b / levels[lv - 1] - Math.round(b / levels[lv - 1])) < 1e-9) continue;
        lines.push(<line key={`${lv}-${i}`} x1={b * ppb} y1={0} x2={b * ppb} y2={totalH}
          stroke={col} strokeWidth={w} opacity={opacity} />);
      }
    });
    return lines;
  }, [ppb, levels, totalH]);

  const rowBg = useMemo(() => {
    const rows = [];
    for (let m = HIGH; m >= LOW; m--) {
      rows.push(<rect key={m} x={0} y={midiToY(m)} width={totalW} height={kh}
        fill={isBlackKey(m) ? '#1d1d28' : '#2a2a3a'} stroke="#16161e" strokeWidth={0.5} />);
    }
    return rows;
  }, [totalW, kh]);

  // ---------- F0 疊加 ----------
  const f0Paths = useMemo(() => {
    return splitSegments(activeF0(project.f0), project.notes).map((seg) =>
      buildF0Path(seg, (t) => secToX(t), (f) => midiToF0Y(f, kh)));
  }, [project.f0, project.notes, secToX, kh]);

  const strokePath = useMemo(() => {
    if (!penStroke || penStroke.erase || !penStroke.s.length) return '';
    return penStroke.s.map((pt, i) =>
      `${i ? 'L' : 'M'}${secToX(pt.t).toFixed(1)},${midiToF0Y(pt.f, kh).toFixed(1)}`).join(' ');
  }, [penStroke, secToX, kh]);

  const editingNote = editingId ? project.notes.find((n) => n.id === editingId) : null;

  // ---------- 時間尺規(點擊/拖曳 = seek 播放頭) ----------
  const rulerInnerRef = useRef(null);
  const rulerDragRef = useRef(false);
  const secPerPxRuler = 60 / (tempo || 120) / (ppb || 120);
  const rulerMarks = useMemo(() => {
    const marks = [];
    const barW = 4 * ppb;
    const step = barW >= 56 ? 1 : barW * 4 >= 56 ? 4 : 16; // 依縮放決定每幾小節一個標籤
    for (let b = 0; b <= BARS; b += step) {
      marks.push({ beat: b * 4, x: b * 4 * ppb, label: String(b + 1) });
    }
    return marks;
  }, [ppb]);
  const seekFromEvent = (e) => {
    if (!seekTo || !rulerInnerRef.current) return;
    const x = e.clientX - rulerInnerRef.current.getBoundingClientRect().left;
    seekTo(Math.max(0, x * secPerPxRuler));
  };
  const onRulerDown = (e) => {
    if (e.button !== 0 || !seekTo) return;
    e.stopPropagation();
    seekFromEvent(e);
    rulerDragRef.current = true;
    const mv = (ev) => { if (rulerDragRef.current) seekFromEvent(ev); };
    const up = () => { rulerDragRef.current = false; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') { setEditingId(null); setNoteMenu(null); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => {
    if (!noteMenu) return undefined;
    const close = () => setNoteMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [noteMenu]);

  return (
    <div className="piano-roll-wrap">
      <div className="roll-area">
      {seekTo && (
        <div className="ruler" onPointerDown={onRulerDown}
          title="點擊/拖曳:移動播放頭(橘線);Ctrl+V 貼上時若滑鼠在 roll 內,以滑鼠位置為錨">
          <div className="playhead-line" />
          <div className="ruler-inner" ref={rulerInnerRef} style={{ width: totalW }}>
            {rulerMarks.map((m) => (
              <div key={m.beat} className="ruler-tick" style={{ left: m.x }}>{m.label}</div>
            ))}
          </div>
        </div>
      )}
      <div className="roll-body">
      <div className="keys-col" ref={keysRef}
        onPointerLeave={() => {
          if (pressedMidiRef.current != null) console.log('[Roll] 琴鍵欄 pointerleave(按住中離開!)midi=', pressedMidiRef.current);
        }}
        onWheel={(e) => {
          // 音名欄上滾動 → 轉嫁給 roll(垂直);Ctrl+滾輪留給縮放(NoteEditorApp 處理)
          if (rollRef.current && !e.ctrlKey) rollRef.current.scrollTop += e.deltaY;
        }}>
        {Array.from({ length: ROWS }, (_, i) => HIGH - i).map((m) => (
          <div key={m}
            className={`key-label ${isBlackKey(m) ? 'black' : ''} ${pressedKey === m ? 'on' : ''}`}
            style={{ height: kh, lineHeight: `${kh}px`, fontSize: Math.min(10, kh - 4) }}
            title={`${midiToName(m)} — 按住發聲,滑過換音`}
            onPointerDown={(e) => {
              e.preventDefault();
              console.log('[Roll] 琴鍵 DOWN midi=', m, midiToName(m), 'freq=', midiToFreq(m).toFixed(1), 'button=', e.button);
              pressedMidiRef.current = m;
              setPressedKey(m);
              keySoundDown(midiToFreq(m));
            }}
            onPointerEnter={() => {
              if (pressedMidiRef.current != null && pressedMidiRef.current !== m) {
                console.log('[Roll] 琴鍵 SLIDE', pressedMidiRef.current, '→', m, midiToName(m));
                pressedMidiRef.current = m;
                setPressedKey(m);
                keySoundGlide(midiToFreq(m)); // 按住滑過 = 平滑滑頻(撥弦感)
              }
            }}>
            {m % 12 === 0 ? midiToName(m) : ''}
          </div>
        ))}
      </div>
      <div className="roll-scroll" ref={rollRef}
        onScroll={(e) => {
          if (keysRef.current) keysRef.current.scrollTop = e.currentTarget.scrollTop;
          if (rulerInnerRef.current) rulerInnerRef.current.style.transform = `translateX(${-e.currentTarget.scrollLeft}px)`;
        }}
        onContextMenu={(e) => e.preventDefault()}>
        {/* mouseleave 不綁:pointer capture 只攔 pointer 事件,原生 mouseleave 照樣在滑出時觸發 = 拖曳被亂殺;
            capture 已保證 mouseup 在視窗外放開也會送到 svg 收尾 */}
        <svg ref={svgRef} width={totalW} height={totalH} className={`roll tool-${tool}`}
          onMouseDown={onBgDown} onMouseMove={onMove} onMouseUp={() => onUp('svg-mouseup')}
          onDoubleClick={(e) => {
            e.preventDefault();
            if (tool === 'select' && !e.target.closest('[data-note]')) {
              const { x, y } = toXY(e);
              createNoteAt(x, y);
            }
          }}>
          {rowBg}
          {gridLines}

          {/* 音符 */}
          {project.notes.map((n) => {
            const g = noteGeom(n);
            const sel = selectedIds.includes(n.id);
            const conflict = conflictIds.has(n.id);
            // 四態:一般藍 / 選取橘 / 衝突灰+紅框 / 選取+衝突 = 橙褐+紅框(同時表達兩種狀態)
            const both = sel && conflict;
            const fill = both ? '#c9855c' : conflict ? '#565660' : sel ? '#ffb454' : '#4fa3ff';
            const stroke = conflict ? '#ff5a5a' : sel ? '#ffe0ac' : '#a8d0ff';
            return (
              <g key={n.id} data-note="1">
                <rect x={g.x} y={g.y + 1} width={g.w} height={kh - 2} rx={2}
                  fill={fill} stroke={stroke} strokeWidth={conflict ? 1.5 : 1}
                  style={{ cursor: tool === 'pen' ? 'crosshair' : 'move' }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (tool === 'pen') { const { x, y } = toXY(e); startPen(x, y, e); }
                    else if (e.button === 2) {
                      // 右鍵:選單(分割於此/刪除/屬性/複製/剪下);不在選取內就單選
                      if (!selectedIds.includes(n.id)) setSelectedIds([n.id]);
                      const { x } = toXY(e);
                      const res = snapHere(x / ppb, [n.id], null);
                      setNoteMenu({ clientX: e.clientX, clientY: e.clientY, svgX: x, noteId: n.id, splitT: resSec(res) });
                    }
                    else { console.log('[Roll] 音符點按 發聲 midi=', n.midi, midiToName(n.midi)); keySoundDown(midiToFreq(n.midi)); startMoveOrResize(e, n, 'move'); }
                  }}
                  onDoubleClick={(e) => onDblClickNote(e, n)} />
                <rect x={g.x} y={g.y + 1} width={EDGE_PX} height={kh - 2} fill="transparent"
                  style={{ cursor: 'ew-resize' }} onMouseDown={(e) => { e.stopPropagation(); startMoveOrResize(e, n, 'resize-l'); }} />
                <rect x={g.x + g.w - EDGE_PX} y={g.y + 1} width={EDGE_PX} height={kh - 2} fill="transparent"
                  style={{ cursor: 'ew-resize' }} onMouseDown={(e) => { e.stopPropagation(); startMoveOrResize(e, n, 'resize-r'); }} />
                {editingId !== n.id && kh >= 10 && (
                  <text x={g.x + 3} y={g.y + kh - 3} fontSize={Math.min(10, kh - 3)} fill={both || conflict ? '#ffd9c9' : sel ? '#0d1a26' : '#0d1a26'} pointerEvents="none">
                    {n.word}
                  </text>
                )}
              </g>
            );
          })}

          {/* 磁吸參考線 */}
          {snapGuide && (
            <line x1={snapGuide.beat * ppb} y1={0} x2={snapGuide.beat * ppb} y2={totalH}
              stroke={snapGuide.kind === 'edge' ? '#ffb454' : '#66d9ff'} strokeWidth={1.2}
              strokeDasharray={snapGuide.kind === 'edge' ? '' : '4 3'} pointerEvents="none" />
          )}

          {/* F0 曲線（間隙不畫線） */}
          {f0Paths.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round"
              opacity={0.85} pointerEvents="none" />
          ))}
          {strokePath && <path d={strokePath} fill="none" stroke="#ffd166" strokeWidth={2} pointerEvents="none" />}

          {/* 框選矩形 */}
          {drag?.mode === 'marquee' && (
            <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)}
              width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)}
              fill="#4fa3ff22" stroke="#4fa3ff" strokeDasharray="4 3" pointerEvents="none" />
          )}
        </svg>
        <WaveOverlay wave={wave} inferring={inferring} kh={kh} tempo={tempo} ppb={ppb} />

        {editingNote && (
          <input
            className="inline-edit"
            autoFocus
            defaultValue={editingNote.word}
            style={{
              left: noteGeom(editingNote).x + 2,
              // 浮在音符上方:蓋在音符上會吃掉 mousedown,新建的音符會拖不動
              top: Math.max(1, noteGeom(editingNote).y - 16),
              width: Math.max(noteGeom(editingNote).w + 8, 70),
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(editingNote.id, e.currentTarget.value); }}
            onBlur={(e) => commitEdit(editingNote.id, e.target.value)}
          />
        )}
      </div>
      </div>
      {noteMenu && (() => {
        const n = project.notes.find((q) => q.id === noteMenu.noteId);
        if (!n) return null;
        const multi = selectedIds.length > 1;
        const ids = selectedIds.includes(n.id) ? selectedIds : [n.id];
        const items = [
          { label: '分割於此', act: () => splitNoteAt(n, noteMenu.svgX) },
          { label: '放慢一倍', act: () => stretchNotes(ids, 2) },
          { label: '變快一倍', act: () => stretchNotes(ids, 0.5) },
          { label: '刪除' + (multi ? `(${selectedIds.length}顆)` : ''), danger: true, act: () => { onDeleteNotes && onDeleteNotes(selectedIds.includes(n.id) ? selectedIds : [n.id]); } },
          { label: '屬性(音素/時長)', act: () => { onNoteProps && onNoteProps(); } },
          { sep: true },
          { label: '複製', act: () => onCopySel && onCopySel() },
          { label: '剪下', act: () => onCutSel && onCutSel() },
        ];
        return (
          <div className="note-ctxmenu" style={{ left: noteMenu.clientX, top: noteMenu.clientY }} onMouseDown={(e) => e.stopPropagation()}>
            {items.map((it, i) => (it.sep
              ? <div key={i} className="sep" />
              : <button key={i} className={it.danger ? 'danger' : ''} onClick={() => { it.act(); setNoteMenu(null); }}>{it.label}</button>))}
          </div>
        );
      })()}
      <div className="playhead-overlay"><div className="playhead-line" /></div>
      </div>
    </div>
  );
}

// memo:播放中父層 4Hz 重渲染(audioUI.t)不再牽動整顆 SVG 重繪
export default memo(PianoRollInner);
