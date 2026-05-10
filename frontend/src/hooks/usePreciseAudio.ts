import { useRef, useState, useCallback, useEffect } from 'react';
import Crunker from 'crunker';

interface UsePreciseAudioProps {
  url: string;
  playbackRate: number;
  onTimeUpdate?: (currentTime: number) => void;
  onPlaybackStateChange?: (isPlaying: boolean) => void;
}

export function usePreciseAudio({ url, playbackRate, onTimeUpdate, onPlaybackStateChange }: UsePreciseAudioProps) {
  const fullAudioBufferRef = useRef<AudioBuffer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const syncAnimRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Initialize and fetch audio buffer
  useEffect(() => {
    const CrunkerConstructor = (Crunker as any).default || Crunker;
    const crunker = new CrunkerConstructor();
    
    setIsLoaded(false);
    crunker.fetchAudio(url)
      .then(([buffer]: AudioBuffer[]) => {
        fullAudioBufferRef.current = buffer;
        setIsLoaded(true);
      })
      .catch((err: Error) => {
        console.error("[usePreciseAudio] Fetch error:", err);
      });

    return () => {
      stop();
      fullAudioBufferRef.current = null;
    };
  }, [url]);

  const applyPitchFix = useCallback((audio: HTMLAudioElement) => {
    const a = audio as any;
    if ('preservesPitch' in a) a.preservesPitch = true;
    if ('webkitPreservesPitch' in a) a.webkitPreservesPitch = true;
    if ('mozPreservesPitch' in a) a.mozPreservesPitch = true;
  }, []);

  const stop = useCallback(() => {
    if (syncAnimRef.current) {
      cancelAnimationFrame(syncAnimRef.current);
      syncAnimRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setIsPlaying(false);
    onPlaybackStateChange?.(false);
  }, [onPlaybackStateChange]);

  const startSyncLoop = useCallback((offset: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    const sync = () => {
      if (audioRef.current === audio && !audio.paused && !audio.ended) {
        onTimeUpdate?.(offset + audio.currentTime);
        syncAnimRef.current = requestAnimationFrame(sync);
      }
    };
    syncAnimRef.current = requestAnimationFrame(sync);
  }, [onTimeUpdate]);

  const playRange = useCallback((start: number, end: number) => {
    const fullBuffer = fullAudioBufferRef.current;
    if (!fullBuffer) return;

    stop();

    const CrunkerConstructor = (Crunker as any).default || Crunker;
    const crunker = new CrunkerConstructor();
    
    const sliceBuffer = crunker.sliceAudio(fullBuffer, start, end);
    const { blob } = crunker.export(sliceBuffer, "audio/wav");
    const blobUrl = URL.createObjectURL(blob);
    blobUrlRef.current = blobUrl;

    const audio = new Audio(blobUrl);
    applyPitchFix(audio);
    audio.playbackRate = playbackRate;
    applyPitchFix(audio);
    
    audioRef.current = audio;

    audio.onended = () => {
      if (blobUrlRef.current === blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrlRef.current = null;
      }
      if (audioRef.current === audio) {
        audioRef.current = null;
        setIsPlaying(false);
        onPlaybackStateChange?.(false);
        onTimeUpdate?.(end);
        if (syncAnimRef.current) cancelAnimationFrame(syncAnimRef.current);
      }
    };

    audio.onplay = () => {
      setIsPlaying(true);
      onPlaybackStateChange?.(true);
      applyPitchFix(audio);
      audio.playbackRate = playbackRate;
      startSyncLoop(start);
    };

    audio.onpause = () => {
      setIsPlaying(false);
      onPlaybackStateChange?.(false);
    };

    audio.play();
  }, [playbackRate, stop, startSyncLoop, applyPitchFix, onPlaybackStateChange, onTimeUpdate]);

  const playFull = useCallback((startTime: number) => {
    stop();

    const audio = new Audio(url);
    applyPitchFix(audio);
    audio.playbackRate = playbackRate;
    applyPitchFix(audio);
    
    audio.currentTime = startTime;
    audioRef.current = audio;

    audio.onended = () => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        setIsPlaying(false);
        onPlaybackStateChange?.(false);
        if (syncAnimRef.current) cancelAnimationFrame(syncAnimRef.current);
      }
    };

    audio.onplay = () => {
      setIsPlaying(true);
      onPlaybackStateChange?.(true);
      applyPitchFix(audio);
      audio.playbackRate = playbackRate;
      startSyncLoop(0);
    };

    audio.onpause = () => {
      setIsPlaying(false);
      onPlaybackStateChange?.(false);
    };

    audio.play();
  }, [url, playbackRate, stop, startSyncLoop, applyPitchFix, onPlaybackStateChange]);

  // Sync playbackRate when it changes externally
  useEffect(() => {
    if (audioRef.current) {
      const audio = audioRef.current;
      applyPitchFix(audio);
      audio.playbackRate = playbackRate;
      applyPitchFix(audio);
    }
  }, [playbackRate, applyPitchFix]);

  return {
    playRange,
    playFull,
    stop,
    isPlaying,
    isLoaded
  };
}
