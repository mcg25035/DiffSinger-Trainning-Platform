// Ramer–Douglas–Peucker（通用版，[{t, f}]）
export function rdp(pts, eps = 2) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const dt = b.t - a.t || 1e-9;
  let maxD = 0, idx = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const f = a.f + (b.f - a.f) * ((p.t - a.t) / dt);
    const d = Math.abs(p.f - f);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps), ...rdp(pts.slice(idx + 1), eps).slice(1)];
}
