import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import Spectrogram from 'wavesurfer.js/plugins/spectrogram';
import type { Region } from 'wavesurfer.js/plugins/regions';
import type { Recording } from '../hooks/useAudioMonitor';
import Crunker from 'crunker';

/**
 * usePreciseAudio Hook
 * 
 * Logic abstracted to prevent future regressions. 
 * This hook handles:
 * 1. Fetching original AudioBuffer via Crunker (ensures sample rate consistency)
 * 2. Pitch-preserved playback via MediaElement (preservesPitch = true)
 * 3. Slicing with Crunker (matching AudioSplitter.tsx logic)
 * 4. Smooth cursor synchronization via requestAnimationFrame
 */
function usePreciseAudio(url: string, playbackRate: number, onTimeUpdate: (time: number) => void, onToggleIsPlaying: (playing: boolean) => void) {
  const fullAudioBufferRef = useRef<AudioBuffer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const syncAnimRef = useRef<number | null>(null);
  const playbackRateRef = useRef(playbackRate);
  const sessionRef = useRef(0);
  const isPlayingRef = useRef(false);
  const [isAudioLoaded, setIsAudioLoaded] = useState(false);

  // 集中管理狀態切換，加上 log
  const setPlaying = (value: boolean, reason: string) => {
    const prev = isPlayingRef.current;
    if (prev === value) return; // 不重複設定
    isPlayingRef.current = value;
    onToggleIsPlaying(value);
    console.log(`[AUDIO-DBG] setPlaying: ${prev} → ${value} (${reason}) session=${sessionRef.current}`);
  };

  useEffect(() => {
    playbackRateRef.current = playbackRate;
  }, [playbackRate]);

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

  const killSession = (reason: string) => {
    const oldSession = sessionRef.current;
    sessionRef.current++;
    console.log(`[AUDIO-DBG] killSession(${reason}): session ${oldSession} → ${sessionRef.current}, wasPlaying=${isPlayingRef.current}`);

    if (syncAnimRef.current) {
      cancelAnimationFrame(syncAnimRef.current);
      syncAnimRef.current = null;
    }
    if (audioRef.current) {
      const old = audioRef.current;
      old.onplay = null;
      old.onpause = null;
      old.onended = null;
      try { old.pause(); } catch (_) { /* ignore */ }
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
      if (sessionRef.current !== mySession) {
        console.log(`[AUDIO-DBG] syncLoop exit: stale session (mine=${mySession}, current=${sessionRef.current})`);
        return;
      }
      const audio = audioRef.current;
      if (!audio || audio.paused || audio.ended) {
        console.log(`[AUDIO-DBG] syncLoop exit: audio gone/paused/ended, session=${mySession}`);
        return;
      }
      try {
        const t = offset + audio.currentTime;
        if (isFinite(t)) {
          onTimeUpdate(t);
        }
      } catch (err) {
        console.error(`[AUDIO-DBG] syncLoop error in onTimeUpdate:`, err);
      }
      syncAnimRef.current = requestAnimationFrame(tick);
    };
    syncAnimRef.current = requestAnimationFrame(tick);
  };

  const playRange = (start: number, end: number) => {
    const fullBuffer = fullAudioBufferRef.current;
    if (!fullBuffer) {
      console.warn(`[AUDIO-DBG] playRange: no buffer loaded`);
      return;
    }

    killSession('playRange');
    const mySession = sessionRef.current;
    console.log(`[AUDIO-DBG] playRange start=${start.toFixed(3)} end=${end.toFixed(3)} session=${mySession}`);

    let sliceBuffer, blob;
    try {
      const CrunkerConstructor = (Crunker as any).default || Crunker;
      const crunker = new CrunkerConstructor();
      sliceBuffer = crunker.sliceAudio(fullBuffer, start, end);
      ({ blob } = crunker.export(sliceBuffer, "audio/wav"));
    } catch (err) {
      console.error(`[AUDIO-DBG] playRange Crunker error:`, err);
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
      if (sessionRef.current !== mySession) {
        console.log(`[AUDIO-DBG] onended IGNORED: stale session (mine=${mySession}, current=${sessionRef.current})`);
        return;
      }
      console.log(`[AUDIO-DBG] onended: session=${mySession}`);
      if (blobUrlRef.current === blobUrl) { URL.revokeObjectURL(blobUrl); blobUrlRef.current = null; }
      audioRef.current = null;
      if (syncAnimRef.current) { cancelAnimationFrame(syncAnimRef.current); syncAnimRef.current = null; }
      setPlaying(false, 'onended');
      try { onTimeUpdate(start); } catch (_) {}
    };

    audio.onplay = () => {
      if (sessionRef.current !== mySession) {
        console.log(`[AUDIO-DBG] onplay IGNORED: stale session (mine=${mySession}, current=${sessionRef.current})`);
        return;
      }
      console.log(`[AUDIO-DBG] onplay: session=${mySession}`);
      setPlaying(true, 'onplay');
      applyPitchFix(audio);
      audio.playbackRate = playbackRateRef.current;
      startSyncLoop(mySession, start);
    };

    // 不設定 onpause — killSession 已經處理所有暫停邏輯
    // onpause 在 onended 前觸發會造成 race condition
    audio.onpause = null;

    audio.play().catch((err) => {
      console.log(`[AUDIO-DBG] playRange audio.play() rejected: session=${mySession}, err=${err?.name}`);
    });
  };

  const playFull = (startTime: number) => {
    killSession('playFull');
    const mySession = sessionRef.current;
    console.log(`[AUDIO-DBG] playFull startTime=${startTime.toFixed(3)} session=${mySession}`);

    const audio = new Audio(url);
    applyPitchFix(audio);
    audio.playbackRate = playbackRateRef.current;
    applyPitchFix(audio);
    audio.currentTime = startTime;
    audioRef.current = audio;

    audio.onended = () => {
      if (sessionRef.current !== mySession) {
        console.log(`[AUDIO-DBG] onended IGNORED: stale session (mine=${mySession}, current=${sessionRef.current})`);
        return;
      }
      console.log(`[AUDIO-DBG] onended (full): session=${mySession}`);
      audioRef.current = null;
      if (syncAnimRef.current) { cancelAnimationFrame(syncAnimRef.current); syncAnimRef.current = null; }
      setPlaying(false, 'onended-full');
      try { onTimeUpdate(audio.duration); } catch (_) {}
    };

    audio.onplay = () => {
      if (sessionRef.current !== mySession) {
        console.log(`[AUDIO-DBG] onplay IGNORED: stale session (mine=${mySession}, current=${sessionRef.current})`);
        return;
      }
      console.log(`[AUDIO-DBG] onplay (full): session=${mySession}`);
      setPlaying(true, 'onplay-full');
      applyPitchFix(audio);
      audio.playbackRate = playbackRateRef.current;
      startSyncLoop(mySession, 0);
    };

    audio.onpause = null;

    audio.play().catch((err) => {
      console.log(`[AUDIO-DBG] playFull audio.play() rejected: session=${mySession}, err=${err?.name}`);
    });
  };

  useEffect(() => {
    if (audioRef.current) {
        applyPitchFix(audioRef.current);
        audioRef.current.playbackRate = playbackRate;
        applyPitchFix(audioRef.current);
    }
  }, [playbackRate]);

  return { playRange, playFull, stop, isAudioLoaded, isPlayingRef };
}

interface Props {
  recording: Recording;
  onCancel: () => void;
}

interface LabSegment {
  start: number;
  end: number;
  label: string;
  score?: number;
}

interface WordInstance {
  word: string;
  start: number;
  end: number;
  phonemes: string[];
}

export function LabelEditor({ recording, onCancel }: Props) {
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isUpdatingRef = useRef(false);
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [labelsCount, setLabelsCount] = useState<number | null>(null);
  const [regionItems, setRegionItems] = useState<{id: string, label: string, region: Region}[]>([]);

  const refreshRegionsState = () => {
      if (!regionsRef.current) return;
      const newAll = regionsRef.current.getRegions().sort((a, b) => a.start - b.start);
      setLabelsCount(newAll.length);
      setRegionItems(newAll.map(r => ({
          id: r.id,
          label: r.content?.getAttribute('data-label-text') || '',
          region: r
      })));
  };
  const [error, setError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [lyrics] = useState(recording.lyrics || '');
  const [wordInstances, setWordInstances] = useState<WordInstance[]>([]);
  const [, setUndoStack] = useState<string[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [lyricsCount, setLyricsCount] = useState(0);

  const { playRange, playFull, stop: stopAudio, isAudioLoaded, isPlayingRef } = usePreciseAudio(
    recording.url, 
    playbackRate, 
    (t) => wavesurferRef.current?.setTime(t), 
    (p) => setIsPlaying(p)
  );


  const parseLab = (content: string): LabSegment[] => {
    return content.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map((line): LabSegment | null => {
        const parts = line.split(/\s+/);
        if (parts.length < 3) return null;
        const [startStr, endStr, ...labelParts] = parts;
        
        // 解析標籤：有些舊標籤可能已經包含了信心值，我們只取第一個空格前的內容作為標籤
        let label = labelParts[0];
        let score: number | undefined = undefined;
        
        if (labelParts.length >= 2) {
          const possibleScore = parseFloat(labelParts[1]);
          if (!isNaN(possibleScore)) {
            score = possibleScore;
          }
        }

        let start = parseFloat(startStr);
        let end = parseFloat(endStr);
        if (start > 100000 || end > 100000) {
            start /= 10000000;
            end /= 10000000;
        }
        return { start, end, label, score };
      })
      .filter((s): s is LabSegment => s !== null);
  };

  const getConfidenceColor = (score?: number) => {
    if (score === undefined) return 'rgba(255,255,255,0.4)';
    const s = Math.abs(score);
    // 假設 -100 是極差的分數，0 是完美的分數
    const factor = Math.min(1, s / 100);
    const r = 255;
    const g = Math.round(255 * (1 - factor));
    const b = Math.round(255 * (1 - factor));
    return `rgb(${r}, ${g}, ${b})`;
  };

  const createLabelElement = (label: string, level: number) => {
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    div.style.pointerEvents = 'none';
    div.style.position = 'absolute';
    const tops = ['10px', '50px'];
    div.style.top = tops[level % 2];
    div.style.left = '5px';
    
    div.setAttribute('data-label-text', label);

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    labelSpan.style.color = '#fff';
    labelSpan.style.fontSize = '13px';
    labelSpan.style.fontWeight = '900';
    labelSpan.style.textShadow = '2px 2px 4px #000';
    div.appendChild(labelSpan);

    return div;
  };

  const applyRegionStyle = (region: Region, label: string, level: number, score?: number) => {
    const isWarning = label === '!';
    const confColor = getConfidenceColor(score);
    
    // 設定背景顏色
    region.setOptions({
        color: isWarning ? 'rgba(255, 0, 0, 0.4)' : (level === 0 ? 'rgba(0, 229, 255, 0.15)' : 'rgba(0, 229, 255, 0.05)'),
    });

    // 透過 CSS 變數控制邊界顏色
    if (region.element) {
        region.element.style.setProperty('--region-border-color', confColor);
        if (score !== undefined) {
            region.element.setAttribute('data-label-score', score.toString());
        }
    }
  };

  const stringifyLab = (regions: Region[]): string => {
    return regions
      .sort((a, b) => a.start - b.start)
      .map(r => {
          const s = Math.round(r.start * 10000000);
          const e = Math.round(r.end * 10000000);
          const label = r.content?.getAttribute('data-label-text') || 'SP';
          return `${s} ${e} ${label}`;
      })
      .join('\n');
  };

  const precisePlayRange = (start: number, end: number) => {
    playRange(start, end);
  };

  const saveHistory = () => {
    if (!regionsRef.current) return;
    const current = stringifyLab(regionsRef.current.getRegions());
    setUndoStack(prev => {
        if (prev.length > 0 && prev[prev.length - 1] === current) return prev;
        return [...prev, current];
    });
    setIsDirty(true);
    setSaveStatus('idle');
  };

  const handleUndo = () => {
    setUndoStack(prev => {
        if (prev.length <= 1) return prev;
        const newStack = [...prev];
        newStack.pop();
        const prevState = newStack[newStack.length - 1];
        if (regionsRef.current) {
            const segments = parseLab(prevState);
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
            refreshRegionsState();
            isUpdatingRef.current = false;
        }
        setIsDirty(true);
        setSaveStatus('idle');
        return newStack;
    });
  };

  const runAlignment = (text: string) => {
    if (!regionsRef.current) return;
    const allRegions = regionsRef.current.getRegions().sort((a, b) => a.start - b.start);
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const labels = allRegions.map(r => r.content?.getAttribute('data-label-text') || '');
    
    const instances: WordInstance[] = [];
    let labelIdx = 0;

    for (const word of words) {
      while (labelIdx < labels.length) {
        const l = labels[labelIdx].toUpperCase();
        if (l === 'SP' || l === 'PAU' || l === 'BR' || l === 'SIL' || l === '!') {
          labelIdx++;
        } else {
          break;
        }
      }

      let currentCombined = '';
      const group: string[] = [];
      const startIdx = labelIdx;

      while (labelIdx < labels.length) {
        const label = labels[labelIdx];
        const nextCombined = currentCombined + label;
        group.push(label);
        currentCombined = nextCombined;
        labelIdx++;
        
        if (currentCombined.toLowerCase() === word.toLowerCase()) break;
        if (group.length > 5 || currentCombined.length > word.length + 5) {
            // Prevent consuming too many labels if alignment completely fails
            break; 
        }
      }

      if (group.length > 0 && startIdx < allRegions.length) {
        instances.push({
          word,
          start: allRegions[startIdx].start,
          end: allRegions[Math.min(labelIdx - 1, allRegions.length - 1)].end,
          phonemes: [...group]
        });
      }
    }
    setWordInstances(instances);
  };

  const loadLabels = async (regions: RegionsPlugin) => {
    try {
      const [labRes, confRes] = await Promise.all([
        fetch(`/api/lab/${encodeURIComponent(recording.filename)}`),
        fetch(`/api/conf/${encodeURIComponent(recording.filename)}`).catch(() => null)
      ]);

      if (labRes.ok) {
        const labContent = await labRes.text();
        const confContent = confRes && confRes.ok ? await confRes.text() : null;
        
        const segments = parseLab(labContent);
        const confSegments = confContent ? parseLab(confContent) : [];
        
        // 合併信心分數
        if (confSegments.length > 0) {
          segments.forEach(seg => {
            const match = confSegments.find(cs => 
              Math.abs(cs.start - seg.start) < 0.001 && 
              Math.abs(cs.end - seg.end) < 0.001 &&
              cs.label === seg.label
            );
            if (match) seg.score = match.score;
          });
        }
        
        const ws = wavesurferRef.current;
        const duration = ws ? ws.getDuration() : 0;
        const filledSegments: LabSegment[] = [];
        let currentPos = 0;
        const eps = 1e-5;

        segments.sort((a, b) => a.start - b.start).forEach(seg => {
            if (seg.start - currentPos > eps) {
                filledSegments.push({ start: currentPos, end: seg.start, label: '!' });
            }
            filledSegments.push(seg);
            currentPos = Math.max(currentPos, seg.end);
        });

        if (duration - currentPos > eps) {
            filledSegments.push({ start: currentPos, end: duration, label: '!' });
        }

        regions.clearRegions();
        filledSegments.forEach((seg, i) => {
          const level = i % 2;
          const reg = regions.addRegion({
            start: seg.start,
            end: seg.end,
            content: createLabelElement(seg.label, level),
            drag: false, // 關閉整塊拖動，讓滑鼠可以穿透去拖動時間軸
            resize: true,
          });
          if (reg) applyRegionStyle(reg, seg.label, level, seg.score);
        });
        refreshRegionsState();
        setUndoStack([stringifyLab(regions.getRegions())]);
      } else {
        const txt = await labRes.text();
        setError(`Failed to load: ${labRes.status} ${txt}`);
        refreshRegionsState();
      }
    } catch (err) {
      console.error("Fetch error:", err);
      setError(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
      refreshRegionsState();
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#00e5ff',
      progressColor: 'rgba(0, 229, 255, 0.15)',
      cursorColor: '#fff',
      height: 120,
      normalize: true,
      minPxPerSec: zoomLevel,
      backend: 'WebAudio',
    });
    ws.setVolume(0); // Mute WaveSurfer audio, we use custom Audio object for pitch preservation
    const regions = ws.registerPlugin(RegionsPlugin.create());
    ws.registerPlugin(
      Spectrogram.create({
        labels: true,
        height: 280,
        splitChannels: false,
        colorMap: 'igray',
        labelsColor: '#fff',
        labelsHzColor: '#fff',
      })
    );
    (regions as any).avoidOverlapping = () => {};
    wavesurferRef.current = ws;
    regionsRef.current = regions;
    ws.once('ready', () => {
      setIsLoaded(true);
      loadLabels(regions).then(() => {
        runAlignment(recording.lyrics || '');
      });
    });
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    regions.on('region-updated', (r: Region) => {
      if (isUpdatingRef.current) return;
      isUpdatingRef.current = true;
      const all = regions.getRegions().sort((a, b) => a.start - b.start);
      const i = all.indexOf(r);
      if (i < all.length - 1) all[i+1].setOptions({ start: r.end });
      if (i > 0) all[i-1].setOptions({ end: r.start });
      isUpdatingRef.current = false;
      saveHistory();
      runAlignment(lyrics);
      refreshRegionsState();
    });
    regions.on('region-clicked', (_r: Region, _e: MouseEvent) => {
      setSelectedRegion(_r);
      setEditLabel(_r.content?.getAttribute('data-label-text') || '');
    });

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    containerRef.current?.addEventListener('contextmenu', handleContextMenu);

    // ws.on('interaction', () => { setSelectedRegion(null); }); // 移除此行，讓編輯框不要因為點擊時間軸而關閉
    ws.on('dblclick', () => {
        const time = ws.getCurrentTime();
        const all = regions.getRegions().sort((a, b) => a.start - b.start);
        const target = all.find(r => time >= r.start && time <= r.end);
        if (target) {
            const oldEnd = target.end;
            const oldLabel = target.content?.getAttribute('data-label-text') || '';
            const oldScoreAttr = target.content?.getAttribute('data-label-score');
            const oldScore = oldScoreAttr ? parseFloat(oldScoreAttr) : undefined;

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
            const newAll = regions.getRegions().sort((a, b) => a.start - b.start);
            newAll.forEach((r, idx) => {
                const level = idx % 2;
                const label = r.content?.getAttribute('data-label-text') || '';
                const scoreAttr = r.content?.getAttribute('data-label-score');
                const score = scoreAttr ? parseFloat(scoreAttr) : undefined;
                applyRegionStyle(r, label, level, score);
            });
            refreshRegionsState();
            saveHistory();
            runAlignment(lyrics);
        }
    });
    ws.load(recording.url);
    const handleWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            setZoomLevel(prev => Math.min(5000, Math.max(20, prev + (e.deltaY > 0 ? -100 : 100))));
        }
    };
    containerRef.current?.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      containerRef.current?.removeEventListener('wheel', handleWheel);
      ws.destroy();
    };
  }, [recording.url, recording.filename]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            handleUndo();
        }
        const active = document.activeElement;
        const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

        if (e.code === 'Space') {
            if (!isInput) {
                e.preventDefault();
                e.stopPropagation();
                if (active instanceof HTMLElement) {
                    active.blur();
                }
                console.log('[KEY-DBG] Space pressed - stopAudio()');
                stopAudio();
            }
        }
        if (e.key === 'w' || e.key === 'W') {
            if (!isInput) {
                e.preventDefault();
                e.stopPropagation();
                console.log('[KEY-DBG] W pressed - handleWordPlay()');
                handleWordPlay();
            }
        }
        if (e.key === 'p' || e.key === 'P') {
            if (!isInput) {
                e.preventDefault();
                e.stopPropagation();
                console.log('[KEY-DBG] P pressed - handlePhonemePlay()');
                handlePhonemePlay();
            }
        }
        if (e.key === 'f' || e.key === 'F') {
            if (!isInput) {
                e.preventDefault();
                e.stopPropagation();
                console.log('[KEY-DBG] F pressed - handleFullPlay()');
                handleFullPlay();
            }
        }
        if (e.key === 'Delete') {
            if (!isInput) {
                e.preventDefault();
                e.stopPropagation();
                handleDeleteRegion();
            }
        }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [wordInstances, labelsCount, isPlayingRef]);

  useEffect(() => {
    if (wavesurferRef.current && isLoaded) {
        wavesurferRef.current.zoom(zoomLevel);
    }
  }, [zoomLevel, isLoaded]);

  useEffect(() => {
    if (isLoaded) {
        runAlignment(lyrics);
    }
  }, [isLoaded, lyricsCount, lyrics]);

  useEffect(() => {
      setLyricsCount(labelsCount || 0);
  }, [labelsCount]);

  useEffect(() => {
    if (saveStatus === 'saved') {
        const timer = setTimeout(() => setSaveStatus('idle'), 10000);
        return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const handleSave = async () => {
    if (!regionsRef.current) return;
    setIsSaving(true);
    setSaveStatus('saving');
    const labContent = stringifyLab(regionsRef.current.getRegions());
    try {
      const res = await fetch(`/api/lab/${recording.filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: labContent
      });
      if (res.ok) {
          setIsDirty(false);
          setSaveStatus('saved');
      }
      else {
          alert("Save failed");
          setSaveStatus('error');
      }
    } catch (err) {
      console.error(err);
      alert("Save error");
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (isDirty) {
        if (confirm("You have unsaved changes. Are you sure you want to leave?")) {
            onCancel();
        }
    } else {
        onCancel();
    }
  };

  const handleUpdateLabel = () => {
    if (selectedRegion) {
      const all = regionsRef.current?.getRegions().sort((a, b) => a.start - b.start) || [];
      const idx = all.indexOf(selectedRegion);
      const level = idx !== -1 ? idx % 2 : 0;
      // 同時檢查 content 和 element 的屬性以相容舊有的渲染
      const scoreAttr = selectedRegion.element?.getAttribute('data-label-score') || 
                        selectedRegion.content?.getAttribute('data-label-score');
      const score = scoreAttr ? parseFloat(scoreAttr) : undefined;
      
      selectedRegion.setOptions({ 
          content: createLabelElement(editLabel, level)
      });
      applyRegionStyle(selectedRegion, editLabel, level, score);

      saveHistory();
      runAlignment(lyrics);
      refreshRegionsState();
    }
  };

  const handleDeleteRegion = () => {
    if (selectedRegion && regionsRef.current) {
        selectedRegion.remove();
        setSelectedRegion(null);
        
        // 重新計算層級顏色
        const newAll = regionsRef.current.getRegions().sort((a, b) => a.start - b.start);
        newAll.forEach((r, i) => {
            const level = i % 2;
            const label = r.content?.getAttribute('data-label-text') || '';
            const scoreAttr = r.element?.getAttribute('data-label-score') || 
                              r.content?.getAttribute('data-label-score');
            const score = scoreAttr ? parseFloat(scoreAttr) : undefined;
            applyRegionStyle(r, label, level, score);
        });
        
        refreshRegionsState();
        saveHistory();
        runAlignment(lyrics);
    }
  };

  const handlePhonemePlay = () => {
    const ws = wavesurferRef.current;
    const regions = regionsRef.current;
    if (!ws || !regions) return;

    const time = ws.getCurrentTime();
    const eps = 0.01;
    
    const all = regions.getRegions().sort((a, b) => a.start - b.start);
    if (all.length === 0) return;

    let target = all.find(r => time >= r.start && time < r.end);
    if (!target) target = all.find(r => time >= r.start && time <= r.end);
    if (!target && time < eps) target = all[0];
                
    if (target) {
      console.log(`[PLAY-PHONEME] ${target.content?.getAttribute('data-label-text')} @ ${target.start}-${target.end}`);
      precisePlayRange(target.start, target.end);
    }
  };

  const handleWordPlay = () => {
    const ws = wavesurferRef.current;
    if (!ws) return;

    const time = ws.getCurrentTime();
    
    let word = wordInstances.find(w => time >= w.start && time < w.end)
            || wordInstances.find(w => time >= w.start && time <= w.end);
              
    if (word) {
      console.log(`[PLAY-WORD] ${word.word} @ ${word.start}-${word.end}`);
      precisePlayRange(word.start, word.end);
    }
  };


  useEffect(() => {
      if (!regionsRef.current) return;
      const all = regionsRef.current.getRegions();
      all.forEach(r => {
          if (r.element) {
              let arrow = r.element.querySelector('.region-selected-arrow') as HTMLElement | null;
              if (selectedRegion && r.id === selectedRegion.id) {
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
                      const label = r.content?.getAttribute('data-label-text') || '';
                      const isWarning = label === '!';
                      const idx = all.indexOf(r);
                      const level = idx !== -1 ? idx % 2 : 0;
                      r.element.style.backgroundColor = isWarning ? 'rgba(255, 0, 0, 0.4)' : (level === 0 ? 'rgba(0, 229, 255, 0.15)' : 'rgba(0, 229, 255, 0.05)');
                  }
              }
          }
      });
  }, [selectedRegion, regionItems]);

  const handleFullPlay = () => {
    const ws = wavesurferRef.current;
    if (!ws) return;

    if (isPlayingRef.current) {
      stopAudio();
      return;
    }

    let startTime = ws.getCurrentTime();
    if (startTime >= ws.getDuration() - 0.05) {
        startTime = 0;
    }

    playFull(startTime);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <h2 style={{ fontSize: '20px', margin: 0, fontWeight: '800', color: '#fff' }}>VISUAL LABELER</h2>
                <div style={{ display: 'flex', alignItems: 'center', color: saveStatus === 'saved' ? '#00e676' : saveStatus === 'saving' ? '#ffea00' : '#888', transition: 'all 0.3s' }}>
                    {saveStatus === 'saving' ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin">
                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                        </svg>
                    ) : saveStatus === 'saved' ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.5 19c2.5 0 4.5-2 4.5-4.5 0-2.3-1.7-4.2-4-4.5C17.4 7.1 14.9 5 12 5c-2.4 0-4.5 1.4-5.5 3.5C4.2 9.1 2 11.3 2 14c0 2.8 2.2 5 5 5h10.5z" />
                            <polyline points="9 13 11 15 15 11" />
                        </svg>
                    ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.5 19c2.5 0 4.5-2 4.5-4.5 0-2.3-1.7-4.2-4-4.5C17.4 7.1 14.9 5 12 5c-2.4 0-4.5 1.4-5.5 3.5C4.2 9.1 2 11.3 2 14c0 2.8 2.2 5 5 5h10.5z" />
                        </svg>
                    )}
                </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  onClick={handleWordPlay} 
                  disabled={!isLoaded || !isAudioLoaded} 
                  style={{ background: '#222', border: '1px solid #00e5ff', color: '#fff', borderRadius: '8px', padding: '10px 16px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
                >
                    WORD-PLAY
                </button>
                <button 
                  onClick={handlePhonemePlay} 
                  disabled={!isLoaded || !isAudioLoaded} 
                  style={{ background: '#222', border: '1px solid #ffea00', color: '#fff', borderRadius: '8px', padding: '10px 16px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
                >
                    PHONEME-PLAY
                </button>
                <button 
                  onClick={handleFullPlay} 
                  disabled={!isLoaded || !isAudioLoaded} 
                  style={{ background: '#222', border: '1px solid #666', color: isPlaying ? '#00e676' : '#fff', borderRadius: '8px', padding: '10px 16px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
                >
                    {isPlaying ? 'PAUSE' : 'FULL-PLAY'}
                </button>
            </div>
            <div style={{ fontSize: '12px', color: '#888', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ fontSize: '10px', fontWeight: 'bold' }}>ZOOM</label>
                    <input type="range" min="20" max="1000" value={zoomLevel} onChange={e => setZoomLevel(Number(e.target.value))} style={{ width: '80px', accentColor: '#00e5ff' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ fontSize: '10px', fontWeight: 'bold' }}>SPEED</label>
                    <input type="range" min="0.1" max="2.0" step="0.1" value={playbackRate} onChange={e => setPlaybackRate(Number(e.target.value))} style={{ width: '80px', accentColor: '#ffea00' }} />
                    <span style={{ minWidth: '30px' }}>{playbackRate.toFixed(1)}x</span>
                </div>
                <span>
                    {error ? <span style={{ color: '#ff4444' }}>{error}</span> : (!isLoaded || !isAudioLoaded ? 'Loading...' : `${labelsCount} labels loaded`)}
                </span>
            </div>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
            <button onClick={handleCancel} style={{ background: '#333', border: 'none', borderRadius: '8px', padding: '10px 20px', color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}>CANCEL</button>
            <button onClick={handleSave} disabled={isSaving || !isLoaded} style={{ background: '#fff', border: 'none', borderRadius: '8px', padding: '10px 20px', color: '#000', cursor: 'pointer', fontWeight: 'bold' }}>
                {isSaving ? 'SAVING...' : 'SAVE CHANGES'}
            </button>
        </div>
      </div>



      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div style={{ background: '#000', borderRadius: '12px', border: '1px solid #444', padding: '20px', position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, position: 'relative', overflowX: 'auto', marginBottom: '10px' }}>
                <div id="label-editor-waveform" ref={containerRef} style={{ minWidth: '100%' }} />
            </div>
            
            {/* The fixed UI and button track */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0, borderTop: '1px solid #333', paddingTop: '10px' }}>
                {/* Fixed Edit UI */}
                <div style={{ minHeight: '40px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                   {selectedRegion ? (
                        <>
                            <span style={{color: '#fff', fontWeight: 'bold'}}>Edit Phoneme:</span>
                            <input 
                                value={editLabel} 
                                onChange={e => setEditLabel(e.target.value.replace(/\s+/g, ''))} 
                                onKeyDown={e => { 
                                    if(e.key === 'Enter') handleUpdateLabel(); 
                                    if(e.key === 'Escape') setSelectedRegion(null); 
                                }} 
                                autoFocus 
                                style={{ background: '#222', border: '1px solid #444', color: '#fff', padding: '6px 10px', borderRadius: '6px', outline: 'none', width: '120px', fontWeight: 'bold' }} 
                            />
                            <button onClick={handleUpdateLabel} style={{ background: '#00e5ff', border: 'none', color: '#000', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>OK</button>
                            <button onClick={() => precisePlayRange(selectedRegion.start, selectedRegion.end)} style={{ background: '#ffea00', border: 'none', color: '#000', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>PLAY</button>
                            <button onClick={handleDeleteRegion} style={{ background: '#ff4444', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>DEL</button>
                            <div style={{ width: '1px', background: '#444', margin: '0 4px', height: '20px' }} />
                            <button onClick={() => setSelectedRegion(null)} style={{ background: '#444', border: 'none', color: '#fff', padding: '6px 10px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>X</button>
                        </>
                   ) : (
                        <span style={{color: '#888', fontStyle: 'italic'}}>Select a region in the track below or waveform to edit its phoneme.</span>
                   )}
                </div>

                {/* Button Track */}
                <div style={{
                    display: 'flex',
                    gap: '4px',
                    overflowX: 'auto',
                    paddingBottom: '8px',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#444 #000'
                }}>
                    {regionItems.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => {
                                setSelectedRegion(item.region);
                                setEditLabel(item.label);
                                if (wavesurferRef.current) {
                                    const ws = wavesurferRef.current;
                                    const duration = ws.getDuration();
                                    if (duration > 0) {
                                        const center = (item.region.start + item.region.end) / 2;
                                        const wrapper = ws.getWrapper();
                                        const scrollWidth = wrapper.scrollWidth;
                                        const clientWidth = wrapper.clientWidth;
                                        const targetScroll = (center / duration) * scrollWidth - clientWidth / 2;
                                        wrapper.scrollTo({ left: targetScroll, behavior: 'smooth' });
                                    }
                                }
                            }}
                            style={{
                                background: selectedRegion?.id === item.id ? '#00e5ff' : '#222',
                                color: selectedRegion?.id === item.id ? '#000' : '#fff',
                                border: '1px solid #444',
                                padding: '6px 12px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                                fontWeight: 'bold'
                            }}
                        >
                            {item.label || 'SP'}
                        </button>
                    ))}
                </div>
            </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `
        #label-editor-waveform ::part(region) {
          border-left: 3px solid var(--region-border-color, rgba(255,255,255,0.4)) !important;
          border-right: 1px solid rgba(255,255,255,0.1) !important;
          transition: border-left-color 0.2s ease;
        }
        #label-editor-waveform ::part(region-handle) {
          width: 8px !important;
        }
        .spin {
            animation: spin 2s linear infinite;
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
      `}} />
    </div>
  );
}
