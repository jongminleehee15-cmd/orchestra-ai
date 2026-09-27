// Melody coverage: every measure carried by exactly one selected voice. The
// prompt asks for this; repairMelodyCoverage is what makes it true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repairMelodyCoverage, suggestedSections, rangesToLabels } from "../lib/planCheck.js";
import { melodyMeasureSet } from "../lib/partCheck.js";

// Who carries measure n, per the repaired roles, for every measure.
function owners(instrumentRoles, voices, measures) {
  const out = [];
  for (let n = 1; n <= measures; n++) {
    out.push(voices.filter((v) => melodyMeasureSet(instrumentRoles[v]?.melodySections || []).has(n)));
  }
  return out;
}

function assertExactlyOne(instrumentRoles, voices, measures) {
  owners(instrumentRoles, voices, measures).forEach((o, i) => {
    assert.equal(o.length, 1, `measure ${i + 1} has ${o.length} carriers: ${o.join(", ")}`);
  });
}

const VOICES = ["Violin", "Flute", "Cello"];

test("a valid plan comes back as the same object, with no warnings", () => {
  const roles = {
    Violin: { primaryRole: "melody", melodySections: ["mm.1-4", "mm.13-16"], instruction: "x" },
    Flute: { primaryRole: "countermelody", melodySections: ["mm.5-8"], instruction: "y" },
    Cello: { primaryRole: "bass", melodySections: ["mm. 9-12"], instruction: "z" },
  };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 16 });
  assert.equal(r.instrumentRoles, roles);
  assert.deepEqual(r.warnings, []);
});

test("a gap is carried by the preceding carrier, and reported", () => {
  const roles = {
    Violin: { primaryRole: "melody", melodySections: ["mm.1-4"] },
    Flute: { primaryRole: "melody", melodySections: ["mm.9-16"] },
    Cello: { primaryRole: "bass", melodySections: [] },
  };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 16 });
  assertExactlyOne(r.instrumentRoles, VOICES, 16);
  assert.deepEqual(r.instrumentRoles.Violin.melodySections, ["mm.1-8"]);
  assert.deepEqual(r.instrumentRoles.Flute.melodySections, ["mm.9-16"]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /measures 5-8 with no instrument carrying the melody\. Violin now carries it/);
  // Everything else about the role is kept.
  assert.equal(r.instrumentRoles.Violin.primaryRole, "melody");
  assert.equal(r.instrumentRoles.Cello, roles.Cello, "an untouched role is the same object");
});

test("a gap at the very start goes to the first carrier after it", () => {
  const roles = { Violin: { melodySections: ["mm.3-8"] } };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 8 });
  assert.deepEqual(r.instrumentRoles.Violin.melodySections, ["mm.1-8"]);
  assert.match(r.warnings[0], /measures 1-2/);
});

test("an overlap goes to the carrier whose range starts latest", () => {
  const roles = {
    Violin: { melodySections: ["mm.1-8"] },
    Flute: { melodySections: ["mm.5-12"] },
    Cello: { melodySections: ["mm.13-16"] },
  };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 16 });
  assertExactlyOne(r.instrumentRoles, VOICES, 16);
  assert.deepEqual(r.instrumentRoles.Violin.melodySections, ["mm.1-4"]);
  assert.deepEqual(r.instrumentRoles.Flute.melodySections, ["mm.5-12"]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /measures 5-8 to both Violin and Flute\. Flute keeps the melody/);
});

test("a short feature nested inside a long section survives the overlap", () => {
  const roles = {
    Violin: { melodySections: ["mm.1-16"] },
    Flute: { melodySections: ["mm.5-8"] },
  };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 16 });
  assertExactlyOne(r.instrumentRoles, VOICES, 16);
  assert.deepEqual(r.instrumentRoles.Violin.melodySections, ["mm.1-4", "mm.9-16"]);
  assert.deepEqual(r.instrumentRoles.Flute.melodySections, ["mm.5-8"]);
});

test("equal starts: the shorter range wins, then voice order", () => {
  const shorter = repairMelodyCoverage({
    instrumentRoles: { Violin: { melodySections: ["mm.1-8"] }, Flute: { melodySections: ["mm.1-4"] } },
    voiceNames: VOICES, measures: 8,
  });
  assert.deepEqual(shorter.instrumentRoles.Flute.melodySections, ["mm.1-4"]);
  assert.deepEqual(shorter.instrumentRoles.Violin.melodySections, ["mm.5-8"]);

  const same = repairMelodyCoverage({
    instrumentRoles: { Flute: { melodySections: ["mm.1-8"] }, Violin: { melodySections: ["mm.1-8"] } },
    voiceNames: VOICES, measures: 8,
  });
  assert.deepEqual(same.instrumentRoles.Violin.melodySections, ["mm.1-8"], "Violin is first in voice order");
  assert.deepEqual(same.instrumentRoles.Flute.melodySections, []);
});

test("ranges past the piece are clipped and reported", () => {
  const roles = { Violin: { melodySections: ["mm.1-4"] }, Flute: { melodySections: ["mm.5-12"] } };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 8 });
  assertExactlyOne(r.instrumentRoles, VOICES, 8);
  assert.deepEqual(r.instrumentRoles.Flute.melodySections, ["mm.5-8"]);
  assert.match(r.warnings.join(" "), /measures 9-12, outside this 8-measure piece/);
});

test("a role under a name that is not a selected voice is reported, and its measures reassigned", () => {
  // The client looks roles up by EXACT voice name, so "Violin" reaches
  // neither "Violin 1" nor "Violin 2": that melody would silently vanish.
  const voices = ["Violin 1", "Violin 2", "Cello"];
  const roles = {
    Violin: { melodySections: ["mm.1-4"] },
    "Violin 2": { melodySections: ["mm.5-8"] },
    Cello: { melodySections: [] },
  };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: voices, measures: 8 });
  assertExactlyOne(r.instrumentRoles, voices, 8);
  assert.deepEqual(r.instrumentRoles["Violin 2"].melodySections, ["mm.1-8"]);
  assert.match(r.warnings[0], /"Violin", which is not one of the selected instruments/);
  assert.match(r.warnings[1], /measures 1-4 with no instrument/);
});

test("a case or spacing variant of a voice name is matched to the real voice", () => {
  const roles = { "flute ": { primaryRole: "melody", melodySections: ["mm.1-4"] }, Violin: { melodySections: ["mm.5-8"] } };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 8 });
  assert.deepEqual(r.instrumentRoles.Flute.melodySections, ["mm.1-4"]);
  assert.equal(r.instrumentRoles.Flute.primaryRole, "melody");
  assert.ok(!("flute " in r.instrumentRoles), "stored under the exact voice name only");
  assertExactlyOne(r.instrumentRoles, VOICES, 8);
});

test("an exact name wins over a case variant for the same voice", () => {
  const roles = { Flute: { melodySections: ["mm.1-8"] }, flute: { melodySections: ["mm.1-2"] } };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 8 });
  assert.deepEqual(r.instrumentRoles.Flute.melodySections, ["mm.1-8"]);
  assertExactlyOne(r.instrumentRoles, VOICES, 8);
});

test("no carrier at all: the melody rotates through the voices by suggested section", () => {
  for (const roles of [undefined, null, [], {}, { Violin: { primaryRole: "harmony" } }]) {
    const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 16 });
    assertExactlyOne(r.instrumentRoles, VOICES, 16);
    const sections = suggestedSections(16, 3);
    sections.forEach((s, i) => {
      const who = VOICES[i % VOICES.length];
      assert.ok(melodyMeasureSet(r.instrumentRoles[who].melodySections).has(s.start), `${who} opens section ${i + 1}`);
    });
    assert.match(r.warnings.join(" "), /did not give the melody to any instrument/);
  }
  // A role that existed keeps its other fields; a voice without one gets a minimal role.
  const r = repairMelodyCoverage({ instrumentRoles: { Violin: { primaryRole: "harmony", instruction: "keep" } }, voiceNames: VOICES, measures: 16 });
  assert.equal(r.instrumentRoles.Violin.instruction, "keep");
  assert.equal(r.instrumentRoles.Flute.primaryRole, "melody");
});

test("unparseable labels are dropped rather than trusted", () => {
  const roles = { Violin: { melodySections: ["mm.1-8", "the bridge", null] } };
  const r = repairMelodyCoverage({ instrumentRoles: roles, voiceNames: VOICES, measures: 8 });
  assert.deepEqual(r.instrumentRoles.Violin.melodySections, ["mm.1-8"]);
  assert.deepEqual(r.warnings, [], "the coverage itself was fine, so there is nothing to report");
});

test("single measures are labelled mm.N and round-trip through the parser", () => {
  assert.deepEqual(rangesToLabels([1, 2, 3, 5, 7, 8]), ["mm.1-3", "mm.5", "mm.7-8"]);
  assert.deepEqual([...melodyMeasureSet(["mm.1-3", "mm.5", "mm.7-8"])], [1, 2, 3, 5, 7, 8]);
});

test("suggestedSections matches the arithmetic the prompts used", () => {
  assert.deepEqual(suggestedSections(16, 3).map((s) => `mm.${s.start}-${s.end}`), ["mm.1-5", "mm.6-10", "mm.11-15", "mm.16-16"]);
  assert.deepEqual(suggestedSections(8, 5).map((s) => `mm.${s.start}-${s.end}`), ["mm.1-4", "mm.5-8"]);
  assert.deepEqual(suggestedSections(4, 1).map((s) => `mm.${s.start}-${s.end}`), ["mm.1-4"]);
});

test("warnings contain no em dashes (user-facing copy)", () => {
  const r = repairMelodyCoverage({
    instrumentRoles: { Ghost: { melodySections: ["mm.1-2"] }, Violin: { melodySections: ["mm.3-10"] }, Flute: { melodySections: ["mm.4-6"] } },
    voiceNames: VOICES, measures: 8,
  });
  assert.ok(r.warnings.length >= 3);
  for (const w of r.warnings) assert.ok(!w.includes("—"), w);
});
