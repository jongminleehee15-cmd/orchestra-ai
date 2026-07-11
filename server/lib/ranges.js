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
