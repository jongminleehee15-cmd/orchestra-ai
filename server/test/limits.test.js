// Server-side input clamping (public-deploy hardening): measures must be one
// of the client's own dropdown values, and ALLOWED_MEASURES must stay in sync
// with src/lib/constants.js MEASURE_OPTIONS or the UI can offer a value the
// API 400s.
import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_MEASURES, MAX_INSTRUMENTS, isValidMeasures } from "../lib/limits.js";

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
