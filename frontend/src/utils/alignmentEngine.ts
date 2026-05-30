/**
 * 歌詞 ⇄ 音素對齊演算法
 *
 * 將 .lab 中的音素標籤對應到歌詞文字，產生 WordInstance 陣列。
 *
 * 🔧 Bug Fix: 靜音音素 (SP, PAU, CL, !, BR, SIL) 現在會各自建立
 *    獨立的 WordInstance，讓 WORD-PLAY 可以播放它們。
 */

export interface WordInstance {
  /** 顯示文字（歌詞字或靜音標籤名稱） */
  word: string;
  /** 起始時間（秒） */
  start: number;
  /** 結束時間（秒） */
  end: number;
  /** 組成此字的音素列表 */
  phonemes: string[];
}

export interface LabelInfo {
  text: string;
  start: number;
  end: number;
}

const SILENT_SET = new Set(['SP', 'PAU', 'BR', 'SIL', '!', 'CL']);

export function isSilentLabel(label: string): boolean {
  return SILENT_SET.has(label.toUpperCase());
}

/**
 * 將歌詞文字對齊到音素標籤
 *
 * @param words - 歌詞文字陣列 (e.g. ['shi', 'ni'])
 * @param labels - 所有音素標籤（含時間資訊）
 * @returns WordInstance 陣列，包含歌詞字和靜音標籤
 */
export function alignLyricsToLabels(
  words: string[],
  labels: LabelInfo[]
): WordInstance[] {
  const instances: WordInstance[] = [];
  let labelIdx = 0;
  const totalWords = words.length;
  const labelTexts = labels.map((l) => l.text);

  for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
    const word = words[wordIdx];

    // ✅ 修復：把前面的靜音標籤各自建立獨立 WordInstance
    while (labelIdx < labels.length && isSilentLabel(labelTexts[labelIdx])) {
      const silentLabel = labels[labelIdx];
      instances.push({
        word: silentLabel.text,
        start: silentLabel.start,
        end: silentLabel.end,
        phonemes: [silentLabel.text],
      });
      labelIdx++;
    }

    if (labelIdx >= labels.length) {
      continue;
    }

    const startIdx = labelIdx;
    const group: string[] = [];
    let currentCombined = '';

    // 計算此字應消耗的非靜音音素數量
    const remainingWords = totalWords - wordIdx;
    const remainingNonSilent = labelTexts
      .slice(labelIdx)
      .filter((l) => !isSilentLabel(l)).length;
    const expectedPhonemes = Math.max(
      1,
      Math.min(4, Math.round(remainingNonSilent / remainingWords))
    );

    let nonSilentConsumed = 0;
    let matchedExact = false;

    while (labelIdx < labels.length) {
      const label = labelTexts[labelIdx];
      // 遇到靜音邊界 — 此字結束
      if (isSilentLabel(label)) break;

      group.push(label);
      currentCombined += label;
      labelIdx++;
      nonSilentConsumed++;

      // 精確匹配
      if (currentCombined.toLowerCase() === word.toLowerCase()) {
        matchedExact = true;
        break;
      }
      // 比例分配停止
      if (nonSilentConsumed >= expectedPhonemes) break;
      // 硬上限
      if (nonSilentConsumed >= 6) break;
    }

    if (group.length > 0 && startIdx < labels.length) {
      instances.push({
        word,
        start: labels[startIdx].start,
        end: labels[Math.min(labelIdx - 1, labels.length - 1)].end,
        phonemes: [...group],
      });
    }
  }

  // ✅ 修復：處理尾部剩餘的靜音標籤
  while (labelIdx < labels.length) {
    const label = labels[labelIdx];
    if (isSilentLabel(label.text)) {
      instances.push({
        word: label.text,
        start: label.start,
        end: label.end,
        phonemes: [label.text],
      });
    }
    labelIdx++;
  }

  return instances;
}
