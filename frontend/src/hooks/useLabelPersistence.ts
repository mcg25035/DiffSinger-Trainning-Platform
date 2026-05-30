/**
 * useLabelPersistence — Label 檔案載入/存檔 Hook
 *
 * 職責：
 *  - 從 API 載入 .lab 和 .conf 檔案
 *  - 存檔到 API
 *  - 管理 isDirty / saveStatus 狀態
 */

import { useState, useRef, useCallback } from 'react';
import type { Recording } from './useAudioMonitor';
import {
  parseLab,
  mergeConfidenceScores,
  fillGaps,
  stringifyLabSegments,
  type LabSegment,
} from '../utils/labParser';

export interface UseLabelPersistenceReturn {
  loadLabels: (duration: number) => Promise<LabSegment[]>;
  saveLabels: (segments: LabSegment[]) => Promise<boolean>;
  isDirty: boolean;
  setIsDirty: (dirty: boolean) => void;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  setSaveStatus: (status: 'idle' | 'saving' | 'saved' | 'error') => void;
  isSaving: boolean;
  error: string | null;
  setError: (error: string | null) => void;
}

export function useLabelPersistence(
  recording: Recording
): UseLabelPersistenceReturn {
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLabels = useCallback(
    async (duration: number): Promise<LabSegment[]> => {
      try {
        const [labRes, confRes] = await Promise.all([
          fetch(`/api/lab/${encodeURIComponent(recording.filename)}`),
          fetch(`/api/conf/${encodeURIComponent(recording.filename)}`).catch(
            () => null
          ),
        ]);

        if (labRes.ok) {
          const labContent = await labRes.text();
          const confContent =
            confRes && confRes.ok ? await confRes.text() : null;

          let segments = parseLab(labContent);
          const confSegments = confContent ? parseLab(confContent) : [];

          segments = mergeConfidenceScores(segments, confSegments);
          const filled = fillGaps(segments, duration);

          return filled;
        } else {
          const txt = await labRes.text();
          setError(`Failed to load: ${labRes.status} ${txt}`);
          return [];
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Fetch error:', err);
        setError(`Fetch error: ${msg}`);
        return [];
      }
    },
    [recording.filename]
  );

  const saveLabels = useCallback(
    async (segments: LabSegment[]): Promise<boolean> => {
      setIsSaving(true);
      setSaveStatus('saving');

      const labContent = stringifyLabSegments(segments);
      try {
        const res = await fetch(`/api/lab/${recording.filename}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: labContent,
        });

        if (res.ok) {
          setIsDirty(false);
          setSaveStatus('saved');
          return true;
        } else {
          setSaveStatus('error');
          return false;
        }
      } catch (err) {
        console.error(err);
        setSaveStatus('error');
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [recording.filename]
  );

  return {
    loadLabels,
    saveLabels,
    isDirty,
    setIsDirty,
    saveStatus,
    setSaveStatus,
    isSaving,
    error,
    setError,
  };
}
