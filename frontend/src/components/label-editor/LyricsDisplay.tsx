import { memo } from 'react';

interface Props {
  lyrics: string;
  visible: boolean;
}

export const LyricsDisplay = memo(({ lyrics, visible }: Props) => {
  if (!visible || !lyrics) return null;

  return (
    <div className="label-editor__lyrics-overlay">
      <div className="label-editor__lyrics-header">
        <span className="label-editor__lyrics-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l12-2v13"></path>
            <circle cx="6" cy="18" r="3"></circle>
            <circle cx="18" cy="16" r="3"></circle>
          </svg>
        </span>
        <span className="label-editor__lyrics-title">Lyrics</span>
      </div>
      <div className="label-editor__lyrics-content">{lyrics}</div>
    </div>
  );
});
