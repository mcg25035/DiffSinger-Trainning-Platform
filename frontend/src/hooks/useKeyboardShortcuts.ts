/**
 * useKeyboardShortcuts — 快捷鍵系統 Hook
 *
 * 🔧 修復 stale closure：使用 ref 持有最新的 handler，
 * effect 只綁定一次事件，透過 ref 取得最新的函式引用。
 */

import { useEffect, useRef } from 'react';

export interface KeyboardHandlers {
  onStop: () => void;
  onWordPlay: () => void;
  onPhonemePlay: () => void;
  onFullPlay: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onFocusInput?: () => void;
  onArrowLeft?: () => void;
  onArrowRight?: () => void;
}

export function useKeyboardShortcuts(handlers: KeyboardHandlers): void {
  // 用 ref 持有最新的 handlers，避免 stale closure
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const isInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement;

      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        handlersRef.current.onUndo();
        return;
      }

      if (isInput) return;

      if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        if (active instanceof HTMLElement) {
          active.blur();
        }
        handlersRef.current.onStop();
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onWordPlay();
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onPhonemePlay();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onFullPlay();
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onFocusInput?.();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onDelete();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onArrowLeft?.();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onArrowRight?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []); // 只綁定一次
}
