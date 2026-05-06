import { useEffect, useRef } from 'react';

interface Props {
  analyser: AnalyserNode | null;
  isRecording: boolean;
}

export function WaveformVisualizer({ analyser, isRecording }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);

  useEffect(() => {
    const draw = () => {
        if (!canvasRef.current || !analyser) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.lineWidth = 2;
        ctx.strokeStyle = isRecording ? '#ff5252' : '#42a5f5';
        ctx.beginPath();

        const sliceWidth = canvas.width * 1.0 / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const y = v * canvas.height / 2;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }

          x += sliceWidth;
        }

        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();

        requestRef.current = requestAnimationFrame(draw);
    };

    requestRef.current = requestAnimationFrame(draw);
    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, [analyser, isRecording]);

  return (
    <div style={{ 
      flex: 1, 
      height: '160px', 
      background: '#111', 
      borderRadius: '12px', 
      overflow: 'hidden',
      border: '1px solid #333',
      position: 'relative'
    }}>
      <canvas 
        ref={canvasRef} 
        width={400} 
        height={160} 
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
