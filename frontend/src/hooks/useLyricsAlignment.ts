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
import { getRegionLabel } from '../utils/regionStyle';
import type { Region } from 'wavesurfer.js/plugins/regions';
import type RegionsPlugin from 'wavesurfer.js/plugins/regions';

export type { WordInstance } from '../utils/alignmentEngine';

export interface UseLyricsAlignmentReturn {
  wordInstances: WordInstance[];
  runAlignment: () => void;
}

export function useLyricsAlignment(
  regionsRef: React.MutableRefObject<RegionsPlugin | null>,
  lyrics: string
): UseLyricsAlignmentReturn {
  const [wordInstances, setWordInstances] = useState<WordInstance[]>([]);
  const lyricsRef = useRef(lyrics);

  useEffect(() => {
    lyricsRef.current = lyrics;
  }, [lyrics]);

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
    }));

    const instances = alignLyricsToLabels(words, labels);
    setWordInstances(instances);
  }, [regionsRef]);

  return { wordInstances, runAlignment };
}
