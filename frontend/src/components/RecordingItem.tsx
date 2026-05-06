import { useState, useRef, useEffect, memo } from 'react';
import type { Recording } from '../hooks/useAudioMonitor';
import { validateLyrics } from '../utils/dictionary';

interface Props {
  recording: Recording;
  onSplit?: (recording: Recording) => void;
  onRefresh?: () => void;
  phonemeSet?: Set<string>;
}

export const RecordingItem = memo(({ recording, onSplit, onRefresh, phonemeSet }: Props) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [lyrics, setLyrics] = useState(recording.lyrics || '');
  
  const audioObjRef = useRef<HTMLAudioElement | null>(null);
  const progressTimerRef = useRef<number | null>(null);

  const cleanup = () => {
    if (audioObjRef.current) {
        audioObjRef.current.pause();
        audioObjRef.current.src = '';
        audioObjRef.current = null;
    }
    if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current);
        progressTimerRef.current = null;
    }
    setIsPlaying(false);
    setProgress(0);
  };

  useEffect(() => {
    return () => cleanup();
  }, []);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (!audioObjRef.current) {
        const audio = new Audio(recording.url);
        audio.onplay = () => setIsPlaying(true);
        audio.onpause = () => setIsPlaying(false);
        audio.onended = () => cleanup();
        // Prevent extension from seeing this audio object by not attaching it to DOM
        audioObjRef.current = audio;
    }

    if (isPlaying) {
        audioObjRef.current.pause();
        if (progressTimerRef.current) {
            clearInterval(progressTimerRef.current);
            progressTimerRef.current = null;
        }
    } else {
        audioObjRef.current.play();
        progressTimerRef.current = window.setInterval(() => {
            if (audioObjRef.current && audioObjRef.current.duration) {
                setProgress((audioObjRef.current.currentTime / audioObjRef.current.duration) * 100);
            }
        }, 100);
    }
  };

  const handleSaveLyrics = async () => {
    if (phonemeSet && phonemeSet.size > 0) {
        const { isValid, invalidWords } = validateLyrics(lyrics, phonemeSet);
        if (!isValid) {
            alert(`無效的羅馬歌詞: ${invalidWords.join(', ')}`);
            return;
        }
    }

    try {
        const response = await fetch('/api/lyrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: recording.filename, lyrics })
        });
        if (response.ok) {
            setIsEditing(false);
            if (onRefresh) onRefresh();
        } else {
            alert("儲存失敗");
        }
    } catch (err) {
        console.error("Save Lyrics Error:", err);
        alert("儲存失敗");
    }
  };

  return (
    <div 
      style={{ 
        display: 'flex', 
        flexDirection: 'column',
        background: '#1a1a1a', 
        padding: '12px 16px', 
        borderRadius: '14px', 
        border: '1px solid #333',
        transition: 'all 0.2s',
        marginBottom: '10px',
        cursor: 'default'
      }}
      onMouseOver={e => {
        e.currentTarget.style.borderColor = '#555';
        e.currentTarget.style.background = '#222';
      }}
      onMouseOut={e => {
        e.currentTarget.style.borderColor = '#333';
        e.currentTarget.style.background = '#1a1a1a';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <button 
          onClick={togglePlay}
          style={{ 
            background: 'none', 
            border: 'none', 
            padding: 0, 
            color: isPlaying ? '#00e676' : '#555',
            display: 'flex', 
            alignItems: 'center',
            cursor: 'pointer',
            transition: 'color 0.2s',
            outline: 'none'
          }}
        >
          {isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5 3l14 9-14 9V3z" />
            </svg>
          )}
        </button>
        
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ 
            fontSize: '11px', 
            color: isPlaying ? '#eee' : '#666', 
            whiteSpace: 'nowrap', 
            overflow: 'hidden', 
            textOverflow: 'ellipsis',
            fontFamily: 'monospace'
          }}>
            {recording.filename}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '60px', height: '2px', background: '#222', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: isPlaying ? '#00e676' : '#2979ff' }} />
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            {recording.type === 'segment' && (
              <button
                onClick={(e) => { e.stopPropagation(); setIsEditing(!isEditing); }}
                style={{ background: 'none', border: 'none', padding: 0, color: lyrics ? '#00e676' : '#666', cursor: 'pointer', opacity: 0.6, display: 'flex', alignItems: 'center' }}
                title="Edit Lyrics"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
            )}

            <a 
              href={recording.url} 
              download={recording.filename}
              style={{ color: '#2979ff', opacity: 0.6, display: 'flex', alignItems: 'center' }}
              title="Download"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </a>

            {onSplit && (
              <button
                onClick={(e) => { e.stopPropagation(); onSplit(recording); }}
                style={{ background: 'none', border: 'none', padding: 0, color: '#ffa726', cursor: 'pointer', opacity: 0.6, display: 'flex', alignItems: 'center' }}
                title="Split Audio"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="6" r="3"></circle>
                  <circle cx="6" cy="18" r="3"></circle>
                  <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
                  <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
                  <line x1="8.12" y1="8.12" x2="12" y2="12"></line>
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {(isEditing || recording.lyrics) && (
        <div style={{ marginTop: isEditing ? '12px' : '4px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {isEditing ? (
            <div style={{ display: 'flex', gap: '8px' }}>
              <input 
                value={lyrics}
                onChange={e => setLyrics(e.target.value)}
                placeholder="輸入羅馬歌詞 (空格分隔)..."
                autoFocus
                style={{ 
                  flex: 1, 
                  background: '#000', 
                  border: '1px solid #333', 
                  borderRadius: '6px', 
                  color: '#fff', 
                  padding: '4px 8px', 
                  fontSize: '11px',
                  outline: 'none'
                }}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveLyrics(); if (e.key === 'Escape') setIsEditing(false); }}
              />
              <button 
                onClick={handleSaveLyrics}
                style={{ background: '#00e676', border: 'none', borderRadius: '6px', color: '#000', padding: '4px 12px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                SAVE
              </button>
            </div>
          ) : (
            <div style={{ fontSize: '10px', color: '#00e676', opacity: 0.8, fontStyle: 'italic', paddingLeft: '28px' }}>
              {recording.lyrics}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
