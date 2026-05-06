import { useAudioMonitor, type Recording } from './hooks/useAudioMonitor';
import { DeviceSelector } from './components/DeviceSelector';
import { RecorderControls } from './components/RecorderControls';
import { VolumeMeter } from './components/VolumeMeter';
import { RecordingList } from './components/RecordingList';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { AudioSplitter } from './components/AudioSplitter';
import { LyricsManager } from './components/LyricsManager';
import { useState, memo, useCallback, useEffect } from 'react';
import type { Dictionary } from './utils/dictionary';
import './index.css';

const Header = memo(({ status }: { status: { text: string, color: string } }) => (
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

const Sidebar = memo(({ rawRecordings, uploadSegments, onSplit, onRefresh }: { 
  rawRecordings: Recording[], 
  uploadSegments: Recording[], 
  onSplit: (rec: Recording) => void,
  onRefresh: () => void
}) => {
  const [dictionaries, setDictionaries] = useState<Dictionary[]>([]);
  const [selectedDictId, setSelectedDictId] = useState<string>('');
  const [showLyricsManager, setShowLyricsManager] = useState(false);

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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
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
        <button 
          onClick={() => setShowLyricsManager(true)}
          style={{ alignSelf: 'end', background: '#222', border: '1px solid #444', borderRadius: '8px', color: '#fff', padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          title="Dictionary Manager"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
         <h2 style={{ fontSize: '11px', margin: '0 0 16px 0', color: '#888', fontWeight: '900', letterSpacing: '2px', textTransform: 'uppercase' }}>
           Raw Recordings ({rawRecordings.length})
         </h2>
         <div style={{ flex: 1, overflowY: 'auto' }}>
           <RecordingList recordings={rawRecordings} onSplit={onSplit} onRefresh={onRefresh} />
         </div>
      </div>
      <div style={{ height: '1px', background: '#333' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
         <h2 style={{ fontSize: '11px', margin: '0 0 16px 0', color: '#00e676', fontWeight: '900', letterSpacing: '2px', textTransform: 'uppercase' }}>
           Upload Segments ({uploadSegments.length})
         </h2>
         <div style={{ flex: 1, overflowY: 'auto' }}>
           <RecordingList recordings={uploadSegments} onRefresh={onRefresh} phonemeSet={phonemeSet} />
         </div>
      </div>
    </div>
  );
});

function App() {
  const {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    analyser,
    status,
    isRecording,
    startRecording,
    stopAndUploadRecording,
    rawRecordings,
    uploadSegments,
    refreshRecordings,
    refreshDevices
  } = useAudioMonitor();

  const [selectedForSplit, setSelectedForSplit] = useState<Recording | null>(null);

  const handleAdopt = useCallback(() => {
    setSelectedForSplit(null);
    refreshRecordings();
  }, [refreshRecordings]);

  const handleSetSplit = useCallback((rec: Recording) => {
    setSelectedForSplit(rec);
  }, []);

  const handleCancelSplit = useCallback(() => {
    setSelectedForSplit(null);
  }, []);

  return (
    <div style={{ 
      width: '100vw', 
      height: '100vh', 
      background: '#0a0a0a', 
      color: '#fff', 
      display: 'flex', 
      flexDirection: 'column',
      padding: '40px',
      boxSizing: 'border-box',
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif'
    }}>
      
      <Header status={status} />

      <div style={{ display: 'flex', flex: 1, gap: '32px', minHeight: 0 }}>
        
        <div style={{ 
          flex: 2, 
          background: '#0f0f0f', 
          borderRadius: '28px', 
          padding: '50px', 
          border: '1px solid #333',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          overflow: 'hidden'
        }}>
          
          <div style={{ display: selectedForSplit ? 'block' : 'none', width: '100%', height: '100%' }}>
            {selectedForSplit && (
              <AudioSplitter 
                recording={selectedForSplit} 
                onAdopt={handleAdopt} 
                onCancel={handleCancelSplit} 
              />
            )}
          </div>

          <div style={{ display: selectedForSplit ? 'none' : 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <RecorderControls 
                isRecording={isRecording}
                onStart={startRecording}
                onStop={stopAndUploadRecording}
                disabled={!selectedDeviceId}
              />
            </div>

            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'auto 1fr', 
              gridTemplateRows: 'auto auto', 
              gap: '16px 24px',
              alignItems: 'end'
            }}>
              <div style={{ gridArea: '1 / 1 / 2 / 2', justifySelf: 'center', paddingBottom: '10px' }}>
                <VolumeMeter analyser={analyser} />
              </div>

              <div style={{ gridArea: '2 / 1 / 3 / 2', justifySelf: 'center', color: '#888' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                  <line x1="12" x2="12" y1="19" y2="22"></line>
                </svg>
              </div>

              <div style={{ gridArea: '1 / 2 / 2 / 3', height: '180px', width: '100%' }}>
                <WaveformVisualizer analyser={analyser} isRecording={isRecording} />
              </div>

              <div style={{ gridArea: '2 / 2 / 3 / 3', width: '400px' }}>
                <DeviceSelector 
                  devices={devices}
                  selectedDeviceId={selectedDeviceId}
                  onSelect={setSelectedDeviceId}
                  onRefresh={refreshDevices}
                  disabled={isRecording}
                />
              </div>
            </div>
          </div>
        </div>

        <Sidebar 
          rawRecordings={rawRecordings} 
          uploadSegments={uploadSegments} 
          onSplit={handleSetSplit} 
          onRefresh={refreshRecordings}
        />

      </div>
    </div>
  );
}

export default App;
