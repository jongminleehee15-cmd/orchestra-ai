// Validate that a generated instrument part actually plays the canonical
// melody in the measures it was assigned. Comparison is transposition-
// invariant so it works for Bb/F/Eb instruments and octave-shifted parts:
//   - RHYTHM must match exactly (sequence of note durations per measure)
//   - CONTOUR must match exactly (up/down/same between consecutive notes)
// Pitch-class-exact checking would require full key-signature bookkeeping on
// both sides; rhythm+contour catches wrong tunes, flattened rhythms, dropped
// notes, and mid-phrase octave breaks without it (see ENGINE_NOTES.md).

import { splitMelodyIntoMeasures, parseMeasureRange } from "./abcMelody.js";

// Semitone value for an ABC pitch token (ignoring key signature — fine for
// contour, see header comment). ^/_/= accidentals and ,/' octave marks apply.
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function semitone(tok) {
  const m = tok.match(/^([_^=]*)([a-gA-G])([,']*)$/);
  if (!m) return null;
  const [, accs, letter, octs] = m;
  let st = BASE[letter.toUpperCase()];
  st += letter === letter.toLowerCase() ? 12 : 0; // lowercase = octave up
  for (const a of accs) st += a === "^" ? 1 : a === "_" ? -1 : 0;
  for (const o of octs) st += o === "'" ? 12 : -12;
  return st;
}

function parseLen(s) {
  if (!s) return 1;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^\/+$/.test(s)) return 1 / Math.pow(2, s.length);
  const m = s.match(/^(\d*)\/(\d+)$/);
  if (m) return (m[1] ? parseInt(m[1], 10) : 1) / parseInt(m[2], 10);
  return 1;
}

// Tokenize one measure into [{ st, len }] (st null for rests). Chords [CEG]
// contribute their TOP note (melody is voiced on top by convention).
export function tokenizeMeasure(measureStr) {
  const s = String(measureStr)
    .replace(/![^!]*!/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/[()\-<>~v.uH]/g, "")
    .replace(/\s+/g, "");
  const re = /(\[[^\]]*\]|[_^=]*[a-gA-G][,']*|[zxZ])(\d+\/\d+|\d+|\/+)?/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    const len = parseLen(m[2] || "");
    let st = null;
    if (m[1].startsWith("[")) {
      const inner = [...m[1].matchAll(/[_^=]*[a-gA-G][,']*/g)].map((x) => semitone(x[0]));
      st = inner.length ? Math.max(...inner.filter((v) => v !== null)) : null;
    } else if (!/^[zxZ]$/.test(m[1])) {
      st = semitone(m[1]);
    }
    out.push({ st, len });
  }
  return out;
}

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

// Compare one part measure against the canonical measure.
// Returns null if OK, else a human-readable problem description.
function compareMeasure(canonical, part, measureNo) {
  const want = tokenizeMeasure(canonical);
  const got = tokenizeMeasure(part);

  if (got.length !== want.length) {
    return `measure ${measureNo}: expected ${want.length} notes (${canonical.trim()}) but the part has ${got.length}`;
  }
  for (let i = 0; i < want.length; i++) {
    if (Math.abs(want[i].len - got[i].len) > 0.01) {
      return `measure ${measureNo}: rhythm differs at note ${i + 1} — canonical durations are [${want.map((n) => n.len).join(" ")}], part has [${got.map((n) => n.len).join(" ")}] (canonical: ${canonical.trim()})`;
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
      return `measure ${measureNo}: melodic contour differs between notes ${i} and ${i + 1} — the tune ${word(wd)} there but your line ${word(gd)} (canonical: ${canonical.trim()})`;
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

// Check every melody measure this part is responsible for.
// Returns { ok, problems[] }.
export function checkPartMelody(partAbc, melodyAbc, melodySections = []) {
  const canonical = splitMelodyIntoMeasures(melodyAbc);
  const part = partMeasures(partAbc);
  const problems = [];

  for (const label of melodySections) {
    const range = parseMeasureRange(label);
    if (!range) continue;
    for (let n = range.start; n <= range.end && n <= canonical.length; n++) {
      if (n > part.length) {
        problems.push(`measure ${n}: missing from the part (part has only ${part.length} measures)`);
        continue;
      }
      if (/\(\d/.test(canonical[n - 1]) || /\(\d/.test(part[n - 1])) continue; // tuplets — skip
      const problem = compareMeasure(canonical[n - 1], part[n - 1], n);
      if (problem) problems.push(problem);
    }
  }
  return { ok: problems.length === 0, problems };
}
