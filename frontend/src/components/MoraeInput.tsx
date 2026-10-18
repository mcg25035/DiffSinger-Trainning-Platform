import { useEffect, useMemo, useRef, useState } from 'react';
import { enumerateParses } from '../lib/romaji-mora';

// ───────── 歌詞輸入框(code-editor 式校錯)─────────
// 規則來自 dictionary(initLyricsIgnore / initLyricsRules),不寫死在 component:
//   - token ∈ phonemes(扣掉 ignore)= valid
//   - 空白時 token 經 trie 解析:唯一解 → 自動修正改寫(kka → cl ka,鮮豔閃一下)
//   - 無解/多解(歧義)→ 保留原字,紅底線,下方顯示最接近的建議
//   - invalid 存在時由父層拒絕送出

export interface MoraValidation {
  tokens: string[];       // 解析後的 mora 序列(送出用)
  invalid: string[];      // 紅底線的原始 token
  corrected: string[];    // 被自動修正的原始 token
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  phonemes: string[];
  ignore: string[];
  rules: { pattern: string; insert: string }[];
  onValidation?: (v: MoraValidation) => void;
  markedIndices?: number[]; // kanji 多出來的讀音(token index)→ 橘色波浪線標示
}

const clean = (s: string) => s.toLowerCase().replace(/[^\w]/g, '');

export function MoraeInput({ value, onChange, phonemes, ignore, rules, onValidation, markedIndices }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [flashed, setFlashed] = useState<Set<string>>(new Set());
  const marked = useMemo(() => new Set(markedIndices ?? []), [markedIndices]);

  const geminate = rules.find(r => r.pattern === 'doubleConsonant')?.insert ?? 'cl';

  // 打完空白 → 正規化所有完成的詞(唯一解改寫 + 閃;invalid 保留原字)
  const handleChange = (nv: string) => {
    if (nv.endsWith(' ')) {
      const words = nv.replace(/\s+$/, '').split(/\s+/).filter(Boolean);
      const outTokens: string[] = [];
      const changed: string[] = [];
      for (const raw of words) {
        const w = clean(raw);
        if (!w) continue;
        if (phonemes.includes(w) && !ignore.includes(w)) {
          outTokens.push(w);
          continue;
        }
        const parses = enumerateParses(w, geminate);
        if (parses.length === 1) {
          outTokens.push(...parses[0]);
          changed.push(raw);
        } else {
          outTokens.push(raw);
        }
      }
      onChange(outTokens.join(' ') + ' ');
      if (changed.length > 0) {
        setFlashed(new Set(changed));
        setTimeout(() => setFlashed(new Set()), 1000);
      }
    } else {
      onChange(nv);
    }
  };

  // 即時校驗(防呆 + 建議用):完成的詞解析後的狀態
  const { tokens, invalid, corrected } = useMemo(() => {
    const words = value.replace(/\s+$/, '').split(/\s+/).filter(Boolean);
    const toks: string[] = [];
    const inv: string[] = [];
    const corr: string[] = [];
    for (const raw of words) {
      const w = clean(raw);
      if (!w) continue;
      if (phonemes.includes(w) && !ignore.includes(w)) {
        toks.push(w);
        continue;
      }
      const parses = enumerateParses(w, geminate);
      if (parses.length === 1) {
        toks.push(...parses[0]);
        corr.push(raw);
      } else {
        toks.push(w);
        inv.push(raw);
      }
    }
    return { tokens: toks, invalid: inv, corrected: corr };
  }, [value, phonemes, ignore, geminate]);

  useEffect(() => {
    onValidation?.({ tokens, invalid, corrected });
  }, [tokens, invalid, corrected]);

  // overlay:value 重畫(可見文字),invalid 紅波浪底線、marked 橘色波浪底線、flashed 紫底閃
  const renderOverlay = () => {
    const segs = value.split(/(\s+)/);
    let tokenIdx = 0;
    return segs.map((seg, i) => {
      if (/^\s*$/.test(seg)) return <span key={i}>{seg}</span>;
      const isInvalid = invalid.includes(seg);
      const isFlash = flashed.has(seg);
      const isMarked = marked.has(tokenIdx);
      tokenIdx += 1;
      return (
        <span
          key={i}
          style={{
            color: '#e2e8f0',
            background: isFlash
              ? '#7c3aed'
              : isMarked ? 'rgba(249,115,22,0.15)' : 'transparent',
            borderRadius: '3px',
            textDecoration: isMarked
              ? 'underline wavy #f97316'
              : isInvalid ? 'underline wavy #ef4444' : 'none',
            textUnderlineOffset: '3px',
            transition: 'background 0.15s',
          }}
        >
          {seg}
        </span>
      );
    });
  };

  // 建議:最接近的 parse 或表裡最像的 token
  const suggestionFor = (raw: string): string => {
    const w = clean(raw);
    const parses = enumerateParses(w, geminate);
    if (parses.length > 0) return parses[0].join(' ');
    let best = '', bestD = 99;
    for (const p of phonemes) {
      const d = lev(w, p);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <div
          ref={overlayRef}
          aria-hidden
          style={{
            position: 'absolute', inset: 0,
            pointerEvents: 'none',
            whiteSpace: 'pre',
            overflow: 'hidden',
            padding: '10px 12px',
            fontSize: '14px',
            fontFamily: 'monospace',
            lineHeight: '20px',
            borderRadius: '8px',
            border: '1px solid transparent',
            color: '#e2e8f0',
          }}
        >
          {renderOverlay()}
        </div>
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          onChange={(e) => handleChange(e.target.value)}
          onScroll={() => { if (overlayRef.current && inputRef.current) overlayRef.current.scrollLeft = inputRef.current.scrollLeft; }}
          style={{
            width: '100%',
            border: '1px solid #444',
            borderRadius: '8px',
            color: 'transparent',
            caretColor: '#fff',
            background: 'transparent',
            padding: '10px 12px',
            fontSize: '14px',
            boxSizing: 'border-box',
            fontFamily: 'monospace',
            position: 'relative',
            marginBottom: 0,
          }}
        />
      </div>
      {invalid.length > 0 && (
        <div style={{ fontSize: '12px', color: '#ef4444', marginTop: '4px' }}>
          ✗ 找不到「{invalid.join('、')}」,最接近:{invalid.map(w => suggestionFor(w)).join(' / ')}(請用空白切開或修正)
        </div>
      )}
    </div>
  );
}

function lev(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}
