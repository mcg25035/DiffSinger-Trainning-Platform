import { useState, useEffect } from 'react';
import type { Dictionary } from '../utils/dictionary';

interface Mapping {
  id: string;
  description: string;
  model: string; // Added model field
  dictionary: Record<string, string>;
  reverse_mapping: Record<string, string>;
}

interface Props {
  onClose: () => void;
}

export function MappingManager({ onClose }: Props) {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [dictionaries, setDictionaries] = useState<Dictionary[]>([]);
  const [selectedDictId, setSelectedDictId] = useState<string>('');
  const [editingMapping, setEditingMapping] = useState<Mapping | null>(null);
  
  // MFA Model State
  const [models, setModels] = useState<{ local: string[], remote: string[] }>({ local: [], remote: [] });
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [validPhones, setValidPhones] = useState<string[]>([]);
  const [isLoadingPhones, setIsLoadingPhones] = useState(false);

  // Form state
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [dictText, setDictText] = useState('');
  const [revText, setRevText] = useState('');

  const fetchData = async () => {
    const [mRes, dRes, modelRes] = await Promise.all([
      fetch('/api/mappings'),
      fetch('/api/dictionaries'),
      fetch('/api/mfa/models')
    ]);
    const mData = await mRes.json();
    const dData = await dRes.json();
    const modelData = await modelRes.json();
    
    setMappings(mData);
    setDictionaries(dData);
    setModels(modelData);

    if (dData.length > 0 && !selectedDictId) setSelectedDictId(dData[0].id);
    if (modelData.local.length > 0 && !selectedModel) {
      setSelectedModel(modelData.local[0]);
    } else if (modelData.remote.length > 0 && !selectedModel) {
      setSelectedModel(modelData.remote[0]);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (selectedModel) {
      setIsLoadingPhones(true);
      fetch(`/api/mfa/phones/${selectedModel}`)
        .then(res => res.json())
        .then(data => {
          setValidPhones(data.phones || []);
          setIsLoadingPhones(false);
        })
        .catch(() => setIsLoadingPhones(false));
    }
  }, [selectedModel]);

  const handleSave = async () => {
    try {
      const dictionaryObj = JSON.parse(dictText);
      const reverseMappingObj = JSON.parse(revText);
      
      // 1. 檢查是否存在對應的 Dictionary
      const targetDict = dictionaries.find(d => d.id === selectedDictId);
      if (!targetDict) return alert("Please select a base Dictionary first.");

      // 2. 交叉檢查：Mapping 的 Key 必須存在於 Dictionary 中 (嚴格匹配)
      const dictPhonemesSet = new Set(targetDict.phonemes);
      const mappingKeys = Object.keys(dictionaryObj);
      const invalidKeys = mappingKeys.filter(k => !dictPhonemesSet.has(k));
      if (invalidKeys.length > 0) {
        return alert(`Validation Error: The following keys are not in the selected Dictionary [${selectedDictId}]:\n${invalidKeys.join(', ')}`);
      }

      // 4. 交叉檢查：Dictionary 中定義的所有音節，在 Mapping 中都必須有定義 (完整性檢查)
      const missingKeys = targetDict.phonemes.filter(p => !dictionaryObj.hasOwnProperty(p));
      if (missingKeys.length > 0) {
        return alert(`Validation Error: The following phonemes from [${selectedDictId}] are missing a Mapping definition:\n${missingKeys.join(', ')}`);
      }

      // 3. 交叉檢查：Dictionary Mapping 產生的 IPA 必須存在於 Reverse Mapping 中
      const usedIPAs = new Set<string>();
      Object.values(dictionaryObj).forEach((ipaStr: any) => {
        String(ipaStr).split(' ').forEach(p => usedIPAs.add(p));
      });
      const revMappingKeys = new Set(Object.keys(reverseMappingObj));
      const missingIPAs = Array.from(usedIPAs).filter(p => !revMappingKeys.has(p));
      
      if (missingIPAs.length > 0) {
        return alert(`Validation Error: The following IPA phonemes are missing from Reverse Mapping:\n${missingIPAs.join(', ')}`);
      }

      // 5. MFA Phoneme Set Validation
      const phoneWhiteList = new Set(validPhones);
      // 特殊處理：MFA 通常允許一些預定義的符號如 sil, sp
      const commonMFA = new Set(['sil', 'sp', 'pau', '']);
      const invalidMFAIPAs = Array.from(usedIPAs).filter(p => !phoneWhiteList.has(p) && !commonMFA.has(p));

      if (invalidMFAIPAs.length > 0) {
        return alert(`MFA Validation Error: The following phonemes are NOT recognized by model [${selectedModel}]:\n${invalidMFAIPAs.join(', ')}\n\nPlease use valid IPA symbols from the phone set.`);
      }

      const res = await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          id, 
          description, 
          model: selectedModel,
          dictionary: dictionaryObj, 
          reverse_mapping: reverseMappingObj 
        })
      });

      if (res.ok) {
        fetchData();
        resetForm();
      }
    } catch (e) {
      alert("Invalid JSON format in Dictionary or Reverse Mapping");
    }
  };

  const resetForm = () => {
    setId('');
    setDescription('');
    setDictText('');
    setRevText('');
    setEditingMapping(null);
  };

  const startEdit = (m: Mapping) => {
    setEditingMapping(m);
    setId(m.id);
    setDescription(m.description);
    setDictText(JSON.stringify(m.dictionary, null, 2));
    setRevText(JSON.stringify(m.reverse_mapping, null, 2));
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete mapping "${id}"?`)) return;
    await fetch(`/api/mappings/${id}`, { method: 'DELETE' });
    fetchData();
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: '#0a0a0a',
      zIndex: 2100,
      display: 'flex',
      flexDirection: 'column',
      padding: '60px',
      overflowY: 'auto'
    }}>
      <div style={{ maxWidth: '1200px', width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '32px', fontWeight: '900', letterSpacing: '-1px' }}>MFA MAPPING MANAGER</h2>
            <p style={{ margin: '8px 0 0 0', color: '#666', fontSize: '14px' }}>Configure how Romaji/Lyrics map to MFA phonemes (IPA).</p>
          </div>
          <button onClick={onClose} style={{ background: '#222', border: '1px solid #444', borderRadius: '12px', color: '#fff', padding: '12px 30px', fontWeight: 'bold', cursor: 'pointer' }}>
            CLOSE
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px' }}>
          {/* Form */}
          <div style={{ padding: '32px', background: '#111', borderRadius: '24px', border: '1px solid #333' }}>
            <h3 style={{ margin: '0 0 24px 0', fontSize: '18px', color: '#2979ff' }}>{editingMapping ? 'Edit Mapping' : 'Create New Mapping'}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>BASE DICTIONARY</label>
                  <select 
                    value={selectedDictId} 
                    onChange={e => setSelectedDictId(e.target.value)}
                    style={{ background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '12px', fontSize: '14px' }}
                  >
                    {dictionaries.map(d => (
                      <option key={d.id} value={d.id}>{d.name} ({d.id})</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>TARGET MFA MODEL</label>
                  <select 
                    value={selectedModel} 
                    onChange={e => setSelectedModel(e.target.value)}
                    style={{ background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '12px', fontSize: '14px' }}
                  >
                    <optgroup label="Local (Downloaded)">
                      {models.local.map(m => <option key={m} value={m}>{m}</option>)}
                    </optgroup>
                    <optgroup label="Remote (Download on save)">
                      {models.remote.map(m => <option key={m} value={m}>{m} (remote)</option>)}
                    </optgroup>
                  </select>
                </div>
              </div>

              {selectedModel && (
                <div style={{ padding: '12px', background: '#000', borderRadius: '10px', border: '1px solid #222' }}>
                  <label style={{ fontSize: '10px', color: '#555', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                    VALID PHONE SET FOR {selectedModel.toUpperCase()} {isLoadingPhones && '(Loading...)'}
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '80px', overflowY: 'auto', fontSize: '12px' }}>
                    {validPhones.map(p => (
                      <span key={p} style={{ background: '#1a1a1a', padding: '2px 6px', borderRadius: '4px', color: '#888' }}>{p}</span>
                    ))}
                    {validPhones.length === 0 && !isLoadingPhones && <span style={{ color: '#444' }}>No phones found or failed to load.</span>}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>MAPPING ID (Filename)</label>
                <input value={id} onChange={e => setId(e.target.value)} disabled={!!editingMapping} placeholder="e.g. japanese_mfa" style={{ background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '12px' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>DESCRIPTION</label>
                <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description of this mapping" style={{ background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '12px' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>DICTIONARY (JSON Object: Romaji to Phonemes)</label>
                <textarea value={dictText} onChange={e => setDictText(e.target.value)} style={{ height: '200px', background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '12px', fontFamily: 'monospace' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: '#888', fontWeight: 'bold' }}>REVERSE MAPPING (JSON Object: IPA to Friendly Name)</label>
                <textarea value={revText} onChange={e => setRevText(e.target.value)} style={{ height: '150px', background: '#000', border: '1px solid #333', borderRadius: '10px', color: '#fff', padding: '12px', fontFamily: 'monospace' }} />
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button onClick={handleSave} style={{ flex: 1, background: '#2979ff', color: '#fff', border: 'none', borderRadius: '12px', padding: '14px', fontWeight: '900' }}>
                  {editingMapping ? 'UPDATE MAPPING' : 'SAVE MAPPING'}
                </button>
                {editingMapping && <button onClick={resetForm} style={{ background: '#222', color: '#fff', border: '1px solid #444', borderRadius: '12px', padding: '14px' }}>CANCEL</button>}
              </div>
            </div>
          </div>

          {/* List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>Active Mappings</h3>
            {mappings.map(m => (
              <div key={m.id} style={{ padding: '20px', background: '#111', borderRadius: '20px', border: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ fontWeight: 'bold' }}>{m.id}</div>
                    <div style={{ fontSize: '10px', background: '#222', color: '#2979ff', padding: '2px 8px', borderRadius: '4px', fontWeight: 'bold', border: '1px solid #333' }}>{m.model || 'unknown model'}</div>
                  </div>
                  <div style={{ fontSize: '12px', color: '#666' }}>{m.description}</div>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={() => startEdit(m)} style={{ background: '#222', border: '1px solid #444', color: '#fff', padding: '6px 12px', borderRadius: '8px', fontSize: '12px' }}>EDIT</button>
                  <button onClick={() => handleDelete(m.id)} style={{ background: 'rgba(255,77,77,0.1)', color: '#ff4d4d', border: 'none', padding: '6px 12px', borderRadius: '8px', fontSize: '12px' }}>DELETE</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
