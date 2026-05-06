import type { Device } from '../hooks/useAudioMonitor';

interface Props {
  devices: Device[];
  selectedDeviceId: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  disabled: boolean;
}

export function DeviceSelector({ devices, selectedDeviceId, onSelect, onRefresh, disabled }: Props) {
  return (
    <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
      <select 
        value={selectedDeviceId}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled}
        style={{ 
          flex: 1, 
          padding: '8px 12px', 
          borderRadius: '6px', 
          border: '1px solid #333', 
          background: '#1a1a1a', 
          color: '#ddd', 
          fontSize: '14px',
          outline: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer'
        }}
      >
        {devices.length === 0 ? (
          <option value="">載入中...</option>
        ) : (
          devices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))
        )}
      </select>
      <button 
        onClick={onRefresh} 
        style={{ 
          background: 'none', 
          border: 'none', 
          color: '#666', 
          cursor: 'pointer',
          padding: '0 4px'
        }}
        title="重新整理"
      >
        ↻
      </button>
    </div>
  );
}
