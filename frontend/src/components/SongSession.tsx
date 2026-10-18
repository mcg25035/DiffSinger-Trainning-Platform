import { useEffect, useRef, useState, useCallback } from 'react';
import { MoraeInput, type MoraValidation } from './MoraeInput';
import { enumerateParses } from '../lib/romaji-mora';

// 「唱歌錄音」v2 — 歌詞先行 + 全域 mora 游標
// 設計: docs/training-inference-design.md §1
// 不用一句對一個錄音;整首歌是一條 mora 進度軸,每次錄音是一段未知長度的區間,
// 系統自動 DP 定位(可跨句、可停在句中),確認後在 mora 邊界切割。

interface SessionLine {
  index: number;
  lyric: string;
  moraeCount: number;
}

interface Take {
  id: string;
  filename: string;
  status: 'asr' | 'confirm' | 'ready' | 'aligning' | 'confirmed' | 'discarded' | 'error';
  rough: string | null;
  start: number | null;
  end: number | null;
  score: number | null;
  error: string | null;
  candidates?: { start: number; end: number; score: number }[];
}

interface Session {
  id: string;
  name: string;
  lines: SessionLine[];
  morae: { line: number; text: string }[];
  covered: boolean[];
  takes: Take[];
  cursor: number;
  lineProgress: { total: number; covered: number }[];
}

interface SessionSummary {
  id: string;
  name: string;
  createdAt: number;
  totalMorae: number;
  coveredMorae: number;
  totalLines: number;
  doneLines: number;
  pendingTakes: number;
}

// 流程:asr(辨識中)→ confirm(選範圍)→ ready(待審,灰)→ aligning(正在審,黃)→ confirmed(完成,綠)
const TAKE_STATUS: Record<Take['status'], { label: string; color: string }> = {
  asr: { label: '辨識中…', color: '#eab308' },
  confirm: { label: '選範圍後送審', color: '#f97316' },
  ready: { label: '待對齊審核', color: '#9ca3af' },
  aligning: { label: 'MMS 對齊中…', color: '#3b82f6' },
  confirmed: { label: '已切割 ✓', color: '#22c55e' },
  discarded: { label: '已丟棄', color: '#666' },
  error: { label: '錯誤', color: '#ef4444' },
};

interface Props {
  isRecording: boolean;
  canRecord: boolean;
  startRecording: () => void;
  stopAndCapture: () => Promise<Blob | null>;
  cancelCapture: () => void;
  dictionaryId: string;
  aligner: string;
}

export function SongSession({ isRecording, canRecord, startRecording, stopAndCapture, cancelCapture, dictionaryId, aligner }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [songName, setSongName] = useState('');
  const [lyricsInput, setLyricsInput] = useState('');
  const [kanjiInput, setKanjiInput] = useState('');
  // 消歧預覽:每行顯示轉好的 mora romaji,可再手動編修
  const [preview, setPreview] = useState<{ romaji: string; marked?: number[] }[] | null>(null);
  const [previewScore, setPreviewScore] = useState<number | null>(null); // 全域對齊分數
  const [previewValid, setPreviewValid] = useState<Record<number, MoraValidation>>({});
  const [busy, setBusy] = useState(false);

  // 待上傳的 take 預覽
  const [takePreview, setTakePreview] = useState<{ blob: Blob; url: string } | null>(null);

  // mora 校錯規則來自 dictionary(initLyricsIgnore / initLyricsRules),不寫死
  const [phonemeList, setPhonemeList] = useState<string[]>([]);
  const [ignoreList, setIgnoreList] = useState<string[]>([]);
  const [moraRules, setMoraRules] = useState<{ pattern: string; insert: string }[]>([]);
  useEffect(() => {
    fetch('/api/dictionaries')
      .then(r => r.json())
      .then((dicts: { id: string; phonemes?: string[]; initLyricsIgnore?: string[]; initLyricsRules?: { pattern: string; insert: string }[] }[]) => {
        const jp = dicts.find(d => d.id === 'jp-romanji');
        if (!jp) return;
        setPhonemeList(jp.phonemes ?? []);
        setIgnoreList(jp.initLyricsIgnore ?? []);
        setMoraRules(jp.initLyricsRules ?? []);
      })
      .catch(() => {});
  }, []);

  const previewHasInvalid = Object.values(previewValid).some(v => v.invalid.length > 0);
  const [coverageGap, setCoverageGap] = useState(0); // kanji↔romaji 涵蓋差異(≠0 = 要修正)
  const [coverageExtraCount, setCoverageExtraCount] = useState(0);
  const [coverageExtras, setCoverageExtras] = useState<{ token: string; src: string; line: number }[]>([]);

  // 轉換進度提示(真進度 %,輪詢 job)
  const [progressText, setProgressText] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  // LCS 對齊:kanji morae(a)↔ 使用者 tokens(b)→ 回每個 a[i] match 到的 b index(沒 match = -1)
  function lcsMatch(a: string[], b: string[]): number[] {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++)
      for (let j = 1; j <= m; j++)
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    const res = new Array(n).fill(-1);
    let i = n, j = m;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) { res[i - 1] = j - 1; i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }
    return res;
  }

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (res.ok) setSession(await res.json());
    } catch (e) { console.error(e); }
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) setSessionList(await res.json());
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  // 有 take 在 asr/aligning 時輪詢
  useEffect(() => {
    if (!session) return;
    const inFlight = session.takes.some(t => t.status === 'asr' || t.status === 'aligning');
    if (inFlight && !pollingRef.current) {
      pollingRef.current = setInterval(() => refreshSession(session.id), 3000);
    } else if (!inFlight && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, [session, refreshSession]);

  useEffect(() => () => {
    if (pollingRef.current) clearInterval(pollingRef.current);
  }, []);

  // ── 消歧預覽:日文 + romaji → mora-exact romaji ──
  // 前提假設(使用者只保證): 兩邊「順序」一致;行數/換行位置都不可信。
  // 全域 DP 對齊後依「使用者 romaji 的 mora-exact 數」切回各行;
  // 若 kanji 讀音沒被 romaji 涵蓋(或多打)→ 差異 ≠ 0 → 跳提示要求使用者修正,擋送出。
  const runPreview = async () => {
    const romajiLines = lyricsInput.split('\n').map(l => l.trim()).filter(Boolean);
    const kanjiLines = kanjiInput.split('\n').map(l => l.trim()).filter(Boolean);
    const hasKanji = kanjiLines.length > 0;
    setBusy(true);
    setProgressText(hasKanji ? 'kanji × 羅馬全域 DP 對齊…' : '羅馬 mora 切分…');
    setProgress(0);
    try {
      // async job + 輪詢真進度
      const startRes = await fetch('/api/romanize_mora', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: hasKanji
            ? [{ kanji: kanjiLines.join(' '), romaji: romajiLines.join(' ') }]
            : romajiLines.map(r => ({ kanji: '', romaji: r })),
        }),
      });
      const { jobId, error } = await startRes.json();
      if (!startRes.ok) throw new Error(error || '轉換失敗');

      let data: any = null;
      for (;;) {
        await new Promise(r2 => setTimeout(r2, 300));
        const pollRes = await fetch(`/api/romanize_mora/${jobId}`);
        if (!pollRes.ok) throw new Error('轉換 job 查詢失敗');
        const job = await pollRes.json();
        if (typeof job.progress === 'number') setProgress(job.progress);
        if (job.stage) setProgressText(job.stage);
        if (job.status === 'completed') { data = job.result; break; }
        if (job.status === 'error') throw new Error(job.error || '轉換失敗');
      }
      if (!data) throw new Error('轉換失敗');


      if (hasKanji) {
        const global = data.results?.[0] || {};
        const morae: string[] = global.morae || [];
        setPreviewScore(typeof global.score === 'number' ? global.score : null);

        // 使用者 tokens(含行歸屬)
        const userTokens: string[] = [];
        const tokenLines: number[] = [];
        romajiLines.forEach((l, li) => {
          l.split(/\s+/).filter(Boolean).forEach(w => {
            const toks = enumerateParses(w.toLowerCase().replace(/[^\w]/g, ''), 'cl')[0] ?? [w];
            toks.forEach(t => { userTokens.push(t); tokenLines.push(li); });
          });
        });

        // LCS 對齊:global mora ↔ user token;沒 match 上的 global mora = kanji 多出來的讀音
        const matchedB = lcsMatch(morae, userTokens);

        // 行歸屬:matched 的 global mora 跟著它的 user token 的行;
        // 多出來的(mismatch)歸到前一個 matched 音的行(kanji 讀音出現在它該在的位置)
        const moraLine: number[] = [];
        let lastLine = 0;
        for (let g = 0; g < morae.length; g++) {
          if (matchedB[g] >= 0) lastLine = tokenLines[matchedB[g]];
          moraLine.push(lastLine);
        }

        // 依行分組(不再天真 counts 切 → 不位移);多出來的音標示出來
        const byLine: string[][] = romajiLines.map(() => []);
        const markedByLine: number[][] = romajiLines.map(() => []);
        morae.forEach((m, g) => {
          const li = Math.min(moraLine[g], romajiLines.length - 1);
          if (matchedB[g] < 0) markedByLine[li].push(byLine[li].length);
          byLine[li].push(m);
        });

        const gap = morae.length - userTokens.length;
        setCoverageGap(gap);
        setCoverageExtraCount(gap > 0 ? markedByLine.flat().length : 0);
        // 多出來的音 + 來源漢字(給提示框與 kanji 行高亮)
        const extras: { token: string; src: string; line: number }[] = [];
        const sources: string[] = (global as any).mora_sources || [];
        for (let g = 0; g < morae.length; g++) {
          if (matchedB[g] >= 0) continue;
          const src = sources[g] ?? '';
          const li = Math.min(moraLine[g], romajiLines.length - 1);
          const last = extras[extras.length - 1];
          if (last && last.src === src && last.line === li) last.token += ' ' + morae[g];
          else extras.push({ token: morae[g], src, line: li });
        }
        setCoverageExtras(extras);
        setPreview(romajiLines.map((r, i) => ({ romaji: byLine[i].length > 0 ? byLine[i].join(' ') : r, marked: markedByLine[i] })));
      } else {
        setPreviewScore(null);
        setCoverageGap(0);
        setPreview(romajiLines.map((r, i) => {
          const item = data.results?.[i] || {};
          return { romaji: item.mora_romaji || r };
        }));
      }
      setPreviewValid({});
    } catch (e: any) {
      alert(`轉換失敗:${e.message}(MMS 服務需在線且 romanizer 可用)`);
    } finally {
      setBusy(false);
      setProgressText(null);
      setProgress(null);
    }
  };

  // ── 建立 session ──
  const createSession = async (withPreview: boolean) => {
    const lyrics = withPreview && preview
      ? preview.map(p => p.romaji).join('\n')
      : lyricsInput;
    if (!lyrics.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: songName, lyrics, dictionaryId, aligner }),
      });
      const data = await res.json();
      if (res.ok) {
        setSession(data);
        setPreview(null);
      } else {
        alert(data.error || '建立失敗');
      }
    } finally {
      setBusy(false);
    }
  };

  // ── 錄音控制 ──
  const handleRecordToggle = async () => {
    if (!isRecording) {
      if (takePreview) URL.revokeObjectURL(takePreview.url);
      setTakePreview(null);
      cancelCapture();
      startRecording();
    } else {
      const blob = await stopAndCapture();
      if (blob) {
        setTakePreview({ blob, url: URL.createObjectURL(blob) });
      }
    }
  };

  const discardPreview = () => {
    if (takePreview) URL.revokeObjectURL(takePreview.url);
    setTakePreview(null);
  };

  // ── 上傳 take,啟動背景管線 ──
  const acceptTake = async () => {
    if (!takePreview || !session) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('audio', takePreview.blob, 'take.wav');
      const res = await fetch(`/api/sessions/${session.id}/takes`, { method: 'POST', body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || '上傳失敗');
        return;
      }
      discardPreview();
      refreshSession(session.id);
    } finally {
      setBusy(false);
    }
  };

  // 送審:使用者選好範圍,送對齊處理(對齊+切割在對齊處理分頁做)
  const submitRange = async (takeId: string, start: number, end: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${session!.id}/takes/${takeId}/submit-range`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start, end }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || '送審失敗'); return; }
      refreshSession(session!.id);
    } finally {
      setBusy(false);
    }
  };

  const discardTake = async (takeId: string) => {
    await fetch(`/api/sessions/${session!.id}/takes/${takeId}/discard`, { method: 'POST' });
    refreshSession(session!.id);
  };

  // ── mora 全域 index → 「第X句 第k個音 (text)」──
  const moraLabel = useCallback((gi: number | null): string => {
    if (session === null || gi === null || gi < 0 || gi >= session.morae.length) return '—';
    const m = session.morae[gi];
    const posInLine = session.morae.slice(0, gi + 1).filter(x => x.line === m.line).length;
    return `第 ${m.line + 1} 句・第 ${posInLine} 個音 (${m.text})`;
  }, [session]);

  // ───────── 建立新歌曲畫面 ─────────
  if (!session) {
    const kanjiLines = kanjiInput.split('\n').map(l => l.trim()).filter(Boolean);
    return (
      <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px' }}>
        <div style={{ width: '100%', maxWidth: '720px', background: '#0f0f0f', border: '1px solid #333', borderRadius: '24px', padding: '32px' }}>
          <h2 style={{ margin: '0 0 8px' }}>開始唱一首歌</h2>
          <p style={{ color: '#888', fontSize: '13px', marginTop: 0 }}>
            貼上整首歌詞。若有<b style={{ color: '#eab308' }}>日文原文</b>,系統會用它來消除羅馬拼音的切分歧義
            (例如 <code>shinai</code> 是「し・な・い」還是「し・ん・あ・い」),建議填。
          </p>
          <input
            value={songName}
            onChange={(e) => setSongName(e.target.value)}
            placeholder="歌名(選填)"
            style={inputStyle}
          />
          <textarea
            value={kanjiInput}
            onChange={(e) => setKanjiInput(e.target.value)}
            placeholder={'日文原文(選填,對應行數,一句一行),例如:\n桜が咲く道を歩いて行く\n春風が頬を撫でていく'}
            rows={5}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
          <textarea
            value={lyricsInput}
            onChange={(e) => setLyricsInput(e.target.value)}
            placeholder={'羅馬拼音,一句一行,例如:\nsakura ga saku michi o aruite iku\nharukaze ga hoho o nadete iku\n…'}
            rows={8}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={runPreview}
              disabled={busy || !lyricsInput.trim()}
              style={btnStyle(busy || !lyricsInput.trim() ? '#333' : '#7c3aed')}
              title="使用日文原文 + 羅馬拼音做消歧,轉出 MMS 可直接使用的 mora-exact 羅馬拼音"
            >
              🔧 轉換預覽(消歧)
            </button>
          </div>

          {progressText && (
            <div style={{ marginTop: '12px' }}>
              <div style={{ fontSize: '13px', color: '#c4b5fd', marginBottom: '8px' }}>
                {progressText} {progress !== null ? `${Math.round(progress * 100)}%` : ''}
              </div>
              <div style={{ position: 'relative', height: '6px', background: '#1a1a1a', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{
                  width: `${(progress ?? 0) * 100}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #7c3aed, #a78bfa)',
                  borderRadius: '3px',
                  transition: 'width 0.25s ease',
                }} />
              </div>
            </div>
          )}

          {preview && (
            <div style={{ marginTop: '20px', borderTop: '1px solid #2a2a2a', paddingTop: '16px' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: '15px' }}>
                消歧預覽(可修改)
                {previewScore !== null && (
                  <span style={{ marginLeft: '10px', fontSize: '12px', color: previewScore >= 0.8 ? '#22c55e' : previewScore >= 0.5 ? '#eab308' : '#ef4444' }}>
                    全域吻合 {Math.round(previewScore * 100)}%
                  </span>
                )}
              </h3>
              <p style={{ color: '#888', fontSize: '12px', margin: '0 0 12px' }}>
                已把日文與羅馬拼音全域對齊後按羅馬行數切回;分數低代表日文裡有沒被羅馬拼音涵蓋的內容(或多打)。
              </p>
              {coverageGap !== 0 && (
                <div style={{
                  background: '#2a1515', border: '1px solid #ef4444', borderRadius: '8px',
                  padding: '10px 14px', marginBottom: '12px', fontSize: '13px', color: '#fca5a5',
                }}>
                  ✗ 日文與羅馬拼音對不起來(差 {Math.abs(coverageGap)} 個音),請修正後重新轉換。
                  {coverageGap > 0 && (
                    <div style={{ marginTop: '4px' }}>
                      行內橘色波浪線標示的 {coverageExtraCount} 個音為漢字推測的讀音,羅馬拼音中沒有對應:
                      {coverageExtras.length > 0 && (
                        <div style={{ marginTop: '4px' }}>
                          {coverageExtras.map((e, i) => (
                            <span key={i} style={{ marginRight: '10px' }}>
                              <b style={{ color: '#f97316' }}>{e.token}</b> ← {e.src || '(來源不明)'}
                            </span>
                          ))}
                        </div>
                      )}
                      請確認讀音後加入羅馬拼音,或修正日文原文。
                    </div>
                  )}
                  {coverageGap < 0 && (
                    <div style={{ marginTop: '4px' }}>
                      羅馬拼音比漢字讀音多 {-coverageGap} 個音,部分音無法對應到漢字 — 請檢查羅馬拼音。
                    </div>
                  )}
                </div>
              )}
              {preview.map((p, i) => (
                <div key={i} style={{ marginBottom: '10px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: '12px', color: '#666', width: '28px', paddingTop: '12px' }}>#{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <KanjiLine text={kanjiLines[i] ?? ''} highlights={coverageExtras.filter(e => e.line === i).map(e => e.src)} />
                    <MoraeInput
                      value={p.romaji}
                      onChange={(v) => {
                        const nv = [...preview];
                        nv[i] = { ...nv[i], romaji: v };
                        setPreview(nv);
                      }}
                      phonemes={phonemeList}
                      ignore={ignoreList}
                      rules={moraRules}
                      markedIndices={p.marked}
                      onValidation={(val) => setPreviewValid(prev => ({ ...prev, [i]: val }))}
                    />
                  </div>
                </div>
              ))}
              <button onClick={() => createSession(true)} disabled={busy} style={btnStyle('#16a34a')}>
                {previewHasInvalid || coverageGap !== 0 ? '✓ 仍要建立(我有確認過)' : '✓ 使用消歧結果建立'}
              </button>
            </div>
          )}
        </div>

        {sessionList.length > 0 && (
          <div style={{ width: '100%', maxWidth: '720px', marginTop: '24px', background: '#0f0f0f', border: '1px solid #333', borderRadius: '24px', padding: '24px 32px' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: '15px', color: '#aaa' }}>最近的歌曲</h3>
            {sessionList.map((s) => (
              <div
                key={s.id}
                onClick={async () => {
                  const res = await fetch(`/api/sessions/${s.id}`);
                  if (res.ok) { setSession(await res.json()); setTakePreview(null); }
                }}
                style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 8px', cursor: 'pointer', borderTop: '1px solid #222', color: '#ccc' }}
              >
                <span>{s.name}</span>
                <span style={{ fontSize: '12px', color: '#777' }}>
                  {s.doneLines}/{s.totalLines} 句 · {s.coveredMorae}/{s.totalMorae} 音
                  {s.pendingTakes > 0 && <span style={{ color: '#f97316' }}> · {s.pendingTakes} 段待確認</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ───────── 錄音主畫面 ─────────
  const allDone = session.cursor >= session.morae.length;
  const cursorText = allDone ? '整首完成 🎉' : `下一個音:${moraLabel(session.cursor)}`;
  const activeTakes = session.takes.filter(t => t.status !== 'discarded');

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '8px 24px 24px' }}>
      <div style={{ maxWidth: '860px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <button onClick={() => { setSession(null); refreshList(); }} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '13px', padding: 0 }}>
              ← 返回歌曲清單
            </button>
            <h2 style={{ margin: '4px 0 0' }}>{session.name}</h2>
          </div>
          <div style={{ fontSize: '13px', color: '#888', textAlign: 'right' }}>
            <div>{cursorText}</div>
            <div>{session.covered.filter(Boolean).length}/{session.morae.length} 音</div>
          </div>
        </div>

        {/* 錄音控制條 */}
        <div style={{
          background: '#0f0f0f', border: `1px solid ${isRecording ? '#ef4444' : '#2a2a2a'}`,
          borderRadius: '14px', padding: '16px 20px', marginBottom: '16px',
          display: 'flex', alignItems: 'center', gap: '16px',
        }}>
          <button
            onClick={handleRecordToggle}
            disabled={busy || !canRecord || allDone}
            style={{
              width: '52px', height: '52px', borderRadius: '50%', border: 'none', flexShrink: 0,
              background: isRecording ? '#ef4444' : allDone ? '#333' : '#2563eb',
              cursor: (busy || !canRecord || allDone) ? 'not-allowed' : 'pointer',
              color: '#fff', fontSize: '20px',
            }}
          >
            {isRecording ? '■' : '●'}
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '14px' }}>
              {isRecording ? `🔴 錄音中(${cursorText}),可以連唱跨句` : allDone ? '整首已完成' : '按下 ● 開始錄下一段(從目前進度繼續)'}
            </div>
            {takePreview && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
                <audio controls src={takePreview.url} style={{ height: '32px', maxWidth: '320px' }} />
                <button onClick={acceptTake} disabled={busy} style={btnStyle('#2563eb')}>✓ 接受,背景處理</button>
                <button onClick={discardPreview} disabled={busy} style={btnStyle('#333')}>重錄</button>
              </div>
            )}
          </div>
        </div>

        {/* take 卡片:辨識 → 選範圍 → 送審(MMS 對齊在這跑,完成後自動進對齊處理) */}
        {activeTakes.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            {activeTakes.map(take => (
              <TakeCard
                key={take.id}
                take={take}
                morae={session.morae}
                moraeCount={session.morae.length}
                busy={busy}
                onSubmit={submitRange}
                onDiscard={discardTake}
              />
            ))}
          </div>
        )}

        {/* 歌詞進度 */}
        {session.lines.map((line, li) => {
          const prog = session.lineProgress[li];
          const ratio = prog.total > 0 ? prog.covered / prog.total : 0;
          const isCursorLine = !allDone && session.cursor < session.morae.length && session.morae[session.cursor]?.line === li;
          return (
            <div key={li} style={{
              background: '#0f0f0f',
              border: `1px solid ${isCursorLine ? '#2563eb' : '#222'}`,
              borderRadius: '10px',
              padding: '12px 16px',
              marginBottom: '8px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '14px', color: ratio === 1 ? '#22c55e' : '#ddd' }}>{line.lyric}</span>
                <span style={{ fontSize: '12px', color: '#777' }}>
                  {prog.covered}/{prog.total} 音{ratio === 1 && ' ✓'}
                </span>
              </div>
              <div style={{ background: '#1a1a1a', borderRadius: '3px', height: '4px', marginTop: '8px', overflow: 'hidden' }}>
                <div style={{ width: `${ratio * 100}%`, height: '100%', background: ratio === 1 ? '#22c55e' : '#2563eb' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────── kanji 行(顯示在羅馬行上面;mismatch 的漢字橘色高亮)─────────
function KanjiLine({ text, highlights }: { text: string; highlights: string[] }) {
  const marks: [number, number][] = [];
  const nt = text.normalize('NFKC');
  for (const h of highlights) {
    if (!h) continue;
    const nh = h.normalize('NFKC');
    let idx = nt.indexOf(nh);
    while (idx >= 0) {
      marks.push([idx, idx + nh.length]);
      idx = nt.indexOf(nh, idx + 1);
    }
  }
  if (marks.length === 0) {
    return nt ? <div style={{ fontSize: '13px', color: '#888', marginBottom: '3px' }}>{nt}</div> : null;
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m]);
  }
  const parts: React.ReactNode[] = [];
  let pos = 0;
  merged.forEach(([s, e], i) => {
    if (s > pos) parts.push(<span key={`t${i}`}>{nt.slice(pos, s)}</span>);
    parts.push(
      <span key={`m${i}`} style={{ color: '#f97316', textDecoration: 'underline wavy #f97316', textUnderlineOffset: '3px' }}>
        {nt.slice(s, e)}
      </span>
    );
    pos = e;
  });
  if (pos < nt.length) parts.push(<span key="tail">{nt.slice(pos)}</span>);
  return <div style={{ fontSize: '13px', color: '#888', marginBottom: '3px' }}>{parts}</div>;
}


// 與 services/romaji-mora.js 同規則的 mora 計數已移除 — 由 /api/romanize_mora 回 lineCounts

// ───────── take 卡片:辨識 → 選範圍 → 送審 ─────────
function TakeCard({
  take, morae, moraeCount, busy, onSubmit, onDiscard,
}: {
  take: Take;
  morae: { line: number; text: string }[];
  moraeCount: number;
  busy: boolean;
  onSubmit: (takeId: string, start: number, end: number) => void;
  onDiscard: (takeId: string) => void;
}) {
  const [start, setStart] = useState<number>(take.start ?? 0);
  const [end, setEnd] = useState<number>(take.end ?? 0);

  useEffect(() => {
    if (take.status === 'confirm') {
      setStart(take.start ?? 0);
      setEnd(take.end ?? 0);
    }
  }, [take.status, take.start, take.end]);

  const info = TAKE_STATUS[take.status];

  return (
    <div style={{
      background: '#111318',
      border: `1px solid ${take.status === 'confirm' ? '#f97316' : '#2a2a2a'}`,
      borderRadius: '12px',
      padding: '14px 18px',
      marginBottom: '10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', color: '#999' }}>{take.filename}</span>
        <span style={{ fontSize: '12px', color: info.color }}>{info.label}</span>
      </div>

      {take.status === 'confirm' && (
        <>
          {/* 候選區間下拉 */}
          {take.candidates && take.candidates.length > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <label style={{ fontSize: '12px', color: '#888', display: 'block', marginBottom: '4px' }}>
                偵測到的可能位置(依母音吻合度排序)
              </label>
              <select
                value={take.candidates.findIndex(c => c.start === start && c.end === end)}
                onChange={(e) => {
                  const i = Number(e.target.value);
                  if (i >= 0) { setStart(take.candidates![i].start); setEnd(take.candidates![i].end); }
                }}
                style={{ ...selectStyle, maxWidth: '100%', width: '100%', padding: '8px' }}
              >
                {!take.candidates.some(c => c.start === start && c.end === end) && (
                  <option value={-1}>✎ 手動調整中:{morae[start]?.text} → {morae[end]?.text}</option>
                )}
                {take.candidates.map((c, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? '⭐ ' : ''}起點 #{c.start + 1}「{morae[c.start]?.text}」 → 終點 #{c.end + 1}「{morae[c.end]?.text}」 · {Math.round(c.score * 100)}%
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 可滑動歌詞條(點起點/終點 chip 出現微調箭頭) */}
          <MoraStrip
            morae={morae}
            start={start}
            end={end}
            onNudge={(which, delta) => {
              if (which === 'start') setStart(Math.max(0, Math.min(end, start + delta)));
              else setEnd(Math.max(start, Math.min(moraeCount - 1, end + delta)));
            }}
          />
          <div style={{ fontSize: '11px', color: '#555', marginBottom: '8px' }}>
            點綠框(起點)或橘框(終點)可左右微調
          </div>

          <audio controls src={`/upload_segments/${take.filename}`} style={{ height: '30px', maxWidth: '320px', display: 'block', marginBottom: '10px' }} />

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => onSubmit(take.id, start, end)} disabled={busy} style={btnStyle('#16a34a')}>
              ✓ 送審(MMS 對齊後送對齊處理,約 10~20 秒)
            </button>
            <button onClick={() => onDiscard(take.id)} disabled={busy} style={btnStyle('#333')}>
              丟棄
            </button>
          </div>
        </>
      )}

      {take.status === 'asr' && (
        <div style={{ fontSize: '12px', color: '#666' }}>辨識中,你可以繼續錄下一段,好了會自動出現在這裡</div>
      )}
      {take.status === 'aligning' && (
        <div style={{ fontSize: '12px', color: '#3b82f6' }}>MMS 對齊中(約 10~20 秒),完成後自動送到「對齊處理」分頁</div>
      )}
      {take.status === 'ready' && (
        <div style={{ fontSize: '12px', color: '#666' }}>已送審 → 到「<b>對齊處理</b>」分頁審核切割</div>
      )}
      {take.status === 'error' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: '#ef4444' }}>{take.error}</span>
          <button onClick={() => onDiscard(take.id)} style={btnStyle('#333')}>移除</button>
        </div>
      )}
    </div>
  );
}

// ───────── 可滑動歌詞條:標出起訖區間;點起點/終點 chip 浮出微調箭頭 ─────────
function MoraStrip({ morae, start, end, onNudge }: {
  morae: { line: number; text: string }[];
  start: number;
  end: number;
  onNudge: (which: 'start' | 'end', delta: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const startChipRef = useRef<HTMLSpanElement>(null);
  const [editing, setEditing] = useState<'start' | 'end' | null>(null);

  // 切換區間時,把起點 chip 捲到視窗中間
  useEffect(() => {
    startChipRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [start, end]);

  // 顯示窗:起點前 8 個 ~ 終點後 8 個
  const w0 = Math.max(0, start - 8);
  const w1 = Math.min(morae.length, end + 9);
  const items = morae.slice(w0, w1);

  return (
    <div
      ref={scrollRef}
      style={{
        display: 'flex',
        gap: '4px',
        overflowX: 'auto',
        padding: '26px 4px 10px', // 上方留空間給浮出的微調箭頭
        marginBottom: '6px',
        background: '#0a0c10',
        borderRadius: '8px',
        border: '1px solid #1e1e1e',
        WebkitMaskImage: 'linear-gradient(to right, transparent, black 32px, black calc(100% - 32px), transparent)',
        maskImage: 'linear-gradient(to right, transparent, black 32px, black calc(100% - 32px), transparent)',
        whiteSpace: 'nowrap',
      }}
    >
      {items.map((m, i) => {
        const gi = w0 + i;
        const inRange = gi >= start && gi <= end;
        const isStart = gi === start;
        const isEnd = gi === end;
        const isHandle = isStart || isEnd;
        const thisEditing = isStart ? editing === 'start' : editing === 'end';
        const color = isStart ? '#22c55e' : '#fb923c';
        return (
          <span key={gi} style={{ position: 'relative', display: 'inline-block' }}>
            {/* 浮出的微調箭頭工具列(點 chip 才出現) */}
            {isHandle && thisEditing && (
              <span style={{
                position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
                display: 'flex', gap: '2px', marginBottom: '2px', zIndex: 5,
              }}>
                <button
                  onClick={(e) => { e.stopPropagation(); onNudge(isStart ? 'start' : 'end', -1); }}
                  style={{ ...arrowBtnStyle, color }}
                >‹</button>
                <button
                  onClick={(e) => { e.stopPropagation(); onNudge(isStart ? 'start' : 'end', 1); }}
                  style={{ ...arrowBtnStyle, color }}
                >›</button>
              </span>
            )}
            <span
              ref={isStart ? startChipRef : undefined}
              title={`#${gi + 1} · 第 ${m.line + 1} 句${isHandle ? '(點擊微調)' : ''}`}
              onClick={isHandle ? () => setEditing(thisEditing ? null : (isStart ? 'start' : 'end')) : undefined}
              style={{
                display: 'inline-block',
                padding: '4px 8px',
                borderRadius: '6px',
                fontSize: '13px',
                fontFamily: 'monospace',
                cursor: isHandle ? 'pointer' : 'default',
                userSelect: 'none',
                background: thisEditing
                  ? (isStart ? 'rgba(34,197,94,0.25)' : 'rgba(251,146,60,0.25)')
                  : inRange ? 'rgba(56,189,248,0.14)' : 'transparent',
                color: inRange ? '#e2e8f0' : '#555',
                border: isHandle ? `1px solid ${color}` : '1px solid transparent',
              }}
            >
              {m.text}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const arrowBtnStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #333',
  borderRadius: '4px',
  padding: '0 7px',
  fontSize: '14px',
  lineHeight: '20px',
  cursor: 'pointer',
  fontFamily: 'monospace',
};

const selectStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #444',
  borderRadius: '6px',
  color: '#fff',
  padding: '6px 8px',
  fontSize: '12px',
  maxWidth: '260px',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1a1a1a',
  border: '1px solid #444',
  borderRadius: '8px',
  color: '#fff',
  padding: '10px 12px',
  fontSize: '14px',
  marginBottom: '12px',
  boxSizing: 'border-box',
};

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    fontSize: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}
