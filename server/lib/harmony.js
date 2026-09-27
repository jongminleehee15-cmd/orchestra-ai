// Does an accompaniment part actually play the chords it was given?
//
// Every other part check is about FORM: the melody bars reproduce the tune,
// the notes are playable, the bars add up. Nothing looked at whether the
// accompaniment fits the harmony — each part is written by its own model call,
// and the shared chord list is the only thing holding the ensemble together.
// This is the first check on the harmony itself.
//
// INFORMATIONAL ONLY, by design. It is not part of the repair retry and never
// changes a note: its false-positive rate on real output is only lightly
// measured (two live runs), and the part prompt explicitly asks for
// suspensions, anticipations and passing tones, which are non-chord tones by
// definition. Warnings plus a per-part server log line, so the rate can be
// measured before deciding whether it should drive regeneration (see
// ENGINE_NOTES.md).
//
// The rule, per accompaniment bar: weight every sounding note by its duration
// (from scanMeasure, the one duration parser), and flag the bar when chord
// tones make up less than FLAG_BELOW (3/8) of that sounding time. Passing
// tones, resolving suspensions and scale runs stay above it; a line that is
// outlining a different chord altogether does not.

import { measurePitchEvents, partMeasures, melodyMeasureSet } from "./partCheck.js";
import { barUnitsFor, splitMelodyIntoMeasures, UNIT_EPSILON } from "./abcMelody.js";

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const mod12 = (n) => ((n % 12) + 12) % 12;
const NO_CHORD = /^n\.?\s*c\.?$/i;

// Chord-symbol modifiers after the quality and number, each → how it changes
// the chord. Longest spellings first so "sus4" is not read as "sus" + "4".
const MODIFIERS = [
  ["add13", (c) => c.extras.push(9)],
  ["add11", (c) => c.extras.push(5)],
  ["add9", (c) => c.extras.push(2)],
  ["add6", (c) => c.extras.push(9)],
  ["add4", (c) => c.extras.push(5)],
  ["add2", (c) => c.extras.push(2)],
  ["sus2", (c) => { c.third = 2; }],
  ["sus4", (c) => { c.third = 5; }],
  ["sus", (c) => { c.third = 5; }],
  ["maj7", (c) => { c.seventh = 11; }],
  ["M7", (c) => { c.seventh = 11; }],
  ["b5", (c) => { c.fifth = 6; }],
  ["-5", (c) => { c.fifth = 6; }],
  ["#5", (c) => { c.fifth = 8; }],
  ["+5", (c) => { c.fifth = 8; }],
  ["b9", (c) => c.extras.push(1)],
  ["#9", (c) => c.extras.push(3)],
  ["#11", (c) => c.extras.push(6)],
  ["b13", (c) => c.extras.push(8)],
  ["no3", (c) => { c.third = null; }],
  ["no5", (c) => { c.fifth = null; }],
];

// Parse ONE chord symbol ("C", "F#m7", "Bbmaj7", "G7/B", "Dm7b5", "Csus4",
// "E7#9", "N.C.") into the set of pitch classes it contains, or null when the
// symbol is not understood. null means "no claim": the caller skips the bar
// rather than guessing a chord and reporting a clash against the guess.
export function parseChordSymbol(symbol) {
  if (typeof symbol !== "string") return null;
  let s = symbol.trim()
    .replace(/♭/g, "b").replace(/♯/g, "#")
    .replace(/[()]/g, "")
    .replace(/6\/9/, "69");
  if (!s || NO_CHORD.test(s)) return null;

  let bass = null;
  const slash = s.match(/^(.+)\/([A-G][#b]?)$/);
  if (slash) {
    s = slash[1];
    bass = mod12(LETTER[slash[2][0]] + (slash[2][1] === "#" ? 1 : slash[2][1] === "b" ? -1 : 0));
  }

  const m = s.match(/^([A-G])([#b]?)(.*)$/);
  if (!m) return null;
  const root = mod12(LETTER[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0));
  let q = m[3];

  const c = { third: 4, fifth: 7, seventh: null, extras: [] };
  let seventhKind = "dominant"; // what a bare 7/9/11/13 means for this quality
  let hasQuality = false;

  // Quality. "maj" must be tried before "m", or "Cmaj7" reads as C minor.
  let qm;
  if ((qm = q.match(/^(maj|Maj|MAJ|M|Δ)/))) {
    seventhKind = "major";
    q = q.slice(qm[0].length);
    if (qm[0] === "Δ" && !/^(7|9|11|13)/.test(q)) c.seventh = 11; // "CΔ" alone = Cmaj7
    hasQuality = true;
  } else if ((qm = q.match(/^(min|mi|m|-)/))) {
    c.third = 3;
    q = q.slice(qm[0].length);
    hasQuality = true;
  } else if ((qm = q.match(/^(dim|o|°)/))) {
    c.third = 3; c.fifth = 6; seventhKind = "diminished";
    q = q.slice(qm[0].length);
    hasQuality = true;
  } else if ((qm = q.match(/^ø/))) {
    c.third = 3; c.fifth = 6; c.seventh = 10;
    q = q.slice(1);
    hasQuality = true;
  } else if ((qm = q.match(/^(aug|\+)/))) {
    c.fifth = 8;
    q = q.slice(qm[0].length);
    hasQuality = true;
  }

  // Number: 5 (power chord), 6, 6/9, 7, 9, 11, 13.
  const seventh = () => (seventhKind === "major" ? 11 : seventhKind === "diminished" ? 9 : 10);
  if ((qm = q.match(/^(13|11|69|9|7|6|5)/))) {
    const n = qm[1];
    q = q.slice(n.length);
    if (n === "5") {
      if (hasQuality) return null; // "Cm5" is not a standard symbol
      c.third = null;
    } else if (n === "6") {
      c.extras.push(9);
    } else if (n === "69") {
      c.extras.push(9, 2);
    } else {
      if (c.seventh === null) c.seventh = seventh();
      if (n === "9" || n === "11" || n === "13") c.extras.push(2);
      if (n === "11" || n === "13") c.extras.push(5);
      if (n === "13") c.extras.push(9);
    }
  }

  // Modifiers, in any order, until the symbol is used up.
  while (q.length > 0) {
    const hit = MODIFIERS.find(([text]) => q.startsWith(text));
    if (!hit) return null; // unknown text: make no claim
    hit[1](c);
    q = q.slice(hit[0].length);
  }

  const tones = new Set([root]);
  for (const iv of [c.third, c.fifth, c.seventh, ...c.extras]) {
    if (iv !== null) tones.add(mod12(root + iv));
  }
  if (bass !== null) tones.add(bass);
  return tones;
}

// One bar's chord annotation ("C", or "G C" when the harmony moves mid-bar)
// → an array of pitch-class sets, or null if ANY symbol is unreadable.
export function parseBarChords(annotation) {
  if (typeof annotation !== "string") return null;
  const symbols = annotation.split(/[\s,]+/).filter(Boolean);
  if (symbols.length === 0) return null;
  const sets = symbols.map(parseChordSymbol);
  return sets.every(Boolean) ? sets : null;
}

// Semitones to subtract from a WRITTEN pitch to get the SOUNDING (concert)
// pitch class. A transposing part's written key sits (writtenFifths −
// concertFifths) fifths above concert, and each fifth is 7 semitones, so this
// works for B♭ (2 → 2 semitones), F (1 → 7) and E♭ (3 → 9) instruments, and
// still holds when the written key was respelled (concert F# → written A♭).
export function writtenToConcertShift(writtenFifths, concertFifths) {
  return mod12((writtenFifths - concertFifths) * 7);
}

// The user-facing warning list: the first few bars, then a count, so a long
// part with many flags doesn't bury its other warnings.
export function harmonyWarnings(result, limit = 8) {
  const all = result?.problems || [];
  if (all.length <= limit) return all;
  const more = all.length - limit;
  return [...all.slice(0, limit), `and ${more} more bar${more > 1 ? "s" : ""} like these`];
}

// A bar is flagged when chord tones make up LESS THAN 3/8 of its sounding
// time. Not an arbitrary number: any 8 consecutive steps of a diatonic scale
// contain every scale degree, so a stepwise run over its own triad always
// holds at least 3 chord tones in 8 notes. Below 3/8 therefore cannot be plain
// scale motion over the right chord (in a one-chord bar; see ENGINE_NOTES.md
// for the two-chord-bar exception). The first live run used 1/2 and flagged
// ordinary Baroque scale runs at exactly 3/8.
export const FLAG_BELOW = 3 / 8;

// Share of a bar's sounding time (duration-weighted) spent on chord tones,
// or null when nothing sounds. `sets` are the bar's chords, splitting the bar
// evenly; the first chord starts at 0 and the last runs to the end of the bar
// (and past it, should a bar still be overfull). A chord-note event counts by
// the fraction of its notes in the chord. `shift` converts written pitch to
// concert pitch (0 for a concert-pitch line such as the canonical melody).
export function chordToneShare(events, sets, barUnits, shift = 0) {
  const span = barUnits / sets.length;
  let onset = 0;
  let sounding = 0;
  let fitting = 0;
  for (const e of events) {
    const start = onset;
    const end = onset + e.len;
    onset = end;
    if (e.pitches.length === 0 || e.len <= UNIT_EPSILON) continue;
    sounding += e.len;
    const pcs = e.pitches.map((st) => mod12(st - shift));
    for (let j = 0; j < sets.length; j++) {
      const from = j === 0 ? -Infinity : j * span;
      const to = j === sets.length - 1 ? Infinity : (j + 1) * span;
      const overlap = Math.min(end, to) - Math.max(start, from);
      if (overlap <= UNIT_EPSILON) continue;
      const inChord = pcs.filter((pc) => sets[j].has(pc)).length;
      fitting += overlap * (inChord / pcs.length);
    }
  }
  return sounding <= UNIT_EPSILON ? null : fitting / sounding;
}

const isFlagged = (share) => share !== null && share < FLAG_BELOW - UNIT_EPSILON;

// Check the bars of one part where it ACCOMPANIES (not melody bars) against
// the plan's chords. Measure numbers are piece numbers: pass the whole part.
//
//   partAbc         the shipped part (header + body)
//   chords          one annotation per measure, concert pitch
//   melodyAbc       the canonical tune, concert pitch (optional, see below)
//   melodySections  this part's melody labels; those bars are skipped
//   writtenFifths   the key signature the part is WRITTEN in
//   concertFifths   the arrangement's concert key signature
//
// A bar whose CANONICAL MELODY itself fails its chord is skipped and counted
// as chordSuspect: the plan's chord contradicts its own tune there, so a part
// that follows (or doubles) the tune would be blamed for the plan's mistake.
// Seen live: model-written extension chords under their own extension melody.
//
// Returns { problems[], checked, flagged, unreadable, chordSuspect } — the
// counts are for the server log, so the flag rate on real output can be measured.
export function checkPartHarmony({ partAbc, chords, timeSignature, melodyAbc = null, melodySections = [], writtenFifths = 0, concertFifths = 0 }) {
  const result = { problems: [], checked: 0, flagged: 0, unreadable: 0, chordSuspect: 0 };
  if (!Array.isArray(chords) || chords.length === 0) return result;

  const barUnits = barUnitsFor(timeSignature);
  const shift = writtenToConcertShift(writtenFifths, concertFifths);
  const melodySet = melodyMeasureSet(melodySections);
  const tune = splitMelodyIntoMeasures(melodyAbc);

  partMeasures(partAbc).forEach((meas, i) => {
    const n = i + 1;
    if (melodySet.has(n) || i >= chords.length) return;
    const annotation = chords[i];
    if (typeof annotation !== "string" || !annotation.trim()) return;
    if (NO_CHORD.test(annotation.trim())) return; // "N.C.": nothing to fit

    const events = measurePitchEvents(meas, timeSignature, writtenFifths);
    if (!events.some((e) => e.pitches.length > 0)) return; // a rest bar says nothing about harmony

    const sets = parseBarChords(annotation);
    if (!sets) { result.unreadable++; return; }

    if (tune[i] && isFlagged(chordToneShare(measurePitchEvents(tune[i], timeSignature, concertFifths), sets, barUnits, 0))) {
      result.chordSuspect++;
      return;
    }

    const share = chordToneShare(events, sets, barUnits, shift);
    if (share === null) return;
    result.checked++;
    if (isFlagged(share)) {
      result.flagged++;
      result.problems.push(
        `measure ${n}: only ${Math.round(share * 100)}% of this bar's notes (by length) belong to the chord ${annotation.trim()}, so the part may be playing against the harmony here`,
      );
    }
  });
  return result;
}

