/**
 * useLyricsAlignment — 歌詞對齊 Hook (純資料邏輯，無副作用)
 *
 * 設計原因：將歌詞對齊引擎與 UI 層（WaveSurfer DOM 結構）解耦，
 * 直接對 React 的 segments state 進行對齊與更新。
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  alignLyricsToLabels,
  type WordInstance,
  type LabelInfo,
} from '../utils/alignmentEngine';
import { saveWordAlignmentMap } from '../utils/alignmentStorage';
import type { LabSegment } from '../utils/labParser';

export type { WordInstance } from '../utils/alignmentEngine';

export interface UseLyricsAlignmentReturn {
  wordInstances: WordInstance[];
  runAlignment: (segmentsOverride?: LabSegment[]) => void;
}

export function useLyricsAlignment(
  segments: LabSegment[],
  setSegments: React.Dispatch<React.SetStateAction<LabSegment[]>>,
  lyrics: string,
  filename: string
): UseLyricsAlignmentReturn {
  const [wordInstances, setWordInstances] = useState<WordInstance[]>([]);
  const lyricsRef = useRef(lyrics);
  const filenameRef = useRef(filename);
  const segmentsRef = useRef(segments);

  // 用 refs 保存最新資料以避免 stale closure
  useEffect(() => {
    lyricsRef.current = lyrics;
  }, [lyrics]);

  useEffect(() => {
    filenameRef.current = filename;
  }, [filename]);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  const runAlignment = useCallback((segmentsOverride?: LabSegment[]) => {
    const currentSegments = segmentsOverride || segmentsRef.current;
    if (currentSegments.length === 0) return;

    const words = lyricsRef.current.split(/\s+/).filter((w: string) => w.length > 0);

    const labels: LabelInfo[] = currentSegments
      .sort((a, b) => a.start - b.start)
      .map((s) => ({
        text: s.label,
        start: s.start,
        end: s.end,
        wordIndex: s.wordIndex,
      }));

    // 使用純對齊演算法計算各音素對應的單詞
    const instances = alignLyricsToLabels(words, labels);
    setWordInstances(instances);

    // 將計算出的 wordIndex 寫回 React 的 segments state
    setSegments((prev) => {
      return prev.map((s, i) => {
        const idx = labels[i]?.wordIndex;
        return {
          ...s,
          wordIndex: idx,
        };
      });
    });

    // 儲存對齊對照表至 localStorage
    saveWordAlignmentMap(filenameRef.current, labels);
  }, [setSegments]);

  return { wordInstances, runAlignment };
}
