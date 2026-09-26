// Helpers for working with the canonical melody as discrete measures.
//
// melodyAbc from the blueprint is a single ABC line: measures separated by `|`,
// ending with `|]`. To maximize melody accuracy we hand each part the EXACT
// notes of the measures it carries, rather than trusting the model to re-derive
// the tune from a prose description. These helpers do the slicing.

// Split the canonical melody body into an array of per-measure note strings.
// Strips repeat markers and the final `|]` so indices line up with measure
// numbers (measure N == result[N-1]).
export function splitMelodyIntoMeasures(melodyAbc) {
  if (!melodyAbc || typeof melodyAbc !== "string") return [];
  return melodyAbc
    // normalize all barline variants (|], ||, |:, :|, ::) to a single divider
    .replace(/:\|\||\|\||\|\]|\[\||:\||\|:/g, "|")
    .split("|")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

// Parse a section label like "mm.1-8", "mm. 17-24", "m.5", "5-12" into a
// 1-based inclusive { start, end } range. Returns null if unparseable.
export function parseMeasureRange(label) {
  if (!label) return null;
  const nums = String(label).match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  const start = parseInt(nums[0], 10);
  const end = nums.length > 1 ? parseInt(nums[1], 10) : start;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

// Given the full measure array and a range label, return the exact ABC for that
// slice (measures joined by " | "). Empty string if nothing matches.
export function sliceMelody(measureArr, label) {
  const range = parseMeasureRange(label);
  if (!range || measureArr.length === 0) return "";
  const slice = measureArr.slice(range.start - 1, range.end);
  return slice.join(" | ");
}

// Units in one full bar of a meter, in L:1/8 eighths (4/4 → 8, 3/4 → 6, 6/8 → 6).
// One definition shared by melody validation, part validation, and bar repair.
export function barUnitsFor(timeSignature) {
  const [num, den] = String(timeSignature || "4/4").split("/").map((n) => parseInt(n, 10));
  return (num || 4) * 8 / (den || 4);
}

// Sum the durational units (in L=1/8 eighths) of one measure's note text, so we
// can check a bar is neither short nor overfull. Tolerant of decorations, chord
// symbols, ties/slurs, chords [CEG], and rests.
function parseLen(s) {
  if (!s) return 1;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^\/+$/.test(s)) return 1 / Math.pow(2, s.length);
  const m = s.match(/^(\d*)\/(\d+)$/);
  if (m) return (m[1] ? parseInt(m[1], 10) : 1) / parseInt(m[2], 10);
  return 1;
}
// A compound meter counts in groups of three (6/8, 9/8, 12/8) — 3/4 is simple
// triple, not compound. Only affects the default tuplet ratio for 5, 7 and 9.
function isCompoundMeter(timeSignature) {
  const num = parseInt(String(timeSignature || "4/4").split("/")[0], 10);
  return Number.isFinite(num) && num > 3 && num % 3 === 0;
}

// How many notes' worth of time a "(p" tuplet occupies when q is not spelled
// out, per the ABC standard: (2 = 2 in the time of 3, (3 = 3 in the time of
// 2, and so on; 5, 7 and 9 follow the meter.
function defaultTupletQ(p, compound) {
  switch (p) {
    case 2: return 3;
    case 3: return 2;
    case 4: return 3;
    case 6: return 2;
    case 8: return 3;
    default: return compound ? 3 : 2; // 5, 7, 9
  }
}

// Walk a measure's ORIGINAL text and return every duration-bearing event as
// { start, end, text, units } (offsets index into measureStr). Decoration
// regions (!mf!, "chords", {grace notes}) and articulation/slur/tie
// characters carry no duration and are skipped, so offsets stay valid for
// rewriting the text.
//
// Tuplets are honoured: "(p", "(p:q" and "(p:q:r" scale the next r events by
// q/p, so "(3CDE" correctly measures 2 eighth-units rather than 3. Before
// this, every caller simply SKIPPED any bar containing a tuplet, which meant
// a wrong-length tuplet bar shipped unchecked.
//
// This is the ONE duration parser. measureUnits sums it, tokenizeMeasure
// reads pitches off it, and the bar repair slices by its offsets —
// deliberately not several implementations that can drift apart (the same
// mistake that left the chunked retry path unfixed; see ENGINE_NOTES.md).
export function scanMeasure(measureStr, timeSignature) {
  const s = String(measureStr);
  const compound = isCompoundMeter(timeSignature);
  // Alternation order matters: skip-regions are matched BEFORE note tokens so
  // a letter inside !crescendo! or "Gm7" is never read as a pitch. The tuplet
  // marker is matched before them too — "(" followed by a digit is a tuplet,
  // "(" followed by anything else is a slur and carries no duration.
  const re = /(![^!]*!|"[^"]*"|\{[^}]*\})|\((\d)(?::(\d*))?(?::(\d*))?|(\[[^\]]*\]|[_^=]*[a-gA-G][,']*|[zxZ])(\d+\/\d+|\d+|\/+)?/g;
  const events = [];
  let m;
  let tupletLeft = 0;
  let tupletRatio = 1;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m[1]) continue; // decoration / annotation / grace notes — no duration
    if (m[2]) {
      const p = parseInt(m[2], 10);
      const q = m[3] ? parseInt(m[3], 10) : defaultTupletQ(p, compound);
      const r = m[4] ? parseInt(m[4], 10) : p;
      if (p > 0 && q > 0 && r > 0) { tupletLeft = r; tupletRatio = q / p; }
      continue;
    }
    let units;
    // A chord can carry its length OUTSIDE the bracket ("[CEG]2") or written
    // on the notes INSIDE it ("[C2E2G2]") — both are legal ABC and the chord
    // lasts as long as its notes either way. Without this, the inside form
    // read as 1 unit and reported a false "bar is short" problem.
    if (m[5].startsWith("[") && !m[6]) {
      const inner = [...m[5].matchAll(/[_^=]*[a-gA-G][,']*(\d+\/\d+|\d+|\/+)?/g)]
        .map((x) => parseLen(x[1] || ""));
      units = inner.length ? Math.max(...inner) : 1;
    } else {
      units = parseLen(m[6] || "");
    }
    if (tupletLeft > 0) { units *= tupletRatio; tupletLeft -= 1; }
    events.push({ start: m.index, end: m.index + m[0].length, text: m[0], units });
  }
  return events;
}

// True when the measure contains a tuplet group. Bar repair uses this to
// refuse to cut INTO a tuplet, which would leave an orphaned group.
export function hasTuplet(measureStr) {
  return /\(\d/.test(String(measureStr));
}

export function measureUnits(measureStr, timeSignature) {
  return scanMeasure(measureStr, timeSignature).reduce((sum, e) => sum + e.units, 0);
}

// Tuplet ratios are thirds, so a bar total can land on 3.9999999999999996.
// Only for DISPLAY in warnings — comparisons use UNIT_EPSILON.
export function roundUnits(u) {
  return Math.round(u * 1000) / 1000;
}

// How close two durations must be to count as equal.
//
// Sized from measurement, not habit. Tuplet ratios are thirds/fifths/sevenths,
// so summing a bar accumulates binary floating-point error — measured at worst
// 8.9e-16 across the most tuplet-dense bars ABC can express. Meanwhile the
// SMALLEST error a real notation mistake can produce is 1/144 ≈ 0.0069 (a
// nine-tuplet of sixteenth notes), because every ABC duration is a rational
// whose denominator divides 16 × 9.
//
// The previous 0.01 sat ABOVE that floor, so a genuinely wrong bar could slip
// through as "close enough". 1e-9 sits six orders of magnitude above the float
// noise and seven below the smallest real error — it cannot mask a mistake and
// cannot fire on arithmetic.
export const UNIT_EPSILON = 1e-9;

// Check a melody line: right number of measures, and every bar sums to the meter.
// Returns { ok, problems[] }. Tuplet bars are measured properly by scanMeasure
// rather than skipped, so a wrong-length triplet bar is caught like any other.
export function analyzeMelody(melodyAbc, timeSignature, expectedMeasures) {
  const expected = barUnitsFor(timeSignature);
  const measures = splitMelodyIntoMeasures(melodyAbc);
  const problems = [];
  if (expectedMeasures && measures.length !== expectedMeasures) {
    problems.push(`the melody has ${measures.length} measures but must have exactly ${expectedMeasures}`);
  }
  measures.forEach((mez, i) => {
    const u = measureUnits(mez, timeSignature);
    if (Math.abs(u - expected) > UNIT_EPSILON) {
      problems.push(`measure ${i + 1} ("${mez}") = ${u} eighth-units but a ${timeSignature || "4/4"} bar must total ${expected}`);
    }
  });
  return { ok: problems.length === 0, problems };
}

// Build a "measure N: <notes>" reference block for every range this part carries
// the melody in. This is the precise, per-measure tune the part must reproduce.
export function buildMelodyExcerpts(melodyAbc, melodySections = []) {
  const measures = splitMelodyIntoMeasures(melodyAbc);
  if (measures.length === 0 || !melodySections || melodySections.length === 0) {
    return "";
  }
  const blocks = [];
  for (const label of melodySections) {
    const range = parseMeasureRange(label);
    if (!range) continue;
    const lines = [];
    for (let m = range.start; m <= range.end && m <= measures.length; m++) {
      lines.push(`  measure ${m}: ${measures[m - 1]}`);
    }
    if (lines.length > 0) {
      blocks.push(`${label}:\n${lines.join("\n")}`);
    }
  }
  return blocks.join("\n");
}
