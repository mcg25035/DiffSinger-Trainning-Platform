// HUD 提示共用套件:useHud(鍵盤/滑鼠狀態)+ Hint(外框)+ 圖示
// ⚠ 行為凍結:任何參數(450/600/260ms、capture、blur 清空)都是現行值,改前先對照兩處使用端
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 即時按鍵/滑鼠狀態(給 hint 點燈用)
 * - keys: { alt, ctrl, shift, del, updown } 全域 keydown/keyup(capture,躲上層 stopPropagation),blur 全清
 * - l/r: 左/右鍵按住中(window mouseup 收燈);r 通常配 flashR() 閃 260ms
 * - combo: ×2 雙擊進度(1=一下半條,2=雙擊全亮,600ms 無第二下歸零);click() = 左鍵按下時呼叫
 * - flashR(): 右鍵閃一下
 */
export function useHud() {
  const [keys, setKeys] = useState({});
  const [l, setL] = useState(false);
  const [r, setR] = useState(false);
  const [combo, setCombo] = useState(0);
  const lastClickRef = useRef(0);
  const comboTimer = useRef(0);
  const rFlashTimer = useRef(0);
  const click = useCallback(() => {
    const now = Date.now();
    const c = now - lastClickRef.current < 450 ? 2 : 1;
    lastClickRef.current = now;
    clearTimeout(comboTimer.current);
    comboTimer.current = setTimeout(() => setCombo(0), 600);
    setL(true);
    setCombo(c);
  }, []);
  const flashR = useCallback(() => {
    clearTimeout(rFlashTimer.current);
    setR(true);
    rFlashTimer.current = setTimeout(() => setR(false), 260);
  }, []);
  useEffect(() => {
    const up = (e) => {
      if (e.button === 0) setL(false);
      else if (e.button === 2) setR(false);
    };
    const kd = (e) => setKeys((k) => {
      if (e.key === 'Alt') return k.alt ? k : { ...k, alt: true };
      if (e.key === 'Control') return k.ctrl ? k : { ...k, ctrl: true };
      if (e.key === 'Shift') return k.shift ? k : { ...k, shift: true };
      if (e.key === 'Delete' || e.key === 'Backspace') return k.del ? k : { ...k, del: true };
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return k.updown ? k : { ...k, updown: true };
      return k;
    });
    const ku = (e) => setKeys((k) => {
      if (e.key === 'Alt') return k.alt ? { ...k, alt: false } : k;
      if (e.key === 'Control') return k.ctrl ? { ...k, ctrl: false } : k;
      if (e.key === 'Shift') return k.shift ? { ...k, shift: false } : k;
      if (e.key === 'Delete' || e.key === 'Backspace') return k.del ? { ...k, del: false } : k;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return k.updown ? { ...k, updown: false } : k;
      return k;
    });
    const bl = () => { setL(false); setR(false); setCombo(0); setKeys({}); };
    window.addEventListener('mouseup', up);
    window.addEventListener('keydown', kd, true);
    window.addEventListener('keyup', ku, true);
    window.addEventListener('blur', bl);
    return () => {
      window.removeEventListener('mouseup', up);
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('keyup', ku, true);
      window.removeEventListener('blur', bl);
      clearTimeout(comboTimer.current);
      clearTimeout(rFlashTimer.current);
    };
  }, []);
  return { keys, l, r, combo, click, flashR };
}

/** 提示外框:on = 整顆亮 */
export const Hint = ({ on, title, children }) => (
  <span className={'hint' + (on ? ' on' : '')} title={title}>{children}</span>
);

export const IcMouseL = () => (
  <svg className="ic" viewBox="0 0 14 14" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="4.25" y="1.5" width="5.5" height="11" rx="2.75" />
    <path d="M7 1.6V5.5" />
    <path d="M6.9 5.5H4.35V4.25A2.75 2.75 0 0 1 6.9 1.5z" fill="currentColor" stroke="none" />
  </svg>
);

/** 右鍵滑鼠;marker: 'dot'=白圈(F0 控制點,圓) | 'bar'=白長方(音符,方) — 都浮在滑鼠外上方 */
export const IcMouseR = ({ marker = 'dot' }) => (
  <svg className="ic" viewBox="0 -3.5 14 17.5" width="16" height="20" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="4.25" y="1.5" width="5.5" height="11" rx="2.75" />
    <path d="M7 1.6V5.5" />
    <path d="M7.1 5.5h2.55V4.25A2.75 2.75 0 0 0 7.1 1.5z" fill="currentColor" stroke="none" />
    {marker === 'dot'
      ? <circle className="ws" cx="7" cy="-1.2" r="1.9" fill="none" stroke="#fff" strokeWidth="1" />
      : <rect className="ws" x="4.4" y="-3.1" width="5.2" height="2.6" rx="0.7" fill="none" stroke="#fff" strokeWidth="1" />}
  </svg>
);

export const IcHoriz = () => (
  <svg className="ic" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.4 7h9.2M4.2 5.2 2.4 7l1.8 1.8M9.8 5.2 11.6 7l-1.8 1.8" />
  </svg>
);

export const IcArrows = () => (
  <svg className="ic" viewBox="0 0 14 14" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 12V2M4.6 4.4 7 2l2.4 2.4M4.6 9.6 7 12l2.4-2.4" />
  </svg>
);
