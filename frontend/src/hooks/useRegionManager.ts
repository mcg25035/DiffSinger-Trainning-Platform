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
import type { Region } from 'wavesurfer.js/plugins/regions';
import type RegionsPlugin from 'wavesurfer.js/plugins/regions';
import type { LabSegment } from '../utils/labParser';
import { stringifyLabSegments } from '../utils/labParser';
import {
  createLabelElement,
  applyRegionStyle,
  getRegionLabel,
  getRegionScore,
} from '../utils/regionStyle';

export interface RegionItem {
  id: string;
  label: string;
  region: Region;
}

export interface UseRegionManagerReturn {
  // State
  selectedRegion: Region | null;
  editLabel: string;
  labelsCount: number | null;
  regionItems: RegionItem[];
  // Actions
  setSelectedRegion: (region: Region | null) => void;
  setEditLabel: (label: string) => void;
  loadRegions: (segments: LabSegment[], regions: RegionsPlugin) => void;
  renderSegments: (segments: LabSegment[], regions: RegionsPlugin) => void;
  updateLabel: () => void;
  deleteSelected: () => void;
  splitAtTime: (time: number) => void;
  handleRegionUpdated: (region: Region) => void;
  handleRegionClicked: (region: Region) => void;
  refreshRegionsState: () => void;
  undo: () => void;
  saveHistory: () => void;
  /** 取得當前所有 regions 的 LabSegment 表示 */
  getCurrentSegments: () => LabSegment[];
}

export function useRegionManager(
  regionsRef: React.MutableRefObject<RegionsPlugin | null>,
  onChange?: () => void
): UseRegionManagerReturn {
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [labelsCount, setLabelsCount] = useState<number | null>(null);
  const [regionItems, setRegionItems] = useState<RegionItem[]>([]);

  const isUpdatingRef = useRef(false);
  const undoStackRef = useRef<string[]>([]);

  // 刷新 region state（從 DOM 讀取最新資料）
  const refreshRegionsState = useCallback(() => {
    if (!regionsRef.current) return;
    const all = regionsRef.current
      .getRegions()
      .sort((a: Region, b: Region) => a.start - b.start);
    setLabelsCount(all.length);
    setRegionItems(
      all.map((r: Region) => ({
        id: r.id,
        label: getRegionLabel(r),
        region: r,
      }))
    );
  }, [regionsRef]);

  // 通知外部（runAlignment 等）
  const notifyChange = useCallback(() => {
    refreshRegionsState();
    onChange?.();
  }, [refreshRegionsState, onChange]);

  // 儲存歷史紀錄
  const saveHistory = useCallback(() => {
    if (!regionsRef.current) return;
    const current = stringifyFromRegions(regionsRef.current.getRegions());
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
        if (reg) applyRegionStyle(reg, seg.label, level, seg.score);
      });
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
      undoStackRef.current = [stringifyFromRegions(regions.getRegions())];
    },
    [renderSegments]
  );

  // 更新選中 region 的標籤
  const updateLabel = useCallback(() => {
    if (!selectedRegion || !regionsRef.current) return;
    const all = regionsRef.current
      .getRegions()
      .sort((a: Region, b: Region) => a.start - b.start);
    const idx = all.indexOf(selectedRegion);
    const level = idx !== -1 ? idx % 2 : 0;
    const score = getRegionScore(selectedRegion);

    selectedRegion.setOptions({
      content: createLabelElement(editLabel, level),
    });
    applyRegionStyle(selectedRegion, editLabel, level, score);

    commitChange();
  }, [selectedRegion, editLabel, regionsRef, commitChange]);

  // 刪除選中的 region
  const deleteSelected = useCallback(() => {
    if (!selectedRegion || !regionsRef.current) return;
    selectedRegion.remove();
    setSelectedRegion(null);

    // 重新計算層級顏色
    const newAll = regionsRef.current
      .getRegions()
      .sort((a: Region, b: Region) => a.start - b.start);
    newAll.forEach((r: Region, i: number) => {
      const level = i % 2;
      const label = getRegionLabel(r);
      const score = getRegionScore(r);
      applyRegionStyle(r, label, level, score);
    });

    commitChange();
  }, [selectedRegion, regionsRef, commitChange]);

  // 在指定時間點切割 region
  const splitAtTime = useCallback(
    (time: number) => {
      if (!regionsRef.current) return;
      const regions = regionsRef.current;
      const all = regions
        .getRegions()
        .sort((a: Region, b: Region) => a.start - b.start);
      const target = all.find(
        (r: Region) => time >= r.start && time <= r.end
      );
      if (!target) return;

      const oldEnd = target.end;
      const oldLabel = getRegionLabel(target);
      const oldScore = getRegionScore(target);

      isUpdatingRef.current = true;
      target.setOptions({ end: time });
      const newReg = regions.addRegion({
        start: time,
        end: oldEnd,
        content: createLabelElement(oldLabel, 0),
        drag: false,
        resize: true,
      });
      if (newReg) applyRegionStyle(newReg, oldLabel, 0, oldScore);

      isUpdatingRef.current = false;

      // 重新計算所有層級
      const newAll = regions
        .getRegions()
        .sort((a: Region, b: Region) => a.start - b.start);
      newAll.forEach((r: Region, idx: number) => {
        const level = idx % 2;
        const label = getRegionLabel(r);
        const score = getRegionScore(r);
        applyRegionStyle(r, label, level, score);
      });

      commitChange();
    },
    [regionsRef, commitChange]
  );

  // region 拖拉後鄰居邊界調整
  const handleRegionUpdated = useCallback(
    (r: Region) => {
      if (isUpdatingRef.current) return;
      if (!regionsRef.current) return;

      isUpdatingRef.current = true;
      const all = regionsRef.current
        .getRegions()
        .sort((a: Region, b: Region) => a.start - b.start);
      const i = all.indexOf(r);
      if (i < all.length - 1) all[i + 1].setOptions({ start: r.end });
      if (i > 0) all[i - 1].setOptions({ end: r.start });
      isUpdatingRef.current = false;

      commitChange();
    },
    [regionsRef, commitChange]
  );

  // region 點擊 → 選取
  const handleRegionClicked = useCallback((r: Region) => {
    setSelectedRegion(r);
    setEditLabel(getRegionLabel(r));
  }, []);

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
      if (reg) applyRegionStyle(reg, seg.label, level, seg.score);
    });
    isUpdatingRef.current = false;

    notifyChange();
  }, [regionsRef, notifyChange]);

  // 取得當前 segments
  const getCurrentSegments = useCallback((): LabSegment[] => {
    if (!regionsRef.current) return [];
    return regionsRef.current
      .getRegions()
      .sort((a: Region, b: Region) => a.start - b.start)
      .map((r: Region) => ({
        start: r.start,
        end: r.end,
        label: getRegionLabel(r),
        score: getRegionScore(r),
      }));
  }, [regionsRef]);

  return {
    selectedRegion,
    editLabel,
    labelsCount,
    regionItems,
    setSelectedRegion,
    setEditLabel,
    loadRegions,
    renderSegments,
    updateLabel,
    deleteSelected,
    splitAtTime,
    handleRegionUpdated,
    handleRegionClicked,
    refreshRegionsState,
    undo,
    saveHistory,
    getCurrentSegments,
  };
}

// ── 內部工具函式 ──

/** 從 Region[] 序列化為 .lab 文字 */
function stringifyFromRegions(regions: Region[]): string {
  return regions
    .sort((a, b) => a.start - b.start)
    .map((r) => {
      const s = Math.round(r.start * 10000000);
      const e = Math.round(r.end * 10000000);
      const label = getRegionLabel(r);
      return `${s} ${e} ${label}`;
    })
    .join('\n');
}

/** 從 .lab 文字快速解析（用於 undo，不需要信心分數） */
function parseLabFromString(content: string): LabSegment[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) return null;
      let start = parseFloat(parts[0]);
      let end = parseFloat(parts[1]);
      const label = parts[2];
      if (start > 100000 || end > 100000) {
        start /= 10000000;
        end /= 10000000;
      }
      return { start, end, label } as LabSegment;
    })
    .filter((s): s is LabSegment => s !== null);
}
