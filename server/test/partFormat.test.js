// The part wire format: a server-built ABC header plus a JSON envelope of
// bare measures. Guards the two things this format exists to guarantee —
// a part can never carry a wrong/missing header, and nothing that isn't
// notation can reach the stave.
import test from "node:test";
import assert from "node:assert/strict";
import abcjs from "abcjs";
import { partHeader, parsePartMeasures, responseToPartAbc, cleanAbc } from "../lib/partFormat.js";
import { measureUnits } from "../lib/abcMelody.js";
import { checkPartBars, partMeasures, melodyMeasureSet } from "../lib/partCheck.js";
import { repairPartBars, stitchBody, headerOf } from "../lib/chunking.js";

const REQ = { key: "D", timeSignature: "4/4", bpm: 56 };

test("partHeader is built from the request, not from model output", () => {
  assert.equal(
    partHeader(REQ, "Violin"),
    "X:1\nT:Violin\nM:4/4\nL:1/8\nQ:1/4=56\nK:D clef=treble",
  );
  // Clef comes from the instrument, not a guess.
  assert.match(partHeader(REQ, "Cello"), /^K:D clef=bass$/m);

  // The whole point for a transposing instrument: a Bb trumpet in a concert-D
  // arrangement READS in E. Letting the model write this line is how a part
  // ends up notated in the wrong key.
  const trumpet = partHeader(REQ, "Trumpet");
  assert.match(trumpet, /^K:E clef=treble$/m);
  assert.match(trumpet, /^T:Trumpet \(in B♭\)$/m);
  // Duplicate players keep their voice number in the title.
  assert.match(partHeader(REQ, "Trumpet 2"), /^T:Trumpet 2 \(in B♭\)$/m);
});

test("parsePartMeasures reads the JSON envelope and tolerates stray barlines", () => {
  assert.deepEqual(
    parsePartMeasures('{"measures":["C2 E2 G2 E2","F4 E4"]}'),
    ["C2 E2 G2 E2", "F4 E4"],
  );
  assert.deepEqual(parsePartMeasures('```json\n{"measures":["C8"]}\n```'), ["C8"]);

  // Every barline spelling is removed whole — "|]" must not leave a "]"
  // behind, which would read as a broken chord.
  assert.deepEqual(
    parsePartMeasures('{"measures":["| C2 E2 G2 E2 |","F8 |]","C8 ||","|: D8 :|"]}'),
    ["C2 E2 G2 E2", "F8", "C8", "D8"],
  );

  // Musical content is preserved untouched.
  assert.deepEqual(parsePartMeasures('{"measures":["!mf!C2 E2 G2 E2"]}'), ["!mf!C2 E2 G2 E2"]);
  assert.deepEqual(parsePartMeasures('{"measures":["[CEG]4 [DFA]4"]}'), ["[CEG]4 [DFA]4"]);
  assert.deepEqual(parsePartMeasures('{"measures":["z8"]}'), ["z8"]);
});

test("parsePartMeasures never lets non-notation reach the stave", () => {
  // A response cut off mid-array: extractJson salvages a truncated array by
  // walking back to the last "]", so this must NOT be read as notation.
  assert.deepEqual(parsePartMeasures('{"measures":["C8","D8","E'), []);
  // A refusal or any other prose.
  assert.deepEqual(parsePartMeasures("I cannot help with that."), []);
  // Prose sitting inside an otherwise valid array is dropped; the resulting
  // short count is what the caller's structure check retries on.
  assert.deepEqual(parsePartMeasures('{"measures":["C8","I am unable to continue","D8"]}'), ["C8", "D8"]);
  // Non-string entries are ignored rather than stringified into the score.
  assert.deepEqual(parsePartMeasures('{"measures":["C8",null,42,"D8"]}'), ["C8", "D8"]);
  // An explicitly empty envelope is an empty part, not a fall-through.
  assert.deepEqual(parsePartMeasures('{"measures":[]}'), []);
});

test("parsePartMeasures still accepts raw ABC as a fallback", () => {
  assert.deepEqual(
    parsePartMeasures("X:1\nT:V\nM:4/4\nL:1/8\nQ:1/4=90\nK:C\nC8 | D8 |]"),
    ["C8", "D8"],
  );
  assert.equal(cleanAbc("```abc\nX:1\nK:C\nC8 |]\n```").startsWith("X:1"), true);
});

// End-to-end over the same sequence /api/part runs: parse the response, check
// the bars, repair what is safe to repair, reassemble. Exercises the composed
// data path rather than each helper in isolation.
test("a malformed model response is detected and repaired into a playable part", () => {
  const header = partHeader(REQ, "Violin");
  // Measure 2 (accompaniment) is overfull by one eighth, measure 3
  // (accompaniment) is two short, measure 4 carries the MELODY and is short.
  const response = JSON.stringify({
    measures: ["C2 E2 G2 E2", "C2 E2 G2 E2 A", "G2 A2 B2", "d3e f2"],
  });

  const abc = responseToPartAbc(response, header);
  const before = checkPartBars(abc, "4/4");
  assert.equal(before.problems.length, 3, `all three bad bars found: ${JSON.stringify(before.problems)}`);

  const melodySet = melodyMeasureSet(["mm.4-4"]);
  const fix = repairPartBars({ measures: partMeasures(abc), timeSignature: "4/4", melodySet });
  const repaired = `${headerOf(abc)}\n${stitchBody(fix.measures)}`;

  // Both accompaniment bars are now exactly one bar long.
  assert.equal(fix.repaired.length, 2);
  assert.equal(measureUnits(fix.measures[1]), 8);
  assert.equal(measureUnits(fix.measures[2]), 8);

  // The melody bar was NOT rewritten — it is reported instead, so the tune is
  // never silently altered to satisfy the bar count.
  assert.equal(fix.measures[3], "d3e f2");
  assert.equal(fix.unrepairable.length, 1);
  assert.match(fix.unrepairable[0], /measure 4: this part carries the melody/);

  // Only the melody bar is still flagged, and the result is valid ABC.
  const after = checkPartBars(repaired, "4/4");
  assert.equal(after.problems.length, 1);
  assert.match(after.problems[0], /measure 4/);
  assert.equal(partMeasures(repaired).length, 4, "measure count preserved");
  assert.equal(abcjs.parseOnly(repaired)[0].warnings, undefined, "engraves cleanly");
});

test("responseToPartAbc assembles a complete, well-formed part", () => {
  const header = partHeader(REQ, "Violin");
  const abc = responseToPartAbc('{"measures":["C2 E2 G2 E2","F4 E4"]}', header);
  assert.equal(abc, `${header}\nC2 E2 G2 E2 | F4 E4 |]`);
  // Each bar survives round-tripping with its duration intact.
  assert.equal(measureUnits("C2 E2 G2 E2"), 8);

  // An unusable response yields the header alone, which the caller's length
  // check then pads into an explicit all-rests part with a warning — it never
  // ships the garbage itself.
  assert.equal(responseToPartAbc("I cannot help with that.", header), header);
  assert.equal(responseToPartAbc("", header), header);
});
