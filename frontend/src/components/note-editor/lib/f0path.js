// 依控制點序列建 SVG path（與 project.f0At 同一套幾何，由 f0Pieces 產生）：
// - line 段：直線
// - cubic 段：Hermite → 貝茲（控制柄 = 端點切線的 1/3，標準換算）
import { f0Pieces } from './project.js';

export function buildF0Path(points, xOf, yOf) {
  const pieces = f0Pieces(points);
  if (!pieces.length) {
    return points.length ? `M${xOf(points[0].t)},${yOf(points[0].f)}` : '';
  }
  let d = `M${xOf(pieces[0].t0).toFixed(1)},${yOf(pieces[0].f0).toFixed(1)}`;
  for (const pc of pieces) {
    const x1 = xOf(pc.t1).toFixed(1), y1 = yOf(pc.f1).toFixed(1);
    if (pc.type === 'line') {
      d += ` L${x1},${y1}`;
    } else {
      const dt3 = (pc.t1 - pc.t0) / 3;
      const c1x = xOf(pc.t0 + dt3).toFixed(1), c1y = yOf(pc.f0 + pc.m0 * dt3).toFixed(1);
      const c2x = xOf(pc.t1 - dt3).toFixed(1), c2y = yOf(pc.f1 - pc.m1 * dt3).toFixed(1);
      d += ` C${c1x},${c1y} ${c2x},${c2y} ${x1},${y1}`;
    }
  }
  return d;
}
