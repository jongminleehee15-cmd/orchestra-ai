// Chunked long-part generation: measure-window math, section clipping,
// header/body stitching, and piece-numbered problem reports from the
// validators when they check a single chunk.
import test from "node:test";
import assert from "node:assert/strict";
import { CHUNK_THRESHOLD, chunkRanges, intersectSections, headerOf, stitchBody, restMeasure, fitMeasureCount, isBetterAttempt, repairPartBars, barRepairNote } from "../lib/chunking.js";
import { checkPartMelody, checkPartBars, melodyMeasureSet } from "../lib/partCheck.js";
import { checkPartRange } from "../lib/ranges.js";
import { measureUnits, barUnitsFor, UNIT_EPSILON } from "../lib/abcMelody.js";

test("chunkRanges tiles the piece with no gaps, overlaps, or runt tails", () => {
  assert.deepEqual(chunkRanges(64), [[1, 16], [17, 32], [33, 48], [49, 64]]);
  assert.deepEqual(chunkRanges(40), [[1, 16], [17, 32], [33, 40]]);
  assert.deepEqual(chunkRanges(30), [[1, 16], [17, 30]]);
  // a would-be tail under 8 bars folds into the previous chunk instead
  assert.deepEqual(chunkRanges(20), [[1, 20]]);
  assert.deepEqual(chunkRanges(38), [[1, 16], [17, 38]]);
  // exhaustive: every length that triggers chunking tiles 1..measures exactly
  for (let m = CHUNK_THRESHOLD + 1; m <= 128; m++) {
    const ranges = chunkRanges(m);
    let next = 1;
    for (const [s, e] of ranges) {
      assert.equal(s, next, `${m}: chunk starts at ${s}, expected ${next}`);
      assert.ok(e >= s, `${m}: non-empty chunk`);
      next = e + 1;
    }
    assert.equal(next, m + 1, `${m}: chunks cover the whole piece`);
  }
});

test("intersectSections clips to the window, in piece or local numbering", () => {
  assert.deepEqual(intersectSections(["mm.5-12"], 9, 16), ["mm.9-12"]);
  assert.deepEqual(intersectSections(["mm.5-12"], 9, 16, true), ["mm.1-4"]);
  assert.deepEqual(intersectSections(["mm.1-4", "mm.20-24"], 9, 16), []);
  assert.deepEqual(intersectSections(["mm.1-32"], 17, 32, true), ["mm.1-16"]);
  assert.deepEqual(intersectSections([], 1, 16), []);
});

test("headerOf + stitchBody reassemble a part", () => {
  const chunk = "X:1\nT:Cello\nM:4/4\nL:1/8\nQ:1/4=90\nK:C clef=bass\nC8 | D8 |]";
  assert.equal(headerOf(chunk), "X:1\nT:Cello\nM:4/4\nL:1/8\nQ:1/4=90\nK:C clef=bass");
  const body = stitchBody(["C8", "D8", "E8", "F8", "G8", "A8"]);
  assert.equal(body, "C8 | D8 | E8 | F8 |\nG8 | A8 |]");
  assert.ok(!body.includes("|]\n"), "only the final bar carries |]");
});

test("restMeasure matches the meter in L:1/8 units", () => {
  assert.equal(restMeasure("4/4"), "z8");
  assert.equal(restMeasure("3/4"), "z6");
  assert.equal(restMeasure("6/8"), "z6");
  assert.equal(restMeasure("2/2"), "z8");
  assert.equal(restMeasure(undefined), "z8");
});

test("fitMeasureCount pads a short part with rests and trims an overrun", () => {
  const short = fitMeasureCount(["C8", "D8"], 4, "4/4");
  assert.deepEqual(short.measures, ["C8", "D8", "z8", "z8"]);
  assert.equal(short.padded, 2);
  assert.equal(short.trimmed, 0);
  const long = fitMeasureCount(["C8", "D8", "E8"], 2, "4/4");
  assert.deepEqual(long.measures, ["C8", "D8"]);
  assert.equal(long.trimmed, 1);
  const exact = fitMeasureCount(["C8", "D8"], 2, "4/4");
  assert.deepEqual(exact.measures, ["C8", "D8"]);
  assert.equal(exact.padded + exact.trimmed, 0);
});

test("isBetterAttempt: structure dominates, even when the retry trades one problem for another", () => {
  // Regression for the exact bug in ENGINE_NOTES.md "Length is a retryable
  // problem": a retry that fixes the wrong length but swaps in an equal
  // count of a different problem type must still win, or the length-repair
  // retry is a no-op in precisely the case it exists for.
  const wrongLength = { structure: ["wrong length"], melody: [], total: 1 };
  const rightLengthNewProblem = { structure: [], melody: ["contour differs"], total: 1 };
  assert.equal(isBetterAttempt(rightLengthNewProblem, wrongLength), true);

  // Equal structure count: falls back to comparing totals.
  const worseOverall = { structure: ["wrong length"], melody: ["a", "b"], total: 3 };
  assert.equal(isBetterAttempt(worseOverall, wrongLength), false);
  const betterOverall = { structure: ["wrong length"], melody: [], total: 1 };
  const original = { structure: ["wrong length"], melody: ["a"], total: 2 };
  assert.equal(isBetterAttempt(betterOverall, original), true);

  // Retry makes structure WORSE — must lose even with a lower total elsewhere.
  const worseStructure = { structure: ["wrong length", "another"], total: 2 };
  assert.equal(isBetterAttempt(worseStructure, wrongLength), false);
});

test("checkPartBars catches wrong-length bars that every other validator misses", () => {
  // The exact regression: measure 2 holds 9 eighth-units and measure 3 holds
  // 6 in a 4/4 part. checkPartMelody (non-melody bars), checkPartRange
  // (pitches only) and abcjs's own parser all accept this silently, so the
  // part shipped and drifted out of time with the rest of the ensemble.
  const bad = "X:1\nT:Violin\nM:4/4\nL:1/8\nQ:1/4=90\nK:C clef=treble\nC2 E2 G2 E2 | C2 E2 G2 E2 A | G2 A2 B2 |]";
  const { ok, problems } = checkPartBars(bad, "4/4");
  assert.equal(ok, false);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /measure 2:.*9 eighth-note units.*must total exactly 8/);
  assert.match(problems[1], /measure 3:.*6 eighth-note units.*must total exactly 8/);

  const good = "X:1\nT:Violin\nM:4/4\nL:1/8\nQ:1/4=90\nK:C clef=treble\nC2 E2 G2 E2 | C8 |]";
  assert.deepEqual(checkPartBars(good, "4/4").problems, []);

  // Meter-aware, and tuplets are MEASURED (not skipped): three eighth-note
  // triplet groups fill a 3/4 bar exactly, so only the short bar is flagged.
  const waltz = "X:1\nT:V\nM:3/4\nL:1/8\nQ:1/4=90\nK:C\nC2 E2 G2 | (3CDE (3FGA (3Bcd | C2 E2 |]";
  const w = checkPartBars(waltz, "3/4");
  assert.equal(w.problems.length, 1, `only the short bar, got: ${JSON.stringify(w.problems)}`);
  assert.match(w.problems[0], /measure 3/);

  // Piece numbering under a chunk offset, like the other validators.
  assert.match(checkPartBars(bad, "4/4", 16).problems[0], /measure 18/);
});

test("tuplet bars are measured, not waved through", () => {
  // Previously EVERY bar containing "(3" was skipped by every bar-math check,
  // so a wrong-length triplet bar shipped unvalidated. "(3CDE" is three
  // eighths in the time of two, i.e. 2 units — not 3.
  assert.equal(measureUnits("(3CDE", "4/4"), 2);
  assert.equal(measureUnits("(3C2D2E2", "4/4"), 4, "quarter-note triplet = 4 units");
  assert.equal(measureUnits("(2CD", "4/4"), 3, "duplet: 2 in the time of 3");
  assert.equal(measureUnits("(4CDEF", "4/4"), 3, "quadruplet: 4 in the time of 3");
  // 5/7/9 follow the meter: 2 in simple time, 3 in compound.
  assert.equal(measureUnits("(5CDEFG", "4/4"), 2);
  assert.equal(measureUnits("(5CDEFG", "6/8"), 3);
  // Explicit (p:q:r — only the first r notes belong to the group.
  assert.ok(Math.abs(measureUnits("(3:2:2CD E", "4/4") - (2 / 3 + 2 / 3 + 1)) < 1e-9);
  // A slur is not a tuplet: "(" not followed by a digit carries no ratio.
  assert.equal(measureUnits("(CDE)", "4/4"), 3);

  // A correct 4/4 triplet bar passes; a wrong one is now caught.
  const ok = "X:1\nT:V\nM:4/4\nL:1/8\nQ:1/4=90\nK:C\n(3CDE (3FGA (3Bcd (3efg |]";
  assert.deepEqual(checkPartBars(ok, "4/4").problems, []);
  const short = "X:1\nT:V\nM:4/4\nL:1/8\nQ:1/4=90\nK:C\n(3CDE F2 G2 |]";
  assert.equal(checkPartBars(short, "4/4").problems.length, 1);
  assert.match(checkPartBars(short, "4/4").problems[0], /totals 6 eighth-note units/);
});

test("measureUnits reads a chord's length whether it is written inside or outside the bracket", () => {
  assert.equal(measureUnits("[CEG]2"), 2);
  assert.equal(measureUnits("[C2E2G2]"), 2, "inside form must not read as a single eighth");
  assert.equal(measureUnits("[C2E2G2] E2 G4"), 8);
  assert.equal(barUnitsFor("4/4"), 8);
  assert.equal(barUnitsFor("3/4"), 6);
  assert.equal(barUnitsFor("6/8"), 6);
});

test("UNIT_EPSILON is tighter than any real bar error but looser than float noise", () => {
  // Every ABC duration is a rational whose denominator divides 16 × 9, so the
  // SMALLEST error a real notation mistake can make is 1/144. The tolerance
  // must sit below that (or it hides real mistakes) and above the float error
  // from summing tuplet thirds (or it fires on arithmetic). 0.01 failed the
  // first condition — it was larger than 1/144.
  const smallestRealError = 1 / 144;
  assert.ok(UNIT_EPSILON < smallestRealError, "cannot mask a real wrong bar");
  assert.ok(0.01 > smallestRealError, "the old tolerance could mask one");

  // Worst observed float deviation across the most tuplet-dense bars.
  let worstNoise = 0;
  for (const bar of [
    "(3CDE (3FGA (3Bcd (3efg",
    "(6CDEFGA (6cdefga",
    "(5CDEFG (5cdefg (7CDEFGAB",
    "(9CDEFGABcd",
  ]) {
    const u = measureUnits(bar, "4/4");
    worstNoise = Math.max(worstNoise, Math.abs(u - Math.round(u * 144) / 144));
  }
  assert.ok(worstNoise < UNIT_EPSILON, `float noise ${worstNoise} must stay under the tolerance`);

  // Exactly-correct tuplet bars still pass despite that noise.
  assert.deepEqual(checkPartBars(`X:1\nK:C\n(3CDE (3FGA (3Bcd (3efg |]`, "4/4").problems, []);
});

test("repairPartBars fits accompaniment bars but never rewrites a melody bar", () => {
  const ts = "4/4";
  const short = repairPartBars({ measures: ["G2 A2 B2"], timeSignature: ts });
  assert.equal(measureUnits(short.measures[0]), 8, "short bar padded to a full bar");
  assert.equal(short.unrepairable.length, 0);
  assert.match(short.repaired[0], /measure 1: padded from 6 to 8/);

  const over = repairPartBars({ measures: ["C2 E2 G2 E2 A"], timeSignature: ts });
  assert.equal(measureUnits(over.measures[0]), 8, "overfull bar trimmed to a full bar");
  assert.match(over.repaired[0], /trimmed from 9 to 8/);

  // An event straddling the barline is SHORTENED to fill the bar exactly,
  // not dropped outright — "C16" alone must become a whole note, not a rest.
  const straddle = repairPartBars({ measures: ["C16"], timeSignature: ts });
  assert.equal(straddle.measures[0], "C8");

  // Melody bars are reported, never altered: padding or trimming one would
  // change the tune and manufacture a checkPartMelody failure.
  const melody = repairPartBars({
    measures: ["G2 A2 B2"], timeSignature: ts, melodySet: melodyMeasureSet(["mm.1-1"]),
  });
  assert.equal(melody.measures[0], "G2 A2 B2", "melody bar left byte-for-byte alone");
  assert.equal(melody.repaired.length, 0);
  assert.match(melody.unrepairable[0], /carries the melody/);

  // Correct bars pass through untouched, tuplet or not.
  const skip = repairPartBars({
    measures: ["(3CDE (3FGA (3Bcd (3efg", "!mf!C2 E2 G2 E2"], timeSignature: ts,
  });
  assert.deepEqual(skip.measures, ["(3CDE (3FGA (3Bcd (3efg", "!mf!C2 E2 G2 E2"]);
  assert.equal(skip.repaired.length + skip.unrepairable.length, 0);

  // A SHORT tuplet bar may be padded — rests land after the group, never
  // inside it, so the tuplet stays intact.
  const shortTuplet = repairPartBars({ measures: ["(3CDE (3FGA"], timeSignature: ts });
  assert.equal(measureUnits(shortTuplet.measures[0], ts), 8);
  assert.match(shortTuplet.measures[0], /^\(3CDE \(3FGA /, "the tuplet groups are untouched");
  assert.equal(shortTuplet.repaired.length, 1);

  // An OVERFULL tuplet bar is reported, never cut — trimming would orphan
  // the group, leaving a "(3" whose remaining notes no longer add up.
  const longTuplet = repairPartBars({
    measures: ["(3CDE (3FGA (3Bcd (3efg (3gab"], timeSignature: ts,
  });
  assert.equal(longTuplet.measures[0], "(3CDE (3FGA (3Bcd (3efg (3gab", "left exactly as written");
  assert.equal(longTuplet.repaired.length, 0);
  assert.match(longTuplet.unrepairable[0], /contains a tuplet/);

  // Dynamics survive repair, and piece numbering respects the chunk offset.
  const dyn = repairPartBars({ measures: ["!ff!C2 E2 G2"], timeSignature: ts, measureOffset: 16 });
  assert.match(dyn.measures[0], /^!ff!/);
  assert.equal(measureUnits(dyn.measures[0]), 8);
  assert.match(dyn.repaired[0], /measure 17/);
});

test("barRepairNote summarises repairs in one line, or says nothing", () => {
  assert.equal(barRepairNote([]), null, "a clean part gets no warning");
  assert.equal(barRepairNote(undefined), null);
  assert.match(barRepairNote(["m5: padded"]), /^1 bar didn't add up .* was padded or trimmed/);
  // Many repairs still produce ONE line, so they can't bury other warnings.
  const many = barRepairNote(["m5", "m6", "m7", "m8"]);
  assert.match(many, /^4 bars didn't add up .* were padded or trimmed/);
  assert.equal(many.split("\n").length, 1);
  assert.match(many, /Regenerate/, "tells the user they can get a cleaner take");
});

test("isBetterAttempt: structural damage (count OR bar length) dominates", () => {
  // Regression for ENGINE_NOTES.md "Length is a retryable problem": a retry
  // that fixes the length but swaps in an equal count of a different problem
  // type must still win, or the length repair is a no-op exactly when needed.
  const wrongLength = { structure: ["wrong length"], bars: [], melody: [], total: 1 };
  const rightLengthNewProblem = { structure: [], bars: [], melody: ["contour differs"], total: 1 };
  assert.equal(isBetterAttempt(rightLengthNewProblem, wrongLength), true);

  // A wrong-length BAR counts as structural too — fixing it beats a tie.
  const badBar = { structure: [], bars: ["m3 is 9 units"], total: 1 };
  const fixedBarNewContour = { structure: [], bars: [], melody: ["contour"], total: 1 };
  assert.equal(isBetterAttempt(fixedBarNewContour, badBar), true);

  // Equal structural count falls back to comparing totals, both directions.
  assert.equal(isBetterAttempt({ structure: ["x"], bars: [], total: 3 }, wrongLength), false);
  assert.equal(
    isBetterAttempt({ structure: ["x"], bars: [], total: 1 }, { structure: ["x"], bars: [], total: 2 }),
    true,
  );
  // A retry that makes structure worse loses even with a lower total.
  assert.equal(isBetterAttempt({ structure: ["a", "b"], bars: [], total: 2 }, wrongLength), false);
  // Callers that predate the `bars` field still work (treated as zero).
  assert.equal(isBetterAttempt({ structure: [], total: 0 }, { structure: ["x"], total: 1 }), true);
});

test("validators report PIECE measure numbers when given a chunk offset", () => {
  // A chunk covering piece measures 17-20; local melody mm.1-2 = piece 17-18.
  const chunkAbc = "X:1\nT:Violin\nM:4/4\nL:1/8\nQ:1/4=90\nK:C\nC2 E2 G2 E2 | G,,8 | c8 | d8 |]";
  const melody = checkPartMelody(chunkAbc, "C2 E2 G2 c2 | C8", ["mm.1-2"], 16);
  assert.ok(melody.problems.length > 0);
  assert.match(melody.problems[0], /measure 17/, `piece-numbered: ${melody.problems[0]}`);
  const range = checkPartRange(chunkAbc, "Violin", 16);
  assert.equal(range.problems.length, 1);
  assert.match(range.problems[0], /measure 18/, `piece-numbered: ${range.problems[0]}`);
});

test("isBetterAttempt: a retry with no usable notation never beats a real part", () => {
  // Live 2026-09-27 (Elise English Horn, 24 bars of 3/8): the first attempt
  // had 8 bars half an eighth short (repairable) plus melody and range
  // problems; the retry returned nothing usable. Counted per message the
  // empty retry won (1 structural problem vs 8) and shipped 24 bars of rests.
  const firstAttempt = { structure: [], bars: Array(8).fill("short bar"), melody: ["a", "b"], range: Array(8).fill("low"), lengthOff: 0, total: 18 };
  const emptyRetry = { structure: ["you wrote 0 measures"], bars: [], melody: Array(6).fill("missing"), range: [], lengthOff: 24, total: 7 };
  assert.equal(isBetterAttempt(emptyRetry, firstAttempt), false, "24 bars of silence is worse than 8 short bars");
  assert.equal(isBetterAttempt(firstAttempt, emptyRetry), true);
  // Each missing measure weighs what a bad bar does: a retry 2 measures short
  // but otherwise clean beats 3 bad bars, and loses to 1.
  const twoShort = { structure: ["you wrote 22 measures"], bars: [], lengthOff: 2, total: 1 };
  assert.equal(isBetterAttempt(twoShort, { structure: [], bars: ["x", "y", "z"], lengthOff: 0, total: 3 }), true);
  assert.equal(isBetterAttempt(twoShort, { structure: [], bars: ["x"], lengthOff: 0, total: 1 }), false);
});
