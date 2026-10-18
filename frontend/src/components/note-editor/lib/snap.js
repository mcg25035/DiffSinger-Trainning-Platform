// 磁吸邏輯：格線 + 其他音符邊緣（視覺閾值以像素為準）
import { secToBeats, snapBeat } from './music.js';

/**
 * @param beat 原始拍位置
 * @param opts { gridDiv, snap, snapNotes, ppb, tempo, notes, excludeIds, altMode, threshPx }
 * @returns { beat, snappedTo: 'grid'|'edge'|null, sec: 吸到音符邊緣時的精確秒值(免 beats 往返造成 1e-16 漂移) }
 */
export function snapPosition(beat, { gridDiv, snap, snapNotes, ppb, tempo, notes, excludeIds = [], altMode = false, threshPx = 8 }) {
  if (!snap) return { beat, snappedTo: null, sec: null };
  let best, snappedTo = null, bestSec = null;
  if (altMode) {
    best = beat;
  } else {
    best = snapBeat(beat, gridDiv, true);
    if (Math.abs(best - beat) > 1e-9) snappedTo = 'grid';
  }
  let bestDist = Math.abs(best - beat);
  const threshBeat = (altMode ? threshPx * 1.5 : threshPx) / ppb;
  if (snapNotes || altMode) {
    for (const n of notes) {
      if (excludeIds.includes(n.id)) continue;
      for (const sec of [n.start, n.start + n.dur]) {
        const b = secToBeats(sec, tempo);
        const d = Math.abs(b - beat);
        if (d < bestDist && d <= threshBeat) { best = b; bestDist = d; snappedTo = 'edge'; bestSec = sec; }
      }
    }
  }
  return { beat: best, snappedTo, sec: snappedTo === 'edge' ? bestSec : null };
}
