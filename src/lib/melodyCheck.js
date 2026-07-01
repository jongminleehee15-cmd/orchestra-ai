// Client-side melody validation for the manual editor — mirrors the server's
// analyzeMelody so users get live "bar 3 is overfull" feedback as they type.
// (Kept in sync with server/lib/abcMelody.js.)

export function splitMeasures(melodyAbc) {
  if (!melodyAbc || typeof melodyAbc !== "string") return [];
  return melodyAbc
    .replace(/:\|\||\|\||\|\]|\[\||:\||\|:/g, "|")
    .split("|")
    .map((m) => m.trim())
    .filter(Boolean);
}

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
    .replace(/![^!]*!/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/[()\->~v.]/g, "")
    .replace(/\s+/g, "");
  const re = /(\[[^\]]*\]|[_^=]*[a-gA-G][,']*|[zxZ])(\d+\/\d+|\d+|\/+)?/g;
  let units = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    units += parseLen(m[2] || "");
  }
  return units;
}

// { ok, problems[], measureCount, expectedUnits }
export function analyzeMelody(melodyAbc, timeSig, expectedMeasures) {
  const [num, den] = String(timeSig || "4/4").split("/").map((n) => parseInt(n, 10));
  const expected = (num || 4) * 8 / (den || 4);
  const measures = splitMeasures(melodyAbc);
  const problems = [];
  if (expectedMeasures && measures.length !== expectedMeasures) {
    problems.push(`${measures.length} measures (expected ${expectedMeasures})`);
  }
  measures.forEach((mez, i) => {
    if (/\(\d/.test(mez)) return; // tuplet — skip
    const u = measureUnits(mez);
    if (Math.abs(u - expected) > 0.01) {
      problems.push(`bar ${i + 1} = ${u} eighth-units (needs ${expected})`);
    }
  });
  return { ok: problems.length === 0, problems, measureCount: measures.length, expectedUnits: expected };
}
