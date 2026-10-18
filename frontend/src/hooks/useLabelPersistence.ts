/**
 * useLabelPersistence — Label 檔案載入/存檔 Hook
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
  loadLabels: (duration: number, labType?: 'lab' | 'lab2') => Promise<LabSegment[]>;
  saveLabels: (segments: LabSegment[], labType?: 'lab' | 'lab2', duration?: number) => Promise<boolean>;
  saveAlgoLabel: (segments: LabSegment[], reason: string, boundaryInfo?: any, duration?: number) => Promise<boolean>;
  /** 觸發防抖自動存檔，呼叫時會重設 800ms 計時器 */
  triggerAutoSave: (getSegments: () => LabSegment[], getDuration?: () => number) => void;
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
    async (duration: number, labType: 'lab' | 'lab2' = 'lab'): Promise<LabSegment[]> => {
      try {
        const endpoint = labType === 'lab2'
          ? `/api/lab2/${encodeURIComponent(recording.filename)}`
          : `/api/lab/${encodeURIComponent(recording.filename)}`;

        const [labRes, confRes] = await Promise.all([
          fetch(endpoint),
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
        } else if (labType === 'lab2') {
          // A missing LAB2 is expected for recordings not in maintenance mode.
          return [];
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

  // 存檔前填補空隙(不能有沒音素的時候):duration > 0 才補,否則照原樣序列化
  const serialize = (segments: LabSegment[], duration?: number): string =>
    stringifyLabSegments(duration && duration > 0 ? fillGaps(segments, duration) : segments);

  const saveLabels = useCallback(
    async (segments: LabSegment[], labType: 'lab' | 'lab2' = 'lab', duration?: number): Promise<boolean> => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }

      setIsSaving(true);
      setSaveStatus('saving');

      const labContent = serialize(segments, duration);
      const endpoint = labType === 'lab2'
        ? `/api/lab2/${recording.filename}`
        : `/api/lab/${recording.filename}`;

      try {
        const res = await fetch(endpoint, {
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

  const saveAlgoLabel = useCallback(
    async (segments: LabSegment[], reason: string, boundaryInfo?: any, duration?: number): Promise<boolean> => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }

      setIsSaving(true);
      setSaveStatus('saving');

      const labContent = serialize(segments, duration);
      try {
        const res = await fetch(`/api/lab_algo/${recording.filename}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: labContent, reason, boundaryInfo }),
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

  // 防抖自動存檔
  const triggerAutoSave = useCallback(
    (getSegments: () => LabSegment[], getDuration?: () => number) => {
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

        const labContent = serialize(segments, getDuration?.());
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
    saveAlgoLabel,
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
