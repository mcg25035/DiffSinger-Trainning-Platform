import React, { useState, memo, useEffect } from 'react';
import type { Recording } from '../hooks/useAudioMonitor';
import type { Dictionary } from '../utils/dictionary';
import { LyricsManager } from './LyricsManager';
import { MappingManager } from './MappingManager';
import { MmsTrainingManager } from './MmsTrainingManager';
import { RecordingList } from './RecordingList';

interface SidebarProps {
  rawRecordings: Recording[];
  uploadSegments: Recording[];
  onSplit: (rec: Recording) => void;
  onLabel: (rec: Recording) => void;
  onRefresh: () => void;
  activeFilename?: string;
}

export const Sidebar = memo(({ rawRecordings, uploadSegments, onSplit, onLabel, onRefresh, activeFilename }: SidebarProps) => {
  const [dictionaries, setDictionaries] = useState<Dictionary[]>([]);
  const [selectedDictId, setSelectedDictId] = useState<string>('');
  const [showLyricsManager, setShowLyricsManager] = useState(false);
  const [showMappingManager, setShowMappingManager] = useState(false);
  const [showMmsTraining, setShowMmsTraining] = useState(false);
  const [selectedAligner, setSelectedAligner] = useState<string>('mfa');

  // Batch recognition state
  const [showBatchDialog, setShowBatchDialog] = useState(false);
  const [selectedFilenames, setSelectedFilenames] = useState<string[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchCurrentFile, setBatchCurrentFile] = useState('');
  const [fullLyricsInput, setFullLyricsInput] = useState('');

  useEffect(() => {
    fetch('/api/dictionaries')
      .then(res => res.json())
      .then(data => {
        setDictionaries(data);
        if (data.length > 0) setSelectedDictId(data[0].id);
      });
  }, []);

  const selectedDict = dictionaries.find(d => d.id === selectedDictId);
  const phonemeSet = new Set(selectedDict?.phonemes.map(p => p.toLowerCase()) || []);

  // Sort segments by filename ascending
  const sortedRecordings = [...uploadSegments].sort((a, b) => 
    a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' })
  );

  const toggleSelectAll = () => {
    if (selectedFilenames.length === sortedRecordings.length) {
      setSelectedFilenames([]);
    } else {
      setSelectedFilenames(sortedRecordings.map(r => r.filename));
    }
  };

  const handleCheckboxClick = (index: number, e: React.MouseEvent<HTMLInputElement>) => {
    const isChecked = e.currentTarget.checked;
    const targetFilename = sortedRecordings[index].filename;
    let newSelected = [...selectedFilenames];

    if (e.shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangeFilenames = sortedRecordings.slice(start, end + 1).map(r => r.filename);

      if (isChecked) {
        newSelected = Array.from(new Set([...newSelected, ...rangeFilenames]));
      } else {
        newSelected = newSelected.filter(name => !rangeFilenames.includes(name));
      }
    } else {
      if (isChecked) {
        if (!newSelected.includes(targetFilename)) {
          newSelected.push(targetFilename);
        }
      } else {
        newSelected = newSelected.filter(name => name !== targetFilename);
      }
    }

    setSelectedFilenames(newSelected);
    setLastSelectedIndex(index);
  };

  const runBatchTranscription = async (useLyrics: boolean) => {
    if (selectedFilenames.length === 0) return;
    if (useLyrics && !fullLyricsInput.trim()) {
      alert("請輸入羅馬拼音歌詞！");
      return;
    }

    setIsBatchProcessing(true);
    setBatchProgress(0);
    setBatchTotal(selectedFilenames.length);
    setBatchCurrentFile('');

    let successCount = 0;
    let failCount = 0;
    
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < selectedFilenames.length; i++) {
      const filename = selectedFilenames[i];
      setBatchCurrentFile(filename);
      setBatchProgress(i);
      
      try {
        const url = useLyrics ? '/api/transcribe_with_lyrics' : '/api/transcribe';
        const body = useLyrics 
          ? { filename, fullLyrics: fullLyricsInput } 
          : { filename };

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (res.ok) {
          const data = await res.json();
          if (data && data.success) {
            successCount++;
          } else {
            console.error(`ASR failure for ${filename}:`, data?.error || 'Unknown error');
            failCount++;
          }
        } else {
          console.error(`HTTP error for ${filename}: status ${res.status}`);
          failCount++;
        }
      } catch (err) {
        console.error(`Network error for ${filename}:`, err);
        failCount++;
      }
      
      // Cooldown delay (e.g. 500ms) to give the ASR backend breathing room
      await sleep(500);
    }

    setBatchProgress(selectedFilenames.length);
    setIsBatchProcessing(false);
    onRefresh();
    setShowBatchDialog(false);
    
    alert(`批次辨識完成！\n成功: ${successCount} 個音訊片段\n失敗: ${failCount} 個音訊片段`);
  };

  return (
    <div style={{ 
      flex: 1, 
      background: '#0f0f0f', 
      borderRadius: '28px', 
      padding: '24px', 
      border: '1px solid #333',
      display: 'flex',
      flexDirection: 'column',
      minWidth: '360px',
      gap: '20px',
      position: 'relative'
    }}>
      {showLyricsManager && (
        <LyricsManager 
          onClose={() => setShowLyricsManager(false)} 
        />
      )}
      
      {showMappingManager && (
        <MappingManager 
          onClose={() => setShowMappingManager(false)} 
        />
      )}

      {showMmsTraining && (
        <MmsTrainingManager 
          onClose={() => setShowMmsTraining(false)} 
          dictionaryId={selectedDictId}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', gap: '12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
            <label style={{ fontSize: '11px', color: '#888', fontWeight: '900', letterSpacing: '1px' }}>VALIDATION LANGUAGE</label>
            <select 
              value={selectedDictId} 
              onChange={e => setSelectedDictId(e.target.value)}
              style={{ background: '#111', border: '1px solid #444', borderRadius: '8px', color: '#fff', padding: '8px', fontSize: '12px', outline: 'none', width: '100%' }}
            >
              {dictionaries.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
            <label style={{ fontSize: '11px', color: '#888', fontWeight: '900', letterSpacing: '1px' }}>ALIGNMENT METHOD</label>
            <select 
              value={selectedAligner} 
              onChange={e => setSelectedAligner(e.target.value)}
              style={{ background: '#111', border: '1px solid #444', borderRadius: '8px', color: '#fff', padding: '8px', fontSize: '12px', outline: 'none', width: '100%' }}
            >
              <option value="mfa">MFA (Montreal)</option>
              <option value="mms">MMS-FA (Meta)</option>
            </select>
          </div>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#666', fontWeight: 'bold', letterSpacing: '0.5px' }}>MANAGEMENT TOOLS</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              onClick={() => setShowMappingManager(true)}
              style={{ background: '#222', border: '1px solid #444', borderRadius: '8px', color: '#2979ff', padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              title="MFA Mapping Manager"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                <line x1="6" y1="6" x2="6.01" y2="6"></line>
                <line x1="6" y1="18" x2="6.01" y2="18"></line>
              </svg>
            </button>
            <button 
              onClick={() => setShowLyricsManager(true)}
              style={{ background: '#222', border: '1px solid #444', borderRadius: '8px', color: '#fff', padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              title="Dictionary Manager"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
              </svg>
            </button>
            <button 
              onClick={() => setShowMmsTraining(true)}
              style={{ background: '#222', border: '1px solid #444', borderRadius: '8px', color: '#00e676', padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              title="MMS-FA Custom Fine-Tuning"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path>
                <path d="M12 6v12"></path>
                <path d="M8 10h8"></path>
                <path d="M8 14h8"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
         <h2 style={{ fontSize: '11px', margin: '0 0 16px 0', color: '#888', fontWeight: '900', letterSpacing: '2px', textTransform: 'uppercase' }}>
           Raw Recordings ({rawRecordings.length})
         </h2>
         <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
           <RecordingList recordings={rawRecordings} onSplit={onSplit} onLabel={onLabel} onRefresh={onRefresh} activeFilename={activeFilename} aligner={selectedAligner} />
         </div>
      </div>
      <div style={{ height: '1px', background: '#333' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
         <h2 style={{ fontSize: '11px', margin: '0 0 16px 0', color: '#00e676', fontWeight: '900', letterSpacing: '2px', textTransform: 'uppercase' }}>
           Upload Segments ({uploadSegments.length})
         </h2>
         <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
           <RecordingList 
             recordings={uploadSegments} 
             onLabel={onLabel} 
             onRefresh={onRefresh} 
             phonemeSet={phonemeSet} 
             dictionaryId={selectedDictId} 
             activeFilename={activeFilename} 
             aligner={selectedAligner}
             onAIContextMenu={(rec) => {
               setSelectedFilenames([rec.filename]);
               setLastSelectedIndex(null);
               setShowBatchDialog(true);
             }}
           />
         </div>
      </div>

      {showBatchDialog && (
        <div 
          onClick={() => {
            if (!isBatchProcessing) setShowBatchDialog(false);
          }}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            backdropFilter: 'blur(4px)'
          }}
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '520px',
              background: '#111',
              border: '1px solid #333',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}
          >
            <div>
              <h3 style={{ margin: 0, fontSize: '20px', fontWeight: '900', color: '#ffa726', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
                </svg>
                AI 批次歌詞辨識
              </h3>
              <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: '#888' }}>
                選擇多個音訊片段進行批次 ASR 歌詞辨識。按住 Shift 鍵可批次選擇範圍。
              </p>
            </div>

            {isBatchProcessing ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '30px 0' }}>
                <div style={{ position: 'relative', width: '80px', height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div className="spinner" style={{ width: '40px', height: '40px', borderWidth: '4px', borderTopColor: '#ffa726' }} />
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '15px', fontWeight: 'bold', color: '#fff', marginBottom: '6px' }}>
                    正在批次辨識中...
                  </div>
                  <div style={{ fontSize: '13px', color: '#ffa726', fontWeight: 'bold' }}>
                    已完成 {batchProgress} / {batchTotal} ({Math.round((batchProgress / batchTotal) * 100)}%)
                  </div>
                  {batchCurrentFile && (
                    <div style={{ fontSize: '11px', color: '#666', marginTop: '8px', fontFamily: 'monospace' }}>
                      處理中: {batchCurrentFile}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
                  <span style={{ color: '#aaa' }}>
                    已選擇 {selectedFilenames.length} / {sortedRecordings.length} 個檔案
                  </span>
                  <button
                    onClick={toggleSelectAll}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#2979ff',
                      cursor: 'pointer',
                      padding: 0,
                      fontWeight: 'bold'
                    }}
                  >
                    {selectedFilenames.length === sortedRecordings.length ? '全部取消' : '全選'}
                  </button>
                </div>

                <div style={{ 
                  maxHeight: '160px', 
                  overflowY: 'auto', 
                  border: '1px solid #222', 
                  borderRadius: '12px', 
                  background: '#050505', 
                  padding: '8px' 
                }}>
                  {sortedRecordings.map((rec, index) => {
                    const isSel = selectedFilenames.includes(rec.filename);
                    return (
                      <div 
                        key={rec.filename} 
                        style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          padding: '6px 10px', 
                          borderBottom: '1px solid #111', 
                          gap: '12px',
                          background: isSel ? 'rgba(255, 167, 38, 0.03)' : 'transparent',
                          transition: 'background 0.2s',
                          borderRadius: '6px'
                        }}
                      >
                        <input 
                          type="checkbox"
                          checked={isSel}
                          onClick={(e) => handleCheckboxClick(index, e)}
                          onChange={() => {}}
                          style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: '#ffa726' }}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: '13px', fontFamily: 'monospace', color: isSel ? '#ffa726' : '#ccc', fontWeight: 'bold' }}>
                            {rec.filename}
                          </span>
                          {rec.lyrics ? (
                            <span style={{ fontSize: '11px', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                              {rec.lyrics}
                            </span>
                          ) : (
                            <span style={{ fontSize: '11px', color: '#444', fontStyle: 'italic', marginTop: '2px' }}>
                              無歌詞記錄
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Full Lyrics Input Section */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', color: '#ffa726', fontWeight: 'bold' }}>
                    輸入整首歌的羅馬拼音歌詞 (供對齊匹配用，選填)
                  </label>
                  <textarea
                    value={fullLyricsInput}
                    onChange={(e) => setFullLyricsInput(e.target.value)}
                    placeholder="貼上整首歌的羅馬拼音歌詞 (例如: ta bu n jo u zu ni na te ta bu n ge de i i ne...)"
                    style={{
                      width: '100%',
                      height: '110px',
                      background: '#000',
                      border: '1px solid #333',
                      borderRadius: '10px',
                      color: '#fff',
                      padding: '10px',
                      fontSize: '12px',
                      lineHeight: '1.5',
                      outline: 'none',
                      resize: 'none',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
                  <button 
                    onClick={() => setShowBatchDialog(false)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#888',
                      padding: '10px 16px',
                      borderRadius: '10px',
                      fontSize: '13px',
                      fontWeight: 'bold',
                      cursor: 'pointer'
                    }}
                  >
                    取消
                  </button>
                  <button 
                    onClick={() => runBatchTranscription(false)}
                    disabled={selectedFilenames.length === 0}
                    style={{
                      background: '#222',
                      border: '1px solid #444',
                      color: selectedFilenames.length === 0 ? '#666' : '#fff',
                      padding: '10px 16px',
                      borderRadius: '10px',
                      fontSize: '13px',
                      fontWeight: 'bold',
                      cursor: selectedFilenames.length === 0 ? 'not-allowed' : 'pointer'
                    }}
                  >
                    跳過 (原始辨識)
                  </button>
                  <button 
                    onClick={() => runBatchTranscription(true)}
                    disabled={selectedFilenames.length === 0}
                    style={{
                      background: selectedFilenames.length === 0 ? '#333' : '#ffa726',
                      border: 'none',
                      color: selectedFilenames.length === 0 ? '#666' : '#000',
                      padding: '10px 20px',
                      borderRadius: '10px',
                      fontSize: '13px',
                      fontWeight: '900',
                      cursor: selectedFilenames.length === 0 ? 'not-allowed' : 'pointer'
                    }}
                  >
                    送出匹配
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
