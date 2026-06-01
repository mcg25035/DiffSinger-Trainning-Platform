/**
 * alignmentStorage — 處理音素單詞對齊資料的 LocalStorage 讀取與寫入
 */

interface SegmentWithWordIndex {
  wordIndex?: number;
}

/**
 * 從 LocalStorage 載入對齊對照表，並套用至 segments 陣列
 */
export function loadWordAlignmentMap(filename: string, segments: SegmentWithWordIndex[]): void {
  const stored = localStorage.getItem(`word_alignment_map_${filename}`);
  if (!stored) return;

  try {
    const arr = JSON.parse(stored);
    if (Array.isArray(arr) && arr.length === segments.length) {
      segments.forEach((seg, idx) => {
        const val = arr[idx];
        seg.wordIndex = val === null ? undefined : val;
      });
    }
  } catch (e) {
    console.error('Failed to parse localStorage word_alignment_map:', e);
  }
}

/**
 * 將目前 segments 的對齊對照表序列化儲存至 LocalStorage
 */
export function saveWordAlignmentMap(filename: string, segments: SegmentWithWordIndex[]): void {
  const wordIndices = segments.map((s) => s.wordIndex);
  localStorage.setItem(`word_alignment_map_${filename}`, JSON.stringify(wordIndices));
}
