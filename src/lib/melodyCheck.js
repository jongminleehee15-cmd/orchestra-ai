// Client-side melody validation for the manual editor — mirrors the server's
// analyzeMelody so users get live "bar 3 is overfull" feedback as they type.
// (Kept in sync with server/lib/abcMelody.js.)

import { measureUnits, barUnitsFor, isCompound } from "./abcDuration.js";

export function splitMeasures(melodyAbc) {
  if (!melodyAbc || typeof melodyAbc !== "string") return [];
  return melodyAbc
    .replace(/:\|\||\|\||\|\]|\[\||:\||\|:/g, "|")
    .split("|")
    .map((m) => m.trim())
    .filter(Boolean);
}

// { ok, problems[], measureCount, expectedUnits }
export function analyzeMelody(melodyAbc, timeSig, expectedMeasures) {
  const expected = barUnitsFor(timeSig);
  const compound = isCompound(timeSig);
  const measures = splitMeasures(melodyAbc);
  const problems = [];
  if (expectedMeasures && measures.length !== expectedMeasures) {
    problems.push(`${measures.length} measures (expected ${expectedMeasures})`);
  }
  measures.forEach((mez, i) => {
    const u = measureUnits(mez, { compound, barUnits: expected });
    if (Math.abs(u - expected) > 0.01) {
      problems.push(`bar ${i + 1} = ${u} eighth-units (needs ${expected})`);
    }
  });
  return { ok: problems.length === 0, problems, measureCount: measures.length, expectedUnits: expected };
}
