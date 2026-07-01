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
export function measureUnits(measureStr) {
  const s = String(measureStr)
    .replace(/![^!]*!/g, "")     // !mf! style decorations
    .replace(/"[^"]*"/g, "")     // "chord symbol" / annotation
    .replace(/\{[^}]*\}/g, "")   // {grace notes}
    .replace(/[()\->~v.]/g, "")  // slurs, ties, broken rhythm, staccato dots
    .replace(/\s+/g, "");
  const re = /(\[[^\]]*\]|[_^=]*[a-gA-G][,']*|[zxZ])(\d+\/\d+|\d+|\/+)?/g;
  let units = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    units += parseLen(m[2] || "");
  }
  return units;
}

// Check a melody line: right number of measures, and every bar sums to the meter.
// Returns { ok, problems[] }. Bars containing tuplets are skipped (their unit math
// differs and models rarely use them in these tunes) to avoid false positives.
export function analyzeMelody(melodyAbc, timeSignature, expectedMeasures) {
  const [num, den] = String(timeSignature || "4/4").split("/").map((n) => parseInt(n, 10));
  const expected = (num || 4) * 8 / (den || 4);
  const measures = splitMelodyIntoMeasures(melodyAbc);
  const problems = [];
  if (expectedMeasures && measures.length !== expectedMeasures) {
    problems.push(`the melody has ${measures.length} measures but must have exactly ${expectedMeasures}`);
  }
  measures.forEach((mez, i) => {
    if (/\(\d/.test(mez)) return; // tuplet — skip
    const u = measureUnits(mez);
    if (Math.abs(u - expected) > 0.01) {
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
