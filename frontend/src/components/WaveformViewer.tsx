import { useEffect, useRef, useState, memo } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';

interface WaveformProps {
  url: string;
  threshold: number;
  onReady: (ws: WaveSurfer, regions: RegionsPlugin) => void;
}

export const WaveformViewer = memo(({ url, threshold, onReady }: WaveformProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [maxAmplitude, setMaxAmplitude] = useState(0.01); // Initial small non-zero value

  useEffect(() => {
    if (!containerRef.current) return;
    
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#00e5ff', 
      progressColor: '#00e5ff',
      cursorColor: '#fff',
      barWidth: 2,
      height: 160,
      normalize: true, 
      // Removed backend: 'WebAudio' to use default more stable rendering in v7
    });
    
    const regions = ws.registerPlugin(RegionsPlugin.create());
    
    ws.on('decode', () => {
      const buffer = ws.getDecodedData();
      if (buffer) {
          const data = buffer.getChannelData(0);
          let max = 0;
          for (let i = 0; i < data.length; i++) {
              const v = Math.abs(data[i]);
              if (v > max) max = v;
          }
          // Update peak amplitude to match WaveSurfer's normalize scaling
          setMaxAmplitude(max || 0.01);
      }
      onReady(ws, regions);
    });

    ws.load(url);

    return () => {
        ws.destroy();
    };
  }, [url, onReady]); 

  // Calculate percentage distance from center (0-50%)
  // If normalized, maxAmplitude visually represents the top/bottom edges (50%)
  const currentAmp = Math.pow(10, threshold / 20);
  const offset = Math.min(50, (currentAmp / maxAmplitude) * 50);

  return (
    <div style={{ background: '#000', borderRadius: '12px', border: '1px solid #666', padding: '16px 16px 40px 16px', minHeight: '220px', overflow: 'hidden', position: 'relative' }}>
      <div style={{ position: 'relative', height: '160px', width: '100%' }}>
        <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
        
        {/* Visual Zero Line */}
        <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: '1px', background: 'rgba(255,255,255,0.15)', pointerEvents: 'none', transform: 'translateY(-50%)' }} />
        
        {/* Threshold Boundaries - Precisely centered using transform */}
        <div style={{ 
          position: 'absolute', 
          top: `${50 - offset}%`, 
          left: 0, 
          right: 0, 
          height: '0px', 
          borderTop: '1px dashed #ff4444', 
          pointerEvents: 'none', 
          transition: 'top 0.1s ease-out',
          transform: 'translateY(-50%)',
          opacity: 0.8
        }} />
        <div style={{ 
          position: 'absolute', 
          bottom: `${50 - offset}%`, 
          left: 0, 
          right: 0, 
          height: '0px', 
          borderTop: '1px dashed #ff4444', 
          pointerEvents: 'none', 
          transition: 'bottom 0.1s ease-out',
          transform: 'translateY(50%)',
          opacity: 0.8
        }} />
      </div>
      <div style={{ position: 'absolute', bottom: '12px', left: 0, right: 0, fontSize: '11px', color: '#ff4444', fontWeight: '900', textAlign: 'center', letterSpacing: '1px' }}>THRESHOLD BOUNDARY</div>
    </div>
  );
});
