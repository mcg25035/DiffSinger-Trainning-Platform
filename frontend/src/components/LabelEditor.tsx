/**
 * LabelEditor — Visual Labeler 主組件（重構後）
 *
 * 此組件現在僅作為**組合層**，整合以下模組：
 *
 * Hooks:
 *  - useWaveSurfer: 顯示層（WaveSurfer + Spectrogram + Regions）
 *  - useAudioPlayback: 播放層（Crunker + HTMLAudioElement）
 *  - useRegionManager: Region CRUD + Undo
 *  - useLyricsAlignment: 歌詞 ⇄ 音素對齊
 *  - useLabelPersistence: 存檔 / 載入 API
 *  - useKeyboardShortcuts: 快捷鍵
 *
 * Sub-components:
 *  - LabelToolbar: 工具列
 *  - PhonemeEditPanel: 音素編輯面板
 *  - RegionButtonTrack: Region 按鈕列表
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import type { Recording } from '../hooks/useAudioMonitor';
import { useWaveSurfer } from '../hooks/useWaveSurfer';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { useRegionManager } from '../hooks/useRegionManager';
import { useLyricsAlignment } from '../hooks/useLyricsAlignment';
import { useLabelPersistence } from '../hooks/useLabelPersistence';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { getRegionLabel } from '../utils/regionStyle';
import { loadWordAlignmentMap } from '../utils/alignmentStorage';
import { focusAndMoveCursorToEnd } from '../utils/domUtils';
import { LabelToolbar } from './label-editor/LabelToolbar';
import { PhonemeEditPanel } from './label-editor/PhonemeEditPanel';
import { RegionButtonTrack } from './label-editor/RegionButtonTrack';
import { LyricsDisplay } from './label-editor/LyricsDisplay';
import './label-editor/LabelEditor.css';
import type { Region } from 'wavesurfer.js/plugins/regions';

interface Props {
  recording: Recording;
  onCancel: () => void;
}

export function LabelEditor({ recording, onCancel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  
  const savedTimeRef = useRef<number>(0);
  const savedSelectionTimeRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lyrics = recording.lyrics || '';
  const lastUrlRef = useRef<string>('');

  // Track the actual height of the waveform container
  useEffect(() => {
    const el = waveformContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      const height = el.clientHeight;
      if (height > 0) {
        setContainerHeight((prev) => {
          // 避免微小的版面晃動（例如播放時按鈕框線微調或捲軸出現）導致 wavesurfer 被銷毀重構。
          // 僅在高度變化大於 10px 時（如切換全螢幕或視窗縮放）才更新高度。
          if (prev === 0 || Math.abs(height - prev) > 10) {
            return height;
          }
          return prev;
        });
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  // ── 顯示層：WaveSurfer (靜音) ──
  const wavesurfer = useWaveSurfer({
    containerRef,
    url: recording.url,
    waveformHeight,
    spectrogramHeight,
    onReady: (ws, regions) => {
      const duration = ws.getDuration();

      // Track last url to only reset start pointer when loading a new file
      const isNewFile = lastUrlRef.current !== recording.url;
      lastUrlRef.current = recording.url;

      if (isNewFile) {
        regionMgr.setStartPointerTime(0);
      }

      // Listen to timeupdate to save time
      ws.on('timeupdate', (time) => {
        savedTimeRef.current = time;
      });

      const currentSegments = regionMgr.getCurrentSegments();

      // 如果當前 React state 中已有編輯中的 segments，我們直接載入，不讀取 API，以保持未存檔進度與 undoStack
      if (currentSegments.length > 0) {
        loadWordAlignmentMap(recording.filename, currentSegments);
        regionMgr.renderSegments(currentSegments, regions);
        alignment.runAlignment();
        regionMgr.refreshRegionsState();
      } else {
        // 第一次載入，自 API 讀取
        persistence.loadLabels(duration).then((segments) => {
          if (segments.length > 0) {
            loadWordAlignmentMap(recording.filename, segments);
            regionMgr.loadRegions(segments, regions);
            alignment.runAlignment();
            regionMgr.refreshRegionsState();
          } else {
            // No segments loaded. Make sure we still add the start pointer!
            regionMgr.recreateStartPointer(regions, 0);
            regionMgr.refreshRegionsState();
          }
        });
      }

      // 恢復播放指標位置
      if (savedTimeRef.current > 0) {
        ws.setTime(savedTimeRef.current);
      }

      // 恢復選取狀態
      if (savedSelectionTimeRef.current !== null) {
        const found = regions.getRegions().filter((r) => r.id !== 'start-pointer').find(
          (r: Region) =>
            savedSelectionTimeRef.current! >= r.start &&
            savedSelectionTimeRef.current! <= r.end
        );
        if (found) {
          regionMgr.setSelectedRegion(found);
          regionMgr.setEditLabel(getRegionLabel(found));
        }
      }
    },
    onRegionUpdate: (region) => {
      regionMgr.handleRegionUpdate(region);
    },
    onRegionUpdated: (region) => {
      regionMgr.handleRegionUpdated(region);
    },
    onRegionClicked: (region, e) => {
      regionMgr.handleRegionClicked(region, e);
    },
    onDblClick: (time) => {
      regionMgr.splitAtTime(time);
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
      if (ws && regionMgr.selectedRegion) {
        ws.setTime(regionMgr.selectedRegion.start);
      }
    },
  });

  const handlePlayRange = useCallback((start: number, end: number) => {
    setActivePlayRange({ start, end });
    audio.playRange(start, end);
  }, [audio]);

  // ── Region 管理 ──
  const regionMgr = useRegionManager(wavesurfer.regionsRef, () => {
    // onChange callback: region 變更後重新對齊
    alignment.runAlignment();
    regionMgr.refreshRegionsState();
    persistence.setIsDirty(true);
    persistence.setSaveStatus('idle');
  });

  // 讓 savedSelectionTimeRef 永遠與 regionMgr.selectedRegion 同步
  useEffect(() => {
    if (regionMgr.selectedRegion) {
      savedSelectionTimeRef.current = (regionMgr.selectedRegion.start + regionMgr.selectedRegion.end) / 2;
    } else {
      savedSelectionTimeRef.current = null;
    }
  }, [regionMgr.selectedRegion]);

  // ── 歌詞對齊 ──
  const alignment = useLyricsAlignment(wavesurfer.regionsRef, lyrics, recording.filename);

  // ── 存檔 / 載入 ──
  const persistence = useLabelPersistence(recording);

  // ── 選中箭頭與開始指標顯示 ──
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
          arrow.innerHTML = '⬇';
          arrow.style.position = 'absolute';
          arrow.style.top = '-20px';
          arrow.style.left = '50%';
          arrow.style.transform = 'translateX(-50%)';
          arrow.style.color = '#00e5ff';
          arrow.style.fontSize = '24px';
          arrow.style.textShadow = '0 2px 4px rgba(0,0,0,0.8)';
          arrow.style.pointerEvents = 'none';
          arrow.style.zIndex = '100';
          r.element.appendChild(arrow);
          r.element.style.backgroundColor = 'rgba(0, 229, 255, 0.3)';
        }
      } else {
        if (arrow) {
          r.element.removeChild(arrow);
          const label = getRegionLabel(r);
          const isWarning = label === '!';
          const idx = phonemes.indexOf(r);
          const level = idx !== -1 ? idx % 2 : 0;
          r.element.style.backgroundColor = isWarning
            ? 'rgba(255, 0, 0, 0.2)'
            : level === 0
              ? 'rgba(0, 229, 255, 0.15)'
              : 'rgba(0, 229, 255, 0.05)';
        }
      }
    });
  }, [regionMgr.selectedRegionIds, regionMgr.regionItems, wavesurfer.isLoaded]);

  // ── save status 自動清除 ──
  useEffect(() => {
    if (persistence.saveStatus === 'saved') {
      const timer = setTimeout(() => persistence.setSaveStatus('idle'), 10000);
      return () => clearTimeout(timer);
    }
  }, [persistence.saveStatus]);

  // ── labels 載入後重新對齊 ──
  useEffect(() => {
    if (wavesurfer.isLoaded) {
      alignment.runAlignment();
      regionMgr.refreshRegionsState();
    }
  }, [wavesurfer.isLoaded, regionMgr.labelsCount]);

  // ── 播放防抖鎖定 Ref ──
  const lastPlaybackRef = useRef<{ start: number; end: number; timestamp: number } | null>(null);
  const lastWordPlaybackRef = useRef<{ start: number; end: number; timestamp: number } | null>(null);

  // ── 播放 handlers ──
  const handlePhonemePlay = useCallback(() => {
    if (regionMgr.selectedRegionIds.size > 1) return;
    const ws = wavesurfer.wavesurferRef.current;
    const regions = wavesurfer.regionsRef.current;
    if (!ws || !regions) return;

    const time = ws.getCurrentTime();
    const eps = 0.01;
    const all = regions.getRegions().filter((r) => r.id !== 'start-pointer').sort((a: Region, b: Region) => a.start - b.start);
    if (all.length === 0) return;

    let target: Region | undefined;
    const now = Date.now();
    const lastPlayback = lastPlaybackRef.current;

    // ── 播放中或剛播放完的容差鎖定（防抖） ──
    if (
      lastPlayback &&
      (audio.isPlayingRef.current || now - lastPlayback.timestamp < (lastPlayback.end - lastPlayback.start) * 1000 + 500)
    ) {
      if (time >= lastPlayback.start && time <= lastPlayback.end + 0.05) {
        target = all.find(
          (r: Region) =>
            Math.abs(r.start - lastPlayback.start) < 0.001 &&
            Math.abs(r.end - lastPlayback.end) < 0.001
        );
      }
    }

    if (!target) {
      target = all.find((r: Region) => time >= r.start && time < r.end);
      if (!target) target = all.find((r: Region) => time >= r.start && time <= r.end);
      if (!target && time < eps) target = all[0];
    }

    if (target) {
      lastPlaybackRef.current = { start: target.start, end: target.end, timestamp: Date.now() };
      handlePlayRange(target.start, target.end);
    }
  }, [audio, wavesurfer.wavesurferRef, wavesurfer.regionsRef, handlePlayRange, regionMgr.selectedRegionIds]);

  const handleWordPlay = useCallback(() => {
    if (regionMgr.selectedRegionIds.size > 1) return;
    const ws = wavesurfer.wavesurferRef.current;
    if (!ws) return;

    const time = ws.getCurrentTime();
    const { wordInstances } = alignment;

    let word: typeof wordInstances[0] | undefined;
    const now = Date.now();
    const lastWordPlayback = lastWordPlaybackRef.current;

    // ── 播放中或剛播放完的容差鎖定（防抖） ──
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
  }, [audio, wavesurfer.wavesurferRef, alignment, handlePlayRange, regionMgr.selectedRegionIds]);

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
    const segments = regionMgr.getCurrentSegments();
    const ok = await persistence.saveLabels(segments);
    if (!ok) {
      alert('Save failed');
    }
  }, [regionMgr, persistence]);

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
    // 播放中禁止切換全螢幕
    if (audio.isPlayingRef.current) return;

    const ws = wavesurfer.wavesurferRef.current;
    if (ws) {
      savedTimeRef.current = ws.getCurrentTime();
    }
    savedSelectionTimeRef.current = regionMgr.selectedRegion
      ? (regionMgr.selectedRegion.start + regionMgr.selectedRegion.end) / 2
      : null;

    setIsFullscreen((prev) => !prev);
  }, [wavesurfer.wavesurferRef, regionMgr.selectedRegion, audio.isPlayingRef]);

  const handleSelectPrevPhoneme = useCallback(() => {
    const ws = wavesurfer.wavesurferRef.current;
    const regions = wavesurfer.regionsRef.current;
    if (!ws || !regions || !regionMgr.selectedRegion) return;

    const all = regions
      .getRegions()
      .filter((r) => r.id !== 'start-pointer')
      .sort((a: Region, b: Region) => a.start - b.start);
    
    const idx = all.findIndex((r) => r.id === regionMgr.selectedRegion!.id);
    if (idx > 0) {
      const prevRegion = all[idx - 1];
      regionMgr.setSelectedRegion(prevRegion);
      regionMgr.setEditLabel(getRegionLabel(prevRegion));

      // 捲動到該 region 的位置
      const duration = ws.getDuration();
      if (duration > 0) {
        const center = (prevRegion.start + prevRegion.end) / 2;
        const wrapper = ws.getWrapper();
        const scrollWidth = wrapper.scrollWidth;
        const clientWidth = wrapper.clientWidth;
        const targetScroll =
          (center / duration) * scrollWidth - clientWidth / 2;
        wrapper.scrollTo({ left: targetScroll, behavior: 'smooth' });
      }
    }
  }, [wavesurfer.wavesurferRef, wavesurfer.regionsRef, regionMgr]);

  const handleSelectNextPhoneme = useCallback(() => {
    const ws = wavesurfer.wavesurferRef.current;
    const regions = wavesurfer.regionsRef.current;
    if (!ws || !regions || !regionMgr.selectedRegion) return;

    const all = regions
      .getRegions()
      .filter((r) => r.id !== 'start-pointer')
      .sort((a: Region, b: Region) => a.start - b.start);
    
    const idx = all.findIndex((r) => r.id === regionMgr.selectedRegion!.id);
    if (idx !== -1 && idx < all.length - 1) {
      const nextRegion = all[idx + 1];
      regionMgr.setSelectedRegion(nextRegion);
      regionMgr.setEditLabel(getRegionLabel(nextRegion));

      // 捲動到該 region 的位置
      const duration = ws.getDuration();
      if (duration > 0) {
        const center = (nextRegion.start + nextRegion.end) / 2;
        const wrapper = ws.getWrapper();
        const scrollWidth = wrapper.scrollWidth;
        const clientWidth = wrapper.clientWidth;
        const targetScroll =
          (center / duration) * scrollWidth - clientWidth / 2;
        wrapper.scrollTo({ left: targetScroll, behavior: 'smooth' });
      }
    }
  }, [wavesurfer.wavesurferRef, wavesurfer.regionsRef, regionMgr]);

  // ── 快捷鍵 ──
  useKeyboardShortcuts({
    onStop: () => audio.stop(),
    onWordPlay: handleWordPlay,
    onPhonemePlay: handlePhonemePlay,
    onFullPlay: handleFullPlay,
    onDelete: () => regionMgr.deleteSelected(),
    onUndo: () => regionMgr.undo(),
    onFocusInput: () => {
      focusAndMoveCursorToEnd(inputRef.current, 50);
    },
    onArrowLeft: handleSelectPrevPhoneme,
    onArrowRight: handleSelectNextPhoneme,
  });

  // ── 渲染 ──
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
      />

      <div className="label-editor__main">
        <div className="label-editor__panel">
          <div className="label-editor__waveform-container" ref={waveformContainerRef}>
            <div
              id="label-editor-waveform"
              ref={containerRef}
              className="label-editor__waveform"
            />
          </div>

          <div className="label-editor__bottom">
            <PhonemeEditPanel
              inputRef={inputRef}
              selectedRegion={regionMgr.selectedRegion}
              isMultipleSelect={regionMgr.selectedRegionIds.size > 1}
              editLabel={regionMgr.editLabel}
              onEditLabelChange={regionMgr.setEditLabel}
              onUpdate={regionMgr.updateLabel}
              onPlay={() => {
                if (regionMgr.selectedRegion) {
                  handlePlayRange(
                    regionMgr.selectedRegion.start,
                    regionMgr.selectedRegion.end
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
                regionMgr.handleRegionClicked(item.region, e);
              }}
              wavesurferRef={wavesurfer.wavesurferRef}
              lyrics={lyrics}
              onWordIndexChange={regionMgr.updateRegionWordIndex}
            />
          </div>
        </div>
      </div>
      <LyricsDisplay lyrics={lyrics} visible={isFullscreen} />
    </div>
  );
}
