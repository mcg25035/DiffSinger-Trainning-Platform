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

  const { calculateSplitPoints } = useSplitterLogic();

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
    let cur = 0;
    points.forEach((p, i) => {
        if (p <= cur + 0.01) return;
        regions.addRegion({ start: cur, end: p, color: i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)', drag: false, resize: true });
        cur = p;
    });
  }, [threshold, minGap, maxLen, calculateSplitPoints]);

  const handleWaveformReady = useCallback((ws: WaveSurfer, regions: RegionsPlugin) => {
    wavesurferRef.current = ws; 
    regionsRef.current = regions; 
    setIsLoaded(true);
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
    });
  }, []);

  useEffect(() => { if (isLoaded) runAutoDetect(); }, [isLoaded, runAutoDetect]);

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
            <button onClick={() => wavesurferRef.current?.playPause()} disabled={!isLoaded} style={{ background: '#222', border: '1px solid #666', color: isPlaying ? '#00e676' : '#fff', borderRadius: '8px', padding: '10px 20px', cursor: 'pointer', fontWeight: 'bold' }}>
                {isPlaying ? 'PAUSE' : 'PLAY'}
            </button>
        </div>
        <button onClick={onCancel} style={{ background: '#333', border: 'none', borderRadius: '8px', padding: '10px 20px', color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}>CANCEL</button>
      </div>

      <WaveformViewer url={recording.url} threshold={threshold} onReady={handleWaveformReady} />

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
    </div>
  );
}
