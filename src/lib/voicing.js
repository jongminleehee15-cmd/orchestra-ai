// Ensemble-level orchestration checks that need EVERY finished part together —
// register crowding ("mud") and duplicate-instrument unison doubling. Neither
// is visible to a single part's generation prompt (each /api/part call is
// written without seeing what any other instrument played), so these only
// run client-side once all parts exist. Informational only — see
// ENGINE_NOTES.md for why this does not auto-correct like enforceRange does.

import { getMeta } from "./constants.js";
import { splitMeasures } from "./melodyCheck.js";
import { findMelodyClashes } from "../../server/lib/ensemble.js";

const BASE_ST = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// ABC pitch token ("^C,", "c'", ...) → MIDI number (key signature ignored,
// same tradeoff server/lib/ranges.js makes — fine for register comparisons).
function midiOf(tok) {
  const m = tok.match(/^([_^=]*)([A-Ga-g])([,']*)$/);
  if (!m) return null;
  let v = 60 + BASE_ST[m[2].toUpperCase()] + (/[a-g]/.test(m[2]) ? 12 : 0);
  for (const a of m[1]) v += a === "^" ? 1 : a === "_" ? -1 : 0;
  for (const o of m[3]) v += o === "'" ? 12 : -12;
  return v;
}

function measurePitches(measureStr) {
  const s = String(measureStr)
    .replace(/![^!]*!/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\{[^}]*\}/g, "");
  return [...s.matchAll(/[_^=]*[A-Ga-g][,']*/g)].map((m) => midiOf(m[0])).filter((v) => v !== null);
}

// Strip ABC headers, return the raw per-measure body text (dynamics/chord
// symbols/etc. still in place — callers that need pitches strip those).
function bodyMeasures(abcText) {
  const body = String(abcText)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[A-Za-z]:/.test(l) && !l.startsWith("%"))
    .join(" ");
  return splitMeasures(body);
}

// Convert every note to CONCERT pitch (written + INSTR_META shift) so a Bb
// trumpet and a cello can be compared directly — mirrors the shift
// AudioPlayer already applies for concert-pitch playback.
function concertMeasures(abcText, baseName) {
  const shift = getMeta(baseName).shift || 0;
  return bodyMeasures(abcText).map((meas) => measurePitches(meas).map((v) => v + shift));
}

// "mm.1-8" / "mm.5" style labels → the set of measure numbers they cover.
function parseRanges(sections = []) {
  const set = new Set();
  for (const label of sections) {
    const m = String(label).match(/(\d+)\s*-\s*(\d+)/) || String(label).match(/(\d+)/);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    for (let n = start; n <= end; n++) set.add(n);
  }
  return set;
}

// Judgment calls (see ENGINE_NOTES.md): C3 as the "low" floor and a minor
// third as "close position" are the same boundary ENGINE_NOTES already
// named as an unenforced gap — not derived from anything stricter.
const LOW_CEILING = 48; // C3
const CLOSE_INTERVAL = 3; // minor third or closer

// Two or more NON-melody instruments both sitting below C3 within a minor
// third of each other in the same measure. A single low part is normal
// orchestration; the collision only exists once every part is on the page.
function findMud(parts, melodyPlan) {
  const warnings = [];
  const withNotes = parts.map((p) => ({
    instrName: p.instrName,
    // The designated bass instrument is SUPPOSED to sit below C3 in every
    // measure — pairing it with any other low chord tone would fire on
    // nearly every arrangement, so it never participates as a mud candidate.
    isBass: melodyPlan?.instrumentRoles?.[p.instrName]?.primaryRole === "bass",
    melodySet: parseRanges(melodyPlan?.instrumentRoles?.[p.instrName]?.melodySections),
    measures: concertMeasures(p.abcText, p.baseName),
  }));
  const maxMeasures = Math.max(0, ...withNotes.map((p) => p.measures.length));

  for (let i = 0; i < maxMeasures && warnings.length < 8; i++) {
    const measureNo = i + 1;
    const lowNotes = [];
    for (const part of withNotes) {
      if (part.isBass || part.melodySet.has(measureNo)) continue;
      const low = (part.measures[i] || []).filter((v) => v < LOW_CEILING);
      if (low.length) lowNotes.push({ instrName: part.instrName, low });
    }
    if (lowNotes.length < 2) continue;
    outer: for (let a = 0; a < lowNotes.length; a++) {
      for (let b = a + 1; b < lowNotes.length; b++) {
        // Any pair 1-3 semitones apart counts — NOT the closest pair overall,
        // since a coincidental unison elsewhere in the measure would mask a
        // real close-interval collision between two other notes.
        const close = lowNotes[a].low.some((x) =>
          lowNotes[b].low.some((y) => {
            const d = Math.abs(x - y);
            return d >= 1 && d <= CLOSE_INTERVAL;
          }),
        );
        if (close) {
          warnings.push(
            `measure ${measureNo}: ${lowNotes[a].instrName} and ${lowNotes[b].instrName} both sit below C3 in close position, which is likely to sound muddy; try spacing them a wider interval apart or moving one an octave`,
          );
          break outer;
        }
      }
    }
  }
  return warnings;
}

// Players sharing an instrument (Violin 1 / Violin 2) playing pitch-identical
// lines outside a melody hand-off. The prompt asks for distinct material but
// nothing checks it, since neither part's generation sees the other.
function findUnison(parts, melodyPlan) {
  const warnings = [];
  const groups = new Map();
  for (const p of parts) {
    if (!groups.has(p.baseName)) groups.set(p.baseName, []);
    groups.get(p.baseName).push(p);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const pa = group[a], pb = group[b];
        const melA = parseRanges(melodyPlan?.instrumentRoles?.[pa.instrName]?.melodySections);
        const melB = parseRanges(melodyPlan?.instrumentRoles?.[pb.instrName]?.melodySections);
        const ma = concertMeasures(pa.abcText, pa.baseName);
        const mb = concertMeasures(pb.abcText, pb.baseName);
        const n = Math.min(ma.length, mb.length);
        let identical = 0, compared = 0;
        for (let i = 0; i < n; i++) {
          const measureNo = i + 1;
          if (melA.has(measureNo) || melB.has(measureNo)) continue; // unison expected at a hand-off
          compared++;
          if (ma[i].length > 0 && JSON.stringify(ma[i]) === JSON.stringify(mb[i])) identical++;
        }
        // Require a couple of shared measures before judging — a single
        // coincidental unison bar is not doubling.
        if (compared >= 2 && identical / compared >= 0.5) {
          warnings.push(
            `${pa.instrName} and ${pb.instrName} play identical pitches in ${identical}/${compared} non-melody measures, which is likely unwanted unison doubling instead of distinct material`,
          );
        }
      }
    }
  }
  return warnings;
}

// ABC dynamic marks (!p! !mf! etc — see prompts.js "Dynamics" rule), ordered
// soft to loud. A mark applies from where it's written until the next one —
// same convention a player reads off the page.
const DYNAMIC_LEVEL = { pp: 0, p: 1, mp: 2, mf: 3, f: 4, ff: 5, fff: 6 };
const LEVEL_NAME = Object.keys(DYNAMIC_LEVEL);

function measureDynamicMarks(measureStr) {
  return [...String(measureStr).matchAll(/!([a-z]+)!/g)]
    .map((m) => DYNAMIC_LEVEL[m[1]])
    .filter((v) => v !== undefined);
}

// Per measure: { min, max } across every dynamic level ACTIVE at some point
// during that measure — the level carried in from before it (sticky, same
// convention a player reads off the page) plus every mark written inside
// it. A measure isn't one level: it can start loud and drop mid-bar, or
// vice versa. { min: null, max: null } until the first mark appears
// anywhere in the part.
function dynamicRanges(measures) {
  let current = null;
  return measures.map((meas) => {
    const marks = measureDynamicMarks(meas);
    const active = current !== null ? [current, ...marks] : marks;
    if (marks.length) current = marks[marks.length - 1];
    return active.length ? { min: Math.min(...active), max: Math.max(...active) } : { min: null, max: null };
  });
}

// A non-melody instrument marked LOUDER than the melody carrier in the same
// measure — the written dynamics contradict the melody being the featured
// voice. Prompts already ask for melody >= accompaniment (prompts.js
// "DYNAMIC BALANCE"); this is the safety net for when that's not followed,
// same role as findMud/findUnison being a net for their own prompt rules.
// Deliberately conservative about which moment in the bar to compare: the
// melody's SOFTEST moment (min) against each other part's LOUDEST moment
// (max) — only flags when the accompaniment's loudest genuinely exceeds the
// melody's softest, not an artifact of which mark happens to be last.
function findDynamicImbalance(parts, melodyPlan) {
  const warnings = [];
  const withInfo = parts.map((p) => ({
    instrName: p.instrName,
    melodySet: parseRanges(melodyPlan?.instrumentRoles?.[p.instrName]?.melodySections),
    ranges: dynamicRanges(bodyMeasures(p.abcText)),
  }));
  const maxMeasures = Math.max(0, ...withInfo.map((p) => p.ranges.length));

  for (let i = 0; i < maxMeasures && warnings.length < 8; i++) {
    const measureNo = i + 1;
    const melodyParts = withInfo.filter((p) => p.melodySet.has(measureNo));
    if (melodyParts.length === 0) continue; // no designated carrier this measure — nothing to balance against
    const melodyMins = melodyParts.map((p) => p.ranges[i]?.min).filter((v) => v !== null && v !== undefined);
    if (melodyMins.length === 0) continue; // melody carrier hasn't marked a dynamic yet — can't judge
    const melodyLevel = Math.min(...melodyMins);

    for (const p of withInfo) {
      if (p.melodySet.has(measureNo)) continue;
      const max = p.ranges[i]?.max;
      if (max !== null && max !== undefined && max > melodyLevel) {
        warnings.push(
          `measure ${measureNo}: ${p.instrName} reaches ${LEVEL_NAME[max]}, louder than ${melodyParts.map((m) => m.instrName).join("/")}'s softest marked dynamic (${LEVEL_NAME[melodyLevel]}) there; the melody should not be the quietest voice in its own measure`,
        );
        break; // one flagged instrument per measure is enough signal
      }
    }
  }
  return warnings;
}

// A non-melody part moving in 2nds (or a major 7th / minor 9th) against the
// melody carrier for most of a bar. Judged at sounding pitch with the
// server's own parser (server/lib/ensemble.js), so key signatures,
// accidentals, tuplets and transposing instruments are read exactly as the
// part checks read them.
function findClashes(parts, melodyPlan, meta) {
  if (!meta?.key || !meta?.timeSignature) return [];
  return findMelodyClashes({
    parts: parts.map((p) => ({ instrName: p.instrName, abc: p.abcText })),
    instrumentRoles: melodyPlan?.instrumentRoles,
    chords: melodyPlan?.chords,
    concertKey: meta.key,
    timeSignature: meta.timeSignature,
  }).map((c) =>
    `measure ${c.measure}: ${c.instrName} sits a 2nd (or a major 7th or minor 9th) away from ${c.carrier}'s melody for ${Math.round(c.share * 100)}% of the bar, so the two lines will rub; listen, and Regenerate ${c.instrName} if it sounds wrong`,
  );
}

// Run every ensemble-level check once at least two parts are finished.
// `parts` needs { instrName, baseName, abcText } (scoreParts shape from
// App.jsx); melodyPlan supplies instrumentRoles so melody measures are
// exempted. meta = { key, timeSignature } of the arrangement (concert key),
// needed to read every part at sounding pitch for the melody-clash check.
export function analyzeVoicing(parts, melodyPlan, meta = null) {
  const usable = parts.filter((p) => p.status === "done" && p.abcText);
  if (usable.length < 2) return [];
  return [
    ...findMud(usable, melodyPlan),
    ...findUnison(usable, melodyPlan),
    ...findDynamicImbalance(usable, melodyPlan),
    ...findClashes(usable, melodyPlan, meta),
  ];
}
