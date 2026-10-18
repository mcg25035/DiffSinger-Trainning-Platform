// 專案資料模型 + .ds 匯出/匯入
// note: { id, start(秒), dur(秒), midi, word: 'a', slur: bool }
//   phonemes 由 word 衍生：word 以空白拆分（預設 'a'）；
//   各 phoneme 絕對時長存 note.phDurs（秒），缺省用「子音固定0.1s、母音分剩餘」啟發式；
//   note 長度變動時差額由母音吸收（子音不動）
// f0 曲線: [ { t(秒), f(Hz) } ]，按時間排序；無聲區間沒有點
import { midiToName, nameToMidi, nextId } from './music.js';

export function emptyProject() {
  return { tempo: 120, gridDiv: 8, snap: true, snapNotes: true, ppb: 80, kh: 14, notes: [], f0: [], f0Manual: false, phonemes: [], phMap: null, phRev: null };
}

/**
 * word → phoneme tokens。
 * table: 音素清單（string[]）；phMap: 羅馬字→音素序列（{wa:'w a',...}，MFA mapping 格式）
 * 有 phMap：對 keys 貪婪最長匹配（促音 kk/tt→cl），命中即展開成音素序列（wa→w,a）。
 * 有空白：手動切完，每個 token 若在 phMap 也照樣展開（"wa sa"→w,a,s,a）。
 * 僅有 table：對清單貪婪最長匹配。
 * 皆無：啟發式「聲母+韻母」。
 * 匹配不到的殘段一律送回啟發式，保證切得完。
 */
export function tokenizePhonemes(word, table, phMap, phRev) {
  const w = (word || '').trim();
  if (!w) return [];
  // 走 phMap 展開後：以 reverse_mapping 轉回羅馬 phoneme（ds/顯示一律用羅馬；IPA 只是切分參考）
  const toRoma = (phs) => (phRev ? phs.map((ph) => phRev[ph] ?? ph) : phs);
  const expand = (m) => toRoma(String(m).split(/\s+/).filter(Boolean));
  if (/\s/.test(w)) {
    const toks = w.split(/\s+/).filter(Boolean);
    if (phMap && typeof phMap === 'object') {
      const out = [];
      for (const t of toks) {
        const m = phMap[t] ?? phMap[t.toLowerCase()];
        if (typeof m === 'string') out.push(...expand(m));
        else out.push(t);
      }
      return out;
    }
    return toks;
  }
  if (phMap && typeof phMap === 'object') {
    const keys = Object.keys(phMap).map((k) => [k, k.toLowerCase()]).sort((a, b) => b[1].length - a[1].length);
    const out = [];
    let s = w, rest = '', i = 0;
    const lower = s.toLowerCase();
    while (i < lower.length) {
      // 羅馬字促音寫法（gakkou 的 kk、kitte 的 tt）→ cl 映射的 phoneme
      const clMap = phMap.cl ?? phMap.CL;
      if (typeof clMap === 'string' && i + 1 < lower.length &&
        lower[i] === lower[i + 1] && /[bcdfghjklmnpqrstvwxz]/.test(lower[i])) {
        if (rest) { out.push(...heuristicTokens(rest)); rest = ''; }
        out.push(...expand(clMap));
        i += 1;
        continue;
      }
      const hit = keys.find(([, lk]) => lower.startsWith(lk, i));
      if (hit) {
        if (rest) { out.push(...heuristicTokens(rest)); rest = ''; }
        out.push(...expand(phMap[hit[0]]));
        i += hit[1].length;
      } else {
        rest += s[i];
        i++;
      }
    }
    if (rest) out.push(...heuristicTokens(rest));
    return out;
  }
  if (Array.isArray(table) && table.length) {
    const byLen = [...table].map((t) => String(t).toLowerCase()).sort((a, b) => b.length - a.length);
    const out = [];
    let s = w, rest = '', i = 0;
    const lower = s.toLowerCase();
    while (i < lower.length) {
      // 羅馬字促音寫法（gakkou 的 kk、kitte 的 tt）→ 對應表中的 cl
      if (byLen.includes('cl') && i > 0 && i + 1 < lower.length &&
        lower[i] === lower[i + 1] && /[bcdfghjklmnpqrstvwxz]/.test(lower[i])) {
        if (rest) { out.push(...heuristicTokens(rest)); rest = ''; }
        out.push('cl');
        i += 1;
        continue;
      }
      const hit = byLen.find((t) => lower.startsWith(t, i));
      if (hit) {
        if (rest) { out.push(...heuristicTokens(rest)); rest = ''; }
        out.push(s.slice(i, i + hit.length));
        i += hit.length;
      } else {
        rest += s[i];
        i++;
      }
    }
    if (rest) out.push(...heuristicTokens(rest));
    return out;
  }
  return heuristicTokens(w);
}

// 啟發式切：聲母 = zh/ch/sh 或單一非母音字母；韻母 = 母音串 + 可選尾音 n/ng/r；多音節依序消費
function heuristicTokens(w) {
  const out = [];
  let s = w;
  while (s.length) {
    const om = s.match(/^(zh|ch|sh|[b-df-hj-np-tv-z])/i);
    const onset = om ? om[0] : '';
    const rest = s.slice(onset.length);
    const fm = rest.match(/^[aeiouüv]+(?:n[g]?|r)?/i);
    if (fm) {
      if (onset) out.push(onset);
      out.push(fm[0]);
      s = rest.slice(fm[0].length);
    } else {
      // 沒找到母音：剩下的整團當一個 phoneme（避免卡死）
      if (onset || rest) out.push(onset + rest);
      break;
    }
  }
  return out;
}

/** word → phonemes（含時長，均分；正式切分請用 notePhSplit） */
export function wordToPhonemes(word, dur, table, phMap, phRev) {
  const toks = tokenizePhonemes(word, table, phMap, phRev);
  const list = toks.length ? toks : ['a'];
  const d = dur / list.length;
  return list.map((ph) => ({ ph, dur: d }));
}

/** word → 母音（最後一個母音串，split 後顆用；無母音原樣返回，如 cl 促音） */
export function wordVowel(w) {
  const ms = [...String(w).matchAll(/[aeiouüv]+(?:n[g]?|r)?/gi)];
  return ms.length ? ms[ms.length - 1][0].toLowerCase() : w;
}

/**
 * 長度權重分類：該 phoneme 是否可拉長（吸收 note 大部分時長）。
 * - 含母音（a/i/u/e/o/v/ü）→ 可拉長（ka/shi 這類音節 phoneme 也算）
 * - 撥音 n/nn/N（日文 moraic nasal，自己一個音拍）→ 可拉長
 * - 其他無母音 token（w/g 聲母、cl 促音）→ 固定短時長（瞬態）
 */
/** phoneme → 羅馬字顯示（MFA mapping 的 reverse_mapping；查不到原樣顯示） */
export function phDisplay(ph, phRev) {
  if (phRev && phRev[ph]) return phRev[ph];
  return ph;
}

const MORAIC = new Set(['n', 'nn', 'N', 'ɴ']);
export function isVowelPh(ph) {
  const t = (ph || '').toLowerCase();
  return /[aeiouvüɯ]/.test(t) || MORAIC.has(t);
}

// 瞬態 phoneme 預設長度（秒）。先驗來自真實標注資料
// (DiffSinger-Dataset/cheesege/cantabile/label_phoneme, 174 首歌) 的各 phoneme 中位數；
// 查不到用 CONS_DUR。子音是瞬態發音，note 再長也不會跟著變長。
const CONS_DUR = 0.07;
const PH_PRIOR = {
  // 羅馬字/通用
  p: 0.036, f: 0.045, r: 0.05, t: 0.06, d: 0.06, n: 0.06, b: 0.059, g: 0.062,
  m: 0.07, k: 0.07, w: 0.071, y: 0.08, h: 0.08, ts: 0.08, cl: 0.08, z: 0.088,
  ny: 0.056, my: 0.07, hy: 0.094, gy: 0.1, ch: 0.103, s: 0.117, sh: 0.127, ky: 0.14,
  // IPA（japanese_mfa mapping 展開後的 token）
  'ɡ': 0.062, 'ɕ': 0.127, 'tɕ': 0.103, 'dʑ': 0.11, 'dz': 0.088,
  'ɾ': 0.05, 'ç': 0.094, 'ɸ': 0.045, 'c': 0.14, 'ɟ': 0.1, 'ɲ': 0.056,
  'ʔ': 0.08, 'j': 0.08, 'bʲ': 0.059, 'pʲ': 0.036, 'mʲ': 0.07, 'ɾʲ': 0.05,
};
// 子音總時長不得超過 note 的此比例（極短音符保護；避免視覺上一半一半）
const CONS_MAX_FRAC = 0.35;
// 每個 phoneme 的最小時長
const PH_MIN = 0.02;

/**
 * 預設切分（絕對秒數）：瞬態 phoneme 各取先驗中位數（PH_PRIOR，查不到 0.07s，
 * 總和超過 note 35% 時等比壓縮），可拉長 phoneme 平分剩餘。
 * 全是瞬態、或音符極短時退化成均分。
 */
export function defaultPhDurs(tokens, dur) {
  const n = tokens.length;
  const isV = tokens.map(isVowelPh);
  if (!isV.some(Boolean)) return tokens.map(() => dur / n);
  let cons = tokens.map((t) => (isVowelPh(t) ? 0 : (PH_PRIOR[t] ?? PH_PRIOR[t.toLowerCase()] ?? CONS_DUR)));
  let consTotal = cons.reduce((a, b) => a + b, 0);
  const cap = dur * CONS_MAX_FRAC;
  if (consTotal > cap) cons = cons.map((c) => (c * cap) / consTotal);
  const rest = Math.max(0, dur - cons.reduce((a, b) => a + b, 0));
  const vCount = isV.filter(Boolean).length;
  const vDur = rest / vCount;
  if (vDur < PH_MIN) return tokens.map(() => dur / n);
  return tokens.map((t, i) => (isV[i] ? vDur : cons[i]));
}

/**
 * note → phoneme 切分（含時長）。
 * note.phDurs（各 phoneme 絕對秒數）數量吻合時優先使用；
 * 總和與 note.dur 不符（拉過音符）時，差額由母音依比例吸收（子音不動）。
 * 舊資料 phRatios → 視為比例乘上 dur 轉換。
 */
export function notePhSplit(note, table, phMap, phRev) {
  const toks = tokenizePhonemes(note.word, table, phMap, phRev);
  const list = toks.length ? toks : ['a'];
  const n = list.length;
  let durs = Array.isArray(note.phDurs) && note.phDurs.length === n &&
    note.phDurs.every((d) => Number.isFinite(d) && d > 0) ? [...note.phDurs] : null;
  if (!durs && Array.isArray(note.phRatios) && note.phRatios.length === n &&
    note.phRatios.every((r) => Number.isFinite(r) && r > 0)) {
    const s = note.phRatios.reduce((a, b) => a + b, 0);
    durs = note.phRatios.map((r) => (r / s) * note.dur);
  }
  if (durs) {
    // note 被拉長/縮短：差額由母音吸收，子音維持固定
    const isV = list.map(isVowelPh);
    let delta = note.dur - durs.reduce((a, b) => a + b, 0);
    if (Math.abs(delta) > 1e-6) {
      const vIdx = list.map((t, i) => i).filter((i) => isV[i]);
      if (vIdx.length) {
        const vSum = vIdx.reduce((a, i) => a + Math.max(durs[i], PH_MIN), 0);
        for (const i of vIdx) durs[i] = Math.max(PH_MIN, durs[i] + (delta * Math.max(durs[i], PH_MIN)) / vSum);
      } else {
        durs = durs.map((d) => Math.max(PH_MIN, d + delta / n));
      }
      // 最後微調：把四捨五入殘差塞回第一個母音（或第一個）
      const fix = note.dur - durs.reduce((a, b) => a + b, 0);
      const target = vIdx.length ? vIdx[0] : 0;
      durs[target] += fix;
    }
    return list.map((ph, i) => ({ ph, dur: durs[i] }));
  }
  return list.map((ph, i) => ({ ph, dur: defaultPhDurs(list, note.dur)[i] }));
}

/** 音符時間重疊區間 [{t0, t1}]（衝突區間；人聲同時只能一個音） */
export function conflictRanges(notes) {
  const sorted = sortNotes(notes);
  const ranges = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      // 吸附/貼上的浮點往返會讓「邊界相接」差 1e-16 級別,容差 1e-6s(遠小於最小格線)內視為相接
      if (sorted[j].start >= sorted[i].start + sorted[i].dur - 1e-6) break;
      const t0 = Math.max(sorted[i].start, sorted[j].start);
      const t1 = Math.min(sorted[i].start + sorted[i].dur, sorted[j].start + sorted[j].dur);
      if (t1 > t0 + 1e-6) ranges.push({ t0, t1 });
    }
  }
  // 合併相鄰/重疊的區間
  const merged = [];
  for (const r of ranges.sort((a, b) => a.t0 - b.t0)) {
    const last = merged[merged.length - 1];
    if (last && r.t0 <= last.t1) last.t1 = Math.max(last.t1, r.t1);
    else merged.push({ ...r });
  }
  return merged;
}

/** 確保 F0 點有穩定 id（拖曳追蹤用）；對物件就地賦值一次 */
export function ensureF0Id(p) {
  if (p.id == null) p.id = nextId('f0');
  return p.id;
}

export function sortNotes(notes) {
  return [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
}

// 依時間排序 F0 控制點，並補齊缺漏的 id/kind（確保拖曳追蹤穩定）
export function normalizeF0(points) {
  return [...points].sort((a, b) => a.t - b.t)
    .map((p) => ({ kind: 'line', ...p, id: p.id ?? nextId('f0') }));
}

/**
 * 把控制點展開成逐段幾何（Hermite 三次曲線）：
 *   [{ type:'line'|'cubic', t0,f0,t1,f1, m0,m1 }]
 * 切線由「點」決定：
 * - 圓曲點（curve）：該點切線 = 0（水平進出）→ 該點兩側永遠平滑，不會有單側折角
 * - 直線點（line）：保持該段割線斜率（硬角刻意保留）
 * 兩端皆直線點時退化成純直線。
 */
export function f0Pieces(points) {
  const pts = [...points].sort((a, b) => a.t - b.t);
  const pieces = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b.t <= a.t) continue;
    const slope = (b.f - a.f) / (b.t - a.t);
    // 只有「明確標示 line」才是直線；舊資料 kind 可能缺漏/異常，一律當平滑（與渲染一致）
    const m0 = a.kind === 'line' ? slope : 0;
    const m1 = b.kind === 'line' ? slope : 0;
    const isLine = a.kind === 'line' && b.kind === 'line';
    pieces.push({ type: isLine ? 'line' : 'cubic', t0: a.t, f0: a.f, t1: b.t, f1: b.f, m0, m1 });
  }
  return pieces;
}

// 取某秒的 F0（與畫線同一套幾何）
export function f0At(points, t) {
  if (!points.length) return 0;
  const pts = [...points].sort((a, b) => a.t - b.t);
  if (t <= pts[0].t) return pts[0].f;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].f;
  for (const pc of f0Pieces(pts)) {
    if (t < pc.t0 || t > pc.t1) continue;
    const u = (t - pc.t0) / (pc.t1 - pc.t0);
    if (pc.type === 'line') return pc.f0 + (pc.f1 - pc.f0) * u;
    const dt = pc.t1 - pc.t0;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * pc.f0 + (u3 - 2 * u2 + u) * pc.m0 * dt
         + (-2 * u3 + 3 * u2) * pc.f1 + (u3 - u2) * pc.m1 * dt;
  }
  return pts[pts.length - 1].f;
}

// 平順 FAR 格式化秒數（對齊範例 6 位小數）
function fmt(x) {
  return x.toFixed(6);
}

// text 欄位：把連續的 b/r 合併成 "br"（模擬範例檔行為），其餘照 ph_seq
function mergedText(phonemes) {
  const out = [];
  for (let i = 0; i < phonemes.length; i++) {
    if (phonemes[i] === 'b' && phonemes[i + 1] === 'r') {
      out.push('br');
      i++;
    } else {
      out.push(phonemes[i]);
    }
  }
  return out.join(' ');
}

// phoneme 分組容差（小於最短 phoneme 時長 ~0.021）
const NR_EPS = 0.005;

// 將整個專案轉成類似範例的 .ds 結構（含 F0 欄位擴充）
export function exportDS(project, { f0Timestep = 0.01 } = {}) {
  const notes = sortNotes(project.notes);
  const noteSeq = [];
  const noteDur = [];
  const isSlur = [];
  const phSeq = [];
  const phDur = [];

  let cursor = 0;
  const pushRest = (dur) => {
    if (dur <= 1e-9) return;
    noteSeq.push('rest');
    noteDur.push(fmt(dur));
    isSlur.push('0');
    phSeq.push('SP');
    phDur.push(fmt(dur));
  };

  for (const n of notes) {
    pushRest(n.start - cursor);
    noteSeq.push(midiToName(n.midi));
    noteDur.push(fmt(n.dur));
    isSlur.push(n.slur ? '1' : '0');
    for (const p of notePhSplit(n, project.phonemes, project.phMap, project.phRev)) {
      phSeq.push(p.ph);
      phDur.push(fmt(p.dur));
    }
    cursor = n.start + n.dur;
  }

  const totalDur = cursor;
  // F0：對曲線取樣（App 保證 f0 永遠有值——無手動編輯時為自動平滑曲線）
  const f0Seq = [];
  for (let t = f0Timestep / 2; t < totalDur; t += f0Timestep) {
    f0Seq.push(f0At(project.f0, t).toFixed(1));
  }

  return [
    {
      offset: 0,
      text: mergedText(phSeq),
      ph_seq: phSeq.join(' '),
      ph_dur: phDur.join(' '),
      note_seq: noteSeq.join(' '),
      note_dur: noteDur.join(' '),
      is_slur: isSlur.join(' '),
      f0_seq: f0Seq.join(' '),
      f0_timestep: String(f0Timestep),
      input_type: 'word',
    },
  ];
}

// 匯入 .ds → 專案資料
export function importDS(data) {
  const d = Array.isArray(data) ? data[0] : data;
  const noteSeq = d.note_seq.split(/\s+/);
  const noteDur = d.note_dur.split(/\s+/).map(Number);
  const slurs = (d.is_slur || '').split(/\s+/);
  const phSeq = (d.ph_seq || '').split(/\s+/);
  const phDur = (d.ph_dur || '').split(/\s+/).map(Number);

  let t = 0, pi = 0;
  const notes = [];
  for (let i = 0; i < noteSeq.length; i++) {
    const dur = noteDur[i];
    // 蒐集此音符（含 rest）的 phonemes（依其 duration 總和）
    const phones = [];
    let acc = 0;
    while (acc < dur - NR_EPS && pi < phSeq.length && (noteSeq[i] !== 'rest' || phSeq[pi] === 'SP')) {
      phones.push({ ph: phSeq[pi], dur: phDur[pi] });
      acc += phDur[pi];
      pi++;
    }
    if (noteSeq[i] === 'rest') { t += dur; continue; }
    notes.push({
      id: `imp_${i}`,
      start: t,
      dur,
      midi: nameToMidi(noteSeq[i]) ?? 60,
      word: phones.map((p) => p.ph).join(' '),
      phDurs: phones.length > 1 ? phones.map((p) => p.dur) : undefined,
      slur: slurs[i] === '1',
    });
    t += dur;
  }

  // F0 取樣點
  const f0 = [];
  if (d.f0_seq && d.f0_timestep) {
    const step = Number(d.f0_timestep);
    d.f0_seq.split(/\s+/).forEach((v, i) => {
      const f = Number(v);
      if (f > 0) f0.push({ t: i * step + step / 2, f });
    });
  }
  return { ...emptyProject(), notes, f0 };
}
