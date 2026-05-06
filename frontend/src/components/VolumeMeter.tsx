import { useEffect, useRef } from 'react';

interface Props {
  analyser: AnalyserNode | null;
}

export function VolumeMeter({ analyser }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number>(0);

  useEffect(() => {
    const update = () => {
        if (!analyser || !barRef.current) {
            requestRef.current = requestAnimationFrame(update);
            return;
        }

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          const val = (dataArray[i] - 128) / 128.0;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / bufferLength);
        const volume = Math.min(100, Math.max(0, rms * 100 * 5));
        
        const barColor = volume > 85 ? '#ff4d4d' : volume > 60 ? '#ffa726' : '#00e676';
        
        if (barRef.current) {
            barRef.current.style.height = `${volume}%`;
            barRef.current.style.background = `linear-gradient(to top, ${barColor}88, ${barColor})`;
            barRef.current.style.boxShadow = `0 0 15px ${barColor}44`;
        }

        requestRef.current = requestAnimationFrame(update);
    };

    requestRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(requestRef.current);
  }, [analyser]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{
        width: '14px',
        height: '160px',
        background: '#222',
        borderRadius: '7px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        border: '1px solid #444',
        boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5)'
      }}>
        <div 
          ref={barRef}
          style={{
            width: '100%',
            height: '0%',
            transition: 'height 0.05s linear',
          }}
        ></div>
      </div>
    </div>
  );
}
