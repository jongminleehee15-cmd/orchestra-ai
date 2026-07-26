// ─────────────────────────────────────────────────────────────────────────────
// abcValidate.js — validate what came back, don't just ask nicely for it.
//
// Two checks the project currently lacks:
//   1. analyzeMelody with anacrusis awareness (pickup bars stop being errors)
//   2. checkPartAgainstMelody — does the generated part ACTUALLY contain the
//      canonical tune in the measures it was assigned? This is the missing
//      feedback signal: today nothing verifies the melody survived the trip
//      through the model, so a drifted part is indistinguishable from a good one.
// ─────────────────────────────────────────────────────────────────────────────
import { measureUnits, barUnitsFor, isCompound } from "./abcDuration.js";
import { transposeAbcBody, parseNoteToken, keyAccidentals } from "./abcPitch.js";

const LETTER_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const SEMIS = [0, 2, 4, 5, 7, 9, 11];

export function splitMeasures(abcBody) {
  if (!abcBody || typeof abcBody !== "string") return [];
  return String(abcBody)
    .replace(/:\|\||\|\||\|\]|\[\||:\||\|:|::/g, "|")
    .split("|")
    .map((m) => m.trim())
    .filter(Boolean);
}

// Bar-math validation that understands pickups. A short FIRST bar plus a short
// LAST bar that together make one full measure is a correctly notated anacrusis,
// not two errors.
export function analyzeMelody(abcBody, timeSignature = "4/4", expectedMeasures = null) {
  const full = barUnitsFor(timeSignature);
  const compound = isCompound(timeSignature);
  const bars = splitMeasures(abcBody);
  const units = bars.map((b) => measureUnits(b, { compound, barUnits: full }));
  const problems = [];

  let firstIsPickup = false;
  if (units.length > 1 && units[0] < full) {
    const last = units[units.length - 1];
    if (Math.abs(units[0] + last - full) < 0.01 || Math.abs(units[0] - (full - last)) < 0.01) {
      firstIsPickup = true;
    } else if (units[0] < full) {
      firstIsPickup = true; // lone pickup with no compensating final bar: still legal
    }
  }

  const counted = firstIsPickup ? bars.length - 1 : bars.length;
  if (expectedMeasures && counted !== expectedMeasures) {
    problems.push(
      `has ${counted} full measures${firstIsPickup ? " (plus a pickup)" : ""} but must have exactly ${expectedMeasures}`,
    );
  }
  units.forEach((u, i) => {
    if (firstIsPickup && i === 0) return;
    if (firstIsPickup && i === units.length - 1) return; // compensated final bar
    if (Math.abs(u - full) > 0.01) {
      problems.push(`measure ${firstIsPickup ? i : i + 1} ("${bars[i]}") = ${round(u)} eighth-units, needs ${full}`);
    }
  });
  return { ok: problems.length === 0, problems, bars, units, firstIsPickup };
}

const round = (n) => Math.round(n * 1000) / 1000;

// Absolute chromatic pitches of one measure, ignoring rhythm and octave choice.
function pitchClassesOf(measureStr, key) {
  const sig = keyAccidentals(key);
  const barAcc = {};
  const out = [];
  const RE = /[_^=]{0,2}[A-Ga-g][,']*[\d/]*/g;
  let m;
  const cleaned = String(measureStr).replace(/!.*?!/g, "").replace(/"[^"]*"/g, "").replace(/\{[^}]*\}/g, "");
  while ((m = RE.exec(cleaned)) !== null) {
    const p = parseNoteToken(m[0]);
    if (!p) continue;
    const slot = p.letter + p.octave;
    let acc;
    if (p.accStr) { acc = { "^^": 2, "^": 1, "=": 0, _: -1, __: -2 }[p.accStr]; barAcc[slot] = acc; }
    else if (slot in barAcc) acc = barAcc[slot];
    else acc = sig[p.letter];
    out.push((((SEMIS[LETTER_IDX[p.letter]] + acc) % 12) + 12) % 12);
  }
  return out;
}

// Does `partAbc` reproduce the canonical melody in the measures it was assigned?
// Compares pitch-class sequences, so octave transposition into an instrument's
// range is allowed but a different tune is not.
//   transposition: { diatonic, semitones, writtenKey } when the part is written
//   for a transposing instrument; omit for concert-pitch parts.
export function checkPartAgainstMelody(partAbc, {
  melodyAbc, melodySections = [], concertKey = "C", transposition = null, timeSignature = "4/4",
}) {
  const partBody = String(partAbc).split(/\r?\n/).filter((l) => l.trim() && !/^[A-Za-z]:/.test(l) && !/^%%/.test(l)).join(" ");
  const partKey = transposition?.writtenKey || concertKey;

  let reference = melodyAbc;
  if (transposition) {
    reference = transposeAbcBody(melodyAbc, {
      fromKey: concertKey, toKey: transposition.writtenKey,
      diatonic: transposition.diatonic, semitones: transposition.semitones,
    });
  }
  const refBars = splitMeasures(reference);
  const partBars = splitMeasures(partBody);
  const mismatches = [];
  let checked = 0;

  for (const label of melodySections) {
    const nums = String(label).match(/\d+/g);
    if (!nums) continue;
    const start = parseInt(nums[0], 10);
    const end = nums[1] ? parseInt(nums[1], 10) : start;
    for (let n = start; n <= end; n++) {
      const ref = refBars[n - 1], got = partBars[n - 1];
      if (ref === undefined || got === undefined) continue;
      checked++;
      const a = pitchClassesOf(ref, partKey);
      const b = pitchClassesOf(got, partKey);
      const same = a.length === b.length && a.every((v, i) => v === b[i]);
      if (!same) mismatches.push({ measure: n, expected: ref, got, expectedPc: a, gotPc: b });
    }
  }
  return {
    ok: mismatches.length === 0,
    checked,
    mismatches,
    accuracy: checked ? round(1 - mismatches.length / checked) : null,
  };
}
