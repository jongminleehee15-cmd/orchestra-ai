// Chunked long-part generation: measure-window math, section clipping,
// header/body stitching, and piece-numbered problem reports from the
// validators when they check a single chunk.
import test from "node:test";
import assert from "node:assert/strict";
import { CHUNK_THRESHOLD, chunkRanges, intersectSections, headerOf, stitchBody } from "../lib/chunking.js";
import { checkPartMelody } from "../lib/partCheck.js";
import { checkPartRange } from "../lib/ranges.js";

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
