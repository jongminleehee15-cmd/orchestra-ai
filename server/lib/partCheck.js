// Validate that a generated instrument part actually plays the canonical
// melody in the measures it was assigned. Comparison is transposition-
// invariant so it works for Bb/F/Eb instruments and octave-shifted parts:
//   - RHYTHM must match exactly (sequence of note durations per measure)
//   - PITCH must match exactly by INTERVAL from the bar's first note, with
//     key signature and bar-long accidentals resolved (opt-in: needs both key
//     signatures; falls back to contour-only without them)
// Interval-exact rather than absolute-pitch-exact so a Bb/F/Eb part and an
// octave shift still pass, while a wrong interval size does not. Catches wrong
// tunes, flattened rhythms, dropped notes, mid-phrase octave breaks, and
// wrong intervals (see ENGINE_NOTES.md).

import { keyAlters } from "./symbolic.js";
import { splitMelodyIntoMeasures, parseMeasureRange, measureUnits, barUnitsFor, scanMeasure, roundUnits, UNIT_EPSILON } from "./abcMelody.js";

const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Resolve one ABC pitch token to a true semitone, applying (in ABC's order of
// precedence) an explicit accidental, then any accidental already set on that
// same letter+octave earlier in the bar, then the key signature. An explicit
// accidental also persists for the rest of the bar, as a player would read it.
function resolveNote(tok, keyMap, barAcc) {
  const m = tok.match(/^([_^=]*)([a-gA-G])([,']*)$/);
  if (!m) return null;
  const [, accs, letter, octs] = m;
  const upper = letter.toUpperCase();
  let st = BASE[upper] + (letter === letter.toLowerCase() ? 12 : 0);
  let octIdx = letter === letter.toLowerCase() ? 1 : 0;
  for (const o of octs) {
    st += o === "'" ? 12 : -12;
    octIdx += o === "'" ? 1 : -1;
  }
  const id = `${upper}:${octIdx}`;
  let alter;
  if (accs) {
    alter = 0;
    for (const a of accs) alter += a === "^" ? 1 : a === "_" ? -1 : 0;
    barAcc[id] = alter; // "=" naturals to 0 and cancels the key signature too
  } else if (id in barAcc) {
    alter = barAcc[id];
  } else {
    alter = keyMap[upper] || 0;
  }
  return st + alter;
}

// Every pitch a scanned event sounds, as semitone values: [] for a rest, one
// value for a note, and each note of a chord in written order.
function pitchesOfToken(text, keyMap, barAcc) {
  // Drop a trailing length so "C2" reads as the pitch C.
  const body = String(text).replace(/(\d+\/\d+|\d+|\/+)$/, "");
  if (body.startsWith("[")) {
    return [...body.matchAll(/[_^=]*[a-gA-G][,']*/g)]
      .map((x) => resolveNote(x[0], keyMap, barAcc))
      .filter((v) => v !== null);
  }
  if (/^[zxZ]$/.test(body)) return [];
  const st = resolveNote(body, keyMap, barAcc);
  return st === null ? [] : [st];
}

// The pitch a scanned event sounds at, as a semitone value: null for rests,
// and for a chord the TOP note (melody is voiced on top by convention).
function pitchOfToken(text, keyMap, barAcc) {
  const all = pitchesOfToken(text, keyMap, barAcc);
  return all.length ? Math.max(...all) : null;
}

// Tokenize one measure into [{ st, len }] (st null for rests).
//
// Durations come from scanMeasure — the single shared parser — so rhythm
// comparison here agrees exactly with the bar-length check, and inherits its
// tuplet handling and its reading of chords whose length is written inside
// the bracket ("[C2E2G2]"). Previously this had its own duration parser that
// knew neither, so a tuplet or an inside-length chord was mis-measured.
// `fifths` is the key signature the measure is WRITTEN in (0 = C/Am). Passing
// it makes `st` a true sounding semitone rather than a letter-only reading, so
// intervals can be compared exactly; omitting it preserves the old behaviour.
export function tokenizeMeasure(measureStr, timeSignature, fifths = 0) {
  const keyMap = keyAlters(fifths);
  const barAcc = {}; // accidentals carry to the end of the bar, per ABC
  return scanMeasure(measureStr, timeSignature).map((e) => ({
    st: pitchOfToken(e.text, keyMap, barAcc),
    len: e.units,
  }));
}

// Like tokenizeMeasure, but keeps EVERY note of a chord: [{ pitches, len }],
// pitches [] for a rest. Used by the harmony check, which has to judge each
// note of an accompaniment chord, not just the top one.
export function measurePitchEvents(measureStr, timeSignature, fifths = 0) {
  const keyMap = keyAlters(fifths);
  const barAcc = {};
  return scanMeasure(measureStr, timeSignature).map((e) => ({
    pitches: pitchesOfToken(e.text, keyMap, barAcc),
    len: e.units,
  }));
}

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

// Compare one part measure against the canonical measure.
// Returns null if OK, else a human-readable problem description.
// The interval check needs BOTH key signatures to resolve written notes to
// true pitches. It is therefore opt-in: a caller that doesn't supply them
// (`null`) gets exactly the old rhythm+contour behaviour rather than false
// positives from reading keyed music as if it were in C.
function compareMeasure(canonical, part, measureNo, timeSignature, canonicalFifths = null, partFifths = null) {
  const intervalExact = canonicalFifths !== null && partFifths !== null;
  const want = tokenizeMeasure(canonical, timeSignature, canonicalFifths ?? 0);
  const got = tokenizeMeasure(part, timeSignature, partFifths ?? 0);

  if (got.length !== want.length) {
    return `measure ${measureNo}: expected ${want.length} notes (${canonical.trim()}) but the part has ${got.length}`;
  }
  for (let i = 0; i < want.length; i++) {
    if (Math.abs(want[i].len - got[i].len) > UNIT_EPSILON) {
      return `measure ${measureNo}: rhythm differs at note ${i + 1}: canonical durations are [${want.map((n) => n.len).join(" ")}], part has [${got.map((n) => n.len).join(" ")}] (canonical: ${canonical.trim()})`;
    }
    const wantRest = want[i].st === null, gotRest = got[i].st === null;
    if (wantRest !== gotRest) {
      return `measure ${measureNo}: note ${i + 1} should be a ${wantRest ? "rest" : "note"} but is a ${gotRest ? "rest" : "note"}`;
    }
  }
  // Contour over consecutive pitched notes (rests break the chain).
  for (let i = 1; i < want.length; i++) {
    if (want[i].st === null || want[i - 1].st === null) continue;
    if (got[i].st === null || got[i - 1].st === null) continue;
    const wd = sign(want[i].st - want[i - 1].st);
    const gd = sign(got[i].st - got[i - 1].st);
    if (wd !== gd) {
      const word = (d) => (d > 0 ? "rises" : d < 0 ? "falls" : "repeats");
      return `measure ${measureNo}: melodic contour differs between notes ${i} and ${i + 1}: the tune ${word(wd)} there but your line ${word(gd)} (canonical: ${canonical.trim()})`;
    }
  }

  // Interval SIZES, not just direction. Contour alone accepts a line with the
  // right shape but the wrong distances — "everything a third off" passes it.
  // Measuring each note against the bar's first pitched note keeps this
  // transposition-invariant (a B♭/F/E♭ part, or an octave shift, moves every
  // pitch by the same amount) while still catching a wrong interval.
  const wantBase = want.find((n) => n.st !== null);
  const gotBase = got.find((n) => n.st !== null);
  if (intervalExact && wantBase && gotBase) {
    for (let i = 0; i < want.length; i++) {
      if (want[i].st === null || got[i].st === null) continue;
      const wi = want[i].st - wantBase.st;
      const gi = got[i].st - gotBase.st;
      if (wi !== gi) {
        const how = Math.abs(gi - wi);
        return `measure ${measureNo}: note ${i + 1} sits ${how} semitone${how > 1 ? "s" : ""} too ${gi > wi ? "high" : "low"} relative to the start of the bar; the tune moves ${wi} semitone${Math.abs(wi) === 1 ? "" : "s"} there but your line moves ${gi} (canonical: ${canonical.trim()})`;
      }
    }
  }
  return null;
}

// Extract the music body measures from a full ABC part (headers stripped).
export function partMeasures(partAbc) {
  const bodyLines = String(partAbc)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[A-Za-z]:/.test(l) && !l.startsWith("%"));
  return splitMelodyIntoMeasures(bodyLines.join(" "));
}

// The 1-based measure numbers this part carries the melody in, as a Set.
// Used to keep deterministic bar repair AWAY from melody measures (trimming
// or padding a melody bar rewrites the tune and manufactures a contour/rhythm
// failure on a part that had none — see ENGINE_NOTES.md).
export function melodyMeasureSet(melodySections = []) {
  const set = new Set();
  for (const label of melodySections) {
    const r = parseMeasureRange(label);
    if (!r) continue;
    for (let n = r.start; n <= r.end; n++) set.add(n);
  }
  return set;
}

// Every measure of a generated part must sum to a full bar in the piece's
// meter. Nothing checked this before: checkPartMelody only looks at measures
// the part carries the MELODY in, checkPartRange only looks at pitches, and
// abcjs's parser accepts a wrong-length bar without any warning. A bar with
// an extra or missing beat therefore shipped silently and pushed that part
// progressively out of sync with the others — heard as a line drifting late
// or ending in the wrong place.
//
// Conventions are deliberately identical to analyzeMelody's bar-math check
// (same UNIT_EPSILON, same shared parser) so part-level and melody-level
// validation can never disagree about what a valid bar is. Tuplet bars are
// measured properly rather than skipped — scanMeasure applies the q/p ratio.
// measureOffset shifts REPORTED measure numbers only (chunked generation).
export function checkPartBars(partAbc, timeSignature, measureOffset = 0) {
  const expected = barUnitsFor(timeSignature);
  const problems = [];
  partMeasures(partAbc).forEach((meas, i) => {
    const units = measureUnits(meas, timeSignature);
    if (Math.abs(units - expected) > UNIT_EPSILON) {
      problems.push(
        `measure ${i + 1 + measureOffset}: the bar totals ${roundUnits(units)} eighth-note units but a ${timeSignature || "4/4"} bar must total exactly ${expected} ("${meas.trim()}")`,
      );
    }
  });
  return { ok: problems.length === 0, problems: problems.slice(0, 8) };
}

// Check every melody measure this part is responsible for.
// Returns { ok, problems[] }.
// measureOffset shifts REPORTED measure numbers only — used by chunked
// generation, where the checked ABC is one section of a longer piece and
// problems should still name piece measure numbers.
export function checkPartMelody(partAbc, melodyAbc, melodySections = [], measureOffset = 0, timeSignature, canonicalFifths = null, partFifths = null) {
  const canonical = splitMelodyIntoMeasures(melodyAbc);
  const part = partMeasures(partAbc);
  const problems = [];

  for (const label of melodySections) {
    const range = parseMeasureRange(label);
    if (!range) continue;
    for (let n = range.start; n <= range.end && n <= canonical.length; n++) {
      if (n > part.length) {
        problems.push(`measure ${n + measureOffset}: missing from the part (it has only ${part.length} measures)`);
        continue;
      }
      // Tuplet bars are compared like any other now: tokenizeMeasure reads
      // their real durations through the shared parser, so a triplet in the
      // tune is matched against a triplet in the part instead of both being
      // waved through unchecked.
      const problem = compareMeasure(canonical[n - 1], part[n - 1], n + measureOffset, timeSignature, canonicalFifths, partFifths);
      if (problem) problems.push(problem);
    }
  }
  return { ok: problems.length === 0, problems };
}
