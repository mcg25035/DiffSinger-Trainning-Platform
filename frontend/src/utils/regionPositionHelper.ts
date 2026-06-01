import type { Region } from 'wavesurfer.js/plugins/regions';

interface CachedPosition {
  start: number;
  end: number;
}

/**
 * 處理拖動/調整邊界時的位置同步更新
 * 支援多個音素 Start 同步拖移且間距不變，並提供邊界限制限制 (Clamping)
 */
export function updateRegionPositions(
  r: Region,
  all: Region[],
  selectedRegionIds: Set<string>,
  cachedMap: Map<string, CachedPosition>
): void {
  const cached = cachedMap.get(r.id);
  if (!cached) return;

  let delta = 0;
  let isStartDragged = false;
  let isEndDragged = false;

  if (Math.abs(r.start - cached.start) > 0.0001) {
    delta = r.start - cached.start;
    isStartDragged = true;
  } else if (Math.abs(r.end - cached.end) > 0.0001) {
    delta = r.end - cached.end;
    isEndDragged = true;
  }

  if (!isStartDragged && !isEndDragged) return;

  const isMultiple = selectedRegionIds.size > 1;
  let isSelectedStartDragged = false;

  if (isMultiple) {
    if (isStartDragged) {
      isSelectedStartDragged = selectedRegionIds.has(r.id);
    } else if (isEndDragged) {
      const idx = all.findIndex((reg) => reg.id === r.id);
      if (idx !== -1 && idx < all.length - 1) {
        const nextReg = all[idx + 1];
        isSelectedStartDragged = selectedRegionIds.has(nextReg.id);
      }
    }
  }

  if (isMultiple && isSelectedStartDragged) {
    const selectedRegs = all.filter((reg) => selectedRegionIds.has(reg.id));
    if (selectedRegs.length > 0) {
      const firstSelected = selectedRegs[0];
      const lastSelected = selectedRegs[selectedRegs.length - 1];

      const firstCached = cachedMap.get(firstSelected.id);
      const lastCached = cachedMap.get(lastSelected.id);

      if (firstCached && lastCached) {
        let minDelta = -Infinity;
        const firstIdx = all.findIndex((reg) => reg.id === firstSelected.id);
        if (firstIdx > 0) {
          const prevReg = all[firstIdx - 1];
          const prevCached = cachedMap.get(prevReg.id);
          if (prevCached) {
            minDelta = prevCached.start + 0.01 - firstCached.start;
          }
        }

        const maxDelta = lastCached.end - 0.01 - lastCached.start;
        delta = Math.max(minDelta, Math.min(maxDelta, delta));

        selectedRegs.forEach((reg) => {
          const c = cachedMap.get(reg.id);
          if (c) {
            reg.setOptions({
              start: c.start + delta,
            });
            if (reg.id !== lastSelected.id) {
              reg.setOptions({
                end: c.end + delta,
              });
            }
          }
        });

        if (firstIdx > 0) {
          const prevReg = all[firstIdx - 1];
          const prevCached = cachedMap.get(prevReg.id);
          if (prevCached) {
            prevReg.setOptions({
              end: firstCached.start + delta,
                });
              }
            }

            lastSelected.setOptions({
              end: lastCached.end,
            });
          }
        }
      } else {
        const i = all.indexOf(r);
        if (i < all.length - 1) all[i + 1].setOptions({ start: r.end });
        if (i > 0) all[i - 1].setOptions({ end: r.start });
      }
}

/**
 * 計算在 Shift+Click 下應被選取的連續 Region ID 集合
 */
export function getShiftSelectionIds(
  all: Region[],
  anchorId: string,
  clickedId: string
): Set<string> {
  const anchorIdx = all.findIndex((reg) => reg.id === anchorId);
  const clickedIdx = all.findIndex((reg) => reg.id === clickedId);
  if (anchorIdx === -1 || clickedIdx === -1) {
    return new Set([clickedId]);
  }

  const startIdx = Math.min(anchorIdx, clickedIdx);
  const endIdx = Math.max(anchorIdx, clickedIdx);

  const ids = new Set<string>();
  for (let i = startIdx; i <= endIdx; i++) {
    ids.add(all[i].id);
  }
  return ids;
}

