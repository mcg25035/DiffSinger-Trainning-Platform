/**
 * WaveSurfer Region 樣式工具
 *
 * 這些函式使用原生 DOM 操作，因為 WaveSurfer Regions Plugin
 * 的 content 屬性必須是 DOM 元素。
 */

import type { Region } from 'wavesurfer.js/plugins/regions';

/**
 * 根據信心分數計算顏色
 * 分數越接近 0 越好（白色），越遠越差（紅色）
 */
export function getConfidenceColor(score?: number): string {
  if (score === undefined) return 'rgba(255,255,255,0.4)';
  const s = Math.abs(score);
  // 假設 -100 是極差的分數，0 是完美的分數
  const factor = Math.min(1, s / 100);
  const r = 255;
  const g = Math.round(255 * (1 - factor));
  const b = Math.round(255 * (1 - factor));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 建立 region 的標籤 DOM 元素
 * @param label - 標籤文字 (e.g. 'SP', 'sh', '!')
 * @param level - 交替層級 (0 或 1)，用於垂直位置交錯避免重疊
 */
export function createLabelElement(label: string, level: number): HTMLDivElement {
  const div = document.createElement('div');
  div.style.display = 'flex';
  div.style.flexDirection = 'column';
  div.style.pointerEvents = 'none';
  div.style.position = 'absolute';
  const tops = ['10px', '50px'];
  div.style.top = tops[level % 2];
  div.style.left = '5px';

  div.setAttribute('data-label-text', label);

  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  labelSpan.style.color = '#fff';
  labelSpan.style.fontSize = '13px';
  labelSpan.style.fontWeight = '900';
  labelSpan.style.textShadow = '2px 2px 4px #000';
  div.appendChild(labelSpan);

  return div;
}

export interface ExtendedRegion extends Region {
  label?: string;
  score?: number;
  wordIndex?: number;
}

/**
 * 套用 region 的視覺樣式（背景色 + 邊界色）
 */
export function applyRegionStyle(
  region: Region,
  label: string,
  level: number,
  score?: number,
  wordIndex?: number
): void {
  const extRegion = region as ExtendedRegion;
  extRegion.label = label;
  extRegion.score = score;
  extRegion.wordIndex = wordIndex;

  const isWarning = label === '!';
  const confColor = getConfidenceColor(score);

  // 設定背景顏色
  region.setOptions({
    color: isWarning
      ? 'rgba(255, 0, 0, 0.2)'
      : level === 0
        ? 'rgba(0, 229, 255, 0.15)'
        : 'rgba(0, 229, 255, 0.05)',
  });

  // 透過 CSS 變數控制邊界顏色
  if (region.element) {
    region.element.style.setProperty('--region-border-color', confColor);
    if (score != null) {
      region.element.setAttribute('data-label-score', score.toString());
    } else {
      region.element.removeAttribute('data-label-score');
    }
    if (wordIndex != null) {
      region.element.setAttribute('data-label-word-index', wordIndex.toString());
    } else {
      region.element.removeAttribute('data-label-word-index');
    }
  }
}

/**
 * 從 region 讀取標籤文字
 */
export function getRegionLabel(region: Region): string {
  const extRegion = region as ExtendedRegion;
  if (extRegion.label != null) return extRegion.label;
  return region.content?.getAttribute('data-label-text') || '';
}

/**
 * 從 region 讀取信心分數
 */
export function getRegionScore(region: Region): number | undefined {
  const extRegion = region as ExtendedRegion;
  if (extRegion.score != null) return extRegion.score;
  const scoreAttr =
    region.element?.getAttribute('data-label-score') ||
    region.content?.getAttribute('data-label-score');
  return scoreAttr ? parseFloat(scoreAttr) : undefined;
}

/**
 * 從 region 讀取 Word Index
 */
export function getRegionWordIndex(region: Region): number | undefined {
  const extRegion = region as ExtendedRegion;
  if (extRegion.wordIndex != null) return extRegion.wordIndex;
  const wordIndexAttr =
    region.element?.getAttribute('data-label-word-index') ||
    region.content?.getAttribute('data-label-word-index');
  return wordIndexAttr ? parseInt(wordIndexAttr, 10) : undefined;
}
