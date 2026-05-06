interface Props {
  isRecording: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled: boolean;
}

export function RecorderControls({ isRecording, onStart, onStop, disabled }: Props) {
  return (
    <div style={{ display: 'flex', gap: '16px' }}>
      {/* Start Button */}
      <button 
        onClick={onStart} 
        disabled={isRecording || disabled}
        style={{ 
          width: '56px',
          height: '42px',
          borderRadius: '10px', 
          border: '1px solid #444', 
          background: '#222', 
          color: (isRecording || disabled) ? '#444' : '#ff4d4d', 
          cursor: (isRecording || disabled) ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s',
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="7" />
        </svg>
      </button>

      {/* Upload/Stop Button */}
      <button 
        onClick={onStop} 
        disabled={!isRecording}
        style={{ 
          width: '56px',
          height: '42px',
          borderRadius: '10px', 
          border: '1px solid #444', 
          background: '#222', 
          color: !isRecording ? '#444' : '#2979ff', 
          cursor: !isRecording ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s',
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          {/* Professional Cloud Upload Icon */}
          <path d="M12 12V3m0 0l-3 3m3-3l3 3" /> {/* The Arrow on top */}
          <path d="M20 10c0-4.4-3.6-8-8-8s-8 3.6-8 8" /> {/* Cloud top arc */}
          <path d="M4 10h16v10H4z" style={{ opacity: 0 }} /> {/* Dummy for space */}
          <path d="M22 13a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5 5 5 0 0 1 5-5h1" />
        </svg>
      </button>
    </div>
  );
}
