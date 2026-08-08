import React, { useState, useEffect } from 'react';

export interface BoundaryInfo {
  phonemeBefore?: string;
  phonemeAfter?: string;
  oldTime?: number;
  newTime?: number;
  diffMs?: number;
}

interface ReasonModalProps {
  isOpen: boolean;
  filename: string;
  boundaryInfo?: BoundaryInfo | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

const PRESET_REASONS = [
  '前子音開頭對齊微調',
  '元音開頭時間偏移修正',
  '靜音 (pau/SP) 區間微調',
  'MMS 時序延遲修正',
  '音素切分點精準度修正',
];

export const ReasonModal: React.FC<ReasonModalProps> = ({
  isOpen,
  filename,
  boundaryInfo,
  onConfirm,
  onCancel,
}) => {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (isOpen) {
      setReason('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(reason.trim() || '邊界對齊微調');
  };

  const handlePresetClick = (preset: string) => {
    setReason((prev) => (prev ? `${prev} / ${preset}` : preset));
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        backgroundColor: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(8px)',
        zIndex: 200000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '480px',
          backgroundColor: '#18181b',
          border: '1px solid #3f3f46',
          borderRadius: '16px',
          padding: '24px',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
          color: '#f4f4f5',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <span style={{ fontSize: '24px' }}>🧪</span>
          <div>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: '#38bdf8' }}>
              {boundaryInfo ? '記錄個案邊界調整原因' : '開發算法對齊標記 - 另存新 Lab'}
            </h3>
            <p style={{ margin: 0, fontSize: '12px', color: '#a1a1aa' }}>
              檔案：{filename}（不覆蓋原始 MMS Lab）
            </p>
          </div>
        </div>

        {boundaryInfo && (
          <div
            style={{
              backgroundColor: 'rgba(56, 189, 248, 0.08)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              borderRadius: '8px',
              padding: '10px 14px',
              marginBottom: '14px',
              fontSize: '13px',
              color: '#e0f2fe',
            }}
          >
            <div style={{ fontWeight: 600, color: '#38bdf8', marginBottom: '4px' }}>
              🎯 邊界對齊變更 [ {boundaryInfo.phonemeBefore || '^'} | {boundaryInfo.phonemeAfter || '$'} ]
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#94a3b8' }}>
              <span>時間：{boundaryInfo.oldTime?.toFixed(3)}s ➔ {boundaryInfo.newTime?.toFixed(3)}s</span>
              <span style={{ color: (boundaryInfo.diffMs || 0) >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>
                {(boundaryInfo.diffMs || 0) >= 0 ? '+' : ''}{boundaryInfo.diffMs} ms
              </span>
            </div>
          </div>
        )}

        <p style={{ fontSize: '13px', color: '#d4d4d8', marginBottom: '16px', lineHeight: '1.5' }}>
          {boundaryInfo
            ? '您剛剛調整了上述邊界，請說明調整原因以存入該邊界個別記錄：'
            : '請輸入修改原因，系統將會另存為獨立的新 .lab 檔案：'}
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '12px', color: '#a1a1aa', marginBottom: '6px' }}>
              邊界調整原因 (Reason for boundary shift):
            </label>
            <input
              type="text"
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：前子音時間對齊微調、音素邊界微調..."
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: '8px',
                border: '1px solid #52525b',
                backgroundColor: '#27272a',
                color: '#fff',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: '#71717a', marginBottom: '6px' }}>
              快速選取常用原因：
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {PRESET_REASONS.map((preset) => (
                <button
                  type="button"
                  key={preset}
                  onClick={() => handlePresetClick(preset)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '6px',
                    border: '1px solid #3f3f46',
                    backgroundColor: '#27272a',
                    color: '#cbd5e1',
                    fontSize: '12px',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.backgroundColor = '#3f3f46';
                    e.currentTarget.style.color = '#38bdf8';
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.backgroundColor = '#27272a';
                    e.currentTarget.style.color = '#cbd5e1';
                  }}
                >
                  + {preset}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button
              type="button"
              onClick={onCancel}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid #3f3f46',
                backgroundColor: 'transparent',
                color: '#a1a1aa',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              取消
            </button>
            <button
              type="submit"
              style={{
                padding: '8px 18px',
                borderRadius: '8px',
                border: 'none',
                background: 'linear-gradient(135deg, #0284c7 0%, #2563eb 100%)',
                color: '#fff',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)',
              }}
            >
              確認儲存邊界理由 (.lab)
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
