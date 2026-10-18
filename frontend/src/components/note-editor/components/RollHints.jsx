// Piano Roll 操作提示(浮在 scroll 底的短 chip):與 F0 共用 HudKit(useHud/Hint/圖示)
// 滑鼠事件認 roll 區(.roll-scroll);鍵盤由 useHud 全域 capture(躲上層 stopPropagation)
import { memo, useEffect, useState } from 'react';
import { useHud, Hint, IcMouseL, IcMouseR, IcArrows } from './HudKit.jsx';

function RollHintsInner({ selected = 0 }) {
  const hud = useHud();
  const [rHover, setRHover] = useState(false);
  const [rMenu, setRMenu] = useState(false);
  // 右鍵點在音符上才閃;hover 音符 = 白方標記亮
  useEffect(() => {
    const down = (e) => {
      const inRoll = !!(e.target.closest && e.target.closest('.note-editor-root .roll-scroll'));
      if (!inRoll) return;
      if (e.button === 0) hud.click();
      else if (e.button === 2 && e.target.closest && e.target.closest('[data-note]')) hud.flashR();
    };
    const over = (e) => {
      const onNote = !!(e.target.closest && e.target.closest('[data-note]'));
      setRHover((v) => (v === onNote ? v : onNote));
    };
    const bl = () => setRHover(false);
    window.addEventListener('mousedown', down);
    window.addEventListener('mouseover', over);
    window.addEventListener('blur', bl);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('mouseover', over);
      window.removeEventListener('blur', bl);
    };
  }, [hud]);
  // 音符選單開著 = 音符選單 hint 持續亮(PianoRoll 的 menu 是內部 state,這裡用 DOM 輪詢)
  useEffect(() => {
    const t = setInterval(() => {
      const open = !!document.querySelector('.note-editor-root .note-ctxmenu');
      setRMenu((v) => (v === open ? v : open));
    }, 150);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="roll-hints" onMouseDown={(e) => e.preventDefault()}>
      <span className="hints">
        <Hint on={hud.l} title="拖空白=框選;拖音符=移動">
          <span className={'mic' + (hud.l ? ' lit' : '')}><IcMouseL /></span>框選
        </Hint>
        <Hint on={hud.combo === 2} title="雙擊空白=新增音符">
          <IcMouseL /><i className="x2">×2</i>新增音符
          <i className="combo" data-c={hud.combo} />
        </Hint>
        <Hint on={hud.r || rMenu} title="右鍵點音符:選單(分割/刪除/屬性/複製/剪下/伸縮)">
          <span className={'rdot' + (rHover ? ' lit' : '')}><IcMouseR marker="bar" /></span>音符選單
        </Hint>
        <Hint on={hud.keys.alt} title="Alt+拖曳:不吸格自由移動"><kbd>Alt</kbd>無視格</Hint>
        <Hint on={hud.keys.ctrl} title="Ctrl+滾輪:水平縮放;Ctrl+Shift+滾輪:垂直縮放;選取時 Ctrl+↑/↓:八度移調">
          <kbd>Ctrl</kbd>縮放<span className={'subtxt' + (hud.keys.shift ? ' on' : '')}>（<kbd className={'sub' + (hud.keys.shift ? ' on' : '')}>Shift</kbd>垂直）</span>
          {selected > 0 && !hud.keys.ctrl && <span className="subtxt">/移調八度</span>}
        </Hint>
        {selected > 0 && (
          <Hint on={hud.keys.updown} title="↑/↓:移調半音;Ctrl+↑/↓:八度">
            <kbd>↑↓</kbd><IcArrows />移調{hud.keys.ctrl && <span className="subtxt on">（八度）</span>}
          </Hint>
        )}
        <Hint on={hud.keys.del} title="刪除選取音符"><kbd>Del</kbd>刪除</Hint>
      </span>
    </div>
  );
}

export default memo(RollHintsInner);
