/**
 * .lab 檔案格式解析與序列化工具
 *
 * 支援兩種時間格式：
 *  - 秒 (小數點格式, e.g. 0.123 0.456 SP)
 *  - HTK 10ns 單位 (整數格式, e.g. 1230000 4560000 SP)
 *
 * 判定規則：如果 start 或 end > 100000，視為 HTK 格式並除以 10000000
 */

export interface LabSegment {
  start: number;
  end: number;
  label: string;
  score?: number;
  wordIndex?: number;
}

/**
 * 解析 .lab 文字內容為 LabSegment 陣列
 */
export function parseLab(content: string): LabSegment[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): LabSegment | null => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) return null;
      const [startStr, endStr, ...labelParts] = parts;

      // 解析標籤：有些舊標籤可能已經包含了信心值，我們只取第一個空格前的內容作為標籤
      const label = labelParts[0];
      let score: number | undefined = undefined;

      if (labelParts.length >= 2) {
        const possibleScore = parseFloat(labelParts[1]);
        if (!isNaN(possibleScore)) {
          score = possibleScore;
        }
      }

      let start = parseFloat(startStr);
      let end = parseFloat(endStr);
      // HTK 格式 (10ns 單位) → 秒
      if (start > 100000 || end > 100000) {
        start /= 10000000;
        end /= 10000000;
      }
      return { start, end, label, score };
    })
    .filter((s): s is LabSegment => s !== null);
}

/**
 * 將 LabSegment 陣列序列化為 .lab 文字 (HTK 格式輸出)
 */
export function stringifyLabSegments(segments: LabSegment[]): string {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const lines: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    const s = Math.round(seg.start * 10000000);
    let e = Math.round(seg.end * 10000000);

    // 相鄰 segment 邊界修正：prev.end = next.start - 1（整數域）
    if (i < sorted.length - 1) {
      const nextStart = Math.round(sorted[i + 1].start * 10000000);
      if (e >= nextStart) {
        e = nextStart - 1;
      }
    }

    if (seg.score !== undefined) {
      lines.push(`${s} ${e} ${seg.label} ${seg.score.toFixed(4)}`);
    } else {
      lines.push(`${s} ${e} ${seg.label}`);
    }
  }

  return lines.join('\n');
}

/**
 * 合併 lab segments 和信心分數
 */
export function mergeConfidenceScores(
  segments: LabSegment[],
  confSegments: LabSegment[]
): LabSegment[] {
  if (confSegments.length === 0) return segments;

  return segments.map((seg) => {
    const match = confSegments.find(
      (cs) =>
        Math.abs(cs.start - seg.start) < 0.001 &&
        Math.abs(cs.end - seg.end) < 0.001 &&
        cs.label === seg.label
    );
    if (match && match.score !== undefined) {
      return { ...seg, score: match.score };
    }
    return seg;
  });
}

/**
 * 填補空隙：在 segments 之間插入 '!' 標記（未確認區間）
 */
export function fillGaps(segments: LabSegment[], duration: number): LabSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const filled: LabSegment[] = [];
  let currentPos = 0;
  const eps = 1e-5;

  sorted.forEach((seg) => {
    if (seg.start - currentPos > eps) {
      filled.push({ start: currentPos, end: seg.start, label: '!' });
    }
    filled.push(seg);
    currentPos = Math.max(currentPos, seg.end);
  });

  if (duration - currentPos > eps) {
    filled.push({ start: currentPos, end: duration, label: '!' });
  }

  return filled;
}
