// Zero-dependency test runner:  node test/run.mjs
//
// Built up stage by stage alongside the accuracy work in audits/audit0.md:
// Stage 2 adds the abcDuration section; later stages append abcPitch,
// abcValidate, and singable sections until the suite reaches 37 tests.
import { measureUnits, parseLen } from "../server/lib/abcDuration.js";

let pass = 0, fail = 0;
const eq = (l, g, w) => {
  const good = JSON.stringify(g) === JSON.stringify(w);
  good ? pass++ : fail++;
  console.log(`${good ? "  ok  " : "  FAIL"} ${l}${good ? "" : `\n         got  ${JSON.stringify(g)}\n         want ${JSON.stringify(w)}`}`);
};
const near = (l, g, w) => {
  const good = Math.abs(g - w) < 1e-9;
  good ? pass++ : fail++;
  console.log(`${good ? "  ok  " : "  FAIL"} ${l}${good ? "" : `  got ${g} want ${w}`}`);
};
const ok = (l, c) => { c ? pass++ : fail++; console.log(`${c ? "  ok  " : "  FAIL"} ${l}`); };

console.log("\nabcDuration — note length grammar");
near("''", parseLen(""), 1);
near("'/'", parseLen("/"), 0.5);
near("'//'", parseLen("//"), 0.25);
near("'/2'", parseLen("/2"), 0.5);
near("'/4'", parseLen("/4"), 0.25);
near("'3/2'", parseLen("3/2"), 1.5);
near("quarters", measureUnits("C2 D2 E2 F2"), 8);
near("32nds as /4", measureUnits("C/4C/4C/4C/4 C/2C/2 D2 E2 F2"), 8);
near("chord, inner length", measureUnits("[C2E2G2] D2 E2 F2"), 8);
near("chord, outer length", measureUnits("[CEG]2 D2 E2 F2"), 8);
near("triplet of eighths", measureUnits("(3CDE C2 D2 E"), 7);
near("whole-bar rest Z", measureUnits("Z"), 8);
near("two-bar rest Z2", measureUnits("Z2"), 16);
near("legacy +f+ decoration", measureUnits("+f+C4 D4"), 8);
near("trailing % comment", measureUnits("C4 D4 % nice"), 8);
near("6/8 compound tuplets", measureUnits("(3GAB (3cde", { compound: true }), 4);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
