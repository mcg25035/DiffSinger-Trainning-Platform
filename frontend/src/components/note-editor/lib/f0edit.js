// F0 曲線筆觸編輯：畫筆新增（覆寫時間範圍）、擦除
import { normalizeF0 } from './project.js';

export const F0_MIN_STEP = 0.005; // 5ms，低於此間距的點合併

/** 把一筆新畫的點合併進既有曲線：筆畫時間範圍內的舊點被取代 */
export function applyStroke(existing, stroke) {
  if (!stroke.length) return existing;
  const t0 = stroke[0].t, t1 = stroke[stroke.length - 1].t;
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  const kept = existing.filter((p) => p.t < lo - F0_MIN_STEP || p.t > hi + F0_MIN_STEP);
  return normalizeF0([...kept, ...stroke]);
}

/** 刪除 t 附近半徑 r 內的點 */
export function eraseAround(existing, t, r) {
  return existing.filter((p) => Math.abs(p.t - t) > r);
}

/** 筆畫點取樣：與上一點距離太近就略過（就地修改 push） */
export function pushStrokePoint(stroke, pt) {
  const last = stroke[stroke.length - 1];
  if (!last || Math.abs(pt.t - last.t) >= F0_MIN_STEP) stroke.push(pt);
}
