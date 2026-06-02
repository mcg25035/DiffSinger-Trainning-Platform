/**
 * useRegionManager — Region CRUD + Undo + 鄰居邊界調整
 *
 * 職責：
 *  - 從 LabSegment[] 建立 regions
 *  - 管理 selectedRegion / regionItems state
 *  - 提供 updateLabel / deleteSelected / split 等操作
 *  - Undo stack 管理
 *  - 鄰居邊界自動調整（region 拖拉時）
 *  - 每次變更後呼叫 onChange 通知外部
 */

import { useState, useRef, useCallback } from 'react';
import type React from 'react';
import type { Region } from 'wavesurfer.js/plugins/regions';
import type RegionsPlugin from 'wavesurfer.js/plugins/regions';
import type { LabSegment } from '../utils/labParser';
import {
  createLabelElement,
  applyRegionStyle,
  getRegionLabel,
  getRegionScore,
  getRegionWordIndex,
} from '../utils/regionStyle';
import { stringifyFromRegions, parseLabFromString } from '../utils/labSerialization';
import { updateRegionPositions, getShiftSelectionIds } from '../utils/regionPositionHelper';

export interface RegionItem {
  id: string;
  label: string;
  region: Region;
  wordIndex?: number;
}

export interface UseRegionManagerReturn {
  // State
  selectedRegion: Region | null;
  selectedRegionIds: Set<string>;
  editLabel: string;
  labelsCount: number | null;
  regionItems: RegionItem[];
  startPointerTime: number;
  // Actions
  setSelectedRegion: (region: Region | null) => void;
  setEditLabel: (label: string) => void;
  loadRegions: (segments: LabSegment[], regions: RegionsPlugin) => void;
  renderSegments: (segments: LabSegment[], regions: RegionsPlugin) => void;
  updateLabel: () => void;
  deleteSelected: () => void;
  splitAtTime: (time: number) => void;
  handleRegionUpdate: (region: Region) => void;
  handleRegionUpdated: (region: Region) => void;
  handleRegionClicked: (region: Region, e?: MouseEvent | React.MouseEvent) => void;
  refreshRegionsState: () => void;
  undo: () => void;
  saveHistory: () => void;
  updateRegionWordIndex: (regionId: string, wordIndex: number | undefined) => void;
  /** 取得當前所有 regions 的 LabSegment 表示 */
  getCurrentSegments: () => LabSegment[];
  setStartPointerTime: (time: number) => void;
  recreateStartPointer: (regions: RegionsPlugin, time?: number) => void;
}

export function useRegionManager(
  regionsRef: React.MutableRefObject<RegionsPlugin | null>,
  onChange?: () => void
): UseRegionManagerReturn {
  const [selectedRegion, setSelectedRegionState] = useState<Region | null>(null);
  const [selectedRegionIds, setSelectedRegionIds] = useState<Set<string>>(new Set());
  const [editLabel, setEditLabel] = useState('');
  const [labelsCount, setLabelsCount] = useState<number | null>(null);
  const [regionItems, setRegionItems] = useState<RegionItem[]>([]);

  // Start pointer states
  const [startPointerTime, setStartPointerTimeState] = useState(0);
  const startPointerTimeRef = useRef(0);

  const setStartPointerTime = useCallback((time: number) => {
    startPointerTimeRef.current = time;
    setStartPointerTimeState(time);
  }, []);

  const recreateStartPointer = useCallback((regions: RegionsPlugin, time?: number) => {
    const existing = regions.getRegions().find((r) => r.id === 'start-pointer');
    if (existing) {
      existing.remove();
    }
    const t = time !== undefined ? time : startPointerTimeRef.current;
    regions.addRegion({
      id: 'start-pointer',
      start: t,
      end: t + 0.05,
      drag: true,
      resize: false,
      color: 'transparent',
    });
  }, []);

  const isUpdatingRef = useRef(false);
  const undoStackRef = useRef<string[]>([]);
  const lastSegmentsRef = useRef<LabSegment[]>([]);
  const dragStartPositionsRef = useRef<Map<string, { start: number; end: number }> | null>(null);

  const setSelectedRegion = useCallback((r: Region | null) => {
    setSelectedRegionState(r);
    if (r) {
      setSelectedRegionIds(new Set([r.id]));
    } else {
      setSelectedRegionIds(new Set());
    }
  }, []);

  // 刷新 region state（從 DOM 讀取最新資料）
  const refreshRegionsState = useCallback(() => {
    if (!regionsRef.current) return;
    const all = regionsRef.current
      .getRegions()
      .filter((r) => r.id !== 'start-pointer')
      .sort((a: Region, b: Region) => a.start - b.start);
    setLabelsCount(all.length);
    setRegionItems(
      all.map((r: Region) => ({
        id: r.id,
        label: getRegionLabel(r),
        region: r,
        wordIndex: getRegionWordIndex(r),
      }))
    );

    // 暫存最新的 segments，避免 wavesurfer 銷毀時丟失修改進度
    lastSegmentsRef.current = all.map((r: Region) => ({
      start: r.start,
      end: r.end,
      label: getRegionLabel(r),
      score: getRegionScore(r),
      wordIndex: getRegionWordIndex(r),
    }));
  }, [regionsRef]);

  // 通知外部（runAlignment 等）
  const notifyChange = useCallback(() => {
    refreshRegionsState();
    onChange?.();
  }, [refreshRegionsState, onChange]);

  // 儲存歷史紀錄
  const saveHistory = useCallback(() => {
    if (!regionsRef.current) return;
    const current = stringifyFromRegions(
      regionsRef.current.getRegions().filter((r) => r.id !== 'start-pointer')
    );
    const stack = undoStackRef.current;
    if (stack.length > 0 && stack[stack.length - 1] === current) return;
    undoStackRef.current = [...stack, current];
  }, [regionsRef]);

  // 標記為已修改並儲存歷史
  const commitChange = useCallback(() => {
    saveHistory();
    notifyChange();
  }, [saveHistory, notifyChange]);

  // 純粹將 segments 重新渲染到新的 RegionsPlugin 實例上，不改動歷史紀錄 (undoStack)
  const renderSegments = useCallback(
    (segments: LabSegment[], regions: RegionsPlugin) => {
      isUpdatingRef.current = true;
      regions.clearRegions();
      segments.forEach((seg, i) => {
        const level = i % 2;
        const reg = regions.addRegion({
          start: seg.start,
          end: seg.end,
          content: createLabelElement(seg.label, level),
          drag: false,
          resize: true,
        });
        if (reg) applyRegionStyle(reg, seg.label, level, seg.score, seg.wordIndex);
      });

      // Re-create the start pointer after clearing
      recreateStartPointer(regions);

      isUpdatingRef.current = false;
      refreshRegionsState();
    },
    [refreshRegionsState]
  );

  // 全新載入 labels，渲染並重設 undo stack
  const loadRegions = useCallback(
    (segments: LabSegment[], regions: RegionsPlugin) => {
      renderSegments(segments, regions);
      // 初始化 undo stack
      undoStackRef.current = [
        stringifyFromRegions(
          regions.getRegions().filter((r) => r.id !== 'start-pointer')
        ),
      ];
    },
    [renderSegments]
  );

  // 更新選中 region 的標籤
  const updateLabel = useCallback(() => {
    if (selectedRegionIds.size > 1) return;
    if (!selectedRegion || !regionsRef.current) return;
    const all = regionsRef.current
      .getRegions()
      .filter((r) => r.id !== 'start-pointer')
      .sort((a: Region, b: Region) => a.start - b.start);
    const idx = all.indexOf(selectedRegion);
    const level = idx !== -1 ? idx % 2 : 0;
    const score = getRegionScore(selectedRegion);
    const wordIndex = getRegionWordIndex(selectedRegion);

    selectedRegion.setOptions({
      content: createLabelElement(editLabel, level),
    });
    applyRegionStyle(selectedRegion, editLabel, level, score, wordIndex);

    commitChange();
  }, [selectedRegion, selectedRegionIds, editLabel, regionsRef, commitChange]);

  // 更新選中 region 的 wordIndex
  const updateRegionWordIndex = useCallback((regionId: string, wordIndex: number | undefined) => {
    if (!regionsRef.current) return;
    const all = regionsRef.current.getRegions().filter((r) => r.id !== 'start-pointer');
    const region = all.find((r) => r.id === regionId);
    if (!region) return;

    const allSorted = [...all].sort((a, b) => a.start - b.start);
    const idx = allSorted.indexOf(region);
    const level = idx !== -1 ? idx % 2 : 0;
    const label = getRegionLabel(region);
    const score = getRegionScore(region);

    applyRegionStyle(region, label, level, score, wordIndex);

    if (selectedRegion && selectedRegion.id === regionId) {
      setSelectedRegion(region);
    }

    commitChange();
  }, [regionsRef, selectedRegion, setSelectedRegion, commitChange]);

  // 刪除選中的 region
  const deleteSelected = useCallback(() => {
    if (selectedRegionIds.size > 1) return;
    if (!selectedRegion || !regionsRef.current) return;

    // 取得刪除前的排序與索引，用 id 匹配避免物件引用不一致
    const allBefore = regionsRef.current
      .getRegions()
      .filter((r) => r.id !== 'start-pointer')
      .sort((a: Region, b: Region) => a.start - b.start);
    const idx = allBefore.findIndex((r: Region) => r.id === selectedRegion.id);
    const deletedEnd = selectedRegion.end;

    selectedRegion.remove();
    setSelectedRegion(null);

    // 讓前一個 region 延伸以填補空隙（float 域共享邊界，-1 由序列化層處理）
    if (idx > 0) {
      allBefore[idx - 1].setOptions({ end: deletedEnd });
    }

    // 重新計算層級顏色
    const newAll = regionsRef.current
      .getRegions()
      .filter((r) => r.id !== 'start-pointer')
      .sort((a: Region, b: Region) => a.start - b.start);
    newAll.forEach((r: Region, i: number) => {
      const level = i % 2;
      const label = getRegionLabel(r);
      const score = getRegionScore(r);
      const wordIndex = getRegionWordIndex(r);
      applyRegionStyle(r, label, level, score, wordIndex);
    });

    commitChange();
  }, [selectedRegion, selectedRegionIds, regionsRef, setSelectedRegion, commitChange]);

  // 在指定時間點切割 region
  const splitAtTime = useCallback(
    (time: number) => {
      if (!regionsRef.current) return;
      const regions = regionsRef.current;
      const all = regions
        .getRegions()
        .filter((r) => r.id !== 'start-pointer')
        .sort((a: Region, b: Region) => a.start - b.start);
      const target = all.find(
        (r: Region) => time >= r.start && time <= r.end
      );
      if (!target) return;

      const oldEnd = target.end;
      const oldLabel = getRegionLabel(target);
      const oldScore = getRegionScore(target);
      const oldWordIndex = getRegionWordIndex(target);

      isUpdatingRef.current = true;
      target.setOptions({ end: time });
      const newReg = regions.addRegion({
        start: time,
        end: oldEnd,
        content: createLabelElement(oldLabel, 0),
        drag: false,
        resize: true,
      });
      if (newReg) applyRegionStyle(newReg, oldLabel, 0, oldScore, oldWordIndex);

      isUpdatingRef.current = false;

      // 重新計算所有層級
      const newAll = regions
        .getRegions()
        .filter((r) => r.id !== 'start-pointer')
        .sort((a: Region, b: Region) => a.start - b.start);
      newAll.forEach((r: Region, idx: number) => {
        const level = idx % 2;
        const label = getRegionLabel(r);
        const score = getRegionScore(r);
        const wordIndex = getRegionWordIndex(r);
        applyRegionStyle(r, label, level, score, wordIndex);
      });

      commitChange();
    },
    [regionsRef, commitChange]
  );

  // region 拖動過程中鄰居邊界/多選同步調整
  const handleRegionUpdate = useCallback(
    (r: Region) => {
      if (isUpdatingRef.current) return;
      if (!regionsRef.current) return;

      if (r.id === 'start-pointer') {
        setStartPointerTime(r.start);
        return;
      }

      if (!dragStartPositionsRef.current) {
        const map = new Map<string, { start: number; end: number }>();
        regionsRef.current.getRegions().forEach((reg) => {
          map.set(reg.id, { start: reg.start, end: reg.end });
        });
        dragStartPositionsRef.current = map;
      }

      const all = regionsRef.current
        .getRegions()
        .filter((reg) => reg.id !== 'start-pointer')
        .sort((a: Region, b: Region) => a.start - b.start);

      isUpdatingRef.current = true;
      updateRegionPositions(r, all, selectedRegionIds, dragStartPositionsRef.current);
      isUpdatingRef.current = false;
    },
    [selectedRegionIds, regionsRef, setStartPointerTime]
  );

  // region 拖拉後鄰居邊界調整
  const handleRegionUpdated = useCallback(
    (r: Region) => {
      if (isUpdatingRef.current) return;
      if (!regionsRef.current) return;

      if (r.id === 'start-pointer') {
        setStartPointerTime(r.start);
        dragStartPositionsRef.current = null;
        return;
      }

      handleRegionUpdate(r);
      dragStartPositionsRef.current = null;
      commitChange();
    },
    [handleRegionUpdate, commitChange, setStartPointerTime]
  );

  // region 點擊 → 選取
  const handleRegionClicked = useCallback(
    (r: Region, e?: MouseEvent | React.MouseEvent) => {
      if (r.id === 'start-pointer') return;
      if (!regionsRef.current) return;
      const all = regionsRef.current
        .getRegions()
        .filter((reg) => reg.id !== 'start-pointer')
        .sort((a: Region, b: Region) => a.start - b.start);

      const shouldMultiSelect = !!(e?.shiftKey && selectedRegion);
      const nextSelectedIds = shouldMultiSelect
        ? getShiftSelectionIds(all, selectedRegion!.id, r.id)
        : new Set([r.id]);

      if (!shouldMultiSelect) {
        setSelectedRegionState(r);
      }
      setSelectedRegionIds(nextSelectedIds);
      setEditLabel(getRegionLabel(r));
    },
    [selectedRegion, regionsRef]
  );

  // 撤銷
  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length <= 1 || !regionsRef.current) return;

    const newStack = [...stack];
    newStack.pop();
    const prevState = newStack[newStack.length - 1];
    undoStackRef.current = newStack;

    // 從文字重建所有 regions
    const segments = parseLabFromString(prevState);
    isUpdatingRef.current = true;
    regionsRef.current.clearRegions();
    segments.forEach((seg, i) => {
      const level = i % 2;
      const reg = regionsRef.current?.addRegion({
        start: seg.start,
        end: seg.end,
        content: createLabelElement(seg.label, level),
        drag: false,
        resize: true,
      });
      if (reg) applyRegionStyle(reg, seg.label, level, seg.score, seg.wordIndex);
    });

    // Re-create start pointer in undo
    recreateStartPointer(regionsRef.current);

    isUpdatingRef.current = false;

    notifyChange();
  }, [regionsRef, notifyChange]);

  // 取得當前 segments
  const getCurrentSegments = useCallback((): LabSegment[] => {
    return lastSegmentsRef.current;
  }, []);

  return {
    selectedRegion,
    selectedRegionIds,
    editLabel,
    labelsCount,
    regionItems,
    startPointerTime,
    setSelectedRegion,
    setEditLabel,
    loadRegions,
    renderSegments,
    updateLabel,
    updateRegionWordIndex,
    deleteSelected,
    splitAtTime,
    handleRegionUpdate,
    handleRegionUpdated,
    handleRegionClicked,
    refreshRegionsState,
    undo,
    saveHistory,
    getCurrentSegments,
    setStartPointerTime,
    recreateStartPointer,
  };
}


