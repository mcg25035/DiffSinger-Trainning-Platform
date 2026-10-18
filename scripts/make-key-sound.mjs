// 產生鍵盤/音符發聲取樣:從資料集歌手挑「標好母音的長音」→ 低通濾波 → 週期對齊無縫迴圈
// 產出:frontend/public/key-sound.wav + frontend/src/components/note-editor/lib/keySoundSample.js
// 用法:node scripts/make-key-sound.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SETS = [
  'datasets/training-inputs/cheesege/alignment-upload-254-legacy',
  'datasets/training-inputs/gr/manual-labels-104-legacy',
];
const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);
const PREFER = ['u', 'o']; // 使用者指定:wo/u 這類圓唇音比較好聽(母音 formants 低,低通後不悶)
const MIN_DUR = 0.28;   // 母音標籤至少這麼長
const LPF_HZ = 1800;    // 低通截止(保留母音溫度,去掉齒音/氣音)
const LOOP_MIN = 0.35, LOOP_MAX = 0.80; // 迴圈長度範圍:越長重複率越低(0.2s=5Hz 會嗡嗡)

// ---------- WAV 讀取(16-bit PCM mono/stereo) ----------
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not wav');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    else if (id === 'data') { data = b.subarray(off + 8, off + 8 + sz); break; }
    off += 8 + sz + (sz % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error(`unsupported (${fmt ? fmt.bits + 'bit' : 'no fmt'})`);
  const n = Math.floor(data.length / 2 / fmt.ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * fmt.ch) / 32768;
  return { x: out, sr: fmt.sr };
}

// ---------- 母音候選 ----------
function candidates() {
  const out = [];
  for (const set of SETS) {
    const dir = path.join(ROOT, set);
    if (!fs.existsSync(dir)) continue;
    for (const lab of fs.readdirSync(dir).filter((f) => f.endsWith('.lab'))) {
      const wav = path.join(dir, lab.replace(/\.lab$/, '.wav'));
      if (!fs.existsSync(wav)) continue;
      const lines = fs.readFileSync(path.join(dir, lab), 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines) {
        const [a, b2, ph] = line.trim().split(/\s+/);
        if (!VOWELS.has(ph)) continue;
        const dur = (Number(b2) - Number(a)) * 1e-7;
        if (dur < MIN_DUR) continue;
        out.push({ wav, ph, t0: Number(a) * 1e-7, t1: Number(b2) * 1e-7, dur, set });
      }
    }
  }
  return out;
}

// ---------- 穩定度:40ms frame,autocorr清晰度 + f0 變異 ----------
function stability(x, sr) {
  const N = 2048, hop = 1024;
  const fs_ = [];
  for (let s = 0; s + N < x.length; s += hop) {
    let e0 = 0; for (let i = 0; i < N; i++) e0 += x[s + i] * x[s + i];
    if (e0 < 1e-5) continue;
    let best = 0, bestL = 0;
    for (let lag = Math.floor(sr / 500); lag <= Math.floor(sr / 80); lag++) {
      let r = 0, n = 0;
      for (let i = 0; i < N - lag; i += 2) { r += x[s + i] * x[s + i + lag]; n++; }
      r /= n;
      if (r > best) { best = r; bestL = lag; }
    }
    if (bestL) fs_.push({ clarity: best / (e0 / N), f0: sr / bestL, rms: Math.sqrt(e0 / N) });
  }
  if (fs_.length < 5) return null;
  const clar = fs_.reduce((a, f) => a + f.clarity, 0) / fs_.length;
  const f0s = fs_.map((f) => f.f0).sort((a, b) => a - b);
  const med = f0s[Math.floor(f0s.length / 2)];
  const spread = (f0s[Math.floor(f0s.length * 0.9)] - f0s[Math.floor(f0s.length * 0.1)]) / med;
  return { clarity: clar, spread, f0: med, frames: fs_.length };
}

// ---------- 4 階低通(RBJ biquad ×2) ----------
function lowpass(x, sr, fc) {
  const mk = (Q) => {
    const w = 2 * Math.PI * fc / sr, c = Math.cos(w), s = Math.sin(w);
    const al = s / (2 * Q), a0 = 1 + al;
    return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
  };
  for (const k of [mk(0.707), mk(0.707)]) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = k.b0 * x[i] + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
      x[i] = y;
    }
  }
  return x;
}

function corr(a, b) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; }
  const na = a.length;
  const ca = saa - sa * sa / na, cb = sbb - sb * sb / na;
  if (ca <= 1e-12 || cb <= 1e-12) return 0;
  return (sab - sa * sb / na) / Math.sqrt(ca * cb);
}
// ---------- 「確定重複」區間搜尋:x[t]≈x[t+P] 逐樣本成立才算(直音;vibrato 會讓 P 漂移直接出局) ----------
// 回傳 { start, periods, P, res }:區間 [start, start+periods*P),res=區間內最大殘差(RMS(x[t+P]-x[t])/RMS(x[t]))
function findRepeatRegion(x, sr) {
  const N = Math.min(4096, x.length >> 1), c0 = (x.length - N) >> 1;
  let best = 0, P = 0;
  for (let lag = Math.floor(sr / 500); lag <= Math.min(Math.floor(sr / 80), N - 1); lag++) {
    let r = 0, n = 0;
    for (let i = 0; i < N - lag; i += 2) { r += x[c0 + i] * x[c0 + i + lag]; n++; }
    r /= n;
    if (r > best) { best = r; P = lag; }
  }
  if (!P) return null;
  const nPer = Math.floor(x.length / P) - 1;
  if (nPer < 4) return null;
  const res = new Float32Array(nPer);
  for (let k = 0; k < nPer; k++) {
    const o = k * P;
    let d = 0, e = 0;
    for (let i = 0; i < P; i++) { const diff = x[o + i] - x[o + P + i]; d += diff * diff; e += x[o + i] * x[o + i]; }
    res[k] = Math.sqrt(d / P) / Math.max(1e-9, Math.sqrt(e / P));
  }
  // 各門檻各找最長 run,取「秒數最長」者(殘差高一點但迴圈長 = 比短而完美更自然)
  let bestRun = null;
  for (const th of [0.05, 0.08, 0.12]) {
    let bs = -1, bl = 0, cs = -1;
    for (let k = 0; k <= nPer; k++) {
      if (k < nPer && res[k] < th) { if (cs < 0) cs = k; }
      else { if (cs >= 0 && k - cs > bl) { bl = k - cs; bs = cs; } cs = -1; }
    }
    if (bs >= 0 && bl >= 4) {
      const sec = (bl * P) / sr;
      if (!bestRun || sec > bestRun.periods * bestRun.P / sr) {
        let mx = 0; for (let k = bs; k < bs + bl; k++) mx = Math.max(mx, res[k]);
        bestRun = { start: bs * P, periods: bl, P, res: mx };
      }
    }
  }
  return bestRun;
}

// ---------- 逐週期追蹤(正交零交越)+重採樣:壓成「每週期恰好 P0 樣本」的完美週期波形 ----------
// 回傳 { seg(壓平後訊號), start, periods(幅度最穩區間), P, res }:res=壓平後週期間殘差(應≈0)
function flattenToPerfectPeriods(x, sr) {
  // 1) 正交零交越(positive-going)= 週期邊界候選
  const zc = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) zc.push(i);
  if (zc.length < 12) return null;
  // 2) 區間清理:中位週期 med;丟掉 <0.7med 的雜訊邊界、≈2med 的補中點(漏抓)
  const L0 = [];
  for (let k = 0; k + 1 < zc.length; k++) L0.push(zc[k + 1] - zc[k]);
  const med0 = [...L0].sort((a, b) => a - b)[Math.floor(L0.length / 2)];
  const bounds = [zc[0]];
  for (let k = 0; k + 1 < zc.length; k++) {
    const L = zc[k + 1] - zc[k];
    if (L < 0.7 * med0) continue;              // 雜訊邊界:丟
    if (L > 1.6 * med0) {                      // 漏抓:中點補
      const nIns = Math.round(L / med0) - 1;
      for (let j = 1; j <= nIns; j++) bounds.push(zc[k] + Math.round((L * j) / (nIns + 1)));
    }
    bounds.push(zc[k + 1]);
  }
  const nPer = bounds.length - 1;
  if (nPer < 10) return null;
  const Ls = [];
  for (let k = 0; k < nPer; k++) Ls.push(bounds[k + 1] - bounds[k]);
  const P0 = [...Ls].sort((a, b) => a - b)[Math.floor(nPer / 2)];
  // 3) 每段線性重採樣到恰好 P0
  const y = new Float32Array(nPer * P0);
  for (let k = 0; k < nPer; k++) {
    const a = bounds[k], L = bounds[k + 1] - bounds[k];
    for (let i = 0; i < P0; i++) {
      const t = a + (i / P0) * L;
      const i0 = Math.floor(t), fr = t - i0;
      y[k * P0 + i] = x[i0] * (1 - fr) + x[Math.min(x.length - 1, i0 + 1)] * fr;
    }
  }
  // 3.5) 樣板化:所有週期換成同一形狀 — 每期差異就是 f0/2 次諧波(往上拉聽到低頻雙頻的來源)
  //      幅度用移動平均(9 期)後的包絡保留自然起伏
  const rms = [];
  for (let k = 0; k < nPer; k++) {
    let e = 0; for (let i = 0; i < P0; i++) e += y[k * P0 + i] * y[k * P0 + i];
    rms.push(Math.sqrt(e / P0));
  }
  const med = [...rms].sort((a, b2) => a - b2)[Math.floor(nPer / 2)];
  let tplK = 0, bd = Infinity;
  for (let k = 0; k < nPer; k++) { const d = Math.abs(rms[k] - med); if (d < bd) { bd = d; tplK = k; } }
  const env = rms.map((_, k) => {
    let s2 = 0, c = 0;
    for (let j = Math.max(0, k - 4); j <= Math.min(nPer - 1, k + 4); j++) { s2 += rms[j]; c++; }
    return s2 / c;
  });
  const y2 = new Float32Array(nPer * P0);
  for (let k = 0; k < nPer; k++) {
    for (let i = 0; i < P0; i++) y2[k * P0 + i] = y[tplK * P0 + i]; // 等幅:包絡起伏會讓 wrap 有階跳,純參考音優先乾淨
  }
  y.set(y2);
  let ks = -1, kl = 0, cs = -1;
  for (let k = 0; k <= nPer; k++) {
    if (k < nPer && Math.abs(rms[k] / med - 1) < 0.12) { if (cs < 0) cs = k; }
    else { if (cs >= 0 && k - cs > kl) { kl = k - cs; ks = cs; } cs = -1; }
  }
  if (ks < 0) { ks = 0; kl = nPer; }
  // 5) 壓平後殘差(驗證:應≈0)
  let mx = 0;
  for (let k = ks; k < Math.min(ks + kl, nPer - 1); k++) {
    let d = 0, e = 0;
    for (let i = 0; i < P0; i++) { const diff = y[k * P0 + i] - y[(k + 1) * P0 + i]; d += diff * diff; e += y[k * P0 + i] * y[k * P0 + i]; }
    mx = Math.max(mx, Math.sqrt(d / P0) / Math.max(1e-9, Math.sqrt(e / P0)));
  }
  return { seg: y, start: ks * P0, periods: kl, P: P0, res: mx };
}

// ---------- 主流程 ----------
// 使用者自錄音源優先:frontend/public/u.wav(已低通 EQ,不再濾波,整檔可用)
const custom = path.join(ROOT, 'frontend/public/u.wav');
const useCustom = fs.existsSync(custom);
const cands = useCustom
  ? [{ wav: custom, ph: 'u', t0: 0, t1: 0, dur: 0, set: 'user-u.wav' }]
  : candidates();
console.log(`母音候選(≥${MIN_DUR}s):`, cands.length, useCustom ? '(使用者自錄 u.wav,免濾波)' : '');
const scored = [];
for (const c of cands) {
  let w;
  try { w = readWav(c.wav); } catch { continue; }
  let s0, s1;
  if (useCustom) {
    s0 = Math.floor(0.03 * w.sr); s1 = w.x.length - Math.floor(0.03 * w.sr); // 去前後 30ms 起收雜訊
  } else {
    const pad = c.dur * 0.10;
    s0 = Math.floor((c.t0 + pad) * w.sr); s1 = Math.min(w.x.length, Math.floor((c.t1 - pad) * w.sr));
  }
  if (s1 - s0 < w.sr * 0.2) continue;
  let seg = Float32Array.from(w.x.subarray(s0, s1));
  if (!useCustom) seg = lowpass(seg, w.sr, LPF_HZ);
  let pk = 0; for (const v of seg) pk = Math.max(pk, Math.abs(v));
  if (pk < 1e-4) continue;
  for (let i = 0; i < seg.length; i++) seg[i] *= 0.7 / pk;
  let rep;
  if (useCustom) {
    // 自錄:逐週期追蹤+重採樣 → 完美週期波形(vibrato/漂移歸零,任意長度零縫迴圈)
    rep = flattenToPerfectPeriods(seg, w.sr);
    if (!rep) { console.error('自錄檔找不到夠長的有聲段'); process.exit(1); }
    seg = rep.seg;
  } else {
    rep = findRepeatRegion(seg, w.sr);
  }
  if (!rep) continue;
  const f0p = w.sr / rep.P, loopSec = (rep.periods * rep.P) / w.sr;
  if (!useCustom && (f0p < 130 || f0p > 430)) continue; // base 頻率範圍(自錄不設限)
  if (loopSec < 0.08) continue;         // 迴圈太短 = 蜂鳴
  scored.push({ ...c, seg, sr: w.sr, ...rep });
}
scored.sort((a, b) => {
  const pa = PREFER.indexOf(a.ph), pb = PREFER.indexOf(b.ph);
  const ka = pa >= 0 ? pa : PREFER.length, kb = pb >= 0 ? pb : PREFER.length;
  const la = a.periods * a.P, lb = b.periods * b.P;
  return (ka - kb) || (lb - la) || (a.res - b.res);
});
console.log(`有「確定重複」區間:`, scored.length, '| top:', scored.slice(0, 3)
  .map((s) => `${path.basename(s.wav)}[${s.ph}] ${(s.periods * s.P / s.sr).toFixed(2)}s@${(s.sr / s.P).toFixed(0)}Hz res=${(s.res * 100).toFixed(1)}%`).join(' / '));
if (!scored.length) { console.error('沒有候選有「確定重複」的區間'); process.exit(1); }
const best = scored[0];

// ---- 組 buffer:[起音頭 ~40ms][重複區間(整數週期)] ----
// 播放=從頭播到 loopEnd,之後 loop 在重複區間內:接縫=整數週期邊界,樣本級對齊
const introN = Math.floor(0.04 * best.sr);
const bufStart = Math.max(0, best.start - introN);       // y-space
const loopStartY = best.start;                            // y-space
const loopEndY = best.start + best.periods * best.P;      // y-space
const buffer = Float32Array.from(best.seg.subarray(bufStart, loopEndY));
const XF = Math.floor(0.004 * best.sr); // 4ms 接縫淡化:迴圈頭與原始延續(=下一週期內容)混合,消掉殘差 tick
const lsBuf = loopStartY - bufStart;                      // buffer-space
for (let i = 0; i < XF && loopEndY + i < best.seg.length; i++) {
  const wgt = i / XF;
  buffer[lsBuf + i] = best.seg[loopStartY + i] * wgt + best.seg[loopEndY + i] * (1 - wgt);
}
const baseFreq = best.sr / best.P;
const loopStartSec = lsBuf / best.sr;
const loopEndSec = buffer.length / best.sr;
console.log(`取樣:${path.basename(best.wav)} [${best.ph}] ${best.set} | P=${best.P}(${baseFreq.toFixed(1)}Hz) | 重複=${best.periods}週期=${(best.periods * best.P / best.sr).toFixed(3)}s 殘差=${(best.res * 100).toFixed(1)}% | buffer=${(buffer.length / best.sr).toFixed(3)}s loop=[${loopStartSec.toFixed(3)},${loopEndSec.toFixed(3)}]`);
if (best.res > 0.08) console.error('⚠ 重複殘差偏高,接縫可能聽得到');

// ---------- 寫 WAV(16-bit mono)+ meta(loopStart/loopEnd 給 AudioBufferSourceNode) ----------
const outDir = path.join(ROOT, 'frontend/public');
fs.mkdirSync(outDir, { recursive: true });
const wav = Buffer.alloc(44 + buffer.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + buffer.length * 2, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(best.sr, 24); wav.writeUInt32LE(best.sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(buffer.length * 2, 40);
for (let i = 0; i < buffer.length; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buffer[i] * 32767))), 44 + i * 2);
fs.writeFileSync(path.join(outDir, 'key-sound.wav'), wav);

const meta = `// 由 scripts/make-key-sound.mjs 產生;勿手改
export const keySoundSample = {
  url: '/key-sound.wav',
  baseFreq: ${baseFreq.toFixed(2)},
  loopStart: ${loopStartSec.toFixed(4)},
  loopEnd: ${loopEndSec.toFixed(4)},
  source: ${JSON.stringify(path.relative(ROOT, best.wav))},
  phoneme: ${JSON.stringify(best.ph)},
  repeatResPct: ${(best.res * 100).toFixed(1)},
};
`;
fs.writeFileSync(path.join(ROOT, 'frontend/src/components/note-editor/lib/keySoundSample.js'), meta);
console.log('✓ frontend/public/key-sound.wav + lib/keySoundSample.js');
