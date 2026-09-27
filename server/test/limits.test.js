// Server-side input clamping (public-deploy hardening): measures must be one
// of the client's own dropdown values, and ALLOWED_MEASURES must stay in sync
// with src/lib/constants.js MEASURE_OPTIONS or the UI can offer a value the
// API 400s.
import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_MEASURES, MAX_INSTRUMENTS, isValidMeasures, sanitizeContextParts, MAX_CONTEXT_ABC, PART_BODY_LIMIT } from "../lib/limits.js";
import { fitContext, CONTEXT_BUDGET } from "../../src/lib/context.js";

test("context parts: malformed entries are dropped, never a reason to fail", () => {
  const ok = { instrName: "Flute", abc: "X:1\nK:C\nC8 |]" };
  assert.equal(sanitizeContextParts(undefined, "Oboe"), null);
  assert.equal(sanitizeContextParts("nope", "Oboe"), null);
  assert.equal(sanitizeContextParts([], "Oboe"), null);
  const r = sanitizeContextParts([
    ok, null, 7, { instrName: 3, abc: "x" }, { instrName: "Viola" }, // malformed
    { instrName: "Oboe", abc: "C8" }, // the part being written: never its own context
    { instrName: "Flute", abc: "D8" }, // duplicate name: first wins
    { instrName: "Tuba", abc: "C".repeat(MAX_CONTEXT_ABC + 1) }, // oversized
  ], "Oboe");
  assert.deepEqual(r, [ok]);
  const many = Array.from({ length: 40 }, (_, i) => ({ instrName: `V${i}`, abc: "C8" }));
  assert.equal(sanitizeContextParts(many, "Oboe").length, MAX_INSTRUMENTS);
});

test("worst-case context fits the client budget, and the budget fits the server cap", () => {
  // 15 finished parts × 128 bars of heavily decorated ABC (~80 chars a bar).
  const bar = '!mf!"Dm7"(^F/G/A/B/ c2) [DFA]2 z2 !f!(^c/d/e/f/ g2) [CEG]2 .A,2 !p!"G7"(B,/D/F/A/) |';
  assert.ok(bar.length >= 80, `a realistically heavy bar (${bar.length} chars)`);
  const body = Array.from({ length: 128 }, () => bar).join(" ");
  const parts = Array.from({ length: 15 }, (_, i) => ({ instrName: `Violin ${i + 1}`, abc: `X:1\nT:x\nM:4/4\nL:1/8\nQ:1/4=100\nK:C clef=treble\n${body}` }));
  assert.ok(parts[0].abc.length < MAX_CONTEXT_ABC, "one part is under the per-part cap");
  const fitted = fitContext(parts);
  assert.equal(fitted.length, 15, "nothing had to be dropped");
  assert.ok(JSON.stringify(fitted).length <= CONTEXT_BUDGET);
  assert.ok(CONTEXT_BUDGET + 20_000 < parseInt(PART_BODY_LIMIT, 10) * 1024, "room for the rest of the request");
  // Over budget, context is trimmed from the end instead of failing.
  const trimmed = fitContext(parts, 50_000);
  assert.ok(trimmed.length > 0 && trimmed.length < 15);
  assert.ok(JSON.stringify(trimmed).length <= 50_000);
  assert.deepEqual(trimmed, parts.slice(0, trimmed.length));
});

test("isValidMeasures accepts every allowed option", () => {
  for (const m of ALLOWED_MEASURES) assert.ok(isValidMeasures(m), `${m} should be valid`);
});

test("isValidMeasures rejects out-of-range, in-between, and non-numeric values", () => {
  assert.ok(!isValidMeasures(10000), "an arbitrary huge value is rejected");
  assert.ok(!isValidMeasures(20), "a value between valid options is rejected");
  assert.ok(!isValidMeasures("banana"), "a non-numeric value is rejected");
  assert.ok(!isValidMeasures(undefined), "undefined is rejected");
});

test("isValidMeasures accepts numeric strings (JSON body values)", () => {
  assert.ok(isValidMeasures("8"), "a numeric string matching an allowed value is valid");
});

test("ALLOWED_MEASURES matches the client's MEASURE_OPTIONS", () => {
  assert.deepEqual(ALLOWED_MEASURES, [4, 8, 12, 16, 24, 32, 48, 64, 96, 128]);
});

test("MAX_INSTRUMENTS is a sane, positive cap", () => {
  assert.ok(MAX_INSTRUMENTS > 0 && MAX_INSTRUMENTS <= 32);
});
