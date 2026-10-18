// 琴鍵/音符發聲 + 音符序列合成預覽:取樣自使用者自錄母音(低通+壓平成完美週期,scripts/make-key-sound.mjs 產生)
// - buffer = [起音頭][重複區間];播放從頭進,loop 在重複區間內(整數週期+4ms 淡化 → 接縫無感)
// - keySoundDown(freq):全新發聲(琴鍵按下/點音符)
// - keySoundGlide(freq):平滑滑頻(拖音符跨列/按住滑琴鍵)— 不重觸發,playbackRate 短時間 ramp
// - keySoundUp():放開收音(50ms release + 保底 hard stop)
// - keySoundPlaySequence(items):照音符序列排程合成(沒有渲染結果時的播放來源)
import { keySoundSample } from './keySoundSample.js';

let ctx = null;
let buf = null; // AudioBuffer(起音頭+重複區間)
let src = null, gain = null;
let vol = 0.2;  // 琴音音量(0~0.8;UI 50% = 0.2)
let seq = [];   // 序列播放中排程 { s, g, tS }
let seqT0 = 0, seqEnd = 0, seqFromT = 0;

// 臨時診斷 log(DEMO 完拆)
const klog = (...a) => console.log('[KeySound]', ...a);

function ensureCtx() {
  if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); klog('ctx 建立 state=', ctx.state, 'sampleRate=', ctx.sampleRate); }
  if (ctx.state === 'suspended') { klog('ctx suspended → resume'); ctx.resume().catch(() => {}); }
  return ctx;
}

/** 音量(UI 0~100,預設 50);感知曲線 g = 0.8·(v/100)² */
export function keySoundSetVolume(v) {
  const c = Math.max(0, Math.min(100, Number(v) || 0));
  vol = 0.8 * (c / 100) * (c / 100);
  klog('setVolume ui=', c, '→ gain=', vol.toFixed(4));
}

export function keySoundPreload() {
  if (buf) return Promise.resolve();
  const ac = ensureCtx();
  return fetch(keySoundSample.url)
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
    .then((ab) => ac.decodeAudioData(ab))
    .then((b) => { buf = b; klog('取樣載入 OK dur=', b.duration.toFixed(3), 'baseFreq=', keySoundSample.baseFreq, 'loop=', keySoundSample.loopStart.toFixed(3), '~', keySoundSample.loopEnd.toFixed(3)); })
    .catch((e) => { console.log('[KeySound] 載入失敗', keySoundSample.url, e); });
}

/** 共用 AudioContext(混合播放排程用) */
export function keySoundCtx() {
  return ensureCtx();
}

/** 取樣基準頻率(合成預覽的 rate 換算用) */
export function keySoundBaseFreq() {
  return keySoundSample.baseFreq;
}

function newSource(freq) {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.loopStart = keySoundSample.loopStart;
  s.loopEnd = keySoundSample.loopEnd;
  s.playbackRate.value = freq / keySoundSample.baseFreq;
  return s;
}

/** 全新發聲(琴鍵按下/點音符) */
export function keySoundDown(freq) {
  if (!freq || freq <= 0) return;
  ensureCtx();
  if (!buf) { klog('DOWN 被擋:取樣還沒解碼好 freq=', freq.toFixed(1), '→ 先觸發載入'); keySoundPreload(); return; } // 還沒解碼好:先觸發載入,這次不響
  keySoundUp(); // 換音先收掉上一個
  const t = ctx.currentTime;
  src = newSource(freq);
  gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(vol, 0.001), t + 0.008); // 8ms attack
  src.connect(gain).connect(ctx.destination);
  src._freq = freq;
  src._t0 = t;
  src.start(t);
  klog('DOWN freq=', freq.toFixed(1), 'rate=', (freq / keySoundSample.baseFreq).toFixed(3), 'vol=', vol.toFixed(4), 'ctx=', ctx.state);
}

/** 平滑滑頻(拖音符跨列/按住滑琴鍵):同一個 source 上 ramp playbackRate,不重觸發 */
export function keySoundGlide(freq, time = 0.07) {
  if (!freq || freq <= 0) return;
  ensureCtx();
  if (!src) { klog('GLIDE 但沒 source → 改 DOWN freq=', freq.toFixed(1)); keySoundDown(freq); return; }
  const t = ctx.currentTime;
  const from = src.playbackRate.value;
  const r = src.playbackRate;
  r.cancelScheduledValues(t);
  r.setValueAtTime(r.value, t);
  r.linearRampToValueAtTime(freq / keySoundSample.baseFreq, t + time);
  src._freq = freq;
  klog('GLIDE rate', from.toFixed(3), '→', (freq / keySoundSample.baseFreq).toFixed(3), '(freq', freq.toFixed(1), ')', time * 1000, 'ms');
}

/** 放開收音(沒在響 = no-op);ramp 50ms + 120ms 後保底 hard stop(就算 ramp 排程出錯也一定停) */
export function keySoundUp() {
  if (!gain || !src) return;
  const g = gain, s = src;
  klog('UP freq=', s._freq ? s._freq.toFixed(1) : '?', '響了', s._t0 ? Math.round((ctx.currentTime - s._t0) * 1000) + 'ms' : '?', 'gain=', g.gain.value.toFixed(4));
  klog('UP caller=', (new Error().stack || '').split('\n').slice(2, 6).map((l) => l.trim()).join(' ← '));
  src = null; gain = null;
  try { g.gain.cancelScheduledValues(ctx.currentTime); } catch { /* noop */ }
  try {
    // 保險:cancel 後 param 可能跳回預設 1.0(排程事件被全取消時)→ 直接 setValueAtTime(1.0) = 爆音
    // 上限永遠是 vol(attack ramp 目標)→ 夾住,只可能小不可能大
    const cur = Math.max(g.gain.value, 0.0001);
    g.gain.setValueAtTime(Math.min(cur, Math.max(vol, 0.001)), ctx.currentTime);
  } catch { /* noop */ }
  try { g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05); } catch { /* noop */ }
  setTimeout(() => { klog('UP hard-stop(120ms 保底)'); try { s.stop(); } catch { /* noop */ } }, 120);
}

// ---------- 音符序列合成預覽(沒渲染結果/渲染中 → 播這個) ----------
/** items: [{t, dur, rates:[[dt, rate]...] }](秒;rates=F0 曲線的 playbackRate 自動化)
 *  when:外部指定的 ctx 起始時間(混合播放用,和 wav 段共用同一條時間軸);fromT:游標起播位置(跳過之前的 items)
 *  回傳 { t0, end },失敗回 null */
export function keySoundPlaySequence(items, when = null, fromT = 0) {
  ensureCtx();
  if (!buf) { klog('SEQ 被擋:取樣沒解碼好'); keySoundPreload(); return null; }
  keySoundStopSequence();
  const t0 = when ?? ctx.currentTime + 0.08;
  let end = 0, nSched = 0, nSkipEarly = 0, nSkipShort = 0;
  for (const it of items) {
    const rates = (it.rates && it.rates.length >= 2) ? it.rates : [[0, it.freq || 1], [it.dur, it.freq || 1]];
    if (!it.dur || it.dur <= 0.02) { nSkipShort++; continue; }
    if (it.t + it.dur <= fromT + 0.01) { nSkipEarly++; continue; } // 起播點之前(含中途起播被切到的,簡化:跳過)
    const s = newSource(0);
    s.loop = true;
    const r = s.playbackRate;
    r.setValueAtTime(Math.max(0.01, rates[0][1]), t0 + it.t - fromT);
    for (let i = 1; i < rates.length; i++) {
      r.linearRampToValueAtTime(Math.max(0.01, rates[i][1]), t0 + it.t - fromT + rates[i][0]);
    }
    const g = ctx.createGain();
    const tS = t0 + it.t - fromT, tE = tS + it.dur;
    g.gain.setValueAtTime(0.0001, tS);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.001), tS + 0.015);
    g.gain.setValueAtTime(Math.max(vol, 0.001), Math.max(tS + 0.016, tE - 0.04));
    g.gain.exponentialRampToValueAtTime(0.0001, tE);
    s.connect(g).connect(ctx.destination);
    s.start(tS);
    s.stop(tE + 0.02);
    seq.push({ s, g, tS });
    nSched++;
    end = Math.max(end, tE);
  }
  klog('SEQ items=', items.length, '排程=', nSched, '跳過(起播前)=', nSkipEarly, '(過短)=', nSkipShort, 'fromT=', fromT.toFixed(2), 'when=', when == null ? 'now+80ms' : 'mix', 'end=', end.toFixed(2), 'ctx=', ctx.state);
  if (!seq.length) return null;
  seqT0 = t0;
  seqEnd = end;
  seqFromT = fromT;
  return { t0, end };
}

/** 停掉序列:已起音的先 5ms 淡到靜再停(硬停 = 波形切半 = 啪;5ms ≈ 220 samples,聽不出來),還沒響的直接取消 */
export function keySoundStopSequence() {
  if (!ctx) return;
  const now = ctx.currentTime;
  let nFade = 0, nCancel = 0;
  for (const q of seq) {
    try {
      if (now >= q.tS) {
        q.g.gain.cancelScheduledValues(now);
        q.g.gain.setValueAtTime(Math.max(q.g.gain.value, 0.0001), now);
        q.g.gain.exponentialRampToValueAtTime(0.0001, now + 0.005);
        setTimeout(() => { try { q.s.stop(); } catch { /* noop */ } }, 12);
        nFade++;
      } else {
        q.s.stop(now); // 排程未到:start 已排、stop 早於 start = 永不播放
        nCancel++;
      }
    } catch { /* noop */ }
  }
  klog('SEQ 停:淡出=', nFade, '取消未響=', nCancel, '/', seq.length, 'pos=', (seq.length ? Math.max(0, now - seqT0 + seqFromT) : 0).toFixed(2));
  seq = [];
  seqEnd = 0;
}

/** 序列播放頭位置(歌曲時間軸秒;沒在播 = 0) */
export function keySoundSeqPos() {
  return seq.length ? Math.max(0, ctx.currentTime - seqT0 + seqFromT) : 0;
}

/** 序列是否還在播 */
export function keySoundSeqActive() {
  if (!seq.length) return false;
  if (ctx.currentTime >= seqEnd) { seq = []; return false; }
  return true;
}

/** e2e/除錯用 */
export function keySoundDebug() {
  return {
    ready: !!buf, playing: !!src, freq: src ? src._freq : null, baseFreq: keySoundSample.baseFreq,
    vol, seqPlaying: seq.length > 0, seqPos: keySoundSeqPos(),
  };
}
