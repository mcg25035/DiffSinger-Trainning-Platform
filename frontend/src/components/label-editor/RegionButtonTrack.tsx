/**
 * RegionButtonTrack — 水平捲動的 region 按鈕列表與單詞歸屬下拉選單
 */

import { useRef, useEffect } from 'react';
import type WaveSurfer from 'wavesurfer.js';
import type { RegionItem } from '../../hooks/useRegionManager';
import { isSilentLabel, getValidWordIndexRange } from '../../utils/alignmentEngine';

interface Props {
  items: RegionItem[];
  selectedIds: Set<string>;
  onSelect: (item: RegionItem, e: React.MouseEvent) => void;
  wavesurferRef: React.MutableRefObject<WaveSurfer | null>;
  activePlayRange?: { start: number; end: number } | null;
  lyrics: string;
  onWordIndexChange: (regionId: string, wordIndex: number | undefined) => void;
}

export function RegionButtonTrack({
  items,
  selectedIds,
  onSelect,
  wavesurferRef,
  activePlayRange,
  lyrics,
  onWordIndexChange,
}: Props) {
  const words = lyrics.split(/\s+/).filter((w) => w.length > 0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedIds.size !== 1) return;
    const container = containerRef.current;
    if (!container) return;
    const selectedEl = container.querySelector('.region-track__btn--selected');
    if (selectedEl) {
      selectedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [selectedIds]);

  const handleClick = (item: RegionItem, e: React.MouseEvent) => {
    onSelect(item, e);

    // 自動捲動到該 region 的位置
    const ws = wavesurferRef.current;
    if (ws) {
      const duration = ws.getDuration();
      if (duration > 0) {
        const center = (item.region.start + item.region.end) / 2;
        const wrapper = ws.getWrapper();
        const scrollWidth = wrapper.scrollWidth;
        const clientWidth = wrapper.clientWidth;
        const targetScroll =
          (center / duration) * scrollWidth - clientWidth / 2;
        wrapper.scrollTo({ left: targetScroll, behavior: 'smooth' });
      }
    }
  };

  return (
    <div className="region-track" ref={containerRef}>
      {items.map((item, idx) => {
        const isPlayingThis =
          activePlayRange &&
          item.region.start < activePlayRange.end &&
          item.region.end > activePlayRange.start;

        const currentWordIndex = item.wordIndex !== undefined ? item.wordIndex : -1;
        const isSilent = isSilentLabel(item.label);
        const { minIdx, maxIdx } = getValidWordIndexRange(items, idx, words.length);

        return (
          <div key={item.id} className="region-track__col">
            <button
              onClick={(e) => handleClick(item, e)}
              className={`region-track__btn ${
                selectedIds.has(item.id) ? 'region-track__btn--selected' : ''
              } ${isPlayingThis ? 'region-track__btn--playing' : ''}`}
            >
              {item.label || 'SP'}
            </button>
            <select
              value={currentWordIndex}
              disabled={isSilent}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                onWordIndexChange(item.id, val === -1 ? undefined : val);
              }}
              className="region-track__select"
            >
              <option value={-1}>-</option>
              {!isSilent &&
                words.map((word, wIdx) => {
                  const isDisabled = wIdx < minIdx || wIdx > maxIdx;
                  return (
                    <option key={wIdx} value={wIdx} disabled={isDisabled}>
                      {wIdx + 1}. {word}
                    </option>
                  );
                })}
            </select>
          </div>
        );
      })}
    </div>
  );
}
