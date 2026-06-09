/**
 * useRegionManager — Pure React State Annotation Manager
 *
 * 職責：
 *  - 管理音素片段的單一資料源 (segments: LabSegment[])
 *  - 所有的 CRUD (編輯標籤、切割、刪除、歌詞對齊索引) 皆為對 React state 的純資料操作
 *  - 管理 selectedSegmentId, editLabel, undoStack, startPointerTime
 *  - 完全不接觸 WaveSurfer 或 DOM
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import type React from 'react';
import type { LabSegment } from '../utils/labParser';
import { updateSegmentPositionsPure, getShiftSelectionIds } from '../utils/regionPositionHelper';

export interface RegionItem {
  id: string;
  label: string;
  start: number;
  end: number;
  wordIndex?: number;
  score?: number;
  // 提供相容的 region 屬性，讓 UI 組件無痛對接
  region: {
    start: number;
    end: number;
  };
}

export interface UseRegionManagerReturn {
  // State
  segments: LabSegment[];
  setSegments: React.Dispatch<React.SetStateAction<LabSegment[]>>;
  selectedSegmentId: string | null;
  selectedSegment: LabSegment | null;
  selectedRegion: LabSegment | null; // 相容別名
  selectedRegionIds: Set<string>; // 相容多選型別
  editLabel: string;
  labelsCount: number | null;
  regionItems: RegionItem[];
  startPointerTime: number;
  // Actions
  setSelectedSegmentId: (id: string | null) => void;
  setSelectedRegion: (segment: LabSegment | null) => void; // 相容別名
  setEditLabel: (label: string) => void;
  loadSegments: (segments: LabSegment[]) => void;
  updateLabel: (labelOverride?: string) => void;
  updateSegmentWordIndex: (regionId: string, wordIndex: number | undefined) => void;
  updateRegionWordIndex: (regionId: string, wordIndex: number | undefined) => void; // 相容別名
  deleteSelected: () => void;
  splitAtTime: (time: number) => void;
  handleSegmentDrag: (
    id: string,
    newStart: number,
    newEnd: number,
    cachedMap: Map<string, { start: number; end: number }>
  ) => void;
  handleSegmentDragEnd: (
    id: string,
    newStart: number,
    newEnd: number,
    cachedMap: Map<string, { start: number; end: number }>
  ) => void;
  handleSegmentClicked: (id: string, e?: MouseEvent | React.MouseEvent) => void;
  handleRegionClicked: (region: { id: string }, e?: MouseEvent | React.MouseEvent) => void; // 相容別名
  undo: () => void;
  saveHistory: () => void;
  getCurrentSegments: () => LabSegment[];
  setStartPointerTime: (time: number) => void;
}

export function useRegionManager(
  onChange?: () => void
): UseRegionManagerReturn {
  const [segments, setSegmentsState] = useState<LabSegment[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<Set<string>>(new Set());
  const [editLabel, setEditLabel] = useState('');
  const [startPointerTime, setStartPointerTime] = useState(0);

  const undoStackRef = useRef<string[]>([]);

  // 封裝 state setter，以在每次資料異動後觸發 onChange 回呼 (自動存檔等)
  const setSegments = useCallback(
    (value: React.SetStateAction<LabSegment[]>) => {
      setSegmentsState((prev) => {
        const next = typeof value === 'function' ? value(prev) : value;
        // 排程觸發通知
        setTimeout(() => onChange?.(), 0);
        return next;
      });
    },
    [onChange]
  );

  // 取得當前選取的段落
  const selectedSegment = useMemo(() => {
    return segments.find((s) => s.id === selectedSegmentId) || null;
  }, [segments, selectedSegmentId]);

  // 計算標籤個數
  const labelsCount = useMemo(() => {
    return segments.length;
  }, [segments]);

  // 將 segments 轉為給 UI 組件使用的 RegionItem
  const regionItems = useMemo<RegionItem[]>(() => {
    return segments
      .sort((a, b) => a.start - b.start)
      .map((s) => ({
        id: s.id || '',
        label: s.label,
        start: s.start,
        end: s.end,
        wordIndex: s.wordIndex,
        score: s.score,
        region: {
          start: s.start,
          end: s.end,
        },
      }));
  }, [segments]);

  // 載入全新資料
  const loadSegments = useCallback((rawSegments: LabSegment[]) => {
    const segmentsWithIds = rawSegments.map((s) => ({
      ...s,
      id: s.id || `seg-${Math.random().toString(36).substring(2, 9)}`,
    }));
    setSegmentsState(segmentsWithIds);
    setSelectedSegmentId(null);
    setSelectedSegmentIds(new Set());
    // 初始化歷史紀錄
    undoStackRef.current = [JSON.stringify(segmentsWithIds)];
  }, []);

  // 設定選取段落 (相容別名)
  const setSelectedRegion = useCallback((s: LabSegment | null) => {
    if (s) {
      setSelectedSegmentId(s.id || null);
      setSelectedSegmentIds(new Set(s.id ? [s.id] : []));
    } else {
      setSelectedSegmentId(null);
      setSelectedSegmentIds(new Set());
    }
  }, []);

  // 儲存歷史紀錄
  const saveHistory = useCallback(() => {
    const currentStr = JSON.stringify(segments);
    const stack = undoStackRef.current;
    if (stack.length > 0 && stack[stack.length - 1] === currentStr) return;
    undoStackRef.current = [...stack, currentStr];
  }, [segments]);

  // 更新選中段落的標籤
  const updateLabel = useCallback(
    (labelOverride?: string) => {
      if (!selectedSegmentId || selectedSegmentIds.size > 1) return;
      const targetLabel = labelOverride !== undefined ? labelOverride : editLabel;
      saveHistory();
      setSegments((prev) =>
        prev.map((s) => (s.id === selectedSegmentId ? { ...s, label: targetLabel } : s))
      );
    },
    [selectedSegmentId, selectedSegmentIds, editLabel, saveHistory, setSegments]
  );

  // 更新段落的單詞對齊索引
  const updateSegmentWordIndex = useCallback(
    (id: string, wordIndex: number | undefined) => {
      saveHistory();
      setSegments((prev) =>
        prev.map((s) => (s.id === id ? { ...s, wordIndex } : s))
      );
    },
    [saveHistory, setSegments]
  );

  // 刪除選中的段落，並讓前一個段落延伸補滿空隙
  const deleteSelected = useCallback(() => {
    if (!selectedSegmentId || selectedSegmentIds.size > 1) return;
    saveHistory();

    setSegments((prev) => {
      const sorted = [...prev].sort((a, b) => a.start - b.start);
      const idx = sorted.findIndex((s) => s.id === selectedSegmentId);
      if (idx === -1) return prev;

      const deletedSeg = sorted[idx];
      const filtered = sorted.filter((s) => s.id !== selectedSegmentId);

      // 若刪除的不是第一個，讓前一個段落向右延伸到被刪除段落的 end
      if (idx > 0) {
        filtered[idx - 1] = {
          ...filtered[idx - 1],
          end: deletedSeg.end,
        };
      }

      return filtered;
    });

    setSelectedSegmentId(null);
    setSelectedSegmentIds(new Set());
  }, [selectedSegmentId, selectedSegmentIds, saveHistory, setSegments]);

  // 在特定時間點切割段落
  const splitAtTime = useCallback(
    (time: number) => {
      saveHistory();
      setSegments((prev) => {
        const sorted = [...prev].sort((a, b) => a.start - b.start);
        const targetIdx = sorted.findIndex((s) => time >= s.start && time <= s.end);
        if (targetIdx === -1) return prev;

        const target = sorted[targetIdx];
        const oldEnd = target.end;

        // 修改被切分段落的 end
        sorted[targetIdx] = {
          ...target,
          end: time,
        };

        // 插入一個新的段落
        const newSeg: LabSegment = {
          id: `seg-${Math.random().toString(36).substring(2, 9)}`,
          start: time,
          end: oldEnd,
          label: target.label,
          score: target.score,
          wordIndex: target.wordIndex,
        };

        sorted.splice(targetIdx + 1, 0, newSeg);
        return sorted;
      });
    },
    [saveHistory, setSegments]
  );

  // 處理音素片段拖曳調整 (即時計算)
  const handleSegmentDrag = useCallback(
    (
      id: string,
      newStart: number,
      newEnd: number,
      cachedMap: Map<string, { start: number; end: number }>
    ) => {
      setSegments((prev) => {
        return updateSegmentPositionsPure(id, newStart, newEnd, prev, selectedSegmentIds, cachedMap);
      });
    },
    [selectedSegmentIds, setSegments]
  );

  // 處理音素片段拖曳完成 (寫入歷史)
  const handleSegmentDragEnd = useCallback(
    (
      id: string,
      newStart: number,
      newEnd: number,
      cachedMap: Map<string, { start: number; end: number }>
    ) => {
      saveHistory();
      setSegments((prev) => {
        return updateSegmentPositionsPure(id, newStart, newEnd, prev, selectedSegmentIds, cachedMap);
      });
    },
    [saveHistory, selectedSegmentIds, setSegments]
  );

  // 處理點選選取段落
  const handleSegmentClicked = useCallback(
    (id: string, e?: MouseEvent | React.MouseEvent) => {
      const sorted = [...segments].sort((a, b) => a.start - b.start);
      const clickedSeg = sorted.find((s) => s.id === id);
      if (!clickedSeg) return;

      const shouldMultiSelect = !!(e?.shiftKey && selectedSegmentId);
      const nextSelectedIds = shouldMultiSelect
        ? getShiftSelectionIds(
            sorted.map((s) => ({ id: s.id || '', start: s.start, end: s.end } as any)),
            selectedSegmentId!,
            id
          )
        : new Set([id]);

      if (!shouldMultiSelect) {
        setSelectedSegmentId(id);
      }
      setSelectedSegmentIds(nextSelectedIds);
      setEditLabel(clickedSeg.label);
    },
    [segments, selectedSegmentId]
  );

  // 撤銷 (Undo)
  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length <= 1) return;

    const newStack = [...stack];
    newStack.pop(); // 移除當前狀態
    const prevStateStr = newStack[newStack.length - 1];
    undoStackRef.current = newStack;

    const prevSegments = JSON.parse(prevStateStr) as LabSegment[];
    setSegmentsState(prevSegments);
    setSelectedSegmentId(null);
    setSelectedSegmentIds(new Set());

    setTimeout(() => onChange?.(), 0);
  }, [onChange]);

  // 取得當前 segments
  const getCurrentSegments = useCallback((): LabSegment[] => {
    return segments;
  }, [segments]);

  return {
    segments,
    setSegments,
    selectedSegmentId,
    selectedSegment,
    selectedRegion: selectedSegment,
    selectedRegionIds: selectedSegmentIds,
    editLabel,
    labelsCount,
    regionItems,
    startPointerTime,
    setSelectedSegmentId,
    setSelectedRegion,
    setEditLabel,
    loadSegments,
    updateLabel,
    updateSegmentWordIndex,
    updateRegionWordIndex: updateSegmentWordIndex,
    deleteSelected,
    splitAtTime,
    handleSegmentDrag,
    handleSegmentDragEnd,
    handleSegmentClicked,
    handleRegionClicked: (r, e) => handleSegmentClicked(r.id, e),
    undo,
    saveHistory,
    getCurrentSegments,
    setStartPointerTime,
  };
}
