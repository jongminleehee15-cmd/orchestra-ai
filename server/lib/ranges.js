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
import { partMeasures, measurePitchEvents } from "./partCheck.js";
import { scanMeasure, splitMelodyIntoMeasures, parseMeasureRange } from "./abcMelody.js";
import { keyFifths, moveOctaves } from "./transpose.js";
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

// ── Reading a part's pitches ──────────────────────────────────────────────────
// Every pitch is read with the part's own key signature and bar accidentals,
// through the one shared reader (partCheck's measurePitchEvents). Until
// 2026-09-27 this file had its own reader that ignored the key signature and
// allowed a semitone of slack for it: a Cello's F#5 in D major read as F5,
// inside the slack, and shipped. Over the saved eval runs that reader flagged
// 0 of the 28 notes that really were outside a hard range.

// The written key signature (fifths) and meter from a part's ABC header.
export function partKey(partAbc) {
  const head = String(partAbc).split("\n");
  const k = (head.find((l) => /^K:/.test(l.trim())) || "K:C").trim().slice(2).trim().split(/\s+/)[0] || "C";
  const m = (head.find((l) => /^M:/.test(l.trim())) || "M:4/4").trim().slice(2).trim();
  return { fifths: keyFifths(k), timeSignature: m };
}

// One measure → [{ text, pitches }] with WRITTEN MIDI numbers (C4 = 60),
// every chord note included, grace notes excluded (as the parser reads them).
function measureNotes(measureStr, timeSignature, fifths) {
  const events = scanMeasure(measureStr, timeSignature);
  return measurePitchEvents(measureStr, timeSignature, fifths)
    .map((e, i) => ({ text: events[i]?.text || "", pitches: e.pitches.map((st) => 60 + st) }));
}

// ── Range validation of a generated part ──────────────────────────────────────

// Bring one measure inside [lo, hi]. Prefers shifting the WHOLE measure by
// octaves (preserves its contour exactly, safe even in melody measures);
// falls back to moving individual offenders when the measure spans too wide.
// Either way moveOctaves rewrites the accidentals, so no note changes pitch
// class: moving one note of "^F2 F2" cannot strip the other's sharp.
function fixMeasure(measureStr, timeSignature, fifths, lo, hi) {
  const pitches = measureNotes(measureStr, timeSignature, fifths).flatMap((e) => e.pitches);
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
  const perNote = (v) => (v < lo ? Math.ceil((lo - v) / 12) : v > hi ? -Math.ceil((v - hi) / 12) : 0);
  const { text, moved } = moveOctaves(measureStr, fifths, (v, inGrace) => (whole ? whole : inGrace ? 0 : perNote(v)));
  if (!moved) return { text: measureStr, change: null };
  const change = whole !== 0
    ? `shifted the whole measure ${whole > 0 ? "up" : "down"} ${Math.abs(whole)} octave${Math.abs(whole) > 1 ? "s" : ""}`
    : `moved ${moved} out-of-range note${moved > 1 ? "s" : ""} to a playable octave`;
  return { text, change };
}

// Deterministic last resort after prompt + retry: octave-correct anything
// still outside the instrument's range so an unplayable part never ships.
// Returns { abc, changed, changes[] }; the ABC is rebuilt (header + 4 bars
// per line) only when something actually moved.
//
// Octave shifts preserve every note's duration, so this never changes a bar's
// length — which is why it is safe to run BEFORE repairPartBars in
// /api/part, and why a wrong-length bar is still detectable afterwards.
export function enforceRange(partAbc, instrName) {
  const info = writtenRangeInfo(instrName);
  const header = headerOf(partAbc);
  // No range data, or no K: header to rebuild around — leave untouched.
  // The headerless case is now unreachable from /api/part (partHeader builds
  // the header server-side, so it always has a K: line); this stays as a
  // guard for any other caller, since rebuilding around a header we couldn't
  // find would corrupt the part.
  if (!info || header === String(partAbc)) return { abc: partAbc, changed: false, changes: [] };
  const { fifths, timeSignature } = partKey(partAbc);
  const changes = [];
  const fixed = partMeasures(partAbc).map((meas, i) => {
    const { text, change } = fixMeasure(meas, timeSignature, fifths, info.lo.midi, info.hi.midi);
    if (change) changes.push(`measure ${i + 1}: ${change}`);
    return text;
  });
  if (changes.length === 0) return { abc: partAbc, changed: false, changes: [] };
  return { abc: `${header}\n${stitchBody(fixed)}`, changed: true, changes };
}

// Check every note of a part against the instrument's written range.
// Returns { ok, problems[] } in the same shape as checkPartMelody.
// measureOffset shifts reported measure numbers (chunked generation). `limit`
// caps the list, as in checkPartBars; the offline evaluation passes Infinity.
export function checkPartRange(partAbc, instrName, measureOffset = 0, limit = 8) {
  const info = writtenRangeInfo(instrName);
  if (!info) return { ok: true, problems: [] };
  const { fifths, timeSignature } = partKey(partAbc);
  const problems = [];
  partMeasures(partAbc).forEach((meas, i) => {
    for (const { text, pitches } of measureNotes(meas, timeSignature, fifths)) {
      for (const v of pitches) {
        if (v < info.lo.midi) {
          problems.push(`measure ${i + 1 + measureOffset}: "${text}" (${midiToName(v)}) is BELOW ${instrName}'s playable range; lowest written note is ${info.lo.name} (ABC "${info.lo.abc}")`);
        } else if (v > info.hi.midi) {
          problems.push(`measure ${i + 1 + measureOffset}: "${text}" (${midiToName(v)}) is ABOVE ${instrName}'s playable range; highest written note is ${info.hi.name} (ABC "${info.hi.abc}")`);
        }
      }
    }
  });
  return { ok: problems.length === 0, problems: problems.slice(0, limit) };
}

// ── Where a melody phrase should sit ──────────────────────────────────────────
// Every part used to be handed the tune at its canonical octave, the octave a
// violin or flute reads it in, told to move it "only as needed". A Cello then
// played Canon in D up to F#5, and over the saved eval runs 27% of the
// Cello's melody notes, 48% of the Tuba's and 23% of the Piccolo's (too LOW)
// sat outside their comfortable band. The octave is now chosen in code, a
// whole phrase at a time so its contour is never broken.

// Whole octaves to move a phrase (its WRITTEN MIDI pitches) for `instrName`:
// the move that puts the most notes in the comfortable band while keeping
// every note inside the hard range; on a tie, the smallest move, then the
// higher octave (a tune sings best at the top of its band). When no move
// keeps every note in the hard range, 0: the hard-range fix handles it.
export function phraseOctave(pitches, instrName) {
  const info = writtenRangeInfo(instrName);
  if (!info || pitches.length === 0) return 0;
  let best = null;
  for (let k = -3; k <= 3; k++) {
    const moved = pitches.map((v) => v + 12 * k);
    if (moved.some((v) => v < info.lo.midi || v > info.hi.midi)) continue;
    const inComfort = moved.filter((v) => v >= info.comfortLo.midi && v <= info.comfortHi.midi).length;
    const better = !best
      || inComfort > best.inComfort
      || (inComfort === best.inComfort && (Math.abs(k) < Math.abs(best.k) || (Math.abs(k) === Math.abs(best.k) && k > best.k)));
    if (better) best = { k, inComfort };
  }
  return best ? best.k : 0;
}

// The pitches of measures `from`..`to` (1-based) of a list of bars.
function phrasePitches(bars, from, to, timeSignature, fifths) {
  return bars.slice(from - 1, to).flatMap((b) => measureNotes(b, timeSignature, fifths).flatMap((e) => e.pitches));
}

// For each of a part's melody sections, the octave move for the melody it
// will be handed. `melodyAbc` is that melody as the part WRITES it (written
// pitch for a transposing part), `fifths` its key signature.
// Returns [{ label, from, to, k }].
export function melodyPlacement(melodyAbc, fifths, timeSignature, sections, instrName) {
  const bars = splitMelodyIntoMeasures(melodyAbc || "");
  return (sections || []).map((label) => {
    const r = parseMeasureRange(label);
    if (!r) return null;
    return { label, from: r.start, to: r.end, k: phraseOctave(phrasePitches(bars, r.start, r.end, timeSignature, fifths), instrName) };
  }).filter(Boolean);
}

// Move ABC body text by `k` octaves (every note, grace notes included).
export function shiftOctaves(text, fifths, k) {
  return k ? moveOctaves(text, fifths, () => k).text : text;
}

// After generation: move each melody phrase the part actually wrote to the
// octave phraseOctave picks, when that strictly improves it (more notes in the
// comfortable band, or back inside the hard range) and stays in the hard
// range. The whole phrase moves together, so every interval and every
// bar-to-bar step is kept. Returns { abc, changes[] }: each change is a note
// for the user, since the part is not what the model wrote.
export function placeMelodyPhrases(partAbc, instrName, sections) {
  const info = writtenRangeInfo(instrName);
  const header = headerOf(partAbc);
  if (!info || header === String(partAbc) || !sections?.length) return { abc: partAbc, changes: [] };
  const { fifths, timeSignature } = partKey(partAbc);
  const bars = partMeasures(partAbc);
  const inComfort = (ps) => ps.filter((v) => v >= info.comfortLo.midi && v <= info.comfortHi.midi).length;
  const inHard = (ps) => ps.every((v) => v >= info.lo.midi && v <= info.hi.midi);
  const changes = [];
  for (const label of sections) {
    const r = parseMeasureRange(label);
    if (!r || r.start > bars.length) continue;
    const to = Math.min(r.end, bars.length);
    const ps = phrasePitches(bars, r.start, to, timeSignature, fifths);
    const k = phraseOctave(ps, instrName);
    if (!k) continue;
    const moved = ps.map((v) => v + 12 * k);
    if (!(inComfort(moved) > inComfort(ps) || !inHard(ps))) continue;
    for (let n = r.start; n <= to; n++) bars[n - 1] = shiftOctaves(bars[n - 1], fifths, k);
    changes.push(`measures ${r.start}-${to}: the melody was moved ${k < 0 ? "down" : "up"} ${Math.abs(k)} octave${Math.abs(k) > 1 ? "s" : ""} so it sits in the ${instrName}'s comfortable range`);
  }
  if (!changes.length) return { abc: partAbc, changes };
  return { abc: `${header}\n${stitchBody(bars)}`, changes };
}
