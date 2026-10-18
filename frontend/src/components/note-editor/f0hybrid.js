// F0 點級混合模式:auto 骨架 + 手動點 + 靜音(✗)標記
// 點旗標:
//   manual: true  使用者碰過/新增的點 — 不隨骨架重算;音符變動時掛著的幾何跟隨(僅時間,音高留原位 — 使用者裁定)
//   muted:  true  被使用者刪掉的自動點 — 曲線跳過它(F0Editor 顯示 ✗),骨架重算後近端匹配重新掛回;刪掉 ✗ = 復原
// 曲線/匯出一律用 activeF0() 過濾掉 muted。
import { genAutoF0 } from './f0auto.js';
import { ensureF0Id, notePhSplit, isVowelPh } from './project.js';

const EPS_M = 0.008;   // ✗ 對應骨架點的匹配窗(8ms)
const EPS_C = 1e-6;    // 涵蓋判定容差

export function activeF0(f0) {
  return (f0 || []).filter((p) => !p.muted);
}

/** 涵蓋 t 的音符 id(邊界歸 start 較後者);沒有回 null */
export function coverNoteId(notes, t) {
  const n = coverNote(notes, t);
  return n ? n.id : null;
}

// 涵蓋 t 的音符(邊界歸 start 較後者,與 dragTransform 慣例一致)
function coverNote(notes, t) {
  let best = null;
  for (const n of notes) {
    if (n.start - EPS_C <= t && t <= n.start + n.dur + EPS_C && (!best || n.start > best.start)) best = n;
  }
  return best;
}

/** 樂句劃分(=F0 線斷點:音符間有縫就斷)→ [{t0, t1, ids}] */
export function phrases(notes) {
  const sorted = [...notes].filter((n) => n.dur > 0).sort((a, b) => a.start - b.start);
  const out = [];
  let cur = null;
  for (const n of sorted) {
    if (cur && n.start - cur.t1 > EPS_C) { out.push(cur); cur = null; }
    if (!cur) cur = { t0: n.start, t1: n.start + n.dur, ids: [] };
    cur.t1 = Math.max(cur.t1, n.start + n.dur);
    cur.ids.push(n.id);
  }
  if (cur) out.push(cur);
  return out;
}

/** 樂句內容指紋(音符幾何+歌詞+phDurs+區間內 active F0 點)— 播放時比對「這句動過沒」 */
export function phraseHash(ph, notes, f0Active) {
  const ns = ph.ids
    .map((id) => notes.find((n) => n.id === id))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .map((n) => `${n.start.toFixed(4)},${n.dur.toFixed(4)},${n.midi},${n.word},${(n.phDurs || []).map((d) => d.toFixed(4)).join('+')}`);
  const pts = f0Active
    .filter((p) => p.t >= ph.t0 - 1e-6 && p.t <= ph.t1 + 1e-6)
    .map((p) => `${p.t.toFixed(4)}:${p.f.toFixed(2)}:${p.kind}`);
  return ns.join('|') + '#' + pts.join('|');
}

/**
 * 音符變動後重算整條曲線。
 * 手動點存**對錨音符的秒偏移**(anchorId + off;end role 對音符尾 offEnd;t 永遠推導)
 * → 音符與 F0 可原子更新;音符伸縮時過渡點不會飛走(偏移不隨 dur 縮放,與自動產生器行為一致)。
 * @param notes  新音符
 * @param f0Prev 舊 f0(含 manual/muted 旗標)
 */
export function reconcileF0(notes, f0Prev) {
  const manualPts = [];
  const mutedPts = [];
  for (const p of f0Prev || []) {
    if (!p.manual && !p.muted) continue; // auto 點不帶:骨架重算就是它的新生
    if (p.manual) {
      let np = { ...p };
      const anchor = p.anchorId ? notes.find((n) => n.id === p.anchorId) : null;
      if (anchor) {
        // 位置=對錨音符的**秒偏移**(off;end role 對音符尾 offEnd)— 不隨 dur 縮放
        // (rel 比例存法會讓過渡點在音符伸縮時飛走;自動產生器的過渡偏移也是夾限秒數,行為對齊)
        const fromEnd = p.role === 'end';
        const base = anchor.start + (fromEnd ? anchor.dur : 0);
        let off = Number.isFinite(p.off) ? p.off
          : Number.isFinite(p.rel) ? p.rel * anchor.dur // 舊 rel 資料一次性換算
          : p.t - base;
        np.off = off;
        np.rel = undefined;
        np.t = Math.max(0, base + off);
      } else {
        // 錨沒了:改掛現在涵蓋它的音符(沒有就保持絕對、無錨)
        const nn = coverNote(notes, p.t);
        if (nn) {
          np.anchorId = nn.id;
          np.rel = nn.dur > EPS_C ? (p.t - nn.start) / nn.dur : 0;
          np.t = p.t;
        } else {
          np.anchorId = null;
          np.rel = undefined;
        }
      }
      manualPts.push(np);
    } else {
      mutedPts.push({ ...p });
    }
  }
  // 骨架重算;✗ 用 anchorId+role 精確回掛(近端 8ms fallback 給舊資料);手動點同 role → 骨架讓位
  // ---- 骨架先算(修復/壓制都要對著它) ----
  const skelRaw = genAutoF0(notes);
  const dbg = { supRole: 0, supNear: 0, retag: 0, dup: 0 };
  // ---- legacy 修復:手動點帶 role 但錨被舊 bug 重抓過 → 依「同 role 最近骨架點」重貼錨(保留使用者 f/t) ----
  for (const m of manualPts) {
    if (!m.role || !m.anchorId) continue;
    const cands = skelRaw.filter((s2) => s2.role === m.role);
    if (!cands.length) continue;
    const near = cands.reduce((a, b) => (Math.abs(b.t - m.t) < Math.abs(a.t - m.t) ? b : a));
    if (near.anchorId !== m.anchorId && Math.abs(near.t - m.t) < 0.5) {
      m.anchorId = near.anchorId;
      m.off = m.t - (near.start + (m.role === 'end' ? (notes.find((n) => n.id === m.anchorId)?.dur ?? 0) : 0));
      dbg.retag++;
    }
  }
  // ---- 去重:同 anchorId+role、或位置 ±1ms 的複本只留一顆(歷史 bug 累積) ----
  const seen = [];
  const deduped = [];
  for (const m of manualPts) {
    const an = m.anchorId ? notes.find((n) => n.id === m.anchorId) : null;
    if (an) {
      const fromEnd = m.role === 'end';
      m.off = Number.isFinite(m.off) ? m.off : m.t - (an.start + (fromEnd ? an.dur : 0));
      m.t = Math.max(0, an.start + (fromEnd ? an.dur : 0) + m.off);
    }
    const dup = seen.find((s2) =>
      (s2.anchorId && m.anchorId && s2.anchorId === m.anchorId && s2.role && m.role && s2.role === m.role) ||
      Math.abs(s2.t - m.t) < 1e-3);
    if (dup) { dbg.dup++; continue; }
    seen.push(m);
    deduped.push(m);
  }
  // ---- 骨架:✗ 回掛(角色優先) + 孿生讓位(role 精確或近端) ----
  const skel = skelRaw.map((p) => {
    const q = p.anchorId && p.role
      ? mutedPts.find((m) => m.anchorId === p.anchorId && m.role === p.role)
        || mutedPts.find((m) => Math.abs(m.t - p.t) < EPS_M)
      : mutedPts.find((m) => Math.abs(m.t - p.t) < EPS_M);
    if (q) return { ...p, muted: true, id: q.id ?? p.id };
    const twin = deduped.find((m) =>
      (p.anchorId && p.role && m.anchorId === p.anchorId && m.role === p.role) ||
      Math.abs(m.t - p.t) < EPS_M);
    if (twin) {
      if (p.anchorId && p.role && twin.anchorId === p.anchorId && twin.role === p.role) dbg.supRole++;
      else dbg.supNear++;
      return null;
    }
    return { ...p, id: p.id ?? `f0:${p.anchorId}:${p.role}` };
  }).filter(Boolean);
  if (dbg.supRole || dbg.supNear || dbg.retag || dbg.dup || deduped.length) {
    console.log(`[F0 Recon] 骨架=${skel.length} 手動=${deduped.length}(壓孿生 role=${dbg.supRole} 近端=${dbg.supNear}) 重貼錨=${dbg.retag} 去重=${dbg.dup} ✗=${mutedPts.length}`);
  }
}

/** 母音群組分段 + F0 排程點(合成預覽用):母音之間不斷(跨音符連續),子音/休止才斷
 *  回傳 keySoundPlaySequence 的 items:[{t, dur, rates:[[dt, rate]...]}] */
export function synthItems(notes, curve, base, table = undefined, phMap = undefined, phRev = undefined) {
  const items = [];
  let cur = null; // 進行中的母音群組 { t0, t1 }
  const flush = () => {
    if (cur && cur.t1 - cur.t0 > 0.02) {
      const pts = [[cur.t0, curve.length ? f0Val(curve, cur.t0) : 0]];
      for (const p of curve) if (p.t > cur.t0 + 1e-4 && p.t < cur.t1 - 1e-4) pts.push([p.t, p.f]);
      pts.push([cur.t1, curve.length ? f0Val(curve, cur.t1) : 0]);
      items.push({ t: cur.t0, dur: cur.t1 - cur.t0, rates: pts.map(([t, f]) => [t - cur.t0, Math.max(0.01, f / base)]) });
    }
    cur = null;
  };
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    if (cur && n.start > cur.t1 + 1e-3) flush(); // 休止 → 斷
    const phs = notePhSplit(n, table, phMap, phRev);
    let t = n.start;
    for (const { ph, dur } of phs) {
      if (isVowelPh(ph)) {
        if (!cur) cur = { t0: t, t1: t };
        cur.t1 = t + dur;
      } else {
        flush(); // 子音 → 斷(子音時長內靜音,下一個母音重新起音)
      }
      t += dur;
    }
  }
  flush();
  return items;
}

// 曲線取值(線性內插)
function f0Val(curve, t) {
  if (!curve.length) return 0;
  if (t <= curve[0].t) return curve[0].f;
  if (t >= curve[curve.length - 1].t) return curve[curve.length - 1].f;
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i].t) {
      const a = curve[i - 1], b = curve[i];
      return a.f + (b.f - a.f) * ((t - a.t) / Math.max(1e-9, b.t - a.t));
    }
  }
  return curve[curve.length - 1].f;
}
