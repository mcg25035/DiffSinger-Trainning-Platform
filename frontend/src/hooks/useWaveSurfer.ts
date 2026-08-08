/**
 * useWaveSurfer — WaveSurfer 顯示層生命週期管理
 *
 * 職責：
 *  - 建立 / 銷毀 WaveSurfer instance (靜音，僅顯示)
 *  - 註冊 Spectrogram + Regions plugin
 *  - 管理 zoom 和 isLoaded state
 *  - 暴露 regions ref 給其他 hooks 使用
 */

import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import Spectrogram from 'wavesurfer.js/plugins/spectrogram';
import type { Region } from 'wavesurfer.js/plugins/regions';

const FFT_SAMPLES = 512;
const FFT_OVERLAP = FFT_SAMPLES / 2;

export interface UseWaveSurferOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  url: string;
  initialZoom?: number;
  waveformHeight?: number;
  spectrogramHeight?: number;
  onReady?: (ws: WaveSurfer, regions: RegionsPlugin) => void;
  onRegionUpdate?: (region: Region) => void;
  onRegionUpdated?: (region: Region) => void;
  onRegionClicked?: (region: Region, e: MouseEvent) => void;
  onDblClick?: (time: number) => void;
  onRightClick?: (time: number) => void;
}

export interface UseWaveSurferReturn {
  wavesurferRef: React.MutableRefObject<WaveSurfer | null>;
  regionsRef: React.MutableRefObject<RegionsPlugin | null>;
  isLoaded: boolean;
  zoomLevel: number;
  setZoomLevel: (level: number | ((prev: number) => number)) => void;
}

export function useWaveSurfer({
  containerRef,
  url,
  initialZoom = 100,
  waveformHeight = 100,
  spectrogramHeight = 180,
  onReady,
  onRegionUpdate,
  onRegionUpdated,
  onRegionClicked,
  onDblClick,
  onRightClick,
}: UseWaveSurferOptions): UseWaveSurferReturn {
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const spectrogramRef = useRef<ReturnType<typeof Spectrogram.create> | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(initialZoom);

  // 用 ref 持有最新的 callbacks 以避免 effect 重新綁定
  const onReadyRef = useRef(onReady);
  const onRegionUpdateRef = useRef(onRegionUpdate);
  const onRegionUpdatedRef = useRef(onRegionUpdated);
  const onRegionClickedRef = useRef(onRegionClicked);
  const onDblClickRef = useRef(onDblClick);
  const onRightClickRef = useRef(onRightClick);
  useEffect(() => {
    onReadyRef.current = onReady;
    onRegionUpdateRef.current = onRegionUpdate;
    onRegionUpdatedRef.current = onRegionUpdated;
    onRegionClickedRef.current = onRegionClicked;
    onDblClickRef.current = onDblClick;
    onRightClickRef.current = onRightClick;
  });

  // 初始化 WaveSurfer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ws = WaveSurfer.create({
      container,
      waveColor: '#00e5ff',
      progressColor: 'rgba(0, 229, 255, 0.15)',
      cursorColor: '#fff',
      height: waveformHeight,
      normalize: true,
      minPxPerSec: initialZoom,
      backend: 'WebAudio',
    });

    // 靜音 — WaveSurfer 只做顯示，播放由 useAudioPlayback 處理
    ws.setVolume(0);

    const regions = ws.registerPlugin(RegionsPlugin.create());
    const spec = ws.registerPlugin(
      Spectrogram.create({
        fftSamples: FFT_SAMPLES,
        noverlap: FFT_OVERLAP,
        windowFunc: 'hann',
        gainDB: 20,
        rangeDB: 80,
        labels: true,
        height: spectrogramHeight,
        splitChannels: false,
        colorMap: 'igray',
        labelsColor: '#fff',
        labelsHzColor: '#fff',
        scale: 'linear',
        frequencyMin: 0,
        frequencyMax: 4000,
      })
    );
    spectrogramRef.current = spec;

    const alignSpectrogramFrames = () => {
      const decoded = ws.getDecodedData();
      if (!decoded || decoded.duration <= 0) return;

      const hopSamples = FFT_SAMPLES - FFT_OVERLAP;
      const frameCount = Math.max(
        0,
        Math.floor((decoded.length - FFT_SAMPLES - 1) / hopSamples) + 1
      );
      if (frameCount === 0) return;

      const firstFrameCenter = (FFT_SAMPLES - 1) / 2 / decoded.sampleRate;
      const analyzedSpan = (frameCount * hopSamples) / decoded.sampleRate;
      const scaleX = analyzedSpan / decoded.duration;
      const offsetPercent = (firstFrameCenter / decoded.duration) * 100;
      const canvasContainer = (
        spec as unknown as { canvasContainer?: HTMLElement }
      ).canvasContainer;
      if (!canvasContainer) return;

      // WaveSurfer stretches complete forward FFT frames across the full audio.
      // Restore each frame to its physical Hann-window center instead.
      canvasContainer.style.transformOrigin = 'left center';
      canvasContainer.style.transform =
        `translateX(${offsetPercent}%) scaleX(${scaleX})`;
    };

    // 停用 Regions Plugin 的重疊避免功能
    (regions as unknown as { avoidOverlapping: () => void }).avoidOverlapping =
      () => {};

    wavesurferRef.current = ws;
    regionsRef.current = regions;

    ws.once('ready', () => {
      alignSpectrogramFrames();
      setIsLoaded(true);
      onReadyRef.current?.(ws, regions);
    });
    const unsubscribeSpecReady = spec.on('ready', alignSpectrogramFrames);
    const unsubscribeRedraw = ws.on('redraw', alignSpectrogramFrames);

    // Region 事件
    regions.on('region-update', (r: Region) => {
      onRegionUpdateRef.current?.(r);
    });

    regions.on('region-updated', (r: Region) => {
      onRegionUpdatedRef.current?.(r);
    });

    regions.on('region-clicked', (r: Region, e: MouseEvent) => {
      onRegionClickedRef.current?.(r, e);
    });

    // 雙擊切割
    ws.on('dblclick', () => {
      const time = ws.getCurrentTime();
      onDblClickRef.current?.(time);
    });

    // 攔截右鍵選單 + 移動 start pointer
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      // 計算右鍵點擊對應的時間位置
      const wrapper = ws.getWrapper();
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const scrollLeft = wrapper.scrollLeft;
      const xInWrapper = e.clientX - rect.left + scrollLeft;
      const scrollWidth = wrapper.scrollWidth;
      const duration = ws.getDuration();
      if (duration <= 0 || scrollWidth <= 0) return;
      const time = Math.max(0, Math.min(duration, (xInWrapper / scrollWidth) * duration));
      onRightClickRef.current?.(time);
    };
    container.addEventListener('contextmenu', handleContextMenu);

    // Ctrl+滾輪 zoom
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        setZoomLevel((prev) =>
          Math.min(5000, Math.max(20, prev + (e.deltaY > 0 ? -100 : 100)))
        );
      }
    };
    container.addEventListener('wheel', handleWheel, {
      passive: false,
    });

    ws.load(url).catch((err) => {
      if (err.name === 'AbortError') {
        // Expected when wavesurfer is destroyed or URL changes mid-flight
        console.log('WaveSurfer load aborted.');
      } else {
        console.error('WaveSurfer load error:', err);
      }
    });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('contextmenu', handleContextMenu);
      unsubscribeSpecReady();
      unsubscribeRedraw();
      ws.destroy();
      wavesurferRef.current = null;
      regionsRef.current = null;
      spectrogramRef.current = null;
      setIsLoaded(false);
    };
  }, [containerRef, initialZoom, url, waveformHeight, spectrogramHeight]);

  // Zoom 同步
  useEffect(() => {
    if (wavesurferRef.current && isLoaded) {
      wavesurferRef.current.zoom(zoomLevel);
    }
  }, [zoomLevel, isLoaded]);

  return {
    wavesurferRef,
    regionsRef,
    isLoaded,
    zoomLevel,
    setZoomLevel,
  };
}
