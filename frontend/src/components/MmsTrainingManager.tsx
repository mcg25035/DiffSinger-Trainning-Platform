import { useState, useEffect } from 'react';

interface MmsTrainingManagerProps {
  onClose: () => void;
  dictionaryId: string;
}

interface TrainingHistoryItem {
  epoch: number;
  loss: number;
}

interface TrainingStatus {
  status: 'idle' | 'training' | 'paused' | 'error';
  current_epoch: number;
  total_epochs: number;
  current_loss: number;
  history: TrainingHistoryItem[];
  error_message?: string | null;
}

export function MmsTrainingManager({ onClose, dictionaryId }: MmsTrainingManagerProps) {
  const [epochs, setEpochs] = useState<number>(20);
  const [lr, setLr] = useState<number>(0.001);
  const [statusData, setStatusData] = useState<TrainingStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [fineTunedExists, setFineTunedExists] = useState<boolean>(false);

  // Poll status function
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/mms/status');
      if (res.ok) {
        const data = await res.json();
        setStatusData(data);
      }
    } catch (err) {
      console.error('Failed to fetch MMS status:', err);
    }
  };

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/mms/health');
      if (res.ok) {
        const data = await res.json();
        setFineTunedExists(!!data.fine_tuned_weights_exist);
      }
    } catch (err) {
      console.error('Failed to fetch MMS health:', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchHealth();

    const interval = setInterval(() => {
      fetchStatus();
      fetchHealth();
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  const handleStartTraining = async () => {
    setIsSyncing(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/mms/sync-train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epochs, lr, dictionaryId })
      });

      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(data.message);
        fetchStatus();
      } else {
        setErrorMsg(data.error || 'Failed to start training');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error');
    } finally {
      setIsSyncing(false);
    }
  };

  const isTraining = statusData?.status === 'training' || statusData?.status === 'paused';

  return (
    <div style={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      background: 'rgba(5, 5, 5, 0.95)',
      backdropFilter: 'blur(10px)',
      zIndex: 100,
      borderRadius: '28px',
      padding: '40px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      color: '#fff',
      fontFamily: 'Inter, system-ui, sans-serif'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <span style={{ fontSize: '11px', color: '#00e676', fontWeight: '900', letterSpacing: '2px', textTransform: 'uppercase' }}>
            Acoustic Model Customization
          </span>
          <h2 style={{ margin: '4px 0 0 0', fontSize: '28px', fontWeight: '900', letterSpacing: '-0.8px' }}>
            MMS-FA FINE-TUNING PANEL
          </h2>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '18px',
            transition: 'background 0.2s'
          }}
          title="Close Panel"
        >
          &times;
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: '30px', minHeight: 0 }}>
        {/* Left column: Setup and action */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={{ background: '#121212', border: '1px solid #222', borderRadius: '16px', padding: '20px' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: '700', textTransform: 'uppercase', color: '#888' }}>
              Training Parameters
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: '#ccc', fontWeight: '600' }}>Epochs (Iterations)</label>
                <input
                  type="number"
                  value={epochs}
                  onChange={e => setEpochs(Math.max(1, parseInt(e.target.value) || 0))}
                  disabled={isTraining || isSyncing}
                  style={{
                    background: '#000',
                    border: '1px solid #333',
                    borderRadius: '8px',
                    color: '#fff',
                    padding: '10px',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: '#ccc', fontWeight: '600' }}>Learning Rate</label>
                <input
                  type="number"
                  step="0.0001"
                  value={lr}
                  onChange={e => setLr(parseFloat(e.target.value) || 0)}
                  disabled={isTraining || isSyncing}
                  style={{
                    background: '#000',
                    border: '1px solid #333',
                    borderRadius: '8px',
                    color: '#fff',
                    padding: '10px',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>
            </div>
          </div>

          <div style={{ background: '#121212', border: '1px solid #222', borderRadius: '16px', padding: '20px' }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '700', textTransform: 'uppercase', color: '#888' }}>
              Status Overview
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>Weights Status:</span>
                <span style={{ color: fineTunedExists ? '#00e676' : '#ff4d4d', fontWeight: 'bold' }}>
                  {fineTunedExists ? '✓ Fine-Tuned (Active)' : 'Zero-Shot Only'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>Service Port:</span>
                <span>8002 (MMS-FA API)</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>Fine-tuning Status:</span>
                <span style={{
                  color: statusData?.status === 'training' ? '#2979ff' : statusData?.status === 'paused' ? '#ff9100' : statusData?.status === 'error' ? '#ff4d4d' : '#888',
                  fontWeight: 'bold',
                  textTransform: 'uppercase'
                }}>
                  {statusData?.status || 'connecting...'}
                </span>
              </div>
            </div>
          </div>

          {errorMsg && (
            <div style={{ background: 'rgba(255, 77, 77, 0.1)', border: '1px solid rgba(255, 77, 77, 0.2)', borderRadius: '12px', padding: '12px 16px', color: '#ff4d4d', fontSize: '13px' }}>
              <strong>Error:</strong> {errorMsg}
            </div>
          )}

          {successMsg && (
            <div style={{ background: 'rgba(0, 230, 118, 0.1)', border: '1px solid rgba(0, 230, 118, 0.2)', borderRadius: '12px', padding: '12px 16px', color: '#00e676', fontSize: '13px' }}>
              {successMsg}
            </div>
          )}

          <button
            onClick={handleStartTraining}
            disabled={isTraining || isSyncing}
            style={{
              background: isTraining ? '#222' : 'linear-gradient(135deg, #00e676 0%, #00b0ff 100%)',
              color: isTraining ? '#555' : '#000',
              border: 'none',
              borderRadius: '12px',
              padding: '16px',
              fontWeight: '800',
              fontSize: '15px',
              cursor: isTraining || isSyncing ? 'not-allowed' : 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              boxShadow: isTraining ? 'none' : '0 4px 15px rgba(0, 230, 118, 0.2)',
              transition: 'transform 0.2s, opacity 0.2s'
            }}
          >
            {isSyncing ? 'Syncing segments...' : statusData?.status === 'paused' ? 'Fine-Tuning Paused...' : isTraining ? 'Fine-Tuning in Progress...' : 'Sync & Start Fine-Tuning'}
          </button>
        </div>

        {/* Right column: Progress and logs */}
        <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', background: '#121212', border: '1px solid #222', borderRadius: '20px', padding: '24px', minHeight: 0 }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: '700', textTransform: 'uppercase', color: '#888', display: 'flex', justifyContent: 'space-between' }}>
            <span>Training Log</span>
            {isTraining && statusData && (
              <span style={{ color: statusData.status === 'paused' ? '#ff9100' : '#2979ff' }}>
                {statusData.status === 'paused' ? 'Paused (yielding to align)' : `Epoch ${statusData.current_epoch}/${statusData.total_epochs}`}
              </span>
            )}
          </h3>

          {/* Progress bar */}
          {isTraining && statusData && (
            <div style={{ width: '100%', height: '8px', background: '#000', borderRadius: '4px', overflow: 'hidden', marginBottom: '20px', border: '1px solid #222' }}>
              <div style={{
                height: '100%',
                background: 'linear-gradient(90deg, #2979ff, #00e676)',
                width: `${(statusData.current_epoch / statusData.total_epochs) * 100}%`,
                transition: 'width 0.3s ease'
              }} />
            </div>
          )}

          {/* Training curves / stats */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }}>
            {statusData?.error_message && (
              <div style={{ background: 'rgba(255, 77, 77, 0.05)', border: '1px dashed #ff4d4d', borderRadius: '8px', padding: '12px', color: '#ff4d4d', fontSize: '13px', whiteSpace: 'pre-wrap' }}>
                {statusData.error_message}
              </div>
            )}

            {statusData?.history && statusData.history.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '8px 12px', borderBottom: '1px solid #222', fontSize: '12px', color: '#888', fontWeight: 'bold' }}>
                  <span>Epoch</span>
                  <span>Average CTC Loss</span>
                </div>
                {statusData.history.map((h, i) => (
                  <div 
                    key={i} 
                    style={{ 
                      display: 'grid', 
                      gridTemplateColumns: '1fr 1fr', 
                      padding: '10px 12px', 
                      background: i % 2 === 0 ? '#181818' : '#121212', 
                      borderRadius: '6px', 
                      fontSize: '13px' 
                    }}
                  >
                    <span>#{h.epoch}</span>
                    <span style={{ color: '#00e676', fontFamily: 'monospace', fontWeight: '600' }}>
                      {h.loss.toFixed(6)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: '13px', textAlign: 'center', flexDirection: 'column', gap: '10px' }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
                  <line x1="4" x2="4" y1="22" y2="15"></line>
                </svg>
                <span>No active fine-tuning history.<br />Sync your saved `.lab` segments to customize the acoustic model.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
