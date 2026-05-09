import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import Spectrogram from 'wavesurfer.js/plugins/spectrogram';
import type { Region } from 'wavesurfer.js/plugins/regions';
import type { Recording } from '../hooks/useAudioMonitor';

interface Props {
  recording: Recording;
  onCancel: () => void;
}

interface LabSegment {
  start: number;
  end: number;
  label: string;
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
  const [error, setError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [lyrics] = useState(recording.lyrics || '');
  const [wordInstances, setWordInstances] = useState<WordInstance[]>([]);
  const [, setUndoStack] = useState<string[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [lyricsCount, setLyricsCount] = useState(0);

  const parseLab = (content: string): LabSegment[] => {
    return content.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const parts = line.split(/\s+/);
        if (parts.length < 3) return null;
        const [startStr, endStr, ...labelParts] = parts;
        const label = labelParts.join(' ');
        let start = parseFloat(startStr);
        let end = parseFloat(endStr);
        if (start > 100000 || end > 100000) {
            start /= 10000000;
            end /= 10000000;
        }
        return { start, end, label };
      })
      .filter((s): s is LabSegment => s !== null);
  };

  const createLabelElement = (label: string, level: number) => {
    const div = document.createElement('div');
    div.textContent = label;
    div.style.color = '#fff';
    div.style.fontSize = '13px';
    div.style.fontWeight = '900';
    div.style.textShadow = '2px 2px 4px #000';
    div.style.position = 'absolute';
    const tops = ['10px', '40px'];
    div.style.top = tops[level % 2];
    div.style.left = '5px';
    div.style.whiteSpace = 'nowrap';
    div.style.pointerEvents = 'none';
    div.setAttribute('data-label-text', label);
    return div;
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
    const ws = wavesurferRef.current;
    if (!ws) return;
    
    const rate = ws.getPlaybackRate();
    const duration = end - start;
    const correctedEnd = start + (duration / rate);
    
    const onPause = () => {
      ws.setTime(end); 
      ws.un('pause', onPause);
    };
    ws.once('pause', onPause);

    ws.play(start, correctedEnd);
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
                const isWarning = seg.label === '!';
                regionsRef.current?.addRegion({
                    start: seg.start,
                    end: seg.end,
                    content: createLabelElement(seg.label, level),
                    color: isWarning ? 'rgba(255, 0, 0, 0.4)' : (level === 0 ? 'rgba(0, 229, 255, 0.15)' : 'rgba(0, 229, 255, 0.05)'),
                    drag: false,
                    resize: true,
                });
            });
            setLabelsCount(segments.length);
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
        if (group.length > 20 || currentCombined.length > word.length + 10) break; 
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
      const res = await fetch(`/api/lab/${encodeURIComponent(recording.filename)}`);
      if (res.ok) {
        const content = await res.text();
        const segments = parseLab(content);
        
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
          const isWarning = seg.label === '!';
          regions.addRegion({
            start: seg.start,
            end: seg.end,
            content: createLabelElement(seg.label, level),
            color: isWarning ? 'rgba(255, 0, 0, 0.4)' : (level === 0 ? 'rgba(0, 229, 255, 0.15)' : 'rgba(0, 229, 255, 0.05)'),
            drag: false, // 關閉整塊拖動，讓滑鼠可以穿透去拖動時間軸
            resize: true,
          });
        });
        setLabelsCount(filledSegments.length);
        setUndoStack([stringifyLab(regions.getRegions())]);
      } else {
        const txt = await res.text();
        setError(`Failed to load: ${res.status} ${txt}`);
        setLabelsCount(0);
      }
    } catch (err) {
      console.error("Fetch error:", err);
      setError(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
      setLabelsCount(0);
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#00e5ff',
      progressColor: 'rgba(0, 229, 255, 0.15)',
      cursorColor: '#fff',
      barWidth: 2,
      height: 120,
      normalize: true,
      minPxPerSec: zoomLevel,
      backend: 'WebAudio',
    });
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
    });
    regions.on('region-clicked', (_r: Region, _e: MouseEvent) => {
      // Left click only navigates, does not show UI
    });

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const ws = wavesurferRef.current;
      const regions = regionsRef.current;
      if (!ws || !regions) return;

      // Get relative time from mouse position
      const rect = containerRef.current!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const scrollLeft = ws.getWrapper().scrollLeft;
      const totalWidth = ws.getWrapper().scrollWidth;
      const time = ((x + scrollLeft) / totalWidth) * ws.getDuration();

      const all = regions.getRegions().sort((a, b) => a.start - b.start);
      const target = all.find(reg => time >= reg.start && time <= reg.end);
      if (target) {
        setSelectedRegion(target);
        setEditLabel(target.content?.getAttribute('data-label-text') || '');
      }
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
            isUpdatingRef.current = true;
            target.setOptions({ end: time });
            regions.addRegion({
                start: time,
                end: oldEnd,
                content: createLabelElement(oldLabel, 0),
                color: 'rgba(0, 229, 255, 0.1)',
                drag: false,
                resize: true,
            });
            isUpdatingRef.current = false;
            const newAll = regions.getRegions().sort((a, b) => a.start - b.start);
            newAll.forEach((r, idx) => {
                const level = idx % 2;
                const label = r.content?.getAttribute('data-label-text') || '';
                const isWarning = label === '!';
                r.setOptions({ 
                    color: isWarning ? 'rgba(255, 0, 0, 0.4)' : (level === 0 ? 'rgba(0, 229, 255, 0.15)' : 'rgba(0, 229, 255, 0.05)'),
                    content: createLabelElement(label, level),
                    drag: false
                });
            });
            setLabelsCount(newAll.length);
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
        if (e.code === 'Space') {
            const active = document.activeElement;
            const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
            if (!isInput) {
                e.preventDefault();
                handleWordPlay();
            }
        }
        if (e.key === 'Delete') {
            const active = document.activeElement;
            const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
            if (!isInput) {
                e.preventDefault();
                handleDeleteRegion();
            }
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [wordInstances, labelsCount]);

  useEffect(() => {
    if (wavesurferRef.current && isLoaded) {
        wavesurferRef.current.zoom(zoomLevel);
    }
  }, [zoomLevel, isLoaded]);

  useEffect(() => {
    if (wavesurferRef.current) {
        wavesurferRef.current.setPlaybackRate(playbackRate);
    }
  }, [playbackRate]);

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
      const isWarning = editLabel === '!';
      
      selectedRegion.setOptions({ 
          content: createLabelElement(editLabel, level),
          color: isWarning ? 'rgba(255, 0, 0, 0.4)' : (level === 0 ? 'rgba(0, 229, 255, 0.15)' : 'rgba(0, 229, 255, 0.05)')
      });
      setSelectedRegion(null);
      saveHistory();
      runAlignment(lyrics);
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
            const isWarning = label === '!';
            r.setOptions({ 
                color: isWarning ? 'rgba(255, 0, 0, 0.4)' : (level === 0 ? 'rgba(0, 229, 255, 0.15)' : 'rgba(0, 229, 255, 0.05)'),
                content: createLabelElement(label, level)
            });
        });
        
        setLabelsCount(newAll.length);
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

    // Search logic for Phoneme:
    // 1. If at boundary (end of a region), re-play the region that JUST ended.
    // 2. Otherwise, play the region the cursor is currently in.
    let target = all.find(r => time > r.start + eps && time <= r.end + eps);
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
    const eps = 0.01;
    
    // Search logic for Word:
    // 1. Try to find if we are in/at-end-of a WordInstance
    let word = wordInstances.find(w => time > w.start + eps && time <= w.end + eps)
            || wordInstances.find(w => time >= w.start && time <= w.end);
              
    if (word) {
      console.log(`[PLAY-WORD] ${word.word} @ ${word.start}-${word.end}`);
      precisePlayRange(word.start, word.end);
    } else {
      // 2. If no Word matches (e.g. cursor is on SP/pau), use Phoneme logic to play that specific segment
      handlePhonemePlay();
    }
  };

  const handleFullPlay = () => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    if (isPlaying) {
      ws.pause();
    } else {
      ws.play(0);
    }
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
                  disabled={!isLoaded} 
                  style={{ background: '#222', border: '1px solid #00e5ff', color: '#fff', borderRadius: '8px', padding: '10px 16px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
                >
                    WORD-PLAY
                </button>
                <button 
                  onClick={handlePhonemePlay} 
                  disabled={!isLoaded} 
                  style={{ background: '#222', border: '1px solid #ffea00', color: '#fff', borderRadius: '8px', padding: '10px 16px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
                >
                    PHONEME-PLAY
                </button>
                <button 
                  onClick={handleFullPlay} 
                  disabled={!isLoaded} 
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
                    {error ? <span style={{ color: '#ff4444' }}>{error}</span> : (labelsCount === null ? 'Loading...' : `${labelsCount} labels loaded`)}
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
        <div style={{ background: '#000', borderRadius: '12px', border: '1px solid #444', padding: '20px', position: 'relative', overflowX: 'auto', flex: 1 }}>
            <div id="label-editor-waveform" ref={containerRef} style={{ minWidth: '100%' }} />
            {selectedRegion && (
                <div style={{ position: 'absolute', top: '10px', left: '50%', transform: 'translateX(-50%)', background: '#222', padding: '12px', borderRadius: '12px', border: '1px solid #555', display: 'flex', gap: '8px', zIndex: 100, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
                    <input value={editLabel} onChange={e => setEditLabel(e.target.value)} onKeyDown={e => { if(e.key === 'Enter') handleUpdateLabel(); if(e.key === 'Escape') setSelectedRegion(null); }} autoFocus style={{ background: '#000', border: '1px solid #444', color: '#fff', padding: '6px 10px', borderRadius: '6px', outline: 'none', width: '80px', fontWeight: 'bold' }} />
                    <button onClick={handleUpdateLabel} style={{ background: '#00e5ff', border: 'none', color: '#000', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>OK</button>
                    <button onClick={() => precisePlayRange(selectedRegion.start, selectedRegion.end)} style={{ background: '#ffea00', border: 'none', color: '#000', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>PLAY</button>
                    <button onClick={handleDeleteRegion} style={{ background: '#ff4444', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>DEL</button>
                    <div style={{ width: '1px', background: '#444', margin: '0 4px' }} />
                    <button onClick={() => setSelectedRegion(null)} style={{ background: '#444', border: 'none', color: '#fff', padding: '6px 10px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>X</button>
                </div>
            )}
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        #label-editor-waveform ::part(region) {
          border-right: 1px solid rgba(255,255,255,0.4) !important;
          border-left: 1px solid rgba(255,255,255,0.4) !important;
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
