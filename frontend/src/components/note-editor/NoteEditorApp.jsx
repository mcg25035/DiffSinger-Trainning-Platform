import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PianoRoll from './components/PianoRoll.jsx';
import PhonemeEditor from './components/PhonemeEditor.jsx';
import F0Editor from './components/F0Editor.jsx';
import RollHints from './components/RollHints.jsx';
import Toolbar from './components/Toolbar.jsx';
import { emptyProject } from './lib/project.js';
import { reconcileF0, activeF0, phrases, phraseHash, synthItems } from './lib/f0hybrid.js';
import { nextId, midiToFreq } from './lib/music.js';
import { keySoundPlaySequence, keySoundStopSequence, keySoundSeqActive, keySoundSeqPos, keySoundBaseFreq, keySoundCtx } from './lib/keySound.js';
import './note-editor.css';

// HTML audio 硬停(pause)也會把波形切半 = 啪:volume 淡到 0 再 pause,完畢後恢復音量並回呼
// ⚠ <audio> 的 volume 變更被瀏覽器按處理區塊量化、rAF 一 tick ~16ms — 這條路做不到 5ms,壓到 ~20ms(兩步)是下限
function fadePause(a, then = null) {
  if (!a || a.paused) { then?.(); return; }
  const v0 = a.volume, t0 = performance.now();
  const step = () => {
    if (a.paused) { a.volume = v0; then?.(); return; }
    const k = 1 - (performance.now() - t0) / 20;
    if (k <= 0) { a.pause(); a.volume = v0; then?.(); return; }
    a.volume = Math.max(0.001, v0 * k);
    requestAnimationFrame(step);
  };
  step();
}
/**
 * 平台整合版（原 svs-note-editor App.jsx）：
 * - props.phonemes：外部塞入音素清單（平台辭典），其餘不用動
 * - props.onProjectChange：每次 project 變動回報（上層存 ref 給推理 POST 用）
 * - root class 改 note-editor-root（CSS 全部 scope 在下面，不漏到平台）
 * - localStorage key 改 inference-note-editor
 *
 * 快捷鍵：
 * - S：切換磁吸
 * - B：畫筆 / V：選取
 * - P：Phoneme 面板開關
 * - T：F0 面板開關
 * - Delete/Backspace：刪除選取音符
 * - Ctrl+滾輪：縮放網格（由 PianoRoll 外層攔截）
 *
 * @param {{ phonemes?: string[] | null, phMap?: object | null, phRev?: object | null, onProjectChange?: ((p: any) => void) | null, wavs?: string[] | null, inferring?: boolean | null, submitTick?: number }} props
 */
export default function NoteEditorApp({ phonemes = null, phMap = null, phRev = null, onProjectChange = null, wavs = [], inferring = false, submitTick = 0, actions = null, settingsExtra = null }) {  const [project, setProjectRaw] = useState(() => {
    try {
      const saved = localStorage.getItem('inference-note-editor');
      if (!saved) return emptyProject();
      const p = { ...emptyProject(), ...JSON.parse(saved) };
      // 舊資料遷移：kind 缺漏的 f0 點（舊版畫筆產生）補上 'curve'
      p.f0 = (p.f0 || []).map((pt) => ({ ...pt, kind: pt.kind ?? 'curve' }));
      return p;
    } catch { return emptyProject(); }
  });
  const [historyTick, setHistoryTick] = useState(0);
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const dirtyRef = useRef(false); // push 後到 commit 前 = true(同批多次 setProject 只 push 一次)
  const pendingRef = useRef(null); // 同批多次 setProject 的累積結果(commit 後清空;updater 一律在最新基底上試算)

  // 指標互動邊界:按著滑鼠期間的連續變更(拖曳)合併成一步;放開後的下一次變更永遠另起一步
  const pointerDownRef = useRef(false);
  const kbMergeRef = useRef(0); // 鍵盤重複(按住方向鍵移調)的合併窗:上次鍵盤變更 400ms 內併同一步
  const f0SelRef = useRef(null); // F0 控制點選取中(id):Del 優先刪點、不刪音符
  useEffect(() => {
    const d = () => { pointerDownRef.current = true; };
    const u = () => { pointerDownRef.current = false; };
    window.addEventListener('pointerdown', d, { capture: true });
    window.addEventListener('pointerup', u, { capture: true });
    window.addEventListener('pointercancel', u, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', d, { capture: true });
      window.removeEventListener('pointerup', u, { capture: true });
      window.removeEventListener('pointercancel', u, { capture: true });
    };
  }, []);

  // 掛載初始化窗:載入正規化/reconcile 的 setProject 不進 undo 歷史(不然 undo 要按好幾下垃圾步才到使用者的操作)
  const readyRef = useRef(false);
  useEffect(() => {
    const h = setTimeout(() => { readyRef.current = true; }, 100);
    return () => clearTimeout(h);
  }, []);

  // 包裝 setProject:updater 先在「最新基底」(commit 後 = project;同批未 commit = 前一次結果)試算:
  // - no-op(算回同一顆物件)→ 不推快照、不佔 dirty(否則 no-op effect 會塞垃圾步 + 卡死下一個真動作的快照)
  // - 有變 → 快照決策(拖曳中合併/初始化窗跳過)後以「值」形式提交;副作用全在 updater 外
  const lastChangeRef = useRef(0);
  const setProject = useCallback((updater) => {
    const base = pendingRef.current ?? projectRefNotes.current;
    const next = typeof updater === 'function' ? updater(base) : updater;
    const now = Date.now();
    lastChangeRef.current = now;
    if (next === base) return;
    const merging = readyRef.current && (pointerDownRef.current || now - kbMergeRef.current <= 400);
    if (readyRef.current && !merging && !dirtyRef.current) {
      pastRef.current.push(base);
      if (pastRef.current.length > 300) pastRef.current.shift();
      futureRef.current = [];
      dirtyRef.current = true;
      setHistoryTick((t) => t + 1);
    }
    pendingRef.current = next;
    setProjectRaw(next);
  }, []);

  const undo = useCallback(() => {
    const p = pastRef.current.pop();
    if (!p) return;
    futureRef.current.push(projectRefNotes.current);
    lastChangeRef.current = 0; // undo 後的下一次變更必須另起快照,不可被併入 undo 前的時間窗
    dirtyRef.current = false;
    pendingRef.current = null;
    setHistoryTick((t) => t + 1);
    setProjectRaw(p);
  }, []);

  const redo = useCallback(() => {
    const f = futureRef.current.pop();
    if (!f) return;
    pastRef.current.push(projectRefNotes.current);
    lastChangeRef.current = 0;
    dirtyRef.current = false;
    pendingRef.current = null;
    setHistoryTick((t) => t + 1);
    setProjectRaw(f);
  }, []);
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedId = selectedIds[selectedIds.length - 1] ?? null;
  const [tool, setTool] = useState('select');
  const [showPhoneme, setShowPhoneme] = useState(false); // 預設關:右鍵「屬性」或工具列 P 才開;關閉後選別的音符不會自動彈出
  const [showF0, setShowF0] = useState(true);
  const appRef = useRef(null);

  useEffect(() => {
    const h = setTimeout(() => localStorage.setItem('inference-note-editor', JSON.stringify(project)), 300);
    return () => clearTimeout(h);
  }, [project]);

  const projectRefNotes = useRef(project);
  projectRefNotes.current = project;
  if (pendingRef.current && pendingRef.current !== project) {
    // commit 已落地且不等於 pending → 清空(pending 只在「同批未 commit」期間有值)
    pendingRef.current = null;
  }
  dirtyRef.current = false;

  // 臨時 debug:讓送出端對照 projectRef 是否過期(診斷完拆)
  useEffect(() => { window.__editorProject = project; }, [project]);

  // 平台注入（phonemes/phMap/phRev 變動時整包塞進 project，同 Toolbar MFA 匯入的形狀）
  useEffect(() => {
    if (phonemes == null) return;
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    setProject((p) => (same(p.phonemes, phonemes) && same(p.phMap, phMap) && same(p.phRev, phRev)
      ? p
      : { ...p, phonemes, phMap: phMap ?? null, phRev: phRev ?? null }));
  }, [phonemes, phMap, phRev]);

  // ---- 播放引擎(最新一次推論的 wav;全域橘色指針 + 播放換頁) ----
  const audioRef = useRef(null);
  const [audioUI, setAudioUI] = useState({ playing: false, t: 0, dur: 0 });
  const [wave, setWave] = useState(null); // { pk: Float32Array 交錯 min/max, spb: 每桶秒數, dur }
  const rafRef = useRef(0);
  const lastUiRef = useRef(0);
  const wavsRef = useRef(wavs);
  wavsRef.current = wavs;
  const inferringRef = useRef(inferring);
  inferringRef.current = inferring;
  const seqDurRef = useRef(0); // 合成預覽的總長(尾端停止用)
  const submitTickRef = useRef(0);
  const phraseSnapRef = useRef(null); // 送出當下的樂句指紋 Set(播放時比對「這句動過沒」)
  const wavBufRef = useRef(null);     // 最新渲染 wav 的 AudioBuffer(混合播放用)
  const mixedRef = useRef(null);      // 混合播放 { sources, t0, fromT, end }

  // 拍快照:樂句 → 指紋
  const snapPhrases = useCallback(() => {
    const p = projectRefNotes.current;
    if (!p) return;
    const curve = activeF0(p.f0);
    phraseSnapRef.current = new Set(phrases(p.notes).map((ph) => phraseHash(ph, p.notes, curve)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 送出推論 → 拍樂句快照(wav = 這個狀態的渲染;之後動過的句子播放時換合成器)
  useEffect(() => {
    submitTickRef.current = submitTick;
    if (submitTick > 0) snapPhrases();
  }, [submitTick, snapPhrases]);

  const secPerPxRef = useRef(0);
  secPerPxRef.current = 60 / (project.tempo || 120) / (project.ppb || 120);

  // 指針畫更新 + 換頁:所有 .playhead-line(roll/F0 各一段)推到游標時間的位置
  const cursorTRef = useRef(0); // 播放頭時間(秒)= 尺規點擊 seek 的錨,也是貼上錨點;播放中跟著音檔走
  const updateHeads = useCallback(() => {
    const a = audioRef.current, root = appRef.current;
    if (!root) return;
    const rs = root.querySelector('.roll-scroll');
    const t = cursorTRef.current;
    const x = t / secPerPxRef.current - (rs?.scrollLeft ?? 0);
    root.querySelectorAll('.playhead-line').forEach((el) => { el.style.transform = `translateX(${x}px)`; });
    // 換頁:播放中指針超過視窗 85% → 下一頁(指針落在新頁 10% 處)
    if (rs && a && !a.paused && x > rs.clientWidth * 0.85) {
      rs.scrollLeft = t / secPerPxRef.current - rs.clientWidth * 0.1;
    }
  }, []);

  // 尺規點擊/拖曳 seek(沒載入音檔時也能移動播放頭;播放中 = 跳播)
  const seekTo = useCallback((t) => {
    const a = audioRef.current;
    cursorTRef.current = Math.max(0, t);
    if (a && a.src) { try { a.currentTime = cursorTRef.current; } catch { /* metadata 未載入 */ } }
    updateHeads();
    setAudioUI((u) => ({ ...u, t: cursorTRef.current }));
  }, [updateHeads]);

  const stopLoop = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; } };
  const loop = useCallback(() => {
    const a = audioRef.current;
    if (a && !a.paused) cursorTRef.current = a.currentTime;
    else if (mixedRef.current) {
      cursorTRef.current = mixedPos();
      if (!mixedActive()) { // 混合播完
        keySoundStopSequence();
        setAudioUI((u) => ({ ...u, playing: false, t: 0 }));
        cursorTRef.current = 0;
        updateHeads();
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
    }
    else if (keySoundSeqActive()) {
      cursorTRef.current = keySoundSeqPos();
      if (cursorTRef.current >= seqDurRef.current - 0.02) { // 播完
        keySoundStopSequence();
        setAudioUI((u) => ({ ...u, playing: false, t: 0 }));
        cursorTRef.current = 0;
        updateHeads();
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
    }
    updateHeads();
    const now = performance.now();
    if (a && now - lastUiRef.current > 250) { // 工具列時間顯示 4Hz 就夠
      lastUiRef.current = now;
      setAudioUI((u) => ({ ...u, t: cursorTRef.current }));
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [updateHeads]);

  // 混合播放器(髒句=合成器、乾淨句=wav 段;同一條 ctx 時間軸)
  // 硬停 = 波形切半 = 啪:已起音的段先 5ms 淡到靜(sample 精度,聽不出來),12ms 後才真正 stop
  const stopMixed = useCallback(() => {
    const m = mixedRef.current;
    if (!m) return;
    mixedRef.current = null;
    const now = keySoundCtx().currentTime;
    (m.gains || []).forEach((g, i) => {
      try {
        if (now >= ((m.tSs || [])[i] ?? 0)) {
          g.gain.cancelScheduledValues(now);
          g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.005);
        }
      } catch { /* noop */ }
    });
    setTimeout(() => { for (const s of m.sources) { try { s.stop(); } catch { /* noop */ } } }, 12);
  }, []);
  const mixedPos = useCallback(() => {
    const m = mixedRef.current;
    return m ? Math.max(0, keySoundCtx().currentTime - m.t0 + m.fromT) : 0;
  }, []);
  const mixedActive = useCallback(() => {
    const m = mixedRef.current;
    if (!m) return false;
    if (keySoundCtx().currentTime - m.t0 + m.fromT >= m.end) { stopMixed(); return false; }
    return true;
  }, [stopMixed]);
  const startMixed = useCallback((wavSegs, sItems, fromT) => {
    stopMixed();
    keySoundStopSequence();
    const ctx = keySoundCtx();
    const t0 = ctx.currentTime + 0.08;
    const sources = [], gains = [], tSs = [];
    let end = 0;
    for (const seg of wavSegs) {
      if (seg.t + seg.dur <= fromT + 0.01 || !wavBufRef.current) continue;
      const skip = Math.max(0, fromT - seg.t);
      if (skip >= seg.dur) continue;
      const src = ctx.createBufferSource();
      src.buffer = wavBufRef.current;
      const g = ctx.createGain();
      const tS = t0 + Math.max(0, seg.t - fromT), tE = t0 + (seg.t + seg.dur - fromT);
      g.gain.setValueAtTime(0.0001, tS);
      g.gain.exponentialRampToValueAtTime(0.9, tS + 0.012);
      g.gain.setValueAtTime(0.9, Math.max(tS + 0.013, tE - 0.03));
      g.gain.exponentialRampToValueAtTime(0.0001, tE);
      src.connect(g).connect(ctx.destination);
      src.start(tS, seg.offset + skip, seg.dur - skip);
      sources.push(src); gains.push(g); tSs.push(tS);
      end = Math.max(end, seg.t + seg.dur);
    }
    if (sItems.length) {
      const r = keySoundPlaySequence(sItems, t0, fromT);
      if (r) end = Math.max(end, r.end - t0 + fromT);
    }
    if (!sources.length && !sItems.length) return;
    mixedRef.current = { sources, gains, tSs, t0, fromT, end };
  }, [stopMixed]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (keySoundSeqActive() || mixedActive()) { // 播放中 → 當暫停
      keySoundStopSequence();
      stopMixed();
      setAudioUI((u) => ({ ...u, playing: false }));
      stopLoop();
      updateHeads();
      return;
    }
    const fromT = Math.max(0, cursorTRef.current);
    if (a && wavsRef.current?.length && !inferringRef.current && wavBufRef.current) {
      // 段落級:動過的句子(移動/F0/音素 — 指紋比對)換合成器,沒動的播 wav
      const snap = phraseSnapRef.current;
      const phs = phrases(project.notes);
      const curve = activeF0(project.f0);
      const hashes = phs.map((ph) => phraseHash(ph, project.notes, curve));
      const anyDirty = snap ? hashes.some((h) => !snap.has(h)) : false;
      if (!anyDirty) {
        // 全部乾淨 → 直接播 wav(原本行為)
        if (a.paused) {
          if (!a.src) a.src = wavsRef.current[0];
          try { a.currentTime = fromT; } catch { /* metadata 未載入,從 0 播 */ }
          a.play().then(() => {
            setAudioUI((u) => ({ ...u, playing: true }));
            stopLoop();
            rafRef.current = requestAnimationFrame(loop);
          }).catch(() => {});
        } else {
          fadePause(a);
          setAudioUI((u) => ({ ...u, playing: false }));
          stopLoop();
          updateHeads();
        }
        return;
      }
      const wavSegs = [], dirtyNotes = [];
      phs.forEach((ph, i) => {
        if (snap && !snap.has(hashes[i])) {
          for (const id of ph.ids) { const n = project.notes.find((q) => q.id === id); if (n) dirtyNotes.push(n); }
        } else {
          wavSegs.push({ t: ph.t0, dur: ph.t1 - ph.t0, offset: ph.t0 });
        }
      });
      const sItems = dirtyNotes.length ? synthItems(dirtyNotes, curve, keySoundBaseFreq(), project.phonemes, project.phMap, project.phRev) : [];
      startMixed(wavSegs, sItems, fromT);
      const endT = phs.length ? phs[phs.length - 1].t1 : 0;
      setAudioUI((u) => ({ ...u, playing: true, dur: endT }));
      stopLoop();
      rafRef.current = requestAnimationFrame(loop);
      return;
    }
    // 沒渲染結果(或正在渲染)→ 合成器預覽:照 F0 曲線排程(vibrato/手調都聽得到)
    // 斷點規則(使用者指定):母音之間不斷(跨音符連續),子音/休止才斷(重新起音)
    const curve = activeF0(project.f0);
    const items = synthItems(project.notes, curve, keySoundBaseFreq(), project.phonemes, project.phMap, project.phRev);
    if (!items.length) return;
    const r = keySoundPlaySequence(items, null, fromT); // fromT = 暫停點(沒播完續播;播完自然 end 會歸 0)
    if (!r) return;
    seqDurRef.current = items[items.length - 1].t + items[items.length - 1].dur;
    cursorTRef.current = fromT > 0 ? fromT : 0;
    setAudioUI((u) => ({ ...u, playing: true, dur: seqDurRef.current }));
    stopLoop();
    rafRef.current = requestAnimationFrame(loop);
  }, [loop, updateHeads, project.notes, project.f0, project.phonemes, project.phMap, project.phRev, mixedActive, startMixed, stopMixed]);

  const stopPlay = useCallback(() => {
    const a = audioRef.current;
    keySoundStopSequence();
    stopMixed();
    cursorTRef.current = 0;
    if (a) fadePause(a, () => { if (a.src) { try { a.currentTime = 0; } catch { /* noop */ } } });
    stopLoop();
    setAudioUI((u) => ({ ...u, playing: false, t: 0 }));
    updateHeads();
  }, [updateHeads, stopMixed]);

  // ---- 音符剪貼簿(Ctrl+C 複製 / Ctrl+X 剪下 / Ctrl+V 貼上成新音符,錨在滑鼠游標) ----
  const clipRef = useRef(null); // { notes, base }
  const mouseRef = useRef({ x: -1, y: -1 }); // 最新滑鼠 client 座標(貼上錨用)
  useEffect(() => {
    const h = (e) => { mouseRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', h, { passive: true });
    return () => window.removeEventListener('mousemove', h);
  }, []);
  const copySel = useCallback(() => {
    const sel = project.notes.filter((n) => selectedIds.includes(n.id));
    if (!sel.length) return false;
    const selIds = new Set(sel.map((n) => n.id));
    // 手動點/✗ 一起帶走。三種都算你的:①錨掛在選取音符上 ②出生身份(srcAnchorId)是選取音符
    // ③位置落在選取區間 ±過渡帶(0.35s)內 — 滑音過渡點常幾何掛在隔壁未選音符、死錨或無錨,
    // 只看 anchorId 會漏 → 貼出來的線在音符邊界斷掉;掛在「別人音符上」的點(covOther)不搶
    const lo = Math.min(...sel.map((n) => n.start));
    const hi = Math.max(...sel.map((n) => n.start + n.dur));
    const covOther = (t) => project.notes.some((n) => !selIds.has(n.id) && t >= n.start - 1e-9 && t <= n.start + n.dur + 1e-9);
    const inZone = (t) => t >= lo - 0.35 && t <= hi + 0.35 && !covOther(t);
    const cand = project.f0.filter((pt) => pt.manual || pt.muted);
    const f0 = cand.filter((pt) => (pt.anchorId && selIds.has(pt.anchorId)) || (pt.srcAnchorId && selIds.has(pt.srcAnchorId)) || inZone(pt.t));
    // 臨時診斷:三種來源各抓幾顆(診斷完拆)
    const via = {
      錨: f0.filter((pt) => pt.anchorId && selIds.has(pt.anchorId)).length,
      出生: f0.filter((pt) => !(pt.anchorId && selIds.has(pt.anchorId)) && pt.srcAnchorId && selIds.has(pt.srcAnchorId)).length,
      區間: f0.filter((pt) => !(pt.anchorId && selIds.has(pt.anchorId)) && !(pt.srcAnchorId && selIds.has(pt.srcAnchorId)) && inZone(pt.t)).length,
    };
    console.log(`[App] 複製 ${sel.length} 音符,帶 ${f0.length}/${cand.length} 手動點(錨=${via.錨}/出生=${via.出生}/區間=${via.區間}), 選取區間 [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
    clipRef.current = { notes: sel.map((n) => ({ ...n })), base: lo, f0: f0.map((pt) => ({ ...pt })) };
    return true;
  }, [project.notes, project.f0, selectedIds]);
  // 刪音符(含 Ctrl+X 剪下):掛在被刪音符上、且沒有倖存音符涵蓋的 F0 點一併移除(不留孤兒點)
  const deleteNotesWithF0 = useCallback((ids) => {
    setProject((p) => {
      const deleted = p.notes.filter((n) => ids.includes(n.id));
      if (!deleted.length) { console.log('[App] 刪除:選取ID沒命中任何音符', JSON.stringify(ids)); return p; }
      const notes = p.notes.filter((n) => !ids.includes(n.id));
      const cov = (t, ns) => ns.some((n) => t >= n.start - 1e-9 && t <= n.start + n.dur + 1e-9);
      const gone = [];
      const f0 = p.f0.filter((pt) => {
        const drop = deleted.some((n) => cov(pt.t, [n])) && !cov(pt.t, notes);
        if (drop) gone.push(pt.id);
        return !drop;
      });
      console.log('[App] 刪除音符', deleted.map((n) => n.id).join(','), '| 清掉 F0 點:', gone.join(',') || '(無)');
      return { ...p, notes, f0: reconcileF0(notes, p.f0, project.glide) };
    });
  }, []);

  const cutSel = useCallback(() => {
    if (!copySel()) return;
    deleteNotesWithF0(selectedIds);
    setSelectedIds([]);
  }, [copySel, deleteNotesWithF0, selectedIds]);
  // 給 memo 化的 PianoRoll/PhonemeEditor 的穩定 callback(inline arrow 會讓 memo 失效 → 播放中 4Hz 全樹重繪)
  const deleteSel = useCallback((ids) => { deleteNotesWithF0(ids); setSelectedIds([]); }, [deleteNotesWithF0]);
  const openNoteProps = useCallback(() => setShowPhoneme(true), []);
  const closePhoneme = useCallback(() => setShowPhoneme(false), []);
  const onPhonemeChange = useCallback((n) => setProject((p) => ({ ...p, notes: p.notes.map((x) => (x.id === n.id ? n : x)) })), []);
  const pasteClip = useCallback(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const tempo = project.tempo || 120;
    const snapBeat = (t) => {
      let beat = t * tempo / 60;
      if (project.snap) beat = Math.round(beat * project.gridDiv / 4) / (project.gridDiv / 4);
      return beat * 60 / tempo;
    };
    // 錨點:滑鼠在 roll 內 = 該時間+該音高列(複製區塊最高音對齊游標列);不在 = 播放頭(不調音高)
    const svg = appRef.current?.querySelector('.roll-scroll .roll');
    const r = svg?.getBoundingClientRect();
    const { x: cx, y: cy } = mouseRef.current;
    let anchorTime, deltaMidi = 0;
    if (r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      const secPerPx = 60 / tempo / (project.ppb || 120);
      anchorTime = snapBeat((cx - r.left) * secPerPx);
      const kh = project.kh || 12;
      const midiAt = Math.max(36, Math.min(84, 84 - Math.floor((cy - r.top) / kh)));
      deltaMidi = midiAt - Math.max(...clip.notes.map((n) => n.midi));
    } else {
      anchorTime = snapBeat(cursorTRef.current);
    }
    const newNotes = clip.notes.map((n) => ({
      ...n, id: nextId(),
      start: Math.max(0, n.start - clip.base + anchorTime),
      midi: Math.max(36, Math.min(84, n.midi + deltaMidi)),
    }));
    // F0 手動點/✗ 跟著貼:錨 remap 到新音符;off(時間偏移)/fp(音高比)是相對量,
    // 移調時 fp 比例讓曲線自動跟著移調,t/f 由 reconcile 從新錨推導
    const idMap = new Map(clip.notes.map((n, i) => [n.id, newNotes[i].id]));
    const noteById = new Map(newNotes.map((n) => [n.id, n]));
    const newF0 = (clip.f0 || []).map((pt) => {
      const nid = idMap.get(pt.anchorId);
      if (nid) {
        const an = noteById.get(nid);
        const off = Number.isFinite(pt.off) ? pt.off : pt.t - an.start;
        const fp = Number.isFinite(pt.fp) ? pt.fp : pt.f / midiToFreq(an.midi);
        // 身份 remap:src 有映射 → 換新身份;沒有 → 清身份(避免跟原點同身份被去重殺掉)
        const src = pt.srcAnchorId && pt.role && idMap.has(pt.srcAnchorId) ? idMap.get(pt.srcAnchorId) : undefined;
        const role = src ? pt.role : undefined;
        return { ...pt, id: src ? `f0:${src}:${role}` : nextId(), anchorId: nid, srcAnchorId: src, role, off, fp, seg: undefined, rel: undefined, v2: true };
      }
      // 錨不在複製集合但出生身份在:改掛出生音符的新分身(過渡點的本體),off/fp 從當下位置重算
      const sid = !nid && pt.srcAnchorId ? idMap.get(pt.srcAnchorId) : undefined;
      if (sid) {
        const anS = noteById.get(sid);
        const newT = Math.max(0, pt.t - clip.base + anchorTime);
        const f2 = Number.isFinite(pt.f) ? pt.f * Math.pow(2, deltaMidi / 12) : pt.f;
        return { ...pt, id: nextId(), t: newT, f: f2, anchorId: sid, off: newT - anS.start, fp: f2 / midiToFreq(anS.midi), srcAnchorId: sid, role: pt.role, seg: undefined, rel: undefined, v2: true };
      }
      // 錨不在複製集合(幾何跨錨/死錨/無錨的過渡點):改掛相對位置相同的新音符;
      // 掛不到(落在音符間隙)就保持絕對 t/f,音高隨移調搬移
      const newT = Math.max(0, pt.t - clip.base + anchorTime);
      const f2 = Number.isFinite(pt.f) ? pt.f * Math.pow(2, deltaMidi / 12) : pt.f;
      const an2 = newNotes.find((n) => newT >= n.start - 1e-9 && newT <= n.start + n.dur + 1e-9);
      if (an2) return { ...pt, id: nextId(), t: newT, f: f2, anchorId: an2.id, off: newT - an2.start, fp: f2 / midiToFreq(an2.midi), srcAnchorId: undefined, role: undefined, seg: undefined, rel: undefined, v2: true };
      return { ...pt, id: nextId(), t: newT, f: f2, anchorId: undefined, off: undefined, fp: undefined, srcAnchorId: undefined, role: undefined, seg: undefined, rel: undefined, v2: true };
    });
    console.log('[App] 貼上', newNotes.length, '顆 @', anchorTime.toFixed(3), 's, 移調', deltaMidi, ', F0 點', newF0.length, '(游標在 roll 內?' + !!(r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) + ')');
    setProject((p) => {
      const notes = [...p.notes, ...newNotes];
      const f0 = reconcileF0(notes, [...p.f0, ...newF0], project.glide);
      // 臨時診斷:貼上點逐一對號 — 落地位置/掛誰/被殺(診斷完拆)
      const after = new Map(f0.map((q) => [q.id, q]));
      const dbg = newF0.map((pt) => {
        const q = after.get(pt.id);
        if (!q) return `${pt.id} t=${Number(pt.t).toFixed(3)} → (被去重殺掉/消失)`;
        return `${q.id} t=${pt.t.toFixed(3)}→${q.t.toFixed(3)} f=${Math.round(q.f)} 錨=${q.anchorId ?? '-'} off=${Number.isFinite(q.off) ? q.off.toFixed(3) : '-'} src=${q.srcAnchorId ?? '-'}/${q.role ?? '-'}${q.muted ? ' ✗' : ''}${q.manual ? '' : '(auto)'}`;
      });
      console.log('[App] 貼上點落地:\n  ' + dbg.join('\n  '));
      return { ...p, notes, f0 };
    });
    setSelectedIds(newNotes.map((n) => n.id));
  }, [project.tempo, project.snap, project.gridDiv, project.ppb, project.kh]);

  // wavs 更新 = 新的推論結果:停掉舊播放、重解碼(只保留最新一筆)

  const wavsKey = (wavs ?? []).join('|');
  useEffect(() => {
    let alive = true;
    stopPlay();
    // 換新推論結果時,清掉 audio 元素的舊 src(togglePlay 只在 !a.src 時設 src — 不清就永遠播舊檔)
    const a = audioRef.current;
    if (a && a.src) { a.removeAttribute('src'); a.load(); }
    if (!wavsKey) { setWave(null); return undefined; }
    const ctx = keySoundCtx(); // 共用 ctx:解碼出的 AudioBuffer 留給混合播放用
    fetch(wavsRef.current[0])
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        if (!alive) return;
        wavBufRef.current = buf;
        if (submitTickRef.current === 0) snapPhrases(); // 重載頁面沒有送出紀錄 → 以到達時狀態當基準
        const ch = buf.getChannelData(0);
        const bucket = Math.max(1, Math.floor(buf.sampleRate * 0.005)); // 固定 200 桶/秒,縮放時免重解碼
        const n = Math.ceil(ch.length / bucket);
        const pk = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          let mn = 1, mx = -1;
          const e = Math.min(ch.length, (i + 1) * bucket);
          for (let j = i * bucket; j < e; j++) { const v = ch[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
          pk[i * 2] = mn; pk[i * 2 + 1] = mx;
        }
        setWave({ pk, spb: bucket / buf.sampleRate, dur: buf.duration });
        setAudioUI({ playing: false, t: 0, dur: buf.duration });
      })
      .catch(() => { if (alive) setWave(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wavsKey]);

  // 水平捲動時指針要跟著視窗重算(暫停中也一樣)
  useEffect(() => {
    const root = appRef.current;
    if (!root) return undefined;
    root.addEventListener('scroll', updateHeads, true);
    return () => root.removeEventListener('scroll', updateHeads, true);
  }, [updateHeads]);
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
  }, []);

  // project 變動回報上層（推理 POST 用，上層存 ref 不觸發重繪）
  useEffect(() => {
    if (onProjectChange) onProjectChange(project);
  }, [project]);


  // F0 混合模式:音符變動 → 骨架重算 + 手動/✗ 點跟隨(f0hybrid.reconcileF0)
  const prevNotesRef = useRef(null);
  useEffect(() => {
    const prev = prevNotesRef.current;
    const next = reconcileF0(project.notes, project.f0, project.glide);
    // [F0W] 除錯:reconcile 前後哪顆手動點動了(t/f/錨)
    const mov = [];
    for (const q of next) {
      if (!q.manual) continue;
      const old = (project.f0 || []).find((x) => x.manual && x.id === q.id);
      if (old && (Math.abs(old.t - q.t) > 1e-4 || Math.abs(old.f - q.f) > 0.05 || old.anchorId !== q.anchorId)) {
        mov.push(`${q.id} t:${old.t.toFixed(3)}→${q.t.toFixed(3)} f:${old.f.toFixed(1)}→${q.f.toFixed(1)} 錨:${old.anchorId}→${q.anchorId} off:${Number(q.off).toFixed(3)} role:${q.role ?? '-'}`);
      }
    }
    if (mov.length) console.log('[F0W] reconcile 動了:\n  ' + mov.join('\n  '));
    const same = next.length === project.f0.length &&
      next.every((p, i) => Math.abs(p.t - project.f0[i].t) < 1e-6 && Math.abs(p.f - project.f0[i].f) < 0.01 &&
        !!p.muted === !!project.f0[i].muted && !!p.manual === !!project.f0[i].manual);
    prevNotesRef.current = project.notes;
    if (!same) setProject((p) => ({ ...p, f0: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.notes, project.glide]);

  const selectedNote = useMemo(
    () => project.notes.find((n) => n.id === selectedId) ?? null,
    [project.notes, selectedId],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (e.key === 'Escape') setSelectedIds([]);  // 不攔截：PianoRoll inline-edit 的 window Escape handler 也要收到
      const k = e.key.toLowerCase();
      const isMod = e.ctrlKey || e.metaKey;
      const bare = !isMod && !e.altKey;
      const handled =
        (isMod && (k === 'z' || k === 'y' || k === 'c' || k === 'x' || k === 'v' || k === 'a')) ||
        (bare && (k === 's' || k === 'v' || k === 'b' || k === 'p' || k === 't' || e.key === ' ')) ||
        e.key === 'Delete' || e.key === 'Backspace' ||
        ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectedIds.length > 0);
      if (!handled) return;
      e.preventDefault();
      // capture+stopPropagation：擋掉還掛載中的平台全域 handler（AudioSplitter 的 Delete/Ctrl+Z、RecordingItem 等）
      e.stopPropagation();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // 上/下 = 半音移動(同拖曳),Ctrl+上下 = 八度;按住連發併成一步 undo
        kbMergeRef.current = Date.now();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (isMod ? 12 : 1);
        setProject((p) => {
          let changed = false;
          const notes = p.notes.map((n) => {
            if (!selectedIds.includes(n.id)) return n;
            const m2 = Math.max(36, Math.min(84, n.midi + d));
            if (m2 === n.midi) return n;
            changed = true;
            return { ...n, midi: m2 };
          });
          if (!changed) return p; // 全卡在琴鍵範圍邊界:no-op 不進歷史
          return { ...p, notes, f0: reconcileF0(notes, p.f0, project.glide) };
        });
        return;
      }
      if (isMod && k === 'z') { e.shiftKey ? redo() : undo(); return; }
      if (isMod && k === 'y') { redo(); return; }
      if (isMod && k === 'a') { setSelectedIds(project.notes.map((n) => n.id)); return; }
      if (isMod && k === 'c') { copySel(); return; }
      if (isMod && k === 'x') { cutSel(); return; }
      if (isMod && k === 'v') { pasteClip(); return; }
      if (k === 's') setProject((p) => ({ ...p, snap: !p.snap }));
      else if (k === 'v') setTool('select');
      else if (k === 'b') setTool('pen');
      else if (k === 'p') setShowPhoneme((v) => !v);
      else if (k === 't') setShowF0((v) => !v);
      else if (e.key === ' ') togglePlay();
      else if (selectedIds.length && f0SelRef.current == null) {
        deleteNotesWithF0(selectedIds);
        setSelectedIds([]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedIds, project.notes, project.glide, undo, redo, togglePlay, copySel, cutSel, pasteClip, deleteNotesWithF0]);

  // Ctrl+滾輪縮放（水平網格）
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setProject((p) => e.shiftKey
        ? { ...p, kh: Math.max(8, Math.min(28, Math.round(p.kh * k))) }   // Ctrl+Shift+滾輪 = 垂直縮放
        : { ...p, ppb: Math.max(24, Math.min(480, Math.round(p.ppb * k))) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="note-editor-root" ref={appRef}>
      <Toolbar
        project={project} setProject={setProject}
        undo={undo} redo={redo}
        canUndo={pastRef.current.length > 0} canRedo={futureRef.current.length > 0}
        historyTick={historyTick}
        tool={tool} setTool={setTool}
        showPhoneme={showPhoneme} setShowPhoneme={setShowPhoneme}
        showF0={showF0} setShowF0={setShowF0}
        playback={{
          playing: audioUI.playing, t: audioUI.t, dur: audioUI.dur,
          canPlay: !!(wave || wavs.length || project.notes.length),
          onToggle: togglePlay, onStop: stopPlay,
        }}
        actions={actions}
        settingsExtra={settingsExtra}
      />
      <div className="main">
        <PianoRoll project={project} setProject={setProject}
          selectedIds={selectedIds} setSelectedIds={setSelectedIds} tool={tool} wave={wave} inferring={inferring} seekTo={seekTo}
          onDeleteNotes={deleteSel} onNoteProps={openNoteProps} onCopySel={copySel} onCutSel={cutSel} />
        {showPhoneme && (
          <PhonemeEditor
            note={selectedNote}
            onChange={onPhonemeChange}
            onClose={closePhoneme}
            phonemes={project.phonemes}
            phMap={project.phMap} />
        )}
      </div>
      {showF0 && (
        <div className="f0-stack">
          <RollHints selected={selectedIds.length} />
          <F0Editor project={project} setProject={setProject} selRef={f0SelRef} />
        </div>
      )}
      <audio ref={audioRef} onEnded={() => { setAudioUI((u) => ({ ...u, playing: false })); stopLoop(); updateHeads(); }} />
    </div>
  );
}
