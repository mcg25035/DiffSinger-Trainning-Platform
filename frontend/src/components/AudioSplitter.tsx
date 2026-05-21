import { useEffect, useRef, useState, useCallback } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import type { Region } from 'wavesurfer.js/plugins/regions';
import type { Recording } from '../hooks/useAudioMonitor';
import { useSplitterLogic } from '../hooks/useSplitterLogic';
import { WaveformViewer } from './WaveformViewer';
import Crunker from 'crunker';

interface Props {
  recording: Recording;
  onAdopt: () => void;
  onCancel: () => void;
}

export function AudioSplitter({ recording, onAdopt, onCancel }: Props) {
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const isUpdatingRef = useRef(false);
  const [threshold, setThreshold] = useState<number>(-45);
  const [minGap, setMinGap] = useState<number>(0.25);
  const [maxLen, setMaxLen] = useState<number>(10);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null);
  const [, setUndoStack] = useState<{start: number, end: number}[][]>([]);
  const saveHistoryTimeout = useRef<number | null>(null);

  const { calculateSplitPoints } = useSplitterLogic();

  const saveHistory = useCallback(() => {
    if (!regionsRef.current) return;
    const current = regionsRef.current.getRegions()
        .sort((a, b) => a.start - b.start)
        .map(r => ({ start: r.start, end: r.end, isAdopted: !!(r as any).isAdopted }));
    
    setUndoStack(prev => {
        if (prev.length > 0) {
            const last = prev[prev.length - 1];
            if (last.length === current.length && last.every((r, i) => Math.abs(r.start - current[i].start) < 0.001 && Math.abs(r.end - current[i].end) < 0.001 && r.isAdopted === current[i].isAdopted)) {
                return prev;
            }
        }
        return [...prev, current];
    });
  }, []);

  const queueSaveHistory = useCallback(() => {
      if (saveHistoryTimeout.current) clearTimeout(saveHistoryTimeout.current);
      saveHistoryTimeout.current = setTimeout(() => {
          saveHistory();
      }, 300);
  }, [saveHistory]);

  const handleUndo = useCallback(() => {
    setUndoStack(prev => {
        if (prev.length <= 1) return prev; 
        const newStack = [...prev];
        newStack.pop();
        const prevState = newStack[newStack.length - 1];
        
        if (regionsRef.current) {
            isUpdatingRef.current = true;
            regionsRef.current.clearRegions();
            setSelectedRegion(null);
            prevState.forEach((seg, i) => {
                // @ts-ignore - allow isAdopted usage
                const reg = regionsRef.current?.addRegion({
                    start: seg.start,
                    end: seg.end,
                    // @ts-ignore
                    color: seg.isAdopted ? '#000' : (i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)'),
                    drag: false,
                    // @ts-ignore
                    resize: !seg.isAdopted
                });
                // @ts-ignore
                if (reg && seg.isAdopted) {
                    (reg as any).isAdopted = true;
                }
            });
            isUpdatingRef.current = false;
        }
        return newStack;
    });
  }, []);

  const runAutoDetect = useCallback(() => {
    const ws = wavesurferRef.current;
    const regions = regionsRef.current;
    if (!ws || !regions) return;
    const buffer = ws.getDecodedData();
    if (!buffer) return;

    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const step = Math.floor(sr * 0.02);
    const dbValues: number[] = [];
    for (let i = 0; i < data.length; i += step) {
        let sum = 0, count = 0;
        for (let j = 0; j < step && i + j < data.length; j++) { sum += data[i+j] * data[i+j]; count++; }
        dbValues.push(20 * Math.log10(Math.sqrt(sum / count) || 1e-10));
    }

    const points = calculateSplitPoints(dbValues, sr, buffer.duration, threshold, minGap, maxLen);
    regions.clearRegions();
    setSelectedRegion(null);
    let cur = 0;
    points.forEach((p, i) => {
        if (p <= cur + 0.01) return;
        regions.addRegion({ start: cur, end: p, color: i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)', drag: false, resize: true });
        cur = p;
    });
    saveHistory();
  }, [threshold, minGap, maxLen, calculateSplitPoints, saveHistory]);

  const handleWaveformReady = useCallback((ws: WaveSurfer, regions: RegionsPlugin) => {
    wavesurferRef.current = ws; 
    regionsRef.current = regions; 
    setIsLoaded(true);
    ws.on('play', () => setIsPlaying(true)); 
    ws.on('pause', () => setIsPlaying(false));
    
    let lastRegionClick = 0;
    regions.on('region-clicked', (r: Region) => {
        if ((r as any).isAdopted) return;
        lastRegionClick = Date.now();
        setSelectedRegion(r);
    });

    ws.on('interaction', () => {
        if (Date.now() - lastRegionClick > 100) {
            setSelectedRegion(null);
        }
    });

    regions.on('region-updated', (r: Region) => {
        if (isUpdatingRef.current) return;
        isUpdatingRef.current = true;
        const all = regions.getRegions().sort((a, b) => a.start - b.start);
        const i = all.indexOf(r);
        if (i < all.length - 1) all[i+1].setOptions({ start: r.end });
        if (i > 0) all[i-1].setOptions({ end: r.start });
        isUpdatingRef.current = false;
        queueSaveHistory();
    });
  }, [queueSaveHistory]);

  const switchToManual = useCallback(() => {
      const ws = wavesurferRef.current;
      const regions = regionsRef.current;
      if (!ws || !regions) return;
      regions.clearRegions();
      setSelectedRegion(null);
      regions.addRegion({ start: 0, end: ws.getDuration(), color: 'rgba(255,255,255,0.08)', drag: false, resize: true });
      saveHistory();
  }, [saveHistory]);

  useEffect(() => { 
      if (!isLoaded) return;
      if (mode === 'auto') runAutoDetect(); 
      else switchToManual();
  }, [isLoaded, runAutoDetect, switchToManual, mode]);

  useEffect(() => {
    if (!regionsRef.current) return;
    const all = regionsRef.current.getRegions().sort((a, b) => a.start - b.start);
    all.forEach((r, i) => {
        if ((r as any).isAdopted) {
            r.setOptions({ color: '#000' });
            return;
        }
        const isSelected = r === selectedRegion;
        r.setOptions({
            color: isSelected ? 'rgba(255, 0, 0, 0.3)' : (i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)')
        });
    });
  }, [selectedRegion]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            handleUndo();
            return;
        }

        if (e.key === 'Enter') {
            const active = document.activeElement;
            const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
            if (!isInput && selectedRegion) {
                e.preventDefault();
                handleAdoptCurrent();
                return;
            }
        }

        if (e.code === 'Space') {
            const active = document.activeElement;
            const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
            if (!isInput) {
                e.preventDefault();
                wavesurferRef.current?.playPause();
                return;
            }
        }

        if (e.key === 'c' || e.key === 'C') {
            const active = document.activeElement;
            const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
            if (!isInput && selectedRegion && regionsRef.current && wavesurferRef.current) {
                e.preventDefault();
                const time = wavesurferRef.current.getCurrentTime();
                if (time > selectedRegion.start + 0.01 && time < selectedRegion.end - 0.01) {
                    const oldEnd = selectedRegion.end;
                    
                    isUpdatingRef.current = true;
                    
                    selectedRegion.setOptions({ end: time });
                    
                    regionsRef.current.addRegion({
                        start: time,
                        end: oldEnd,
                        drag: false,
                        resize: true
                    });
                    
                    const newAll = regionsRef.current.getRegions().sort((a, b) => a.start - b.start);
                    newAll.forEach((r, i) => {
                        const isSelected = r === selectedRegion;
                        r.setOptions({
                            color: isSelected ? 'rgba(255, 0, 0, 0.3)' : (i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)')
                        });
                    });
                    
                    isUpdatingRef.current = false;
                    saveHistory();
                }
                return;
            }
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedRegion && regionsRef.current) {
                const allRegions = regionsRef.current.getRegions().sort((a, b) => a.start - b.start);
                const idx = allRegions.indexOf(selectedRegion);
                const prev = idx > 0 ? allRegions[idx - 1] : null;
                const next = idx < allRegions.length - 1 ? allRegions[idx + 1] : null;
                const bStart = selectedRegion.start;
                const bEnd = selectedRegion.end;

                selectedRegion.remove();
                setSelectedRegion(null);
                
                isUpdatingRef.current = true;

                // ALWAYS merge adjacent regions to maintain contiguous boundaries!
                if (prev) {
                    prev.setOptions({ end: bEnd });
                } else if (next) {
                    next.setOptions({ start: bStart });
                }

                // Recalculate colors for remaining regions
                const newAll = regionsRef.current.getRegions().sort((a, b) => a.start - b.start);
                newAll.forEach((r, i) => {
                    if ((r as any).isAdopted) return;
                    r.setOptions({
                        color: i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)'
                    });
                });

                isUpdatingRef.current = false;
                saveHistory();
            }
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedRegion, handleUndo, saveHistory, mode, isProcessing]);

  const handleAdoptCurrent = async () => {
      if (!selectedRegion || !regionsRef.current || isProcessing) return;
      setIsProcessing(true);
      try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const CrunkerConstructor = (Crunker as any).default || Crunker;
          const crunker = new CrunkerConstructor();
          const [fullBuffer] = await crunker.fetchAudio(recording.url);
          
          const reg = selectedRegion;
          if (reg.end - reg.start >= 0.05) {
              const slicedBuffer = crunker.sliceAudio(fullBuffer, reg.start, reg.end);
              const { blob } = crunker.export(slicedBuffer, "audio/wav");
              
              const fd = new FormData();
              fd.append('type', 'upload_segments');
              fd.append('audio', blob, 'segment.wav');
              await fetch('/upload', { method: 'POST', body: fd });
              
              // Mark as adopted instead of removing to maintain boundary list and obscure waveform visually
              (reg as any).isAdopted = true;
              setSelectedRegion(null);
              
              isUpdatingRef.current = true;
              
              const newAll = regionsRef.current.getRegions().sort((a, b) => a.start - b.start);
              newAll.forEach((r, i) => {
                  if ((r as any).isAdopted) {
                      r.setOptions({ color: '#000', resize: false });
                  } else {
                      r.setOptions({ color: i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)' });
                  }
              });
              isUpdatingRef.current = false;
              saveHistory();
          }
      } catch (err) {
          console.error("Adopt Current Error:", err);
          alert("Processing failed. See console for details.");
      } finally {
          setIsProcessing(false);
      }
  };

  const handleProcess = async () => {
    setIsProcessing(true);
    
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const CrunkerConstructor = (Crunker as any).default || Crunker;
        const crunker = new CrunkerConstructor();
        
        // fetchAudio resamples to the instance's context rate automatically
        const [fullBuffer] = await crunker.fetchAudio(recording.url);
        
        const regs = regionsRef.current?.getRegions().sort((a, b) => a.start - b.start) || [];

        for (let i = 0; i < regs.length; i++) {
            const reg = regs[i];
            if (reg.end - reg.start < 0.05) continue;
            if ((reg as any).isAdopted) continue;
            
            const slicedBuffer = crunker.sliceAudio(fullBuffer, reg.start, reg.end);
            const { blob } = crunker.export(slicedBuffer, "audio/wav");
            
            const fd = new FormData();
            fd.append('type', 'upload_segments');
            fd.append('audio', blob, 'segment.wav');
            await fetch('/upload', { method: 'POST', body: fd });
        }
        onAdopt();
    } catch (err) {
        console.error("Splitter Error:", err);
        alert("Processing failed. See console for details.");
    } finally {
        setIsProcessing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
            <h2 style={{ fontSize: '20px', margin: 0, fontWeight: '800', color: '#fff' }}>PRECISION SPLITTER</h2>
            <div style={{ display: 'flex', background: '#222', borderRadius: '8px', padding: '4px' }}>
                <button onClick={() => setMode('auto')} style={{ background: mode === 'auto' ? '#00e5ff' : 'transparent', color: mode === 'auto' ? '#000' : '#fff', border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer', fontWeight: 'bold' }}>AUTO</button>
                <button onClick={() => setMode('manual')} style={{ background: mode === 'manual' ? '#00e5ff' : 'transparent', color: mode === 'manual' ? '#000' : '#fff', border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer', fontWeight: 'bold' }}>MANUAL</button>
            </div>
            <button onClick={() => wavesurferRef.current?.playPause()} disabled={!isLoaded} style={{ background: '#222', border: '1px solid #666', color: isPlaying ? '#00e676' : '#fff', borderRadius: '8px', padding: '10px 20px', cursor: 'pointer', fontWeight: 'bold' }}>
                {isPlaying ? 'PAUSE' : 'PLAY'}
            </button>
        </div>
        <button onClick={onCancel} style={{ background: '#333', border: 'none', borderRadius: '8px', padding: '10px 20px', color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}>CANCEL</button>
      </div>

      <WaveformViewer url={recording.url} threshold={threshold} onReady={handleWaveformReady} />

      {mode === 'auto' ? (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '24px', alignItems: 'end', padding: '24px', background: '#111', borderRadius: '16px', border: '1px solid #444' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ fontSize: '11px', color: '#ccc', fontWeight: '800' }}>THRESHOLD: {threshold}dB</label>
          <input type="range" min="-80" max="-10" value={threshold} onChange={e => setThreshold(Number(e.target.value))} style={{ width: '100%', accentColor: '#00e5ff' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
           <label style={{ fontSize: '11px', color: '#ccc', fontWeight: '800' }}>MIN GAP: {minGap}s</label>
           <input type="range" min="0.05" max="1.0" step="0.05" value={minGap} onChange={e => setMinGap(Number(e.target.value))} style={{ width: '100%', accentColor: '#00e5ff' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
           <label style={{ fontSize: '11px', color: '#ccc', fontWeight: '800' }}>MAX LEN: {maxLen}s</label>
           <input type="range" min="1" max="30" step="1" value={maxLen} onChange={e => setMaxLen(Number(e.target.value))} style={{ width: '100%', accentColor: '#00e5ff' }} />
        </div>
        <button onClick={handleProcess} disabled={isProcessing || !isLoaded} style={{ padding: '0 40px', height: '52px', background: '#fff', color: '#000', border: 'none', borderRadius: '12px', fontWeight: '900', cursor: 'pointer' }}>
          {isProcessing ? 'SAVING...' : 'ADOPT ALL'}
        </button>
      </div>
      ) : (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px', background: '#111', borderRadius: '16px', border: '1px solid #444' }}>
          <div style={{ color: '#ccc', fontSize: '13px', lineHeight: '1.6' }}>
             <b>MANUAL MODE</b><br/>
             Press <b style={{color: '#00e5ff'}}>C</b> to split at playhead.<br/>
             Select a region and click <b style={{color: '#00e5ff'}}>ADOPT SELECTED</b> (or press Enter) to extract it.
          </div>
          <div style={{ display: 'flex', gap: '16px' }}>
              <button onClick={handleAdoptCurrent} disabled={!selectedRegion || isProcessing} style={{ padding: '0 30px', height: '52px', background: selectedRegion ? '#00e5ff' : '#444', color: '#000', border: 'none', borderRadius: '12px', fontWeight: '900', cursor: selectedRegion ? 'pointer' : 'not-allowed' }}>
                {isProcessing ? 'SAVING...' : 'ADOPT SELECTED'}
              </button>
              <button onClick={handleProcess} disabled={isProcessing || !isLoaded} style={{ padding: '0 30px', height: '52px', background: '#fff', color: '#000', border: 'none', borderRadius: '12px', fontWeight: '900', cursor: 'pointer' }}>
                ADOPT ALL
              </button>
          </div>
      </div>
      )}
    </div>
  );
}
