/**
 * PhonemeEditPanel — 選中 region 時的音素編輯面板
 */

import type { Region } from 'wavesurfer.js/plugins/regions';

interface Props {
  selectedRegion: Region | null;
  isMultipleSelect?: boolean;
  editLabel: string;
  onEditLabelChange: (label: string) => void;
  onUpdate: () => void;
  onPlay: () => void;
  onDelete: () => void;
  onDeselect: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function PhonemeEditPanel({
  selectedRegion,
  isMultipleSelect,
  editLabel,
  onEditLabelChange,
  onUpdate,
  onPlay,
  onDelete,
  onDeselect,
  inputRef,
}: Props) {
  if (!selectedRegion) {
    return (
      <div className="phoneme-edit">
        <span className="phoneme-edit__hint">
          Select a region in the track below or waveform to edit its phoneme.
        </span>
      </div>
    );
  }

  if (isMultipleSelect) {
    return (
      <div className="phoneme-edit">
        <span className="phoneme-edit__hint">
          Multiple phonemes selected (Move boundaries to drag them together).
        </span>
        <button onClick={onDeselect} className="phoneme-edit__btn phoneme-edit__btn--close">X</button>
      </div>
    );
  }

  return (
    <div className="phoneme-edit">
      <span className="phoneme-edit__label">Edit Phoneme:</span>
      <input
        ref={inputRef}
        className="phoneme-edit__input"
        value={editLabel}
        onChange={(e) => onEditLabelChange(e.target.value.replace(/\s+/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onUpdate();
          if (e.key === 'Escape') onDeselect();
        }}
      />
      <button onClick={onUpdate} className="phoneme-edit__btn phoneme-edit__btn--ok">OK</button>
      <button onClick={onPlay} className="phoneme-edit__btn phoneme-edit__btn--play">PLAY</button>
      <button onClick={onDelete} className="phoneme-edit__btn phoneme-edit__btn--del">DEL</button>
      <div className="phoneme-edit__divider" />
      <button onClick={onDeselect} className="phoneme-edit__btn phoneme-edit__btn--close">X</button>
    </div>
  );
}
