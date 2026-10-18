// 自動 F0：從音符產生類人聲音高曲線
// - 銜接時間依前後音符長度比例（min(dur) * ratio，ratio 預設 0.35，夾在 40ms ~ 200ms×ratio/0.35）
// - 過渡「提早預備」：pre（預設 65%）落在前一音符尾端，其餘落在後音符起點 — 兩者可由 glide 設定覆蓋
// - 音符「確實斷開」（中間有靜默縫）才斷句：該區間不產生任何點（畫線時斷開）
// - 產生後以 RDP 簡化（平直筒段幾乎不剩點）
import { midiToFreq } from './music.js';
import { sortNotes, conflictRanges } from './project.js';

const EPS = 1e-6;
const DT = 0.01;

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// Ramer–Douglas–Peucker，以 midi 空間誤差簡化
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const dt = b.t - a.t || 1e-9;
  let maxD = 0, idx = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const m = a.m + (b.m - a.m) * ((p.t - a.t) / dt);
    const d = Math.abs(p.m - m);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps), ...rdp(pts.slice(idx + 1), eps).slice(1)];
}

/** 回傳 {t, f} 點列；無聲區間無點（前後點 t 間距 > gap 視為線段斷開） */
/** glide 滑音政策:{ pre: 過渡在前一音內的佔比(0=下一音起點才滑,1=前一音內滑完), ratio: 過渡長佔較短音符比(越大滑得越慢) } */
export function genAutoF0(notes, glide = {}) {
  const pre = Number.isFinite(glide.pre) ? glide.pre : 0.65;
  const ratio = Number.isFinite(glide.ratio) ? glide.ratio : 0.35;
  const sorted = sortNotes(notes).filter((n) => n.dur > 0);
  if (!sorted.length) return [];
  const conflicts = conflictRanges(sorted);
  const inConflict = (t) => conflicts.some((r) => t >= r.t0 && t < r.t1);

  // 音符間有實際縫隙（確實斷開）就切成樂句
  const phrases = [];
  let cur = [];
  for (const n of sorted) {
    if (cur.length && n.start - (cur[cur.length - 1].start + cur[cur.length - 1].dur) > EPS) {
      phrases.push(cur); cur = [];
    }
    cur.push(n);
  }
  if (cur.length) phrases.push(cur);

  // 稀疏控制點：直線點為骨架，轉折處的兩端標 'curve'（讓出半段給圓角）
  const out = [];
  phrases.forEach((phrase, si) => {
    const pts = [];
    for (let i = 0; i < phrase.length; i++) {
      const n = phrase[i];
      const prev = i > 0 ? phrase[i - 1] : null;
      if (i === 0) pts.push({ t: n.start, f: midiToFreq(n.midi), kind: 'line', anchorId: n.id, role: 'start' });
      let noteEnd = n.start + n.dur;
      if (prev) {
        // 上限跟著 ratio 走(ratio=0.35 時 = 舊制 200ms;拉長滑音上限也放寬,不然滑桿拉了沒效果)
        const trans = Math.min(0.2 * (ratio / 0.35), Math.max(0.04, Math.min(prev.dur, n.dur) * ratio));
        const tStart = n.start - trans * pre, tEnd = n.start + trans * (1 - pre);
        // 修正前一個點：若它是 prev 的終點且晚於 tStart，要拿掉
        if (pts.length && pts[pts.length - 1].t > tStart) pts.pop();
        pts.push({ t: tStart, f: midiToFreq(prev.midi), kind: 'curve', anchorId: n.id, role: 'trans-pre' });
        pts.push({ t: tEnd, f: midiToFreq(n.midi), kind: 'curve', anchorId: n.id, role: 'trans-post' });
      }
      pts.push({ t: noteEnd, f: midiToFreq(n.midi), kind: 'line', anchorId: n.id, role: 'end' });
    }
    // 衝突挖洞：點落在衝突區間就直接移除，並在邊界斷開 segment
    let segIdx = 0, wasHole = true;
    for (const p of pts) {
      if (inConflict(p.t)) { wasHole = true; continue; }
      if (wasHole) { segIdx++; wasHole = false; }
      out.push({ ...p, seg: si * 10000 + segIdx });
    }
  });
  return out;
}

/** 把點列拆成線段:只在 seg 不同時斷(樂句斷開/衝突挖洞,由 genAutoF0 標 seg)。
 *  手動點(無 seg)一律相連——含跨越靜默的直線橋接:拖曳音符後轉折點對可能被拆開,
 *  若再按「音符斷開就斷線」會出現半空斷掉的不自然外觀,故靜默區間直接橋接。 */
export function splitSegments(pts, notes = []) {
  const segs = [];
  let cur = [];
  for (const p of pts) {
    const prev = cur[cur.length - 1];
    const brk = !!(prev && p.seg != null && prev.seg != null && p.seg !== prev.seg);
    if (brk) { segs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  return segs;
}
