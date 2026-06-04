/**
 * useLabelPersistence — Label 檔案載入/存檔 Hook
 *
 * 職責：
 *  - 從 API 載入 .lab 和 .conf 檔案
 *  - 存檔到 API
 *  - 管理 isDirty / saveStatus 狀態
 */

import { useState, useCallback, useRef, useEffect } from 'react';
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
  /** 觸發防抖自動存檔，呼叫時會重設 800ms 計時器 */
  triggerAutoSave: (getSegments: () => LabSegment[]) => void;
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
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, []);

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
      // 手動存檔時取消任何待處理的自動存檔
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }

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

  // 防抖自動存檔：每次呼叫重設 800ms 計時器
  const triggerAutoSave = useCallback(
    (getSegments: () => LabSegment[]) => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
      autoSaveTimerRef.current = setTimeout(async () => {
        autoSaveTimerRef.current = null;
        if (!isMountedRef.current) return;

        const segments = getSegments();
        if (segments.length === 0) return;

        setIsSaving(true);
        setSaveStatus('saving');

        const labContent = stringifyLabSegments(segments);
        try {
          const res = await fetch(`/api/lab/${recording.filename}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: labContent,
          });

          if (!isMountedRef.current) return;
          if (res.ok) {
            setIsDirty(false);
            setSaveStatus('saved');
          } else {
            setSaveStatus('error');
          }
        } catch (err) {
          console.error('Autosave error:', err);
          if (isMountedRef.current) {
            setSaveStatus('error');
          }
        } finally {
          if (isMountedRef.current) {
            setIsSaving(false);
          }
        }
      }, 800);
    },
    [recording.filename]
  );

  return {
    loadLabels,
    saveLabels,
    triggerAutoSave,
    isDirty,
    setIsDirty,
    saveStatus,
    setSaveStatus,
    isSaving,
    error,
    setError,
  };
}
