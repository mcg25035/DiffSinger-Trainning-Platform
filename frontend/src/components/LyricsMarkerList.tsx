import { useState, useEffect, memo } from 'react';

interface Props {
  lyrics: string;
  filename: string;
  isPending?: boolean;
}

export const LyricsMarkerList = memo(({ lyrics, filename, isPending }: Props) => {
  const [markedIndices, setMarkedIndices] = useState<number[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Sync state and prune markers when lyrics or filename changes
  useEffect(() => {
    const key = `lyrics_markers_${filename}`;
    const stored = localStorage.getItem(key);
    const words = lyrics.split(/\s+/).filter((w) => w.length > 0);
    if (stored) {
      try {
        const parsed: number[] = JSON.parse(stored);
        const filtered = parsed.filter((i) => i < words.length);
        setMarkedIndices(filtered);
        if (filtered.length !== parsed.length) {
          localStorage.setItem(key, JSON.stringify(filtered));
        }
      } catch (e) {
        setMarkedIndices([]);
      }
    } else {
      setMarkedIndices([]);
    }
  }, [lyrics, filename]);

  const toggleMarker = (index: number) => {
    const key = `lyrics_markers_${filename}`;
    let next: number[];
    if (markedIndices.includes(index)) {
      next = markedIndices.filter((i) => i !== index);
    } else {
      next = [...markedIndices, index].sort((a, b) => a - b);
    }
    setMarkedIndices(next);
    localStorage.setItem(key, JSON.stringify(next));
  };

  const words = lyrics.split(/\s+/).filter((w) => w.length > 0);

  if (words.length === 0) return null;

  return (
    <div
      style={{
        paddingLeft: '28px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      {isPending && (
        <div
          style={{
            fontSize: '10px',
            color: '#ffca28',
            opacity: 0.8,
            fontStyle: 'italic',
            marginBottom: '2px',
          }}
        >
          ⚠️ [AI]
        </div>
      )}
      <div
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          gap: '4px 12px',
          alignItems: 'flex-start',
          overflowX: 'auto',
          paddingBottom: '6px',
          width: '100%',
          scrollbarWidth: 'thin',
        }}
      >
        {words.map((word, index) => {
          const isMarked = markedIndices.includes(index);
          const isHoveredWord = hoveredIndex === index;
          return (
            <div
              key={index}
              onClick={(e) => {
                e.stopPropagation();
                toggleMarker(index);
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'transform 0.15s ease',
                flexShrink: 0,
              }}
              onPointerOver={(e) => {
                e.currentTarget.style.transform = 'scale(1.08)';
              }}
              onPointerOut={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              <span
                style={{
                  fontSize: '11px',
                  color: isMarked
                    ? '#ff9800'
                    : isHoveredWord
                    ? '#00e5ff'
                    : isPending
                    ? '#ffca28'
                    : '#00e676',
                  fontWeight: isMarked ? '800' : '500',
                  transition: 'all 0.15s ease',
                  borderBottom: isMarked
                    ? '1px dashed #ff9800'
                    : isHoveredWord
                    ? '1px dashed #00e5ff'
                    : '1px solid transparent',
                  paddingBottom: '1px',
                }}
              >
                {word}
              </span>
              <span
                style={{
                  fontSize: '9px',
                  color: isMarked ? '#ff9800' : '#00e5ff',
                  opacity: isMarked ? 1 : isHoveredWord ? 0.4 : 0,
                  transform:
                    isMarked || isHoveredWord
                      ? 'translateY(0)'
                      : 'translateY(-2px)',
                  transition: 'all 0.15s ease',
                  marginTop: '1px',
                  lineHeight: 1,
                }}
              >
                ▲
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
