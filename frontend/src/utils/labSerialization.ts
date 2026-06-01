import type { Region } from 'wavesurfer.js/plugins/regions';
import type { LabSegment } from './labParser';
import {
  getRegionLabel,
  getRegionScore,
  getRegionWordIndex,
} from './regionStyle';

/** 從 Region[] 序列化為 .lab 文字 */
export function stringifyFromRegions(regions: Region[]): string {
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const lines: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const s = Math.round(sorted[i].start * 10000000);
    let e = Math.round(sorted[i].end * 10000000);
    const label = getRegionLabel(sorted[i]);
    const score = getRegionScore(sorted[i]);
    const wordIndex = getRegionWordIndex(sorted[i]);

    // 相鄰邊界修正：prev.end = next.start - 1（整數域）
    if (i < sorted.length - 1) {
      const nextStart = Math.round(sorted[i + 1].start * 10000000);
      if (e >= nextStart) {
        e = nextStart - 1;
      }
    }

    const scoreVal = score !== undefined ? score : 1.0;
    const wordIdxVal = wordIndex !== undefined ? wordIndex : '';

    if (wordIdxVal !== '') {
      lines.push(`${s} ${e} ${label} ${scoreVal.toFixed(4)} ${wordIdxVal}`);
    } else if (score !== undefined) {
      lines.push(`${s} ${e} ${label} ${scoreVal.toFixed(4)}`);
    } else {
      lines.push(`${s} ${e} ${label}`);
    }
  }

  return lines.join('\n');
}

/** 從 .lab 文字快速解析（用於 undo，不需要信心分數） */
export function parseLabFromString(content: string): LabSegment[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) return null;
      let start = parseFloat(parts[0]);
      let end = parseFloat(parts[1]);
      const label = parts[2];
      if (start > 100000 || end > 100000) {
        start /= 10000000;
        end /= 10000000;
      }
      let score: number | undefined = undefined;
      if (parts.length >= 4) {
        const parsedScore = parseFloat(parts[3]);
        if (!isNaN(parsedScore)) {
          score = parsedScore;
        }
      }
      let wordIndex: number | undefined = undefined;
      if (parts.length >= 5) {
        const parsedIdx = parseInt(parts[4], 10);
        if (!isNaN(parsedIdx)) {
          wordIndex = parsedIdx;
        }
      }
      return { start, end, label, score, wordIndex } as LabSegment;
    })
    .filter((s): s is LabSegment => s !== null);
}
