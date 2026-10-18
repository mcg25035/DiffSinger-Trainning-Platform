import { useAudioMonitor, type Recording } from './hooks/useAudioMonitor';
import { DeviceSelector } from './components/DeviceSelector';
import { RecorderControls } from './components/RecorderControls';
import { VolumeMeter } from './components/VolumeMeter';
import { WaveformVisualizer } from './components/WaveformVisualizer';
import { AudioSplitter } from './components/AudioSplitter';
import { LabelEditor } from './components/LabelEditor';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { TrainingManager } from './components/TrainingManager';
import { InferenceStudio } from './components/InferenceStudio';
import { SongSession } from './components/SongSession';
import { AlignmentReview } from './components/AlignmentReview';
import { useState, useCallback } from 'react';
import './index.css';

type Page = 'record' | 'sing' | 'align' | 'train' | 'inference';

const PAGE_TITLES: Record<Page, string> = {
  record: '錄音',
  sing: '唱歌錄音',
  align: '對齊處理',
  train: '訓練管理',
  inference: '推理 (開發中)',
};

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
    uploadFile,
    rawRecordings,
    uploadSegments,
    refreshRecordings,
    refreshDevices,
    stopAndCaptureRecording,
    cancelCapture
  } = useAudioMonitor();

  const [page, setPage] = useState<Page>('record');
  const [selectedForSplit, setSelectedForSplit] = useState<Recording | null>(null);
  const [selectedForLabeling, setSelectedForLabeling] = useState<Recording | null>(null);
  const [isLabelFullscreen, setIsLabelFullscreen] = useState(false);
  // 對齊設定(錄音側欄與唱歌錄音共用;建立 session 時存進 session,take 對齊用)
  const [selectedDictId, setSelectedDictId] = useState('');
  const [selectedAligner, setSelectedAligner] = useState('mfa');

  const handleAdopt = useCallback(() => {
    setSelectedForSplit(null);
    refreshRecordings();
  }, [refreshRecordings]);

  const handleSetSplit = useCallback((rec: Recording) => {
    setSelectedForSplit(rec);
    setSelectedForLabeling(null);
  }, []);

  const handleSetLabeling = useCallback((rec: Recording) => {
    setSelectedForLabeling(rec);
    setSelectedForSplit(null);
  }, []);

  const handleCancelSplit = useCallback(() => {
    setSelectedForSplit(null);
  }, []);

  const handleCancelLabeling = useCallback(() => {
    setSelectedForLabeling(null);
    setIsLabelFullscreen(false);
    refreshRecordings(); // Refresh when closing to ensure updated state
  }, [refreshRecordings]);

  // ── Next / Previous navigation for LabelEditor fullscreen ──
  const allLabelableRecordings = [...rawRecordings, ...uploadSegments];
  const currentLabelIndex = selectedForLabeling
    ? allLabelableRecordings.findIndex((r) => r.filename === selectedForLabeling.filename)
    : -1;

  const handleNextRecording = useCallback(() => {
    const all = [...rawRecordings, ...uploadSegments];
    const idx = selectedForLabeling
      ? all.findIndex((r) => r.filename === selectedForLabeling.filename)
      : -1;
    if (idx !== -1 && idx < all.length - 1) {
      setSelectedForLabeling(all[idx + 1]);
    }
  }, [rawRecordings, uploadSegments, selectedForLabeling]);

  const handlePrevRecording = useCallback(() => {
    const all = [...rawRecordings, ...uploadSegments];
    const idx = selectedForLabeling
      ? all.findIndex((r) => r.filename === selectedForLabeling.filename)
      : -1;
    if (idx > 0) {
      setSelectedForLabeling(all[idx - 1]);
    }
  }, [rawRecordings, uploadSegments, selectedForLabeling]);

  const hasNext = currentLabelIndex !== -1 && currentLabelIndex < allLabelableRecordings.length - 1;
  const hasPrev = currentLabelIndex > 0;

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

      <div style={{ display: 'flex', gap: '8px', margin: '16px 0' }}>
        {(Object.keys(PAGE_TITLES) as Page[]).map((p) => (
          <button
            key={p}
            onClick={() => setPage(p)}
            style={{
              background: page === p ? '#2563eb' : '#1a1a1a',
              color: page === p ? '#fff' : '#888',
              border: '1px solid #333',
              borderRadius: '10px',
              padding: '8px 20px',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            {PAGE_TITLES[p]}
          </button>
        ))}
      </div>

      {page === 'sing' && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <SongSession
            isRecording={isRecording}
            canRecord={!!selectedDeviceId}
            startRecording={startRecording}
            stopAndCapture={stopAndCaptureRecording}
            cancelCapture={cancelCapture}
            dictionaryId={selectedDictId}
            aligner={selectedAligner}
          />
        </div>
      )}
      {page === 'align' && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <AlignmentReview />
        </div>
      )}
      {page === 'train' && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <TrainingManager recordings={uploadSegments.filter((r) => r.isChecked)} />
        </div>
      )}
      {page === 'inference' && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <InferenceStudio />
        </div>
      )}

      <div style={{ display: page === 'record' ? 'flex' : 'none', flex: 1, gap: '32px', minHeight: 0 }}>
        
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

          <div style={{ display: selectedForLabeling ? 'block' : 'none', width: '100%', height: '100%' }}>
            {selectedForLabeling && (
              <LabelEditor 
                key={selectedForLabeling.filename}
                recording={selectedForLabeling} 
                onCancel={handleCancelLabeling}
                onNext={hasNext ? handleNextRecording : undefined}
                onPrevious={hasPrev ? handlePrevRecording : undefined}
                isFullscreen={isLabelFullscreen}
                onFullscreenChange={setIsLabelFullscreen}
              />
            )}
          </div>

          <div style={{ display: (selectedForSplit || selectedForLabeling) ? 'none' : 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <RecorderControls 
                isRecording={isRecording}
                onStart={startRecording}
                onStop={stopAndUploadRecording}
                onUploadFile={uploadFile}
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
          onLabel={handleSetLabeling}
          onRefresh={refreshRecordings}
          activeFilename={selectedForLabeling?.filename || selectedForSplit?.filename}
          selectedDictId={selectedDictId}
          onDictChange={setSelectedDictId}
          selectedAligner={selectedAligner}
          onAlignerChange={setSelectedAligner}
        />

      </div>
    </div>
  );
}

export default App;
