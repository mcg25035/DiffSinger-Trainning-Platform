/**
 * useLyricsAlignment — 歌詞對齊 Hook
 *
 * 包裝 alignmentEngine 的純演算法，管理 wordInstances state。
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  alignLyricsToLabels,
  type WordInstance,
  type LabelInfo,
} from '../utils/alignmentEngine';
import { saveWordAlignmentMap } from '../utils/alignmentStorage';
import { getRegionLabel, getRegionWordIndex } from '../utils/regionStyle';
import type { Region } from 'wavesurfer.js/plugins/regions';
import type RegionsPlugin from 'wavesurfer.js/plugins/regions';

export type { WordInstance } from '../utils/alignmentEngine';

export interface UseLyricsAlignmentReturn {
  wordInstances: WordInstance[];
  runAlignment: () => void;
}

export function useLyricsAlignment(
  regionsRef: React.MutableRefObject<RegionsPlugin | null>,
  lyrics: string,
  filename: string
): UseLyricsAlignmentReturn {
  const [wordInstances, setWordInstances] = useState<WordInstance[]>([]);
  const lyricsRef = useRef(lyrics);
  const filenameRef = useRef(filename);

  useEffect(() => {
    lyricsRef.current = lyrics;
  }, [lyrics]);

  useEffect(() => {
    filenameRef.current = filename;
  }, [filename]);

  const runAlignment = useCallback(() => {
    if (!regionsRef.current) return;

    const allRegions = regionsRef.current
      .getRegions()
      .sort((a: Region, b: Region) => a.start - b.start);
    const words = lyricsRef.current.split(/\s+/).filter((w: string) => w.length > 0);

    const labels: LabelInfo[] = allRegions.map((r: Region) => ({
      text: getRegionLabel(r),
      start: r.start,
      end: r.end,
      wordIndex: getRegionWordIndex(r),
    }));

    const instances = alignLyricsToLabels(words, labels);
    setWordInstances(instances);

    // 將自動分配好的單詞索引寫回 region DOM 屬性，以便後續儲存
    allRegions.forEach((r: Region, i: number) => {
      const idx = labels[i].wordIndex;
      if (idx !== undefined && getRegionWordIndex(r) === undefined) {
        r.element?.setAttribute('data-label-word-index', idx.toString());
      }
    });

    // 儲存至 localStorage，避免修改實體 .lab 檔案
    saveWordAlignmentMap(filenameRef.current, labels);
  }, [regionsRef]);

  return { wordInstances, runAlignment };
}
