import { useState, useEffect } from 'react';
import type { Dictionary } from '../utils/dictionary';

interface Props {
  onClose: () => void;
}

export function LyricsManager({ onClose }: Props) {
  const [dictionaries, setDictionaries] = useState<Dictionary[]>([]);
  
  // Dictionary Management State
  const [newDictName, setNewDictName] = useState('');
  const [newDictId, setNewDictId] = useState('');
  const [newDictPhonemes, setNewDictPhonemes] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  const fetchDicts = async () => {
    const res = await fetch('/api/dictionaries');
    const data = await res.json();
    setDictionaries(data);
  };

  useEffect(() => {
    fetchDicts();
  }, []);

  const handleSaveDict = async () => {
    if (!newDictId || !newDictName) return alert("ID and Name required");
    // Handle both space and newline as separators
    const phonemes = newDictPhonemes.split(/[\s,]+/).filter(p => p.length > 0);
    const res = await fetch('/api/dictionaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: newDictId, name: newDictName, phonemes })
    });
    if (res.ok) {
      fetchDicts();
      resetForm();
    }
  };

  const resetForm = () => {
    setNewDictId('');
    setNewDictName('');
    setNewDictPhonemes('');
    setIsEditing(false);
  };

  const handleDeleteDict = async (id: string) => {
    if (!confirm(`Delete dictionary "${id}"? This cannot be undone.`)) return;
    await fetch(`/api/dictionaries/${id}`, { method: 'DELETE' });
    fetchDicts();
  };

  const startEdit = (d: Dictionary) => {
    setNewDictId(d.id);
    setNewDictName(d.name);
    setNewDictPhonemes(d.phonemes.join(' '));
    setIsEditing(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: '#0a0a0a',
      zIndex: 2000,
      display: 'flex',
      flexDirection: 'column',
      padding: '60px',
      overflowY: 'auto'
    }}>
      <div style={{ maxWidth: '1200px', width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '32px', fontWeight: '900', letterSpacing: '-1px' }}>DICTIONARY MANAGER</h2>
            <p style={{ margin: '8px 0 0 0', color: '#666', fontSize: '14px' }}>Configure phoneme sets for lyric validation across different languages.</p>
          </div>
          <button 
            onClick={onClose} 
            style={{ 
              background: '#222', 
              border: '1px solid #444', 
              borderRadius: '12px', 
              color: '#fff', 
              padding: '12px 30px', 
              fontWeight: 'bold', 
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            CLOSE
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px', alignItems: 'start' }}>
          
          {/* Left Side: Form */}
          <div style={{ padding: '32px', background: '#111', borderRadius: '24px', border: '1px solid #333', position: 'sticky', top: '20px' }}>
            <h3 style={{ margin: '0 0 24px 0', fontSize: '18px', color: '#00e676' }}>{isEditing ? 'Edit Dictionary' : 'Create New Dictionary'}</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>UNIQUE ID</label>
                  <input 
                    placeholder="e.g. zh-pinyin"
                    value={newDictId} 
                    onChange={e => setNewDictId(e.target.value)} 
                    disabled={isEditing}
                    style={{ background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '12px', fontSize: '14px', outline: 'none' }} 
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>DISPLAY NAME</label>
                  <input 
                    placeholder="e.g. Chinese Pinyin"
                    value={newDictName} 
                    onChange={e => setNewDictName(e.target.value)} 
                    style={{ background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '12px', fontSize: '14px', outline: 'none' }} 
                  />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>VALID PHONEMES (Space separated)</label>
                <textarea 
                  placeholder="Enter all valid phonemes or symbols allowed in this language..."
                  value={newDictPhonemes} 
                  onChange={e => setNewDictPhonemes(e.target.value)} 
                  style={{ height: '300px', background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '16px', fontSize: '14px', lineHeight: '1.6', outline: 'none', resize: 'none' }} 
                />
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <button 
                  onClick={handleSaveDict} 
                  style={{ flex: 1, background: '#fff', color: '#000', border: 'none', borderRadius: '12px', padding: '14px', fontWeight: '900', fontSize: '14px', cursor: 'pointer' }}
                >
                  {isEditing ? 'UPDATE DICTIONARY' : 'CREATE DICTIONARY'}
                </button>
                {isEditing && (
                  <button 
                    onClick={resetForm} 
                    style={{ background: '#222', color: '#fff', border: '1px solid #444', borderRadius: '12px', padding: '14px', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' }}
                  >
                    CANCEL
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Right Side: List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>Existing Dictionaries ({dictionaries.length})</h3>
            {dictionaries.map(d => (
              <div key={d.id} style={{ padding: '24px', background: '#111', borderRadius: '20px', border: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'all 0.2s' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '4px' }}>{d.name}</div>
                  <div style={{ fontSize: '12px', color: '#666', fontFamily: 'monospace' }}>ID: {d.id} • {d.phonemes.length} phonemes</div>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button 
                    onClick={() => startEdit(d)}
                    style={{ background: '#222', border: '1px solid #444', color: '#fff', padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                  >
                    EDIT
                  </button>
                  <button 
                    onClick={() => handleDeleteDict(d.id)}
                    style={{ background: 'rgba(255,77,77,0.1)', border: '1px solid rgba(255,77,77,0.2)', color: '#ff4d4d', padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                  >
                    DELETE
                  </button>
                </div>
              </div>
            ))}
            
            {dictionaries.length === 0 && (
              <div style={{ padding: '60px', textAlign: 'center', background: '#111', borderRadius: '24px', border: '1px dashed #333', color: '#555' }}>
                No dictionaries found. Create one on the left.
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
