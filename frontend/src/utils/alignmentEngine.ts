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
  wordIndex?: number;
}

const SILENT_SET = new Set(['SP', 'PAU', 'BR', 'SIL', '!', 'CL']);

export function isSilentLabel(label: string): boolean {
  return SILENT_SET.has(label.toUpperCase());
}

/**
 * 自動為音素標籤分配單詞索引（啟發式對齊）
 */
export function autoAssignWordIndices(
  words: string[],
  labels: LabelInfo[]
): void {
  let labelIdx = 0;
  const totalWords = words.length;

  for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
    const word = words[wordIdx];

    // 跳過靜音標籤
    while (labelIdx < labels.length && isSilentLabel(labels[labelIdx].text)) {
      labels[labelIdx].wordIndex = undefined;
      labelIdx++;
    }

    if (labelIdx >= labels.length) {
      continue;
    }

    const remainingWords = totalWords - wordIdx;
    const remainingNonSilent = labels
      .slice(labelIdx)
      .filter((l) => !isSilentLabel(l.text)).length;
    const expectedPhonemes = Math.max(
      1,
      Math.min(4, Math.round(remainingNonSilent / remainingWords))
    );

    let nonSilentConsumed = 0;
    let currentCombined = '';

    while (labelIdx < labels.length) {
      const label = labels[labelIdx];
      if (isSilentLabel(label.text)) break;

      label.wordIndex = wordIdx;
      currentCombined += label.text;
      labelIdx++;
      nonSilentConsumed++;

      if (currentCombined.toLowerCase() === word.toLowerCase()) {
        break;
      }
      if (nonSilentConsumed >= expectedPhonemes) break;
      if (nonSilentConsumed >= 6) break;
    }
  }

  // 處理尾部剩餘標籤
  while (labelIdx < labels.length) {
    if (isSilentLabel(labels[labelIdx].text)) {
      labels[labelIdx].wordIndex = undefined;
    }
    labelIdx++;
  }
}

/**
 * 補齊缺失的單詞索引（傳播已有的手動對齊資訊）
 */
export function fillMissingWordIndices(
  words: string[],
  labels: LabelInfo[]
): void {
  const nonSilentLabels = labels.filter((l) => !isSilentLabel(l.text));
  if (nonSilentLabels.length === 0) return;

  const allUndefined = nonSilentLabels.every((l) => l.wordIndex === undefined);

  if (allUndefined) {
    autoAssignWordIndices(words, labels);
    return;
  }

  // 尋找第一個有定義單詞索引的非靜音標籤
  const firstDefinedIdx = labels.findIndex((l) => !isSilentLabel(l.text) && l.wordIndex !== undefined);
  let defaultVal = 0;
  if (firstDefinedIdx !== -1) {
    defaultVal = labels[firstDefinedIdx].wordIndex!;
  }

  // 向前傳播 (Forward propagation)
  let lastVal = defaultVal;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (isSilentLabel(label.text)) {
      label.wordIndex = undefined;
    } else {
      if (label.wordIndex !== undefined) {
        lastVal = label.wordIndex;
      } else {
        label.wordIndex = lastVal;
      }
    }
  }
}

/**
 * 將已分配單詞索引的標籤分組為 WordInstance 陣列
 */
export function groupLabelsToWordInstances(
  words: string[],
  labels: LabelInfo[]
): WordInstance[] {
  const instances: WordInstance[] = [];
  let i = 0;

  while (i < labels.length) {
    const label = labels[i];

    if (isSilentLabel(label.text)) {
      // 靜音標籤各自建立獨立的 WordInstance
      instances.push({
        word: label.text,
        start: label.start,
        end: label.end,
        phonemes: [label.text],
      });
      i++;
    } else {
      const currentWordIdx = label.wordIndex;

      if (currentWordIdx === undefined || currentWordIdx < 0 || currentWordIdx >= words.length) {
        instances.push({
          word: label.text,
          start: label.start,
          end: label.end,
          phonemes: [label.text],
        });
        i++;
      } else {
        const group: LabelInfo[] = [];
        const wordText = words[currentWordIdx];

        while (i < labels.length && !isSilentLabel(labels[i].text) && labels[i].wordIndex === currentWordIdx) {
          group.push(labels[i]);
          i++;
        }

        if (group.length > 0) {
          instances.push({
            word: wordText,
            start: group[0].start,
            end: group[group.length - 1].end,
            phonemes: group.map((l) => l.text),
          });
        }
      }
    }
  }

  return instances;
}

/**
 * 將歌詞文字對齊到音素標籤
 *
 * @param words - 歌詞文字陣列 (e.g. ['shi', 'ni'])
 * @param labels - 所有音素標籤（含時間資訊與可選的手動 wordIndex）
 * @returns WordInstance 陣列，包含歌詞字和靜音標籤
 */
export function alignLyricsToLabels(
  words: string[],
  labels: LabelInfo[]
): WordInstance[] {
  fillMissingWordIndices(words, labels);
  return groupLabelsToWordInstances(words, labels);
}

/**
 * 取得特定位置音素的合法單詞選取範圍（維持時間順序單調性，防止選取錯誤的單詞順序）
 */
export function getValidWordIndexRange(
  labels: { label: string; wordIndex?: number }[],
  itemIdx: number,
  totalWords: number
): { minIdx: number; maxIdx: number } {
  let minIdx = 0;
  // 往前找最近的一個有指派單詞的非靜音音素
  for (let j = itemIdx - 1; j >= 0; j--) {
    const pItem = labels[j];
    if (!isSilentLabel(pItem.label) && pItem.wordIndex !== undefined) {
      minIdx = pItem.wordIndex;
      break;
    }
  }

  let maxIdx = totalWords - 1;
  // 往後找最近的一個有指派單詞的非靜音音素
  for (let j = itemIdx + 1; j < labels.length; j++) {
    const nItem = labels[j];
    if (!isSilentLabel(nItem.label) && nItem.wordIndex !== undefined) {
      maxIdx = nItem.wordIndex;
      break;
    }
  }

  return { minIdx, maxIdx };
}
