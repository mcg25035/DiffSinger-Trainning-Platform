/**
 * LabelEditor — Visual Labeler 主組件 (重構後)
 *
 * 此組件現在作為**組合與同步層**：
 *  - 負責初始化所有資料/播放 hooks。
 *  - 提供一個單向的同步 Effect，負責將 React 的 segments state 繪製到 WaveSurfer 畫面上。
 *  - 將 WaveSurfer 的操作（如雙擊切割、右鍵設定播放起點、拖曳 Region 等）轉換為對 React state 的更新。
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import type { Recording } from '../hooks/useAudioMonitor';
import { useWaveSurfer } from '../hooks/useWaveSurfer';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { useRegionManager } from '../hooks/useRegionManager';
import { useLyricsAlignment } from '../hooks/useLyricsAlignment';
import { useLabelPersistence } from '../hooks/useLabelPersistence';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import {
  getRegionLabel,
  getRegionWordIndex,
  createLabelElement,
  applyRegionStyle,
} from '../utils/regionStyle';
import { loadWordAlignmentMap } from '../utils/alignmentStorage';
import { focusAndSelectAll } from '../utils/domUtils';
import { LabelToolbar } from './label-editor/LabelToolbar';
import { PhonemeEditPanel } from './label-editor/PhonemeEditPanel';
import { RegionButtonTrack } from './label-editor/RegionButtonTrack';
import { LyricsDisplay } from './label-editor/LyricsDisplay';
import { ReasonModal, type BoundaryInfo } from './label-editor/ReasonModal';
import {
  D114514BoundaryOverlay,
  type D114514BoundaryOverlayData,
} from './label-editor/D114514BoundaryOverlay';
import './label-editor/LabelEditor.css';
import type { Region } from 'wavesurfer.js/plugins/regions';
import type { LabSegment } from '../utils/labParser';

interface Props {
  recording: Recording;
  onCancel: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  isFullscreen?: boolean;
  onFullscreenChange?: (fs: boolean) => void;
}

export function LabelEditor({
  recording,
  onCancel,
  onNext,
  onPrevious,
  isFullscreen: isFullscreenProp = false,
  onFullscreenChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isFullscreenLocal, setIsFullscreenLocal] = useState(false);
  const isFullscreen = onFullscreenChange ? isFullscreenProp : isFullscreenLocal;
  const setIsFullscreen = onFullscreenChange ?? setIsFullscreenLocal;
  const [containerHeight, setContainerHeight] = useState<number>(0);

  const [isReasonModalOpen, setIsReasonModalOpen] = useState(false);
  const [activeBoundaryInfo, setActiveBoundaryInfo] = useState<BoundaryInfo | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [activeLabType, setActiveLabType] = useState<'lab' | 'lab2'>('lab');
  const [hasLab2, setHasLab2] = useState(false);
  const [boundaryOverlayData, setBoundaryOverlayData] = useState<D114514BoundaryOverlayData | null>(null);
  const hasLab2Ref = useRef(false);

  const savedTimeRef = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lyrics = recording.lyrics || '';
  const lastUrlRef = useRef<string>('');

  useEffect(() => {
    const controller = new AbortController();

    hasLab2Ref.current = false;
    setHasLab2(false);
    setActiveLabType('lab');
    setIsReasonModalOpen(false);
    setActiveBoundaryInfo(null);

    fetch(`/api/lab2/${encodeURIComponent(recording.filename)}`, {
      method: 'HEAD',
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) return;
        hasLab2Ref.current = true;
        setHasLab2(true);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.warn('Unable to check LAB2 availability:', error);
      });

    return () => controller.abort();
  }, [recording.filename]);

  useEffect(() => {
    const controller = new AbortController();
    setBoundaryOverlayData(null);
    if (recording.type !== 'segment') return () => controller.abort();

    fetch(`/api/red-boundaries/${encodeURIComponent(recording.filename)}`, {
      signal: controller.signal,
    })
      .then(async response => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<D114514BoundaryOverlayData>;
      })
      .then(data => {
        if (data) setBoundaryOverlayData(data);
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.warn('Unable to load segmentation boundaries:', error);
      });

    return () => controller.abort();
  }, [recording.filename, recording.type]);

  // 用於在拖曳時保存起始狀態
  const dragStartPositionsRef = useRef<Map<string, { start: number; end: number }> | null>(null);
  // 用於防範 React 同步與 WaveSurfer 事件觸發的遞迴更新
  const isSyncingRef = useRef(false);

  // 測量波形容器的高度（視窗 resize 與全螢幕切換時）
  useEffect(() => {
    const handleResize = () => {
      const el = waveformContainerRef.current;
      if (el) {
        const height = el.offsetHeight;
        if (height > 0) {
          setContainerHeight((prev) => {
            if (prev === 0 || Math.abs(height - prev) > 10) {
              return height;
            }
            return prev;
          });
        }
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isFullscreen]);

  const defaultHeight = isFullscreen ? 800 : 280;
  const actualHeight = containerHeight > 0 ? containerHeight : defaultHeight;

  let waveformHeight = Math.floor(actualHeight * 0.35);
  let spectrogramHeight = actualHeight - waveformHeight - 4;

  if (waveformHeight < 60) {
    waveformHeight = 60;
  }
  if (spectrogramHeight < 100) {
    spectrogramHeight = 100;
  }

  // ── 存檔 / 載入 Hook ──
  const persistence = useLabelPersistence(recording);

  // ── Region/Segments 資料狀態管理 Hook ──
  const regionMgr = useRegionManager(() => {
    // 當 segments 有任何修改時：
    alignment.runAlignment();
    persistence.setIsDirty(true);
    persistence.setSaveStatus('idle');
    if (!hasLab2Ref.current) {
      persistence.triggerAutoSave(() => regionMgr.getCurrentSegments());
    }
  });

  // ── 歌詞對齊 Hook ──
  const alignment = useLyricsAlignment(
    regionMgr.segments,
    regionMgr.setSegments,
    lyrics,
    recording.filename
  );

  // ── 顯示層：WaveSurfer ──
  const wavesurfer = useWaveSurfer({
    containerRef,
    url: recording.url,
    waveformHeight,
    spectrogramHeight,
    onReady: (ws, _regions) => {
      const duration = ws.getDuration();

      const isNewFile = lastUrlRef.current !== recording.url;
      lastUrlRef.current = recording.url;

      if (isNewFile) {
        regionMgr.setStartPointerTime(0);
      }

      ws.on('timeupdate', (time) => {
        savedTimeRef.current = time;
      });

      const currentSegments = regionMgr.getCurrentSegments();

      // 若目前已有暫存資料，直接使用它重新對齊
      if (currentSegments.length > 0) {
        loadWordAlignmentMap(recording.filename, currentSegments);
        alignment.runAlignment(currentSegments);
      } else {
        // 第一次載入，自 API 讀取
        persistence.loadLabels(duration).then((loaded) => {
          if (wavesurfer.wavesurferRef.current !== ws) return;
          if (loaded.length > 0) {
            loadWordAlignmentMap(recording.filename, loaded);
            regionMgr.loadSegments(loaded);
            alignment.runAlignment(loaded);
          } else {
            regionMgr.loadSegments([]);
          }
        });
      }

      if (savedTimeRef.current > 0) {
        ws.setTime(savedTimeRef.current);
      }
    },
    onRegionUpdate: (region) => {
      if (isSyncingRef.current) return;
      if (region.id === 'start-pointer') {
        regionMgr.setStartPointerTime(region.start);
      } else {
        if (!dragStartPositionsRef.current) {
          const map = new Map<string, { start: number; end: number }>();
          regionMgr.segments.forEach((s) => {
            if (s.id) map.set(s.id, { start: s.start, end: s.end });
          });
          dragStartPositionsRef.current = map;
        }
        regionMgr.handleSegmentDrag(region.id, region.start, region.end, dragStartPositionsRef.current);
      }
    },
    onRegionUpdated: (region) => {
      if (isSyncingRef.current) return;
      if (region.id === 'start-pointer') {
        regionMgr.setStartPointerTime(region.start);
      } else {
        if (dragStartPositionsRef.current) {
          const oldPos = dragStartPositionsRef.current.get(region.id);
          regionMgr.handleSegmentDragEnd(region.id, region.start, region.end, dragStartPositionsRef.current);

          if (oldPos) {
            const startShifted = Math.abs(oldPos.start - region.start) > 0.0005;
            const endShifted = Math.abs(oldPos.end - region.end) > 0.0005;

            if (hasLab2Ref.current && (startShifted || endShifted)) {
              const sorted = [...regionMgr.segments].sort((a, b) => a.start - b.start);
              const idx = sorted.findIndex((s) => s.id === region.id);

              let phonemeBefore = '^';
              let phonemeAfter = '$';
              let oldTime = 0;
              let newTime = 0;

              if (startShifted && idx >= 0) {
                phonemeBefore = idx > 0 ? sorted[idx - 1].label : '^';
                phonemeAfter = sorted[idx].label;
                oldTime = oldPos.start;
                newTime = region.start;
              } else if (endShifted && idx >= 0) {
                phonemeBefore = sorted[idx].label;
                phonemeAfter = idx < sorted.length - 1 ? sorted[idx + 1].label : '$';
                oldTime = oldPos.end;
                newTime = region.end;
              }

              const diffMs = Math.round((newTime - oldTime) * 1000);
              const bndInfo: BoundaryInfo = {
                phonemeBefore,
                phonemeAfter,
                oldTime,
                newTime,
                diffMs,
              };

              setActiveBoundaryInfo(bndInfo);
              setIsReasonModalOpen(true);
            }
          }
        }
      }
      dragStartPositionsRef.current = null;
    },
    onRegionClicked: (region, e) => {
      if (region.id === 'start-pointer') return;
      regionMgr.handleSegmentClicked(region.id, e);
    },
    onDblClick: (time) => {
      regionMgr.splitAtTime(time);
    },
    onRightClick: (time) => {
      regionMgr.setStartPointerTime(time);
    },
  });

  const [activePlayRange, setActivePlayRange] = useState<{ start: number; end: number } | null>(null);

  // ── 播放層：Crunker + HTMLAudioElement ──
  const audio = useAudioPlayback({
    url: recording.url,
    playbackRate,
    onTimeUpdate: (t) => wavesurfer.wavesurferRef.current?.setTime(t),
    onPlaybackStateChange: (p) => {
      setIsPlaying(p);
      if (p) return;

      setActivePlayRange(null);
      const ws = wavesurfer.wavesurferRef.current;
      if (ws && regionMgr.selectedSegment) {
        ws.setTime(regionMgr.selectedSegment.start);
      }
    },
  });

  const handlePlayRange = useCallback(
    (start: number, end: number) => {
      setActivePlayRange({ start, end });
      audio.playRange(start, end);
    },
    [audio]
  );

  // ── 單向資料流同步：React State ➔ WaveSurfer Regions ──
  useEffect(() => {
    const ws = wavesurfer.wavesurferRef.current;
    const regions = wavesurfer.regionsRef.current;
    if (!ws || !regions || !wavesurfer.isLoaded) return;

    const wsRegions = regions.getRegions().filter((r) => r.id !== 'start-pointer');
    const wsRegionsMap = new Map(wsRegions.map((r) => [r.id, r]));
    const segmentsMap = new Map(regionMgr.segments.map((s) => [s.id, s]));

    isSyncingRef.current = true;

    // 1. 移除已被刪除的段落
    wsRegions.forEach((r) => {
      if (!segmentsMap.has(r.id)) {
        r.remove();
      }
    });

    // 2. 新增或更新段落
    regionMgr.segments.forEach((seg, i) => {
      const level = i % 2;
      const existing = wsRegionsMap.get(seg.id || '');

      if (existing) {
        const currentLabel = getRegionLabel(existing);
        const currentWordIndex = getRegionWordIndex(existing);

        const timeChanged =
          Math.abs(existing.start - seg.start) > 0.001 ||
          Math.abs(existing.end - seg.end) > 0.001;
        const labelChanged = currentLabel !== seg.label;
        const wordIndexChanged = currentWordIndex !== seg.wordIndex;

        if (timeChanged || labelChanged || wordIndexChanged) {
          existing.setOptions({
            start: seg.start,
            end: seg.end,
            content: labelChanged ? createLabelElement(seg.label, level) : existing.content,
          });
          if (labelChanged || wordIndexChanged) {
            applyRegionStyle(existing, seg.label, level, seg.score, seg.wordIndex);
          }
        }
      } else if (seg.id) {
        const reg = regions.addRegion({
          id: seg.id,
          start: seg.start,
          end: seg.end,
          content: createLabelElement(seg.label, level),
          drag: false,
          resize: true,
        });
        if (reg) {
          applyRegionStyle(reg, seg.label, level, seg.score, seg.wordIndex);
        }
      }
    });

    isSyncingRef.current = false;
  }, [regionMgr.segments, wavesurfer.isLoaded, wavesurfer.wavesurferRef, wavesurfer.regionsRef]);

  // ── 單向資料流同步：React State ➔ WaveSurfer Start Pointer ──
  useEffect(() => {
    const ws = wavesurfer.wavesurferRef.current;
    const regions = wavesurfer.regionsRef.current;
    if (!ws || !regions || !wavesurfer.isLoaded) return;

    const existing = regions.getRegions().find((r) => r.id === 'start-pointer');
    if (existing) {
      if (Math.abs(existing.start - regionMgr.startPointerTime) > 0.001) {
        existing.setOptions({
          start: regionMgr.startPointerTime,
          end: regionMgr.startPointerTime + 0.05,
        });
      }
    } else {
      regions.addRegion({
        id: 'start-pointer',
        start: regionMgr.startPointerTime,
        end: regionMgr.startPointerTime + 0.05,
        drag: true,
        resize: false,
        color: 'transparent',
      });
    }
  }, [regionMgr.startPointerTime, wavesurfer.isLoaded, wavesurfer.wavesurferRef, wavesurfer.regionsRef]);

  // ── 選取標示：添加箭頭效果 ──
  useEffect(() => {
    if (!wavesurfer.regionsRef.current) return;
    const all = wavesurfer.regionsRef.current.getRegions();

    const phonemes = all.filter((r) => r.id !== 'start-pointer');
    phonemes.forEach((r: Region) => {
      if (!r.element) return;
      let arrow = r.element.querySelector('.region-selected-arrow') as HTMLElement | null;
      if (regionMgr.selectedRegionIds.has(r.id)) {
        if (!arrow) {
          arrow = document.createElement('div');
          arrow.className = 'region-selected-arrow';
          arrow.innerHTML = '▼';
          r.element.appendChild(arrow);
        }
        arrow.style.display = 'block';
      } else if (arrow) {
        arrow.style.display = 'none';
      }
    });
  }, [regionMgr.selectedRegionIds, regionMgr.regionItems, wavesurfer.isLoaded]);

  // ── 播放與選擇控制邏輯 ──
  const handlePhonemePlay = useCallback(() => {
    if (regionMgr.selectedRegionIds.size > 1) return;
    const ws = wavesurfer.wavesurferRef.current;
    if (!ws) return;

    const time = ws.getCurrentTime();
    const eps = 0.01;
    const all = [...regionMgr.segments].sort((a, b) => a.start - b.start);
    if (all.length === 0) return;

    let target: LabSegment | undefined;
    const now = Date.now();
    const lastPlayback = lastPlaybackRef.current;

    // 播放防抖
    if (
      lastPlayback &&
      (audio.isPlayingRef.current || now - lastPlayback.timestamp < (lastPlayback.end - lastPlayback.start) * 1000 + 500)
    ) {
      if (time >= lastPlayback.start && time <= lastPlayback.end + 0.05) {
        target = all.find(
          (s) =>
            Math.abs(s.start - lastPlayback.start) < 0.001 &&
            Math.abs(s.end - lastPlayback.end) < 0.001
        );
      }
    }

    if (!target) {
      target = all.find((s) => time >= s.start && time < s.end);
      if (!target) target = all.find((s) => time >= s.start && time <= s.end);
      if (!target && time < eps) target = all[0];
    }

    if (target) {
      lastPlaybackRef.current = { start: target.start, end: target.end, timestamp: Date.now() };
      handlePlayRange(target.start, target.end);
    }
  }, [audio, wavesurfer.wavesurferRef, regionMgr.segments, regionMgr.selectedRegionIds, handlePlayRange]);

  const handleWordPlay = useCallback(() => {
    if (regionMgr.selectedRegionIds.size > 1) return;
    const ws = wavesurfer.wavesurferRef.current;
    if (!ws) return;

    const time = ws.getCurrentTime();
    const { wordInstances } = alignment;

    let word: typeof wordInstances[0] | undefined;
    const now = Date.now();
    const lastWordPlayback = lastWordPlaybackRef.current;

    // 播放防抖
    if (
      lastWordPlayback &&
      (audio.isPlayingRef.current || now - lastWordPlayback.timestamp < (lastWordPlayback.end - lastWordPlayback.start) * 1000 + 500)
    ) {
      if (time >= lastWordPlayback.start && time <= lastWordPlayback.end + 0.05) {
        word = wordInstances.find(
          (w) =>
            Math.abs(w.start - lastWordPlayback.start) < 0.001 &&
            Math.abs(w.end - lastWordPlayback.end) < 0.001
        );
      }
    }

    if (!word) {
      word =
        wordInstances.find((w) => time >= w.start && time < w.end) ||
        wordInstances.find((w) => time >= w.start && time <= w.end);
    }

    if (word) {
      lastWordPlaybackRef.current = { start: word.start, end: word.end, timestamp: Date.now() };
      handlePlayRange(word.start, word.end);
    }
  }, [audio, wavesurfer.wavesurferRef, alignment, regionMgr.selectedRegionIds, handlePlayRange]);

  const handleFullPlay = useCallback(() => {
    if (regionMgr.selectedRegionIds.size > 1) return;
    const ws = wavesurfer.wavesurferRef.current;
    if (!ws) return;

    if (audio.isPlayingRef.current) {
      audio.stop();
      return;
    }

    let startTime = regionMgr.startPointerTime;
    if (startTime >= ws.getDuration() - 0.05) {
      startTime = 0;
    }
    audio.playFull(startTime);
  }, [audio, wavesurfer.wavesurferRef, regionMgr.selectedRegionIds, regionMgr.startPointerTime]);

  const handleSave = useCallback(async () => {
    if (hasLab2Ref.current) {
      setIsReasonModalOpen(true);
      return;
    }

    const ok = await persistence.saveLabels(regionMgr.getCurrentSegments());
    if (!ok) {
      alert('Save failed');
    }
  }, [regionMgr, persistence]);

  const handleConfirmSaveAlgo = useCallback(async (reason: string) => {
    const segments = regionMgr.getCurrentSegments();
    const ok = await persistence.saveAlgoLabel(segments, reason, activeBoundaryInfo);
    if (ok) {
      setIsReasonModalOpen(false);
      const bndTag = activeBoundaryInfo ? `【${activeBoundaryInfo.phonemeBefore} | ${activeBoundaryInfo.phonemeAfter}】` : '';
      setActiveBoundaryInfo(null);
      setSuccessToast(`已成功記錄邊界理由 ${bndTag} 並新建 Lab！`);
      setTimeout(() => setSuccessToast(null), 4500);
    } else {
      alert('記錄邊界對齊失敗');
    }
  }, [regionMgr, persistence, activeBoundaryInfo]);

  const handleLabTypeChange = useCallback(async (type: 'lab' | 'lab2') => {
    if (type === 'lab2' && !hasLab2Ref.current) return;

    setActiveLabType(type);
    const ws = wavesurfer.wavesurferRef.current;
    if (ws) {
      const duration = ws.getDuration();
      const loadedSegments = await persistence.loadLabels(duration, type);
      if (loadedSegments.length > 0) {
        regionMgr.loadSegments(loadedSegments);
        setSuccessToast(`已切換對齊標籤層：${type === 'lab2' ? '✨ 規則精修 (.lab2)' : '📄 原始 (.lab)'}`);
        setTimeout(() => setSuccessToast(null), 3000);
      }
    }
  }, [wavesurfer.wavesurferRef, persistence, regionMgr]);

  const handleCancel = useCallback(() => {
    if (persistence.isDirty) {
      if (confirm('You have unsaved changes. Are you sure you want to leave?')) {
        onCancel();
      }
    } else {
      onCancel();
    }
  }, [persistence.isDirty, onCancel]);

  const handleToggleFullscreen = useCallback(() => {
    if (audio.isPlayingRef.current) return;

    const ws = wavesurfer.wavesurferRef.current;
    if (ws) {
      savedTimeRef.current = ws.getCurrentTime();
    }

    setIsFullscreen(!isFullscreen);
  }, [wavesurfer.wavesurferRef, audio.isPlayingRef, isFullscreen, setIsFullscreen]);

  const handleSelectPrevPhoneme = useCallback(() => {
    const ws = wavesurfer.wavesurferRef.current;
    if (!ws || !regionMgr.selectedSegment) return;

    const all = [...regionMgr.segments].sort((a, b) => a.start - b.start);
    const idx = all.findIndex((s) => s.id === regionMgr.selectedSegment!.id);
    if (idx > 0) {
      const prevSeg = all[idx - 1];
      regionMgr.setSelectedRegion(prevSeg);
      regionMgr.setEditLabel(prevSeg.label);

      // 捲動畫面到該位置
      const duration = ws.getDuration();
      if (duration > 0) {
        const center = (prevSeg.start + prevSeg.end) / 2;
        const wrapper = ws.getWrapper();
        const scrollWidth = wrapper.scrollWidth;
        const clientWidth = wrapper.clientWidth;
        const targetScroll = (center / duration) * scrollWidth - clientWidth / 2;
        wrapper.scrollTo({ left: targetScroll, behavior: 'smooth' });
      }
    }
  }, [wavesurfer.wavesurferRef, regionMgr]);

  const handleSelectNextPhoneme = useCallback(() => {
    const ws = wavesurfer.wavesurferRef.current;
    if (!ws || !regionMgr.selectedSegment) return;

    const all = [...regionMgr.segments].sort((a, b) => a.start - b.start);
    const idx = all.findIndex((s) => s.id === regionMgr.selectedSegment!.id);
    if (idx !== -1 && idx < all.length - 1) {
      const nextSeg = all[idx + 1];
      regionMgr.setSelectedRegion(nextSeg);
      regionMgr.setEditLabel(nextSeg.label);

      // 捲動畫面到該位置
      const duration = ws.getDuration();
      if (duration > 0) {
        const center = (nextSeg.start + nextSeg.end) / 2;
        const wrapper = ws.getWrapper();
        const scrollWidth = wrapper.scrollWidth;
        const clientWidth = wrapper.clientWidth;
        const targetScroll = (center / duration) * scrollWidth - clientWidth / 2;
        wrapper.scrollTo({ left: targetScroll, behavior: 'smooth' });
      }
    }
  }, [wavesurfer.wavesurferRef, regionMgr]);

  // ── 播放狀態追蹤 Refs ──
  const lastPlaybackRef = useRef<{ start: number; end: number; timestamp: number } | null>(null);
  const lastWordPlaybackRef = useRef<{ start: number; end: number; timestamp: number } | null>(null);

  // ── 快捷鍵 ──
  useKeyboardShortcuts({
    onStop: () => audio.stop(),
    onWordPlay: handleWordPlay,
    onPhonemePlay: handlePhonemePlay,
    onFullPlay: handleFullPlay,
    onDelete: () => regionMgr.deleteSelected(),
    onUndo: () => regionMgr.undo(),
    onFocusInput: () => {
      focusAndSelectAll(inputRef.current, 50);
    },
    onArrowLeft: handleSelectPrevPhoneme,
    onArrowRight: handleSelectNextPhoneme,
    onQuickReplace: (replacement) => {
      if (regionMgr.selectedSegment && regionMgr.editLabel === '!') {
        regionMgr.setEditLabel(replacement);
        regionMgr.updateLabel(replacement);
      }
    },
  });

  return (
    <div className={`label-editor ${isFullscreen ? 'label-editor--fullscreen' : ''}`}>
      <LabelToolbar
        isLoaded={wavesurfer.isLoaded}
        isAudioLoaded={audio.isAudioLoaded}
        isPlaying={isPlaying}
        isMultipleSelect={regionMgr.selectedRegionIds.size > 1}
        labelsCount={regionMgr.labelsCount}
        error={persistence.error}
        isSaving={persistence.isSaving}
        saveStatus={persistence.saveStatus}
        isDirty={persistence.isDirty}
        zoomLevel={wavesurfer.zoomLevel}
        playbackRate={playbackRate}
        onZoomChange={(level) => wavesurfer.setZoomLevel(level)}
        onPlaybackRateChange={setPlaybackRate}
        onWordPlay={handleWordPlay}
        onPhonemePlay={handlePhonemePlay}
        onFullPlay={handleFullPlay}
        onSave={handleSave}
        onCancel={handleCancel}
        isFullscreen={isFullscreen}
        onToggleFullscreen={handleToggleFullscreen}
        filename={recording.filename}
        activeLabType={activeLabType}
        hasLab2={hasLab2}
        onLabTypeChange={handleLabTypeChange}
        onNext={onNext}
        onPrevious={onPrevious}
      />

      <div className="label-editor__main">
        <div className="label-editor__panel">
          <div className="label-editor__waveform-container" ref={waveformContainerRef}>
            <div
              id="label-editor-waveform"
              ref={containerRef}
              className="label-editor__waveform"
            />
            <D114514BoundaryOverlay
              wavesurferRef={wavesurfer.wavesurferRef}
              isLoaded={wavesurfer.isLoaded}
              waveformHeight={waveformHeight}
              spectrogramHeight={spectrogramHeight}
              data={boundaryOverlayData}
            />
          </div>

          <div className="label-editor__bottom">
            <PhonemeEditPanel
              inputRef={inputRef}
              selectedRegion={regionMgr.selectedSegment}
              isMultipleSelect={regionMgr.selectedRegionIds.size > 1}
              editLabel={regionMgr.editLabel}
              onEditLabelChange={regionMgr.setEditLabel}
              onUpdate={regionMgr.updateLabel}
              onPlay={() => {
                if (regionMgr.selectedSegment) {
                  handlePlayRange(
                    regionMgr.selectedSegment.start,
                    regionMgr.selectedSegment.end
                  );
                }
              }}
              onDelete={regionMgr.deleteSelected}
              onDeselect={() => regionMgr.setSelectedRegion(null)}
            />

            <RegionButtonTrack
              items={regionMgr.regionItems}
              selectedIds={regionMgr.selectedRegionIds}
              activePlayRange={activePlayRange}
              onSelect={(item, e) => {
                regionMgr.handleSegmentClicked(item.id, e);
              }}
              wavesurferRef={wavesurfer.wavesurferRef}
              lyrics={lyrics}
              onWordIndexChange={regionMgr.updateSegmentWordIndex}
            />
          </div>
        </div>
      </div>
      <LyricsDisplay lyrics={lyrics} visible={isFullscreen} />

      {successToast && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          backgroundColor: '#065f46',
          border: '1px solid #10b981',
          color: '#ecfdf5',
          padding: '12px 20px',
          borderRadius: '10px',
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.3)',
          zIndex: 200001,
          fontSize: '14px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span>✨</span> {successToast}
        </div>
      )}

      <ReasonModal
        isOpen={hasLab2 && isReasonModalOpen}
        filename={recording.filename}
        boundaryInfo={activeBoundaryInfo}
        onConfirm={handleConfirmSaveAlgo}
        onCancel={() => {
          setIsReasonModalOpen(false);
          setActiveBoundaryInfo(null);
        }}
      />
    </div>
  );
}
