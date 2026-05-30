/**
 * RegionButtonTrack — 水平捲動的 region 按鈕列表
 */

import type WaveSurfer from 'wavesurfer.js';
import type { RegionItem } from '../../hooks/useRegionManager';

interface Props {
  items: RegionItem[];
  selectedId: string | undefined;
  onSelect: (item: RegionItem) => void;
  wavesurferRef: React.MutableRefObject<WaveSurfer | null>;
  activePlayRange?: { start: number; end: number } | null;
}

export function RegionButtonTrack({
  items,
  selectedId,
  onSelect,
  wavesurferRef,
  activePlayRange,
}: Props) {
  const handleClick = (item: RegionItem) => {
    onSelect(item);

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
    <div className="region-track">
      {items.map((item) => {
        const isPlayingThis =
          activePlayRange &&
          item.region.start < activePlayRange.end &&
          item.region.end > activePlayRange.start;

        return (
          <button
            key={item.id}
            onClick={() => handleClick(item)}
            className={`region-track__btn ${
              selectedId === item.id ? 'region-track__btn--selected' : ''
            } ${isPlayingThis ? 'region-track__btn--playing' : ''}`}
          >
            {item.label || 'SP'}
          </button>
        );
      })}
    </div>
  );
}
