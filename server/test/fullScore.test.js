// Full-score builder: stacks generated parts into one multi-voice ABC tune.
// Verified against abcjs itself: the score must engrave cleanly (per-voice
// keys/clefs) and SOUND at concert pitch (per-voice %%MIDI program/transpose).
import test from "node:test";
import assert from "node:assert/strict";
import abcjs from "abcjs";
import { buildFullScoreAbc } from "../../src/lib/abcHelpers.js";

const META = { title: "Test Song", timeSig: "4/4", bpm: 90, key: "C" };

// A B♭ trumpet part WRITTEN in D (concert C arrangement) and a concert-pitch
// cello part. The trumpet's written E must SOUND a major 2nd lower (D).
const trumpet = {
  instrName: "Trumpet 1",
  baseName: "Trumpet",
  status: "done",
  abcText: "X:1\nT:Trumpet 1 (in Bb) — Test Song\nM:4/4\nL:1/8\nQ:1/4=90\nK:D clef=treble\nE2 F2 G2 A2 | B2 A2 G2 F2 |]",
};
const cello = {
  instrName: "Cello",
  baseName: "Cello",
  status: "done",
  abcText: "X:1\nT:Cello — Test Song\nM:4/4\nL:1/8\nQ:1/4=90\nK:C clef=bass\nC,2 E,2 G,2 E,2 | C,2 E,2 G,2 E,2 |]",
};
const pending = { instrName: "Viola", baseName: "Viola", status: "idle", abcText: null };

test("combines only finished parts, with per-voice key, program, and transpose", () => {
  const abc = buildFullScoreAbc([trumpet, pending, cello], META);
  assert.ok(abc, "returns a score");
  assert.match(abc, /%%score V1 V2\n/, "two voices in play order");
  assert.match(abc, /V:V1 name="Trumpet 1" snm="Tru\. 1" clef=treble/);
  assert.match(abc, /V:V2 name="Cello" snm="Cel\." clef=bass/);
  assert.match(abc, /V:V1\nK:D clef=treble\n%%MIDI program 56\n%%MIDI transpose -2/, "trumpet keeps its written key, plays back at concert pitch");
  assert.match(abc, /V:V2\nK:C clef=bass\n%%MIDI program 42\n/, "cello gets its instrument sound");
  const v2Body = abc.slice(abc.lastIndexOf("\nV:V2\n"));
  assert.ok(!v2Body.includes("%%MIDI transpose"), "non-transposing part is not shifted");
  assert.ok(!abc.includes("Viola"), "unfinished parts are left out");
});

test("returns null when no part is finished", () => {
  assert.equal(buildFullScoreAbc([pending], META), null);
  assert.equal(buildFullScoreAbc([], META), null);
});

test("abcjs engraves the score: one system, per-voice keys and clefs, no warnings", () => {
  const abc = buildFullScoreAbc([trumpet, cello], META);
  const tune = abcjs.parseOnly(abc)[0];
  assert.equal(tune.warnings, undefined, `no parse warnings, got: ${JSON.stringify(tune.warnings)}`);
  const staves = tune.lines.find((l) => l.staff)?.staff || [];
  assert.equal(staves.length, 2, "both parts on one system");
  assert.deepEqual(staves.map((s) => s.key.root), ["D", "C"], "trumpet stays in its written key on the page");
  assert.deepEqual(staves.map((s) => s.clef.type), ["treble", "bass"]);
});

test("abcjs audio: each voice gets its instrument and sounds at concert pitch", () => {
  const abc = buildFullScoreAbc([trumpet, cello], META);
  const tune = abcjs.parseOnly(abc)[0];
  const seq = tune.setUpAudio({ chordsOff: true });
  assert.equal(seq.tracks.length, 2);
  const programs = seq.tracks.map((t) => t.find((e) => e.cmd === "program")?.instrument);
  assert.deepEqual(programs, [56, 42], "GM trumpet + cello");
  const firstPitch = (t) => t.find((e) => e.cmd === "note")?.pitch;
  // Written E4 (64) in the trumpet part must SOUND D4 (62) — concert pitch.
  assert.equal(firstPitch(seq.tracks[0]), 62);
  assert.equal(firstPitch(seq.tracks[1]), 48, "cello C3 untouched");
});
