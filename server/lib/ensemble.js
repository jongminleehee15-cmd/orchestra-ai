// Parts heard TOGETHER, at the pitch they actually sound.
//
// Two jobs, sharing one reading of the notes:
//   1. renderEnsembleContext: the parts already written, shown to the model
//      writing the next part, bar by bar at sounding pitch. Before this every
//      part was written blind to every other part; the shared chord list was
//      the only thing holding the ensemble together.
//   2. findMelodyClashes: a part moving in seconds against the melody carrier
//      (seen live: a Trumpet shadowing the tune in parallel 7ths).
//      The chord check (harmony.js) cannot see this: a line can fit the chord
//      and still rub against the tune.
//
// Pure and browser-safe on purpose: the client's orchestration checks import
// this file, so it must not pull in anything that touches Node (anthropic.js,
// config.js, process.env). Keep its imports to the pure music modules.

import { measurePitchEvents, partMeasures, melodyMeasureSet } from "./partCheck.js";
import { splitMelodyIntoMeasures, barUnitsFor, UNIT_EPSILON } from "./abcMelody.js";
import { parseBarChords } from "./harmony.js";
import { WRITTEN_SHIFT } from "./ranges.js";
import { writtenKeyFor, keyFifths } from "./transpose.js";
import { baseName } from "./instrMeta.js";

// ── Sounding pitch ───────────────────────────────────────────────────────────

// Semitones a part is WRITTEN above where it sounds, octave included (the
// app writes tenor sax a 2nd up, not a 9th; see ranges.js).
export function writtenShiftFor(instrName) {
  return WRITTEN_SHIFT[baseName(instrName)] || 0;
}

// One bar → [{ start, end, pitches }] with pitches as SOUNDING MIDI numbers
// (C4 = 60). Durations come from scanMeasure via measurePitchEvents.
export function soundingEvents(measureStr, timeSignature, writtenFifths, writtenShift) {
  let onset = 0;
  return measurePitchEvents(measureStr, timeSignature, writtenFifths).map((e) => {
    const ev = { start: onset, end: onset + e.len, pitches: e.pitches.map((st) => 60 + st - writtenShift) };
    onset += e.len;
    return ev;
  });
}

// Every bar of a part at sounding pitch, reading it in its own written key.
export function partSoundingBars(partAbc, instrName, concertKey, timeSignature) {
  const { fifths } = writtenKeyFor(concertKey, instrName);
  const shift = writtenShiftFor(instrName);
  return partMeasures(partAbc).map((m) => soundingEvents(m, timeSignature, fifths, shift));
}

// The canonical tune at sounding (concert) pitch, as written in melodyAbc.
export function melodySoundingBars(melodyAbc, concertKey, timeSignature) {
  const fifths = keyFifths(concertKey);
  return splitMelodyIntoMeasures(melodyAbc).map((m) => soundingEvents(m, timeSignature, fifths, 0));
}

// ── 1. Context for the next part's prompt ────────────────────────────────────

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const midiName = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// Length in L:1/8 units → a short readable value (e = eighth, q = quarter…).
const LEN_NAMES = { 0.5: "s", 1: "e", 1.5: "e.", 2: "q", 3: "q.", 4: "h", 6: "h.", 8: "w", 12: "w." };
function lenName(u) {
  const hit = Object.keys(LEN_NAMES).find((k) => Math.abs(Number(k) - u) <= UNIT_EPSILON);
  return hit !== undefined ? LEN_NAMES[hit] : String(Math.round(u * 100) / 100);
}

// One bar of sounding events → "F#5 q, E5 e, [D4 F#4 A4] h, rest q".
export function describeBar(events) {
  if (events.length === 0) return "(empty)";
  return events.map((e) => {
    const len = lenName(e.end - e.start);
    if (e.pitches.length === 0) return `rest ${len}`;
    const p = e.pitches.map(midiName);
    return `${p.length > 1 ? `[${p.join(" ")}]` : p[0]} ${len}`;
  }).join(", ");
}

// Render the already-written parts for the prompt of `forInstr`, bar by bar,
// for piece measures `from`..`to` (1-based, inclusive).
//
//   contextParts   [{ instrName, abc }] already finished (never forInstr itself)
//   instrumentRoles the plan's roles, to mark who carries the melody where
//   melodyAbc      the canonical tune: shown for bars whose carrier is not
//                  written yet, so the melody is always present in the grid
//
// Returns "" when there is nothing to show, so a request without context
// produces exactly the prompt it did before.
export function renderEnsembleContext({ contextParts, forInstr, instrumentRoles, melodyAbc, concertKey, timeSignature, from, to }) {
  const parts = (contextParts || []).filter((p) => p && p.instrName !== forInstr);
  if (parts.length === 0) return "";
  const bars = parts.map((p) => ({
    instrName: p.instrName,
    bars: partSoundingBars(p.abc, p.instrName, concertKey, timeSignature),
    melody: melodyMeasureSet(instrumentRoles?.[p.instrName]?.melodySections || []),
  }));
  const tune = melodySoundingBars(melodyAbc, concertKey, timeSignature);
  const carrierOf = (n) => Object.entries(instrumentRoles || {})
    .find(([, r]) => melodyMeasureSet(r?.melodySections || []).has(n))?.[0];

  const lines = [];
  for (let n = from; n <= to; n++) {
    lines.push(`m${n}:`);
    const carrier = carrierOf(n);
    const carrierWritten = bars.some((b) => b.instrName === carrier);
    if (!carrierWritten && tune[n - 1] && carrier !== forInstr) {
      lines.push(`  melody (${carrier ? `${carrier}, not written yet; ` : ""}canonical tune, its octave may differ): ${describeBar(tune[n - 1])}`);
    }
    for (const b of bars) {
      if (!b.bars[n - 1]) continue;
      lines.push(`  ${b.instrName}${b.melody.has(n) ? " (MELODY)" : ""}: ${describeBar(b.bars[n - 1])}`);
    }
  }
  return lines.join("\n");
}

// ── 2. Clashes against the melody ────────────────────────────────────────────

// Distances that count as rubbing against the tune: the dissonant interval
// CLASSES, 2nds and 7ths in any octave (distance mod 12 of 1, 2, 10 or 11,
// so 9ths and compound 7ths too). By interval class and not absolute size
// because the octave a carrier plays the tune in is its own choice: live, a
// Trumpet shadowing the Canon a step below the CANONICAL octave actually sat
// a 7th ABOVE the Alto Sax carrying it an octave down, and an absolute
// "2nds only" set missed it. Parallel unisons, 3rds, 6ths and octaves are
// never flagged (their classes are 0, 3, 4); parallel 2nds and 7ths always
// are. A dominant 7th held against the tune is a known risk; the half-bar
// threshold below is what keeps a brief one from counting.
export const CLASH_CLASSES = new Set([1, 2, 10, 11]);
const isClash = (a, b) => CLASH_CLASSES.has(Math.abs(a - b) % 12);

// Only a dissonance the PART creates counts: its note is OUTSIDE the chord
// sounding at that moment AND a 2nd/7th from the melody. When the part sits
// on a chord tone, a rub with the tune is the melody's own passing tone or a
// chord 7th, which is ordinary writing (seen live: a Tuba on the root under
// the tune's passing note was flagged before this rule).
//
// A bar is flagged when that is true for at least HALF of the time both
// sound, with at least a quarter note of shared sounding time. Why a half:
// any 8 consecutive scale steps hold at most 4 tones of one triad, so a part
// shadowing a stepwise tune in parallel 2nds or 7ths is off the chord at
// least half the time and is always flagged; a single passing collision or a
// resolving suspension is a minority and is not. Parallel unisons, 3rds, 6ths
// and octaves never count at all.
export const CLASH_SHARE = 1 / 2;
const MIN_SHARED = 2; // L:1/8 units: a quarter note

// { shared, clash } sounding time of one part bar against the melody bar.
// `sets` are the bar's chords (pitch-class sets, splitting the bar evenly, as
// in harmony.js). A chord in the part counts by the fraction of its notes
// that clash.
export function clashTime(partEvents, melodyEvents, sets, barUnits) {
  const span = barUnits / sets.length;
  let shared = 0;
  let clash = 0;
  for (const p of partEvents) {
    if (p.pitches.length === 0) continue;
    for (const m of melodyEvents) {
      if (m.pitches.length === 0) continue;
      const a = Math.max(p.start, m.start);
      const b = Math.min(p.end, m.end);
      if (b - a <= UNIT_EPSILON) continue;
      const top = Math.max(...m.pitches);
      for (let j = 0; j < sets.length; j++) {
        const from = j === 0 ? -Infinity : j * span;
        const to = j === sets.length - 1 ? Infinity : (j + 1) * span;
        const sub = Math.min(b, to) - Math.max(a, from);
        if (sub <= UNIT_EPSILON) continue;
        const hits = p.pitches.filter((x) => isClash(x, top) && !sets[j].has(((x % 12) + 12) % 12)).length;
        shared += sub;
        clash += sub * (hits / p.pitches.length);
      }
    }
  }
  return { shared, clash };
}

// Every non-melody part against the part that actually carries the melody in
// each bar, both at sounding pitch. Skipped, never guessed: bars whose carrier
// isn't finished, and bars with no chord or a chord symbol harmony.js can't
// read. Returns [{ measure, instrName, carrier, share }], at most `limit`.
export function findMelodyClashes({ parts, instrumentRoles, chords, concertKey, timeSignature, limit = 8 }) {
  const out = [];
  if (!Array.isArray(chords)) return out;
  const barUnits = barUnitsFor(timeSignature);
  const sounding = new Map(parts.map((p) => [p.instrName, partSoundingBars(p.abc, p.instrName, concertKey, timeSignature)]));
  const melodySets = new Map(parts.map((p) => [p.instrName, melodyMeasureSet(instrumentRoles?.[p.instrName]?.melodySections || [])]));
  const measures = Math.max(0, ...[...sounding.values()].map((b) => b.length));

  for (let i = 0; i < measures && out.length < limit; i++) {
    const n = i + 1;
    const carrier = parts.find((p) => melodySets.get(p.instrName).has(n));
    if (!carrier) continue;
    const tune = sounding.get(carrier.instrName)[i];
    if (!tune) continue;
    const sets = parseBarChords(chords[i]);
    if (!sets) continue;
    for (const p of parts) {
      if (p === carrier || melodySets.get(p.instrName).has(n)) continue;
      const bar = sounding.get(p.instrName)[i];
      if (!bar) continue;
      const { shared, clash } = clashTime(bar, tune, sets, barUnits);
      if (shared < MIN_SHARED - UNIT_EPSILON) continue;
      const share = clash / shared;
      if (share >= CLASH_SHARE - UNIT_EPSILON) {
        out.push({ measure: n, instrName: p.instrName, carrier: carrier.instrName, share });
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}
