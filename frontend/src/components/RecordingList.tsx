import { RecordingItem } from './RecordingItem';
import type { Recording } from '../hooks/useAudioMonitor';

interface Props {
  recordings: Recording[];
  onSplit?: (recording: Recording) => void;
  onLabel?: (recording: Recording) => void;
  onRefresh?: () => void;
  phonemeSet?: Set<string>;
  dictionaryId?: string;
}

export function RecordingList({ recordings, onSplit, onLabel, onRefresh, phonemeSet, dictionaryId }: Props) {
  if (recordings.length === 0) {
    return (
      <div style={{ padding: '30px', textAlign: 'center', background: '#121212', borderRadius: '12px', border: '1px dashed #222' }}>
        <p style={{ color: '#555', margin: 0, fontSize: '12px' }}>No history</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {recordings.map((rec, idx) => (
        <RecordingItem 
            key={`${rec.filename}-${idx}`} 
            recording={rec} 
            onSplit={onSplit} 
            onLabel={onLabel}
            onRefresh={onRefresh} 
            phonemeSet={phonemeSet} 
            dictionaryId={dictionaryId}
        />
      ))}
    </div>
  );
}
