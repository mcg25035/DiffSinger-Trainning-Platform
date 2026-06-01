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
}: UseWaveSurferOptions): UseWaveSurferReturn {
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const spectrogramRef = useRef<any>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(initialZoom);

  // 用 ref 持有最新的 callbacks 以避免 effect 重新綁定
  const onReadyRef = useRef(onReady);
  const onRegionUpdateRef = useRef(onRegionUpdate);
  const onRegionUpdatedRef = useRef(onRegionUpdated);
  const onRegionClickedRef = useRef(onRegionClicked);
  const onDblClickRef = useRef(onDblClick);
  useEffect(() => {
    onReadyRef.current = onReady;
    onRegionUpdateRef.current = onRegionUpdate;
    onRegionUpdatedRef.current = onRegionUpdated;
    onRegionClickedRef.current = onRegionClicked;
    onDblClickRef.current = onDblClick;
  });

  // 初始化 WaveSurfer
  useEffect(() => {
    if (!containerRef.current) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
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
        labels: true,
        height: spectrogramHeight,
        splitChannels: false,
        colorMap: 'igray',
        labelsColor: '#fff',
        labelsHzColor: '#fff',
      })
    );
    spectrogramRef.current = spec;

    // 停用 Regions Plugin 的重疊避免功能
    (regions as any).avoidOverlapping = () => {};

    wavesurferRef.current = ws;
    regionsRef.current = regions;

    ws.once('ready', () => {
      setIsLoaded(true);
      onReadyRef.current?.(ws, regions);
    });

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

    // 攔截右鍵選單
    const handleContextMenu = (e: MouseEvent) => e.preventDefault();
    containerRef.current?.addEventListener('contextmenu', handleContextMenu);

    // Ctrl+滾輪 zoom
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        setZoomLevel((prev) =>
          Math.min(5000, Math.max(20, prev + (e.deltaY > 0 ? -100 : 100)))
        );
      }
    };
    containerRef.current?.addEventListener('wheel', handleWheel, {
      passive: false,
    });

    ws.load(url);

    return () => {
      containerRef.current?.removeEventListener('wheel', handleWheel);
      containerRef.current?.removeEventListener(
        'contextmenu',
        handleContextMenu
      );
      ws.destroy();
      wavesurferRef.current = null;
      regionsRef.current = null;
      spectrogramRef.current = null;
      setIsLoaded(false);
    };
  }, [url, waveformHeight, spectrogramHeight]);

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
