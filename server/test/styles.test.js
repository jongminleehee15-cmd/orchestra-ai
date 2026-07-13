// The style/density chips live in src/lib/constants.js; their arranging
// directives live in server/lib/styles.js. This keeps the two in sync — a
// chip without a directive would silently degrade to the old do-nothing word.
import test from "node:test";
import assert from "node:assert/strict";
import { STYLE_DIRECTIVES, DENSITY_DIRECTIVES, styleBlock } from "../lib/styles.js";
import { STYLES, DENSITIES } from "../../src/lib/constants.js";

test("every UI style and density chip has a concrete directive", () => {
  for (const s of STYLES) assert.ok(STYLE_DIRECTIVES[s], `missing STYLE_DIRECTIVES entry: ${s}`);
  for (const d of DENSITIES) assert.ok(DENSITY_DIRECTIVES[d], `missing DENSITY_DIRECTIVES entry: ${d}`);
});

test("styleBlock stays firm for unknown labels and empty for none", () => {
  assert.match(styleBlock("Vaporwave", "Moderate"), /Vaporwave/);
  assert.equal(styleBlock(undefined, undefined), "");
});
