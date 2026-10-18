import { useEffect, useRef, useState } from 'react';

const H = 48;
const WL = 96; // 波長(px)=瓷磚寬;流動動畫 = CSS transform 位移一個波長循環(無縫)

// 單波長瓷磚:緞帶曲線 + 對中線的填色(圍起來的區域上色);兩條共用,靠 background-position 錯相位
const mkTile = (stroke, fill) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48" viewBox="0 0 96 48">` +
  `<path d="M0 24C12 6.7 36 6.7 48 24C60 41.3 84 41.3 96 24L0 24Z" fill="${fill}"/>` +
  `<path d="M0 24C12 6.7 36 6.7 48 24C60 41.3 84 41.3 96 24" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/>` +
  `</svg>`
);
const TILE_DIM = mkTile('rgba(110,185,255,0.45)', 'rgba(96,170,255,0.10)');
const TILE_GLOW = mkTile('rgba(242,250,255,0.95)', 'rgba(150,205,255,0.38)');

/**
 * 波形疊層:畫在 roll 內、半透明,固定錨在「C4 往下一點」的列位置,
 * 跟著 roll 內容一起水平/垂直捲動(absolute 在 roll-scroll 裡),不攔滑鼠。
 * 推論進行中(inferring):
 * - 兩條暗緞帶以不同速度向右流動(瓷磚+CSS transform,GPU 合成)
 * - 亮帶 = 每條緞帶一片「亮版分身」,用 mask 羽化窗(視野寬、隨 scrollLeft 跟隨)掃過
 *   → 只有圖形本體被点亮(空白處不亮),出視野右緣即回視野左緣重掃
 * 結果到達/失敗即停(元素移除)。
 */
export default function WaveOverlay({ wave, inferring = false, kh, tempo, ppb }) {
  const ref = useRef(null);
  const sentinelRef = useRef(null);
  const [view, setView] = useState({ x: 0, w: 0 });
  const totalW = 64 * 4 * ppb;
  const secPerPx = 60 / (tempo || 120) / (ppb || 120);
  // C4 列底 = C4 中心再往下半列
  const top = Math.max(0, (84 - 60) * kh + kh - H / 2);

  // 亮帶跟隨可視範圍(捲動容器的 scrollLeft/clientWidth);inferring 期間掛 scroll/resize 監聽
  useEffect(() => {
    if (!inferring) return;
    const el = sentinelRef.current?.parentElement;
    if (!el) return undefined;
    const measure = () => setView({ x: el.scrollLeft, w: el.clientWidth });
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [inferring]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !wave) return;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = 'rgba(79,163,255,0.5)';
    const { pk, spb } = wave;
    const nb = pk.length / 2;
    const mid = H / 2, amp = H / 2 - 4;
    for (let x = 0; x < cv.width; x++) {
      const fi = Math.min(nb - 1, Math.floor((x * secPerPx) / spb));
      const mn = pk[fi * 2], mx = pk[fi * 2 + 1];
      const y1 = mid - mx * amp, y2 = mid - mn * amp;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }, [wave, secPerPx, totalW]);

  if (!wave && !inferring) return null;
  const ribbons = [{ dur: '4.5s', px: 0 }, { dur: '8s', px: -24 }];
  return (
    <>
      {wave && (
        <canvas ref={ref} width={totalW} height={H}
          style={{ position: 'absolute', left: 0, top, width: totalW, height: H, pointerEvents: 'none' }} />
      )}
      {inferring && (
        <>
          {/* 暗緞帶本體:left=-WL 補左緣,位移 +WL 循環不露底 */}
          {ribbons.map((cfg, i) => (
            <div key={i} className="wave-ribbon"
              style={{ left: -WL, top, width: totalW + 2 * WL, height: H,
                backgroundImage: `url("${TILE_DIM}")`, backgroundPositionX: cfg.px, animationDuration: cfg.dur }} />
          ))}
          {/* 量測用哨兵(parentElement = roll-scroll) */}
          <div ref={sentinelRef} style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0 }} />
          {/* 亮帶 = 亮版緞帶分身 × 羽化窗;窗掃 viewport,counter 抵銷窗位移,亮版與暗版同速流動 = 永遠對齊 */}
          {view.w > 0 && ribbons.map((cfg, i) => (
            <div key={i} className="wave-glow-win"
              style={{ left: view.x, top, width: view.w, height: H, animationDuration: cfg.dur, '--bx': `${view.x}px` }}>
              <div className="wave-glow-counter" style={{ animationDuration: cfg.dur }}>
                <div className="wave-ribbon"
                  style={{ left: `calc(${-WL}px - var(--bx))`, top: 0, width: totalW + 2 * WL, height: H,
                    backgroundImage: `url("${TILE_GLOW}")`, backgroundPositionX: cfg.px, animationDuration: cfg.dur }} />
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
