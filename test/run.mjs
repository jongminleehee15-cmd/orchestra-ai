// Zero-dependency test runner:  node test/run.mjs
//
// Built up stage by stage alongside the accuracy work in audits/audit0.md:
// Stage 2 adds the abcDuration section; later stages append abcPitch,
// abcValidate, and singable sections until the suite reaches 37 tests.
import { measureUnits, parseLen } from "../server/lib/abcDuration.js";
import { analyzeMelody as analyzeMelodyServer } from "../server/lib/abcMelody.js";
import { analyzeMelody as analyzeMelodyClient } from "../src/lib/melodyCheck.js";
import { transposeAbcBody } from "../server/lib/abcPitch.js";
import { buildPartPrompt, buildPartCorrectionPrompt, resolveTransposition } from "../server/prompts.js";
import { analyzeMelody as analyzeMelodyValidate, checkPartAgainstMelody } from "../server/lib/abcValidate.js";
import { isValidMeasures, ALLOWED_MEASURES, MAX_INSTRUMENTS } from "../server/lib/limits.js";

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

// These exercise analyzeMelody() through its real entry points (server/lib/abcMelody.js,
// src/lib/melodyCheck.js), not the isolated abcDuration module — a passing unit test above
// proves the arithmetic is right, but only these prove the rewiring actually passes the
// correct barUnits/compound through for each call site.
console.log("\nabcMelody / melodyCheck — integration wiring (Stage 2 regression guard)");
for (const [label, analyzeMelody] of [["server", analyzeMelodyServer], ["client", analyzeMelodyClient]]) {
  ok(`${label}: whole-bar rests wired correctly`, analyzeMelody("Z | Z", "4/4", 2).ok);
  ok(`${label}: chord inner-length wired correctly`, analyzeMelody("[C2E2G2] D2 E2 F2", "4/4", 1).ok);
  ok(`${label}: 32nd-note run wired correctly`, analyzeMelody("C/4C/4C/4C/4 C/2C/2 D2 E2 F2", "4/4", 1).ok);
  ok(`${label}: compound meter (6/8) barUnits/isCompound wired`, analyzeMelody("GAB cde", "6/8", 1).ok);
  ok(`${label}: genuinely short bar still caught`, !analyzeMelody("C2 D2 E2", "4/4", 1).ok);
}
// Server-only: exercises the tuplet path specifically (client analyzeMelody has no separate
// compound-tuplet case beyond the above, so this stays server-side to avoid a redundant assert).
ok("server: 6/8 tuplet bar correctly measures short (4 != 6 units)",
  !analyzeMelodyServer("(3GAB (3cde", "6/8", 1).ok);

console.log("\nabcPitch — transposition");
eq("C major up M2 (Bb trumpet)",
  transposeAbcBody("C D E F G A B c", { fromKey: "C", toKey: "D", diatonic: 1, semitones: 2 }),
  "D E F G A B c d");
eq("F major up M6 (Eb alto sax)",
  transposeAbcBody("F G A _B c d e f", { fromKey: "F", toKey: "D", diatonic: 5, semitones: 9 }),
  "d e f g a b c' d'");
eq("C up P5 (F horn)",
  transposeAbcBody("E2 E2 F2 G2", { fromKey: "C", toKey: "G", diatonic: 4, semitones: 7 }),
  "B2 B2 c2 d2");
eq("chromatic respelling",
  transposeAbcBody("_E2 =E2 F2 G2", { fromKey: "Eb", toKey: "F", diatonic: 1, semitones: 2 }),
  "F2 ^F2 G2 A2");
eq("bar-local accidentals reset at barline",
  transposeAbcBody("^F F | F2 G2", { fromKey: "C", toKey: "D", diatonic: 1, semitones: 2 }),
  "^G ^G | G2 A2");
eq("chords transpose",
  transposeAbcBody("[CEG]4", { fromKey: "C", toKey: "D", diatonic: 1, semitones: 2 }),
  "[DFA]4");
{
  const o = "E2 E2 F2 G2 | G2 F2 E2 D2 |]";
  const up = transposeAbcBody(o, { fromKey: "C", toKey: "D", diatonic: 1, semitones: 2 });
  eq("round-trip is lossless",
    transposeAbcBody(up, { fromKey: "D", toKey: "C", diatonic: -1, semitones: -2 }), o);
}

console.log("\nprompts.js — programmatic transposition wiring (Stage 3 regression guard)");
{
  const melodyAbc = "E2 E2 F2 G2 | G2 F2 E2 D2 |]";
  const excerptFor = (instrName) => {
    const prompt = buildPartPrompt({
      songTitle: "Test", instrName, style: "x", density: "x", tempoFeel: "x",
      key: "C", timeSignature: "4/4", bpm: 100, measures: 2,
      otherInstruments: "x", role: { primaryRole: "melody", melodySections: ["mm.1-2"] },
      melodyAbc, chords: ["C", "C"],
    });
    const m = prompt.match(/measure 1: (.*)\n {2}measure 2: (.*)/);
    return m ? `${m[1]} | ${m[2]}` : null;
  };
  eq("Bb trumpet excerpt pre-transposed up a M2", excerptFor("Trumpet"), "F2 F2 G2 A2 | A2 G2 F2 E2");
  eq("F horn excerpt pre-transposed up a P5", excerptFor("French Horn"), "B2 B2 c2 d2 | d2 c2 B2 A2");
  eq("numbered voice (Trumpet 2) still transposes via baseName", excerptFor("Trumpet 2"), "F2 F2 G2 A2 | A2 G2 F2 E2");
  eq("non-transposing instrument excerpt stays at concert pitch", excerptFor("Violin"), "E2 E2 F2 G2 | G2 F2 E2 D2");
  ok("no ear-transposition prose remains in the prompt",
    !buildPartPrompt({
      songTitle: "Test", instrName: "Trumpet", style: "x", density: "x", tempoFeel: "x",
      key: "C", timeSignature: "4/4", bpm: 100, measures: 2,
      otherInstruments: "x", role: { primaryRole: "melody", melodySections: ["mm.1-2"] },
      melodyAbc, chords: ["C", "C"],
    }).includes("transpose all notes"));
}

console.log("\nabcValidate — bar math and part conformance");
ok("pickup bar accepted", analyzeMelodyValidate("G | c2 c2 d2 e2 | f8 |]", "4/4", 2).ok);
ok("genuinely short bar still caught", !analyzeMelodyValidate("C2 D2 E2 | F2 G2 A2 B2 |]", "4/4", 2).ok);
ok("Z tacet bar accepted", analyzeMelodyValidate("C2 D2 E2 F2 | Z | G8 | A8 |]", "4/4", 4).ok);
{
  const mel = "E2 E2 F2 G2 | G2 F2 E2 D2";
  const good = "X:1\nK:C\ne2 e2 f2 g2 | g2 f2 e2 d2 |]";
  const bad = "X:1\nK:C\ne2 e2 f2 g2 | g2 a2 g2 e2 |]";
  ok("octave-displaced but correct tune passes",
    checkPartAgainstMelody(good, { melodyAbc: mel, melodySections: ["mm.1-2"], concertKey: "C" }).ok);
  ok("drifted measure is caught",
    !checkPartAgainstMelody(bad, { melodyAbc: mel, melodySections: ["mm.1-2"], concertKey: "C" }).ok);
  const tpt = "X:1\nK:D\nf2 f2 g2 a2 | a2 g2 f2 e2 |]";
  const tr = { diatonic: 1, semitones: 2, writtenKey: "D" };
  ok("correctly transposed Bb trumpet part passes",
    checkPartAgainstMelody(tpt, { melodyAbc: mel, melodySections: ["mm.1-2"], concertKey: "C", transposition: tr }).ok);
  ok("trumpet that forgot to transpose is caught",
    !checkPartAgainstMelody(tpt.replace("f2 f2 g2 a2", "e2 e2 f2 g2"),
      { melodyAbc: mel, melodySections: ["mm.1-2"], concertKey: "C", transposition: tr }).ok);
}

console.log("\nStage 4 — /api/part conformance wiring (regression guard)");
{
  // Mirrors exactly what server/index.js does: resolveTransposition() then
  // checkPartAgainstMelody() with its output — not the isolated function in
  // a hand-built context.
  const melodyAbc = "E2 E2 F2 G2 | G2 F2 E2 D2 |]";
  const { concertKey, writtenKey, transposes, transposeSpec } = resolveTransposition("C", "Trumpet");
  const checkArgs = {
    melodyAbc, melodySections: ["mm.1-2"], concertKey,
    transposition: transposes && transposeSpec
      ? { diatonic: transposeSpec.diatonic, semitones: transposeSpec.semitones, writtenKey }
      : null,
    timeSignature: "4/4",
  };
  const correctTrumpetAbc = "X:1\nK:D\nf2 f2 g2 a2 | a2 g2 f2 e2 |]";
  const driftedTrumpetAbc = "X:1\nK:D\ne2 e2 f2 g2 | a2 g2 f2 e2 |]"; // measure 1 wrong
  const goodResult = checkPartAgainstMelody(correctTrumpetAbc, checkArgs);
  const badResult = checkPartAgainstMelody(driftedTrumpetAbc, checkArgs);
  ok("resolveTransposition + checkPartAgainstMelody: correct trumpet part passes", goodResult.ok);
  ok("resolveTransposition + checkPartAgainstMelody: drifted measure caught", !badResult.ok);
  eq("drifted measure identified as measure 1", badResult.mismatches.map((m) => m.measure), [1]);

  const correction = buildPartCorrectionPrompt({
    instrName: "Trumpet", writtenKey, previousAbc: driftedTrumpetAbc, mismatches: badResult.mismatches,
  });
  ok("correction prompt names the exact failing measure and required pitches",
    correction.includes('measure 1: must be exactly "F2 F2 G2 A2"'));
}

console.log("\nStage 5 — input clamping (server-side hardening)");
ok("4 is a valid measures option", isValidMeasures(4));
ok("128 is a valid measures option", isValidMeasures(128));
ok("an arbitrary huge value is rejected", !isValidMeasures(10000));
ok("a value between valid options is rejected", !isValidMeasures(20));
ok("a non-numeric value is rejected", !isValidMeasures("banana"));
eq("ALLOWED_MEASURES matches the client's MEASURE_OPTIONS", ALLOWED_MEASURES, [4, 8, 12, 16, 24, 32, 48, 64, 96, 128]);
ok("MAX_INSTRUMENTS is a sane cap", MAX_INSTRUMENTS > 0 && MAX_INSTRUMENTS <= 32);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
