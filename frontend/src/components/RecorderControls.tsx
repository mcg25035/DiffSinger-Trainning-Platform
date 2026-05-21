import { useRef } from 'react';

interface Props {
  isRecording: boolean;
  onStart: () => void;
  onStop: () => void;
  onUploadFile?: (file: File) => Promise<void>;
  disabled: boolean;
}

export function RecorderControls({ isRecording, onStart, onStop, onUploadFile, disabled }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0] && onUploadFile) {
      await onUploadFile(e.target.files[0]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
      <input 
        type="file" 
        accept=".wav" 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        onChange={handleFileChange} 
      />
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

      {/* Separator */}
      <div style={{ width: '1px', height: '30px', background: '#333' }}></div>

      {/* Upload File Button */}
      <button 
        onClick={() => fileInputRef.current?.click()}
        disabled={isRecording}
        style={{ 
          width: '56px',
          height: '42px',
          borderRadius: '10px', 
          border: '1px solid #444', 
          background: '#222', 
          color: isRecording ? '#444' : '#ffa726', 
          cursor: isRecording ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s',
        }}
        title="Upload WAV File"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </button>
    </div>
  );
}
