// Realistic playable ranges for every instrument in the catalog, and a
// validator that flags generated notes an actual player couldn't play.
//
// Ranges are stored at SOUNDING pitch (MIDI numbers, middle C = C4 = 60) as
// { lo, comfortLo, comfortHi, hi }: lo/hi are hard physical limits (kept
// slightly conservative — these are parts for real players, not virtuoso
// showpieces); the comfort band is where most of a part should live.
//
// Parts for transposing instruments are WRITTEN above concert pitch, by the
// exact interval the part prompt asks for (see prompts.js / transpose.js):
// B♭ instruments +2 semitones, F +7, alto sax +9 — and tenor sax +2, because
// this app writes it only a major 2nd up (not the conventional 9th). So
// prompt guidance and validation both use written pitch = sounding + shift.

import { baseName } from "./instrMeta.js";
import { partMeasures } from "./partCheck.js";
import { headerOf, stitchBody } from "./chunking.js";

const R = (lo, comfortLo, comfortHi, hi) => ({ lo, comfortLo, comfortHi, hi });

export const SOUNDING_RANGES = {
  // Strings
  Violin: R(55, 55, 84, 91), // G3 up to G6 (top E-string ledger work capped)
  Viola: R(48, 48, 74, 81), // C3–A5
  Cello: R(36, 36, 67, 76), // C2–E5
  "Double Bass": R(28, 31, 50, 55), // E1–G3 (sounding; written as sounding here)
  Harp: R(36, 40, 89, 96),
  "Classical Guitar": R(40, 45, 72, 76), // E2 (low string) up
  // Brass
  "French Horn": R(41, 48, 72, 77),
  Trumpet: R(52, 55, 79, 82), // E3–Bb5 sounding
  Flugelhorn: R(52, 55, 77, 80),
  Trombone: R(40, 43, 67, 72), // E2–C5
  Tuba: R(29, 33, 57, 62), // F1–D4
  // Woodwinds
  Flute: R(60, 62, 91, 96), // C4–C7
  Piccolo: R(74, 79, 96, 103), // D5 up — never below the staff
  Oboe: R(58, 60, 84, 89), // Bb3–F6
  Clarinet: R(50, 52, 84, 91), // D3–G6 sounding
  Bassoon: R(34, 36, 65, 72), // Bb1–C5
  "English Horn": R(52, 54, 77, 81), // E3–A5 sounding
  "Alto Sax": R(49, 51, 75, 80), // Db3–Ab5 sounding
  "Tenor Sax": R(44, 46, 72, 76), // Ab2–E5 sounding
  // Percussion (pitched)
  Timpani: R(38, 41, 53, 55), // D2–G3 — kettle drums, narrow by nature
  Xylophone: R(65, 67, 91, 96),
  Marimba: R(48, 50, 89, 96),
  Vibraphone: R(53, 55, 84, 89), // F3–F6 exactly (standard 3-octave bars)
  Glockenspiel: R(79, 81, 96, 103),
  "Tubular Bells": R(60, 60, 77, 77), // C4–F5 — 1.5 octaves of tubes, hard limit
  // Keyboard
  Piano: R(28, 36, 96, 103),
  Harpsichord: R(29, 36, 84, 89),
  Organ: R(36, 40, 91, 96),
  Celesta: R(60, 62, 96, 103),
  // Voice
  Soprano: R(60, 62, 79, 81), // C4–A5
  "Mezzo-soprano": R(57, 58, 74, 77),
  Tenor: R(48, 50, 69, 72), // C3–C5
  Baritone: R(43, 45, 62, 65),
  Bass: R(40, 41, 60, 64), // E2–E4
  // Guitar / bass / electronic
  "Electric Guitar": R(40, 45, 79, 86),
  "Acoustic Guitar": R(40, 43, 74, 79),
  "Bass Guitar": R(28, 31, 53, 60), // E1 up
  Synthesizer: R(36, 40, 91, 96),
  "Electric Piano": R(33, 36, 91, 96),
};

// Written pitch sits this many semitones ABOVE sounding — must mirror the
// intervals buildPartPrompt asks for (and transpose.js key fifths).
export const WRITTEN_SHIFT = {
  Trumpet: 2, Flugelhorn: 2, Clarinet: 2, "Tenor Sax": 2,
  "French Horn": 7, "English Horn": 7,
  "Alto Sax": 9,
};

// ── Pitch formatting ──────────────────────────────────────────────────────────
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ABC_LETTER = ["C", "^C", "D", "^D", "E", "F", "^F", "G", "^G", "A", "^A", "B"];

// 60 → "C4"
export function midiToName(midi) {
  return SHARP_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

// 60 → "C", 72 → "c", 84 → "c'", 48 → "C,"  (ABC pitch token, sharps spelling)
export function midiToAbc(midi) {
  const pc = ((midi % 12) + 12) % 12;
  // ABC: uppercase = C4 octave, lowercase = C5 octave, then ' and , marks.
  const oct = Math.floor(midi / 12) - 1; // scientific octave
  const [acc, letter] = ABC_LETTER[pc].length === 2 ? [ABC_LETTER[pc][0], ABC_LETTER[pc][1]] : ["", ABC_LETTER[pc]];
  if (oct >= 5) return acc + letter.toLowerCase() + "'".repeat(oct - 5);
  return acc + letter + ",".repeat(4 - oct);
}

// ── Written range for one part ────────────────────────────────────────────────
// { lo, hi, comfortLo, comfortHi } each as { midi, name, abc }, or null when
// the instrument has no range data (fail open — never block generation).
export function writtenRangeInfo(instrName) {
  const base = baseName(instrName);
  const r = SOUNDING_RANGES[base];
  if (!r) return null;
  const shift = WRITTEN_SHIFT[base] || 0;
  const at = (m) => ({ midi: m + shift, name: midiToName(m + shift), abc: midiToAbc(m + shift) });
  return { lo: at(r.lo), hi: at(r.hi), comfortLo: at(r.comfortLo), comfortHi: at(r.comfortHi), shifted: shift !== 0 };
}

// ── Range validation of a generated part ──────────────────────────────────────
const BASE_ST = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// ABC pitch token → MIDI (key signature ignored — accounted for by the ±1
// tolerance in checkPartRange).
function midiOf(tok) {
  const m = tok.match(/^([_^=]*)([A-Ga-g])([,']*)$/);
  if (!m) return null;
  let v = 60 + BASE_ST[m[2].toUpperCase()] + (/[a-g]/.test(m[2]) ? 12 : 0);
  for (const a of m[1]) v += a === "^" ? 1 : a === "_" ? -1 : 0;
  for (const o of m[3]) v += o === "'" ? 12 : -12;
  return v;
}

// Every pitch in a measure — unlike the melody check, chord notes all count
// (a chord's bottom note can be unplayable even when its top is fine).
function measurePitches(measureStr) {
  const s = String(measureStr)
    .replace(/![^!]*!/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\{[^}]*\}/g, "");
  return [...s.matchAll(/[_^=]*[A-Ga-g][,']*/g)].map((m) => m[0]);
}

// Change an ABC pitch token by whole octaves: C, → C → c → c' …
function shiftTokenOctave(tok, octaves) {
  const m = tok.match(/^([_^=]*)([A-Ga-g])([,']*)$/);
  if (!m) return tok;
  const [, acc, letter, marks] = m;
  let n = /[a-g]/.test(letter) ? 1 : 0; // octave index relative to the uppercase (C4) octave
  for (const c of marks) n += c === "'" ? 1 : -1;
  n += octaves;
  const upper = letter.toUpperCase();
  return n >= 1 ? acc + upper.toLowerCase() + "'".repeat(n - 1) : acc + upper + ",".repeat(-n);
}

// Matches either a region whose letters are NOT notes (decorations, chord
// symbols, grace notes) or one pitch token. Fresh regex per use (stateful /g).
const skipOrPitch = () => /(![^!]*!|"[^"]*"|\{[^}]*\})|([_^=]*[A-Ga-g][,']*)/g;

// Bring one measure inside [lo, hi]. Prefers shifting the WHOLE measure by
// octaves (preserves its contour exactly — safe even in melody measures);
// falls back to moving individual offenders when the measure spans too wide.
function fixMeasure(measureStr, lo, hi) {
  const pitches = [];
  let m;
  const scan = skipOrPitch();
  while ((m = scan.exec(measureStr)) !== null) {
    if (m[2]) {
      const v = midiOf(m[2]);
      if (v !== null) pitches.push(v);
    }
  }
  if (pitches.length === 0) return { text: measureStr, change: null };
  const min = Math.min(...pitches);
  const max = Math.max(...pitches);
  if (min >= lo && max <= hi) return { text: measureStr, change: null };

  let whole = 0;
  if (min < lo && max <= hi) {
    const k = Math.ceil((lo - min) / 12);
    if (max + 12 * k <= hi) whole = k;
  } else if (max > hi && min >= lo) {
    const k = Math.ceil((max - hi) / 12);
    if (min - 12 * k >= lo) whole = -k;
  }

  let out = "";
  let last = 0;
  let perNote = 0;
  const rewrite = skipOrPitch();
  while ((m = rewrite.exec(measureStr)) !== null) {
    if (!m[2]) continue;
    const v = midiOf(m[2]);
    if (v === null) continue;
    let oct = whole;
    if (whole === 0) {
      if (v < lo) { oct = Math.ceil((lo - v) / 12); perNote++; }
      else if (v > hi) { oct = -Math.ceil((v - hi) / 12); perNote++; }
      else continue;
    }
    out += measureStr.slice(last, m.index) + shiftTokenOctave(m[2], oct);
    last = m.index + m[0].length;
  }
  out += measureStr.slice(last);
  const change = whole !== 0
    ? `shifted the whole measure ${whole > 0 ? "up" : "down"} ${Math.abs(whole)} octave${Math.abs(whole) > 1 ? "s" : ""}`
    : `moved ${perNote} out-of-range note${perNote > 1 ? "s" : ""} to a playable octave`;
  return { text: out, change };
}

// Deterministic last resort after prompt + retry: octave-correct anything
// still outside the instrument's range so an unplayable part never ships.
// Returns { abc, changed, changes[] }; the ABC is rebuilt (header + 4 bars
// per line) only when something actually moved.
export function enforceRange(partAbc, instrName) {
  const info = writtenRangeInfo(instrName);
  const header = headerOf(partAbc);
  // No range data, or no K: header to rebuild around — leave untouched.
  if (!info || header === String(partAbc)) return { abc: partAbc, changed: false, changes: [] };
  const lo = info.lo.midi - 1; // same key-signature slack as checkPartRange
  const hi = info.hi.midi + 1;
  const changes = [];
  const fixed = partMeasures(partAbc).map((meas, i) => {
    const { text, change } = fixMeasure(meas, lo, hi);
    if (change) changes.push(`measure ${i + 1}: ${change}`);
    return text;
  });
  if (changes.length === 0) return { abc: partAbc, changed: false, changes: [] };
  return { abc: `${header}\n${stitchBody(fixed)}`, changed: true, changes };
}

// Check every note of a part against the instrument's written range.
// Returns { ok, problems[] } in the same shape as checkPartMelody.
// measureOffset shifts reported measure numbers (chunked generation).
export function checkPartRange(partAbc, instrName, measureOffset = 0) {
  const info = writtenRangeInfo(instrName);
  if (!info) return { ok: true, problems: [] };
  // ±1 semitone slack: our parser ignores the key signature, so a boundary
  // note can read one semitone off — only flag clear violations.
  const lo = info.lo.midi - 1;
  const hi = info.hi.midi + 1;
  const problems = [];
  partMeasures(partAbc).forEach((meas, i) => {
    for (const tok of measurePitches(meas)) {
      const v = midiOf(tok);
      if (v === null) continue;
      if (v < lo) {
        problems.push(`measure ${i + 1 + measureOffset}: "${tok}" (~${midiToName(v)}) is BELOW ${instrName}'s playable range — lowest written note is ${info.lo.name} (ABC "${info.lo.abc}")`);
      } else if (v > hi) {
        problems.push(`measure ${i + 1 + measureOffset}: "${tok}" (~${midiToName(v)}) is ABOVE ${instrName}'s playable range — highest written note is ${info.hi.name} (ABC "${info.hi.abc}")`);
      }
    }
  });
  return { ok: problems.length === 0, problems: problems.slice(0, 8) };
}
