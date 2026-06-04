import { memo } from 'react';

interface HeaderProps {
  status: {
    text: string;
    color: string;
  };
}

export const Header = memo(({ status }: HeaderProps) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
    <div>
      <h1 style={{ margin: 0, fontSize: '24px', fontWeight: '800', letterSpacing: '-0.8px', color: '#fff' }}>DiffSinger Recorder</h1>
      <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#888', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '1px' }}>
        PCM 16-BIT • Direct Stream
      </p>
    </div>
    <div style={{ 
      fontSize: '12px', 
      color: status.color === 'red' ? '#ff4d4d' : status.color === 'green' ? '#00e676' : '#2979ff',
      background: 'rgba(255,255,255,0.03)',
      padding: '8px 16px',
      borderRadius: '30px',
      border: '1px solid rgba(255,255,255,0.1)',
      fontWeight: '600'
    }}>
      {status.text}
    </div>
  </div>
));
