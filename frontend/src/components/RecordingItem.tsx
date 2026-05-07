import { useState, useRef, useEffect, memo } from 'react';
import type { Recording } from '../hooks/useAudioMonitor';
import { validateLyrics } from '../utils/dictionary';

interface Props {
  recording: Recording;
  onSplit?: (recording: Recording) => void;
  onLabel?: (recording: Recording) => void;
  onRefresh?: () => void;
  phonemeSet?: Set<string>;
  dictionaryId?: string;
}

export const RecordingItem = memo(({ recording, onSplit, onLabel, onRefresh, phonemeSet, dictionaryId }: Props) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isAligning, setIsAligning] = useState(false);
  const [lyrics, setLyrics] = useState(recording.lyrics || '');
  const [playbackRate, setPlaybackRate] = useState(1);
  const pollIntervalRef = useRef<number | null>(null);

  const startPolling = (jobId: string) => {
    setIsAligning(true);
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    
    pollIntervalRef.current = window.setInterval(async () => {
        try {
            const statusRes = await fetch(`/api/jobs/${jobId}`);
            if (!statusRes.ok) {
                clearInterval(pollIntervalRef.current!);
                setIsAligning(false);
                return;
            }
            const job = await statusRes.json();
            
            if (job.status === 'completed') {
                clearInterval(pollIntervalRef.current!);
                setIsAligning(false);
                if (onRefresh) onRefresh();
            } else if (job.status === 'error') {
                clearInterval(pollIntervalRef.current!);
                setIsAligning(false);
                alert(`對齊失敗: ${job.error}`);
            }
        } catch (err) {
            console.error("Polling error:", err);
        }
    }, 2000);
  };

  useEffect(() => {
    if (recording.activeJobId && !isAligning) {
        startPolling(recording.activeJobId);
    }
  }, [recording.activeJobId]);
  
  // Sync state when prop updates (critical for AI transcription results)
  useEffect(() => {
    setLyrics(recording.lyrics || '');
  }, [recording.lyrics]);

  const audioObjRef = useRef<HTMLAudioElement | null>(null);
  const progressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (audioObjRef.current) {
      audioObjRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

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
    return () => {
        cleanup();
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (!audioObjRef.current) {
        const audio = new Audio(recording.url);
        audio.onplay = () => setIsPlaying(true);
        audio.onpause = () => setIsPlaying(false);
        audio.onended = () => cleanup();
        audio.playbackRate = playbackRate;
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

  const handleTranscribe = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsTranscribing(true);
    try {
        const res = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: recording.filename })
        });
        if (res.ok) {
            if (onRefresh) onRefresh();
        } else {
            alert("辨識失敗");
        }
    } catch (err) {
        console.error(err);
        alert("辨識錯誤");
    } finally {
        setIsTranscribing(false);
    }
  };

  const handleAlign = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!dictionaryId) return alert("Please select a language first");
    
    if (recording.hasAlignment) {
      if (!confirm("This segment already has alignment data (.lab). Re-running will overwrite it. Continue?")) {
        return;
      }
    }

    // Step 1: Pre-validation
    try {
        const valRes = await fetch('/api/validate_lyrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lyrics, model: 'japanese_mfa' }) // 暫時寫死，或根據 dictionaryId 映射
        });
        const valData = await valRes.json();
        if (!valData.valid) {
            alert(`對齊檢查失敗: ${valData.message}\n請先在 MAPPING MANAGER 中補齊或修正歌詞。`);
            return;
        }
    } catch (err) {
        console.warn("Validation check failed, skipping to align:", err);
    }
    
    setIsAligning(true);
    try {
        const res = await fetch('/api/align', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: recording.filename, dictionaryId })
        });
        
        if (res.ok) {
            const { jobId } = await res.json();
            startPolling(jobId);
        } else {
            const txt = await res.text();
            alert(`請求失敗: ${txt}`);
            setIsAligning(false);
        }
    } catch (err) {
        console.error(err);
        alert("對齊錯誤");
        setIsAligning(false);
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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
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
          
          <div style={{ display: 'flex', gap: '2px' }}>
            {[0.5, 0.75, 1].map(rate => (
              <button
                key={rate}
                onClick={(e) => { e.stopPropagation(); setPlaybackRate(rate); }}
                style={{
                  background: playbackRate === rate ? '#333' : 'transparent',
                  border: 'none',
                  borderRadius: '3px',
                  color: playbackRate === rate ? '#fff' : '#666',
                  fontSize: '7px',
                  padding: '1px 3px',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  letterSpacing: '-0.2px'
                }}
              >
                {rate === 1 ? '1x' : rate}
              </button>
            ))}
          </div>
        </div>
        
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
              <>
                <button
                  onClick={handleTranscribe}
                  disabled={isTranscribing}
                  style={{ 
                      background: '#222', 
                      border: '1px solid #444', 
                      borderRadius: '12px',
                      padding: '2px 8px', 
                      color: isTranscribing ? '#aaa' : '#ffa726', 
                      cursor: isTranscribing ? 'wait' : 'pointer', 
                      opacity: 1, 
                      display: 'flex', 
                      alignItems: 'center',
                      fontWeight: '900',
                      fontSize: '10px',
                      transition: 'all 0.2s'
                  }}
                  title="AI Transcribe Lyrics"
                >
                  {isTranscribing ? "..." : "AI"}
                </button>

                <button
                  onClick={handleAlign}
                  disabled={isAligning}
                  style={{ 
                      background: recording.hasAlignment ? '#2979ff' : '#9c27b0', 
                      border: 'none', 
                      borderRadius: '12px',
                      padding: '2px 10px', 
                      color: '#fff', 
                      cursor: isAligning ? 'wait' : 'pointer', 
                      opacity: 1, 
                      display: 'flex', 
                      alignItems: 'center',
                      fontWeight: '900',
                      fontSize: '10px',
                      minWidth: '36px',
                      height: '18px',
                      justifyContent: 'center',
                      transition: 'all 0.2s',
                      gap: '4px'
                  }}
                  title="MFA Forced Alignment"
                >
                  {isAligning ? <div className="spinner" /> : "MFA"}
                </button>

                <button
                  onClick={(e) => { e.stopPropagation(); setIsEditing(!isEditing); }}
                  style={{ 
                      background: 'none', 
                      border: 'none', 
                      padding: 0, 
                      color: recording.isPending ? '#ffca28' : (lyrics ? '#00e676' : '#666'), 
                      cursor: 'pointer', 
                      opacity: 0.8, 
                      display: 'flex', 
                      alignItems: 'center' 
                  }}
                  title={recording.isPending ? "AI Generated (Pending Confirmation)" : "Edit Lyrics"}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                </button>
              </>
            )}

            <a 
              href={recording.url} 
              download={recording.filename}
              style={{ color: '#2979ff', opacity: 0.6, display: 'flex', alignItems: 'center' }}
              title="Download Audio (.wav)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </a>

            {recording.hasAlignment && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onLabel?.(recording); }}
                  style={{ color: '#00e5ff', background: 'none', border: 'none', padding: 0, cursor: 'pointer', opacity: 0.8, display: 'flex', alignItems: 'center' }}
                  title="Visual Labeler (Edit .lab)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                    <line x1="12" y1="22.08" x2="12" y2="12"></line>
                  </svg>
                </button>
                <a 
                  href={recording.url.replace(/\.wav$/, '.lab')} 
                  download={recording.filename.replace(/\.wav$/, '.lab')}
                  style={{ color: '#00e5ff', opacity: 0.8, display: 'flex', alignItems: 'center' }}
                  title="Download MFA Alignment (.lab)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                  </svg>
                </a>
              </>
            )}

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
                  border: `1px solid ${recording.isPending ? '#ffca28' : '#333'}`, 
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
                style={{ background: '#fff', border: 'none', borderRadius: '6px', color: '#000', padding: '4px 12px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                SAVE
              </button>
            </div>
          ) : (
            <div style={{ 
                fontSize: '10px', 
                color: recording.isPending ? '#ffca28' : '#00e676', 
                opacity: 0.8, 
                fontStyle: 'italic', 
                paddingLeft: '28px' 
            }}>
              {recording.isPending && "⚠️ [AI] "}
              {recording.lyrics}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
