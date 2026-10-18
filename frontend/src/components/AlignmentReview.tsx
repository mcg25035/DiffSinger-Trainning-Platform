/**
 * AlignmentReview — 「對齊處理」分頁
 *
 * 左:等待審核的 take 清單(灰=待審 黃=正在審 綠=完成 紅=錯誤)
 * 中:Visual Labeler(LabelEditor)
 * 下:確定完成 → 切割成訓練段 → 直接跳下一個待審 take
 *
 * 流程:選待審 take → POST /align 觸發 MMS 對齊(背景,take 狀態 → aligning)
 *   → .lab/moraEnds 就緒 → Labeler 顯示 → 使用者聽/檢查/改邊界
 *   → 確定完成 → POST confirm(同範圍不重跑 MMS,直接切)→ 跳下一個
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { LabelEditor } from './LabelEditor';

interface TakeRow {
  sessionId: string;
  sessionName: string;
  takeId: string;
  status: 'ready' | 'aligning' | 'confirmed' | 'error';
  filename: string;
  start: number | null;
  end: number | null;
  score: number | null;
  realigned: boolean;
  hasFiles: boolean;
  error: string | null;
  lyrics: string;
  createdAt: number;
}

// 灰=待審(對齊好,等審) 黃=正在審(選取中) 綠=完成
const STATUS_META: Record<TakeRow['status'], { label: string; color: string }> = {
  ready: { label: '待審', color: '#9ca3af' },
  aligning: { label: '對齊中', color: '#eab308' },
  confirmed: { label: '完成', color: '#22c55e' },
  error: { label: '錯誤', color: '#ef4444' },
};

const STATUS_ORDER: Record<TakeRow['status'], number> = {
  ready: 0,
  error: 1,
  confirmed: 2,
  aligning: 3,
};

function btn(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    fontSize: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

export function AlignmentReview() {
  const [rows, setRows] = useState<TakeRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/alignment-takes');
      if (res.ok) setRows(await res.json());
    } catch { /* 下次輪詢再試 */ }
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  const sorted = [...rows].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.createdAt - b.createdAt
  );
  const selected = rows.find((r) => r.takeId === selectedId) || null;

  // 選取 take(送審時 MMS 已在唱歌錄音跑完,直接顯示 Labeler)
  const select = useCallback((row: TakeRow) => {
    setSelectedId(row.takeId);
  }, []);

  // 確定完成 → 切割 → 直接跳下一個待審 take
  const confirmAndNext = useCallback(async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${selected.sessionId}/takes/${selected.takeId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: selected.start, end: selected.end }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || '確認失敗'); return; }

      const res2 = await fetch('/api/alignment-takes');
      const fresh: TakeRow[] = res2.ok ? await res2.json() : [];
      setRows(fresh);
      const next = fresh
        .filter((r) => r.status === 'ready' && typeof r.start === 'number')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (next) select(next);
      else setSelectedId(null);
    } finally {
      setBusy(false);
    }
  }, [selected, busy, select]);

  const discard = useCallback(async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await fetch(`/api/sessions/${selected.sessionId}/takes/${selected.takeId}/discard`, { method: 'POST' });
      setSelectedId(null);
      refresh();
    } finally {
      setBusy(false);
    }
  }, [selected, busy, refresh]);

  // 反悔重切:刪掉切出的訓練段,退回唱歌錄音重新選範圍送審
  const revertTake = useCallback(async () => {
    if (!selected || busy) return;
    if (!confirm('反悔這段?會刪掉它切出的訓練段、退回唱歌錄音重新選範圍送審(原始錄音保留)。')) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${selected.sessionId}/takes/${selected.takeId}/revert`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { alert(data.error || '反悔失敗'); return; }
      setSelectedId(null);
      refresh();
    } finally {
      setBusy(false);
    }
  }, [selected, busy, refresh]);

  const labelerReady = !!selected && selected.hasFiles &&
    ((selected.status === 'ready' && selected.realigned) || selected.status === 'confirmed');

  return (
    <div style={{ display: 'flex', gap: '12px', height: '100%', padding: '8px 4px', boxSizing: 'border-box' }}>
      {/* 左:take 清單 */}
      <div style={{
        width: '300px', flexShrink: 0, overflowY: 'auto',
        background: '#0f0f0f', border: '1px solid #333', borderRadius: '20px', padding: '18px',
      }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '15px', color: '#aaa' }}>待審核 Take</h3>
        {sorted.length === 0 && (
          <div style={{ fontSize: '13px', color: '#666' }}>目前沒有待審核的錄音</div>
        )}
        {sorted.map((row) => {
          const meta = STATUS_META[row.status];
          const isSelected = row.takeId === selectedId;
          return (
            <div
              key={row.takeId}
              onClick={() => select(row)}
              style={{
                padding: '10px 12px', marginBottom: '8px', borderRadius: '10px', cursor: 'pointer',
                background: isSelected ? '#16203a' : '#141414',
                border: `1px solid ${isSelected ? '#2563eb' : '#2a2a2a'}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px', color: '#ccc', fontFamily: 'monospace' }}>{row.filename}</span>
                <span style={{ fontSize: '12px', color: meta.color, fontWeight: 600, flexShrink: 0 }}>{meta.label}</span>
              </div>
              <div style={{ fontSize: '11px', color: '#777', marginTop: '4px' }}>{row.sessionName}</div>
              {row.status === 'error' && row.error && (
                <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '4px' }}>{row.error}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* 中:Visual Labeler + 下面確認列 */}
      <div style={{
        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
        background: '#0f0f0f', border: '1px solid #333', borderRadius: '20px', padding: '14px',
      }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          {selected && labelerReady ? (
            <LabelEditor
              key={selected.takeId}
              recording={{
                filename: selected.filename,
                url: `/upload_segments/${selected.filename}`,
                type: 'segment',
                lyrics: selected.lyrics,
              }}
              onCancel={() => setSelectedId(null)}
            />
          ) : selected ? (
            <div style={{
              height: '100%', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: '10px',
            }}>
              {selected.status === 'ready' && !selected.realigned && (
                <span style={{ color: '#888', fontSize: '14px' }}>對齊資料準備中…</span>
              )}
              {selected.status === 'confirmed' && !selected.hasFiles && (
                <span style={{ color: '#888', fontSize: '13px' }}>已切割成訓練段(這段是舊流程切的,原始錄音檔已清理)</span>
              )}
              {selected.status === 'error' && (
                <span style={{ color: '#ef4444', fontSize: '13px' }}>{selected.error || '對齊失敗'}</span>
              )}
            </div>
          ) : (
            <div style={{
              height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#666', fontSize: '14px',
            }}>
              ← 從左邊選一段 take 開始審核
            </div>
          )}
        </div>

        {selected && (
          <div style={{
            borderTop: '1px solid #2a2a2a', paddingTop: '12px', marginTop: '10px',
            display: 'flex', gap: '10px', alignItems: 'center',
          }}>
            <div
              style={{
                flex: 1, fontSize: '12px', color: '#888',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              title={`${selected.sessionName} · ${selected.lyrics}`}
            >
              {selected.sessionName} · {selected.lyrics}
            </div>
            {selected.status !== 'confirmed' && (
              <button onClick={discard} disabled={busy} style={btn('#333')}>丟棄</button>
            )}
            {selected.status === 'confirmed' && (
              <button onClick={revertTake} disabled={busy} style={btn('#b45309')}>↩ 反悔重切</button>
            )}
            <button
              onClick={confirmAndNext}
              disabled={busy || (selected.status !== 'ready' && selected.status !== 'aligning')}
              style={btn('#16a34a')}
            >
              ✓ 確定完成,跳下一個
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
