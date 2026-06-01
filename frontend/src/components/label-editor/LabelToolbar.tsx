/**
 * LabelToolbar — Visual Labeler 頂部工具列
 */


interface Props {
  isLoaded: boolean;
  isAudioLoaded: boolean;
  isPlaying: boolean;
  labelsCount: number | null;
  error: string | null;
  // Save
  isSaving: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  isDirty: boolean;
  // Zoom / Speed
  zoomLevel: number;
  playbackRate: number;
  onZoomChange: (level: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  // Actions
  onWordPlay: () => void;
  onPhonemePlay: () => void;
  onFullPlay: () => void;
  onSave: () => void;
  onCancel: () => void;
  // Fullscreen
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function LabelToolbar({
  isLoaded,
  isAudioLoaded,
  isPlaying,
  labelsCount,
  error,
  isSaving,
  saveStatus,
  zoomLevel,
  playbackRate,
  onZoomChange,
  onPlaybackRateChange,
  onWordPlay,
  onPhonemePlay,
  onFullPlay,
  onSave,
  onCancel,
  isFullscreen = false,
  onToggleFullscreen,
}: Props) {
  const disabled = !isLoaded || !isAudioLoaded;

  // 雲朵圖示 JSX
  const renderCloudIcon = () => (
    <div className={`label-toolbar__save-icon label-toolbar__save-icon--${saveStatus}`}>
      {saveStatus === 'saving' ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="label-toolbar__spin">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      ) : saveStatus === 'saved' ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.5 19c2.5 0 4.5-2 4.5-4.5 0-2.3-1.7-4.2-4-4.5C17.4 7.1 14.9 5 12 5c-2.4 0-4.5 1.4-5.5 3.5C4.2 9.1 2 11.3 2 14c0 2.8 2.2 5 5 5h10.5z" />
          <polyline points="9 13 11 15 15 11" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.5 19c2.5 0 4.5-2 4.5-4.5 0-2.3-1.7-4.2-4-4.5C17.4 7.1 14.9 5 12 5c-2.4 0-4.5 1.4-5.5 3.5C4.2 9.1 2 11.3 2 14c0 2.8 2.2 5 5 5h10.5z" />
        </svg>
      )}
    </div>
  );

  // 全螢幕模式下的 Toolbar
  if (isFullscreen) {
    return (
      <div className="label-toolbar label-toolbar--fullscreen-mode">
        <div className="label-toolbar__left">
          <div className="label-toolbar__title-group">
            {renderCloudIcon()}
          </div>
          
          {/* 保留核心的 ZOOM / SPEED 和狀態，這在調整音素視圖時依然很有用 */}
          <div className="label-toolbar__controls">
            <div className="label-toolbar__slider-group">
              <label className="label-toolbar__slider-label">ZOOM</label>
              <input type="range" min="20" max="1000" value={zoomLevel} onChange={(e) => onZoomChange(Number(e.target.value))} className="label-toolbar__slider label-toolbar__slider--zoom" />
            </div>
            <div className="label-toolbar__slider-group">
              <label className="label-toolbar__slider-label">SPEED</label>
              <input type="range" min="0.1" max="2.0" step="0.1" value={playbackRate} onChange={(e) => onPlaybackRateChange(Number(e.target.value))} className="label-toolbar__slider label-toolbar__slider--speed" />
              <span className="label-toolbar__speed-value">{playbackRate.toFixed(1)}x</span>
            </div>
            <span className="label-toolbar__status">
              {error ? (
                <span className="label-toolbar__error">{error}</span>
              ) : !isLoaded || !isAudioLoaded ? (
                'Loading...'
              ) : (
                `${labelsCount} labels loaded`
              )}
            </span>
          </div>
        </div>

        <div className="label-toolbar__right">
          <button onClick={onToggleFullscreen} className="label-toolbar__btn label-toolbar__btn--exit">
            ⛶ EXIT-FULL-SCREEN
          </button>
        </div>
      </div>
    );
  }

  // 正常模式下的 Toolbar
  return (
    <div className="label-toolbar">
      <div className="label-toolbar__left">
        <div className="label-toolbar__title-group">
          <h2 className="label-toolbar__title">VISUAL LABELER</h2>
          {renderCloudIcon()}
        </div>

        <div className="label-toolbar__play-buttons">
          <button onClick={onWordPlay} disabled={disabled} className="label-toolbar__btn label-toolbar__btn--word">
            WORD-PLAY
          </button>
          <button onClick={onPhonemePlay} disabled={disabled} className="label-toolbar__btn label-toolbar__btn--phoneme">
            PHONEME-PLAY
          </button>
          <button onClick={onFullPlay} disabled={disabled} className={`label-toolbar__btn label-toolbar__btn--full ${isPlaying ? 'label-toolbar__btn--playing' : ''}`}>
            {isPlaying ? 'PAUSE' : 'FULL-PLAY'}
          </button>
        </div>

        <div className="label-toolbar__controls">
          <div className="label-toolbar__slider-group">
            <label className="label-toolbar__slider-label">ZOOM</label>
            <input type="range" min="20" max="1000" value={zoomLevel} onChange={(e) => onZoomChange(Number(e.target.value))} className="label-toolbar__slider label-toolbar__slider--zoom" />
          </div>
          <div className="label-toolbar__slider-group">
            <label className="label-toolbar__slider-label">SPEED</label>
            <input type="range" min="0.1" max="2.0" step="0.1" value={playbackRate} onChange={(e) => onPlaybackRateChange(Number(e.target.value))} className="label-toolbar__slider label-toolbar__slider--speed" />
            <span className="label-toolbar__speed-value">{playbackRate.toFixed(1)}x</span>
          </div>
          <span className="label-toolbar__status">
            {error ? (
              <span className="label-toolbar__error">{error}</span>
            ) : !isLoaded || !isAudioLoaded ? (
              'Loading...'
            ) : (
              `${labelsCount} labels loaded`
            )}
          </span>
        </div>
      </div>

      <div className="label-toolbar__right">
        <button onClick={onToggleFullscreen} className="label-toolbar__btn label-toolbar__btn--fullscreen">
          ⛶ FULL-SCREEN
        </button>
        <button onClick={onCancel} className="label-toolbar__btn label-toolbar__btn--cancel">
          CANCEL
        </button>
        <button onClick={onSave} disabled={isSaving || !isLoaded} className="label-toolbar__btn label-toolbar__btn--save">
          {isSaving ? 'SAVING...' : 'SAVE CHANGES'}
        </button>
      </div>
    </div>
  );
}
