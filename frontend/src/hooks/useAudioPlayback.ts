/**
 * useAudioPlayback — 精準音訊播放引擎
 *
 * 設計原因：WaveSurfer 無法在變速播放下做到精準的區間播放，
 * 因此使用 Crunker 切片 + HTMLAudioElement (preservesPitch) 獨立處理播放，
 * WaveSurfer 只作為顯示層。
 *
 * 功能：
 *  1. Crunker 取得完整 AudioBuffer
 *  2. playRange(start, end): 切片 → Blob URL → Audio 播放
 *  3. playFull(startTime): 原始 URL → Audio 播放
 *  4. preservesPitch = true 實現變速不變調
 *  5. requestAnimationFrame 同步回報 currentTime
 *
 * 🔧 Bug Fix (playback freeze):
 *  - audio.play() reject 時正確 reset 狀態
 *  - 最小切片長度 guard
 *  - safety timeout 防 onplay 不觸發
 */

import { useEffect, useRef, useState } from 'react';
import Crunker from 'crunker';

export interface UseAudioPlaybackOptions {
  url: string;
  playbackRate: number;
  onTimeUpdate: (currentTime: number) => void;
  onPlaybackStateChange: (isPlaying: boolean) => void;
}

export interface UseAudioPlaybackReturn {
  playRange: (start: number, end: number) => void;
  playFull: (startTime: number) => void;
  stop: () => void;
  isAudioLoaded: boolean;
  isPlayingRef: React.MutableRefObject<boolean>;
}

/** 最小可播放時長（秒），低於此值的切片不播放 */
const MIN_PLAYABLE_DURATION = 0.005;

/** onplay 的 safety timeout（毫秒），超時自動 reset */
const PLAY_SAFETY_TIMEOUT_MS = 3000;

export function useAudioPlayback({
  url,
  playbackRate,
  onTimeUpdate,
  onPlaybackStateChange,
}: UseAudioPlaybackOptions): UseAudioPlaybackReturn {
  const fullAudioBufferRef = useRef<AudioBuffer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const syncAnimRef = useRef<number | null>(null);
  const playbackRateRef = useRef(playbackRate);
  const sessionRef = useRef(0);
  const isPlayingRef = useRef(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 用 ref 持有最新的 callbacks 以避免 stale closure
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onPlaybackStateChangeRef = useRef(onPlaybackStateChange);
  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
    onPlaybackStateChangeRef.current = onPlaybackStateChange;
  });

  const [isAudioLoaded, setIsAudioLoaded] = useState(false);

  // 集中管理播放狀態切換
  const setPlaying = (value: boolean, _reason: string) => {
    const prev = isPlayingRef.current;
    if (prev === value) return;
    isPlayingRef.current = value;
    onPlaybackStateChangeRef.current(value);
  };

  // 同步 playbackRate ref
  useEffect(() => {
    playbackRateRef.current = playbackRate;
  }, [playbackRate]);

  // 載入 AudioBuffer
  useEffect(() => {
    const CrunkerConstructor = (Crunker as any).default || Crunker;
    const crunker = new CrunkerConstructor();
    setIsAudioLoaded(false);
    crunker.fetchAudio(url).then(([buffer]: AudioBuffer[]) => {
      fullAudioBufferRef.current = buffer;
      setIsAudioLoaded(true);
    });
    return () => {
      killSession('unmount');
      fullAudioBufferRef.current = null;
    };
  }, [url]);

  const applyPitchFix = (audio: HTMLAudioElement) => {
    const a = audio as any;
    if ('preservesPitch' in a) a.preservesPitch = true;
    if ('webkitPreservesPitch' in a) a.webkitPreservesPitch = true;
    if ('mozPreservesPitch' in a) a.mozPreservesPitch = true;
  };

  const clearSafetyTimer = () => {
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  };

  const killSession = (reason: string) => {
    sessionRef.current++;
    clearSafetyTimer();

    if (syncAnimRef.current) {
      cancelAnimationFrame(syncAnimRef.current);
      syncAnimRef.current = null;
    }
    if (audioRef.current) {
      const old = audioRef.current;
      old.onplay = null;
      old.onpause = null;
      old.onended = null;
      try {
        old.pause();
      } catch (_) {
        /* ignore */
      }
      old.removeAttribute('src');
      old.load();
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPlaying(false, `killSession(${reason})`);
  };

  const stop = () => killSession('user-stop');

  const startSyncLoop = (mySession: number, offset: number) => {
    const tick = () => {
      if (sessionRef.current !== mySession) return;
      const audio = audioRef.current;
      if (!audio || audio.paused || audio.ended) return;
      try {
        const t = offset + audio.currentTime;
        if (isFinite(t)) {
          onTimeUpdateRef.current(t);
        }
      } catch (_) {
        /* ignore */
      }
      syncAnimRef.current = requestAnimationFrame(tick);
    };
    syncAnimRef.current = requestAnimationFrame(tick);
  };

  const playRange = (start: number, end: number) => {
    const fullBuffer = fullAudioBufferRef.current;
    if (!fullBuffer) return;

    // 🔧 Bug fix: 最小切片長度 guard
    if (end - start < MIN_PLAYABLE_DURATION) {
      return;
    }

    killSession('playRange');
    const mySession = sessionRef.current;

    let sliceBuffer, blob;
    try {
      const CrunkerConstructor = (Crunker as any).default || Crunker;
      const crunker = new CrunkerConstructor();
      sliceBuffer = crunker.sliceAudio(fullBuffer, start, end);
      ({ blob } = crunker.export(sliceBuffer, 'audio/wav'));
    } catch (err) {
      console.error(`[AudioPlayback] playRange Crunker error:`, err);
      return;
    }

    const blobUrl = URL.createObjectURL(blob);
    blobUrlRef.current = blobUrl;

    const audio = new Audio(blobUrl);
    applyPitchFix(audio);
    audio.playbackRate = playbackRateRef.current;
    applyPitchFix(audio);
    audioRef.current = audio;

    audio.onended = () => {
      if (sessionRef.current !== mySession) return;
      if (blobUrlRef.current === blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrlRef.current = null;
      }
      audioRef.current = null;
      if (syncAnimRef.current) {
        cancelAnimationFrame(syncAnimRef.current);
        syncAnimRef.current = null;
      }
      clearSafetyTimer();
      try {
        onTimeUpdateRef.current(start);
      } catch (_) {
        /* ignore */
      }
      setPlaying(false, 'onended');
    };

    audio.onplay = () => {
      if (sessionRef.current !== mySession) return;
      clearSafetyTimer();
      setPlaying(true, 'onplay');
      applyPitchFix(audio);
      audio.playbackRate = playbackRateRef.current;
      startSyncLoop(mySession, start);
    };

    // 不設定 onpause — killSession 已處理所有暫停邏輯
    // onpause 在 onended 前觸發會造成 race condition
    audio.onpause = null;

    // 🔧 Bug fix: safety timeout — 如果 onplay 遲遲沒觸發就 reset
    safetyTimerRef.current = setTimeout(() => {
      if (sessionRef.current === mySession && !isPlayingRef.current) {
        killSession('safety-timeout');
      }
    }, PLAY_SAFETY_TIMEOUT_MS);

    // 🔧 Bug fix: play() reject 時清理狀態
    audio.play().catch((err) => {
      if (sessionRef.current === mySession) {
        clearSafetyTimer();
        if (blobUrlRef.current === blobUrl) {
          URL.revokeObjectURL(blobUrl);
          blobUrlRef.current = null;
        }
        audioRef.current = null;
        setPlaying(false, `play-rejected(${err?.name})`);
      }
    });
  };

  const playFull = (startTime: number) => {
    killSession('playFull');
    const mySession = sessionRef.current;

    const audio = new Audio(url);
    applyPitchFix(audio);
    audio.playbackRate = playbackRateRef.current;
    applyPitchFix(audio);
    audio.currentTime = startTime;
    audioRef.current = audio;

    audio.onended = () => {
      if (sessionRef.current !== mySession) return;
      audioRef.current = null;
      if (syncAnimRef.current) {
        cancelAnimationFrame(syncAnimRef.current);
        syncAnimRef.current = null;
      }
      clearSafetyTimer();
      try {
        onTimeUpdateRef.current(audio.duration);
      } catch (_) {
        /* ignore */
      }
      setPlaying(false, 'onended-full');
    };

    audio.onplay = () => {
      if (sessionRef.current !== mySession) return;
      clearSafetyTimer();
      setPlaying(true, 'onplay-full');
      applyPitchFix(audio);
      audio.playbackRate = playbackRateRef.current;
      startSyncLoop(mySession, 0);
    };

    audio.onpause = null;

    // 🔧 Bug fix: safety timeout
    safetyTimerRef.current = setTimeout(() => {
      if (sessionRef.current === mySession && !isPlayingRef.current) {
        killSession('safety-timeout');
      }
    }, PLAY_SAFETY_TIMEOUT_MS);

    // 🔧 Bug fix: play() reject 時清理狀態
    audio.play().catch((err) => {
      if (sessionRef.current === mySession) {
        clearSafetyTimer();
        audioRef.current = null;
        setPlaying(false, `play-rejected(${err?.name})`);
      }
    });
  };

  // 動態更新 playbackRate
  useEffect(() => {
    if (audioRef.current) {
      applyPitchFix(audioRef.current);
      audioRef.current.playbackRate = playbackRate;
      applyPitchFix(audioRef.current);
    }
  }, [playbackRate]);

  return { playRange, playFull, stop, isAudioLoaded, isPlayingRef };
}
