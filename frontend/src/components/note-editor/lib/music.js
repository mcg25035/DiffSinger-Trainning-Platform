// 音符名稱 <-> MIDI、頻率轉換與各種小工具

const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_TO_SHARP = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

export function midiToName(midi) {
  const n = NOTE_NAMES_SHARP[midi % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${n}${oct}`;
}

export function nameToMidi(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  let n = m[1].toUpperCase() + (m[2] || '');
  if (FLAT_TO_SHARP[n]) n = FLAT_TO_SHARP[n];
  const idx = NOTE_NAMES_SHARP.indexOf(n);
  if (idx < 0) return null;
  return (parseInt(m[3], 10) + 1) * 12 + idx;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

// 秒 <-> beat（拍），tempo = BPM
export function beatsToSec(beats, bpm) {
  return (beats * 60) / bpm;
}
export function secToBeats(sec, bpm) {
  return (sec * bpm) / 60;
}

// 吸附到格線（以拍為單位）
export function snapBeat(beat, gridDiv /*每拍幾格*/, enabled = true) {
  if (!enabled) return beat;
  const g = 1 / gridDiv;
  return Math.round(beat / g) * g;
}

export function isBlackKey(midi) {
  return [1, 3, 6, 8, 10].includes(midi % 12);
}

let _id = 0;
export function nextId(prefix = 'n') {
  return `${prefix}_${Date.now().toString(36)}_${_id++}`;
}
