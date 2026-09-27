// Offline scoring of one saved arrangement run. Pure: no network, no API.
//
// Every number is RECOMPUTED from the saved ABC and plan with the checks as
// they are in the code today, so runs made months apart are scored by the
// same ruler. The warnings the server returned at generation time are kept
// separately (`served`), because they reflect whatever code served that run.
//
// What this measures: consistency with the plan (right melody, right chords,
// right length, playable range, no rubbing against the tune). It does NOT
// measure whether the arrangement is musically good, and the harmony and
// clash checks have known false-alarm rates (ENGINE_NOTES.md). Use it to
// catch regressions and compare engine versions, with a listening test on top.
//
// Run shape: { meta?, common: { key, timeSignature, measures, ... },
//              voices: [names], plan: { melodyAbc, chords, instrumentRoles,
//              measures }, parts: [{ instrName, abc, error?, ...warnings }] }

import { checkPartHarmony, chordToneShare, parseBarChords, writtenToConcertShift, isFlagged } from "../server/lib/harmony.js";
import { checkPartBars, checkPartMelody, partMeasures, measurePitchEvents, melodyMeasureSet } from "../server/lib/partCheck.js";
import { checkPartRange } from "../server/lib/ranges.js";
import { splitMelodyIntoMeasures, barUnitsFor } from "../server/lib/abcMelody.js";
import { findMelodyClashes } from "../server/lib/ensemble.js";
import { writtenKeyFor, keyFifths } from "../server/lib/transpose.js";
import { analyzeVoicing } from "../src/lib/voicing.js";

// analyzeVoicing returns user-facing sentences; these sort them into kinds.
// Pinned by server/test/evalScore.test.js, so a wording change fails a test
// instead of silently zeroing a metric. Anything unmatched lands in `other`.
export const VOICING_KINDS = {
  mud: /likely to sound muddy/,
  unison: /unwanted unison doubling/,
  dynamics: /louder than .*softest marked dynamic/,
};

// A transposing part's accompaniment read three ways. It counts as correctly
// transposed when the correct reading fits the chords best AND at least 45%
// (the success criterion fixed before the 2026-09-26 live run).
export const TRANSPOSED_OK_MIN = 0.45;

function meanShare(abc, chords, ts, writtenFifths, melodySet, shift) {
  const vals = [];
  partMeasures(abc).forEach((m, i) => {
    if (melodySet.has(i + 1)) return;
    const sets = parseBarChords(chords[i]);
    if (!sets) return;
    const v = chordToneShare(measurePitchEvents(m, ts, writtenFifths), sets, barUnitsFor(ts), shift);
    if (v !== null) vals.push(v);
  });
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Does the plan's melody fit the plan's own chords? Same rule as the part
// check (isFlagged), so the library works score 0 here (their calibration).
export function planChordFit(plan, key, timeSignature) {
  const out = { checked: 0, flagged: 0, bars: [] };
  const tune = splitMelodyIntoMeasures(plan?.melodyAbc || "");
  const chords = Array.isArray(plan?.chords) ? plan.chords : [];
  const fifths = keyFifths(key);
  tune.forEach((bar, i) => {
    const sets = parseBarChords(chords[i]);
    if (!sets) return;
    const share = chordToneShare(measurePitchEvents(bar, timeSignature, fifths), sets, barUnitsFor(timeSignature), 0);
    if (share === null) return;
    out.checked++;
    if (isFlagged(share)) { out.flagged++; out.bars.push(i + 1); }
  });
  return out;
}

export function scoreRun(run) {
  const { key, timeSignature: ts } = run.common;
  const plan = run.plan || {};
  const measures = plan.measures || run.common.measures;
  const roles = plan.instrumentRoles || {};
  const chords = Array.isArray(plan.chords) ? plan.chords : [];
  const concertFifths = keyFifths(key);
  const parts = (run.parts || []).filter((p) => typeof p.abc === "string" && partMeasures(p.abc).length > 0);

  const m = {
    parts: (run.voices || run.parts || []).length,
    missingParts: (run.voices || run.parts || []).length - parts.length,
    measures,
    partBars: 0,
    lengthErrors: 0, // parts whose measure count isn't the plan's
    barErrors: 0, // bars that don't hold exactly one bar of time
    melodyBars: 0, // melody bars owed by the parts present
    melodyMismatch: 0, // of those, bars that don't match the tune
    rangeNotes: 0, // notes outside the instrument's written range
    harmonyChecked: 0, harmonyFlagged: 0, harmonySuspect: 0, harmonyUnreadable: 0,
    clashes: 0, // bars where a part rubs against the melody carrier
    uncoveredBars: 0, // bars no finished part carries the melody in
    planChordChecked: 0, planChordFlagged: 0, // the plan's tune vs its own chords
    transposingParts: 0, mistransposed: 0,
    mud: 0, unison: 0, dynamics: 0, voicingOther: 0,
  };
  const perPart = [];
  const served = { melody: 0, range: 0, harmony: 0 };

  for (const p of parts) {
    const w = writtenKeyFor(key, p.instrName);
    const sections = roles[p.instrName]?.melodySections || [];
    const melodySet = melodyMeasureSet(sections);
    const bars = partMeasures(p.abc).length;
    m.partBars += bars;
    if (bars !== measures) m.lengthErrors++;
    const barErr = checkPartBars(p.abc, ts, 0, Infinity).problems.length;
    m.barErrors += barErr;
    let owed = 0;
    for (const n of melodySet) if (n <= measures) owed++;
    m.melodyBars += owed;
    const mel = plan.melodyAbc && sections.length
      ? checkPartMelody(p.abc, plan.melodyAbc, sections, 0, ts, concertFifths, w.fifths).problems.length
      : 0;
    m.melodyMismatch += mel;
    const range = checkPartRange(p.abc, p.instrName, 0, Infinity).problems.length;
    m.rangeNotes += range;
    const h = checkPartHarmony({
      partAbc: p.abc, chords, timeSignature: ts, melodyAbc: plan.melodyAbc, melodySections: sections,
      writtenFifths: w.fifths, concertFifths,
    });
    m.harmonyChecked += h.checked; m.harmonyFlagged += h.flagged;
    m.harmonySuspect += h.chordSuspect; m.harmonyUnreadable += h.unreadable;

    let transposition = null;
    if (w.transposes) {
      m.transposingParts++;
      const s = writtenToConcertShift(w.fifths, concertFifths);
      const right = meanShare(p.abc, chords, ts, w.fifths, melodySet, s);
      const none = meanShare(p.abc, chords, ts, w.fifths, melodySet, 0);
      const twice = meanShare(p.abc, chords, ts, w.fifths, melodySet, (2 * s) % 12);
      // No accompaniment bars to read: no verdict, not a failure.
      const ok = right === null || (right > (none ?? -1) && right > (twice ?? -1) && right >= TRANSPOSED_OK_MIN);
      if (!ok) m.mistransposed++;
      transposition = { right, none, twice, ok };
    }

    for (const k of Object.keys(served)) served[k] += (p[`${k}Warnings`] || []).length;
    perPart.push({ instrName: p.instrName, bars, barErrors: barErr, melodyMismatch: mel, rangeNotes: range, harmonyFlagged: h.flagged, harmonyChecked: h.checked, transposition });
  }

  // Melody coverage among the parts that actually exist.
  const carried = new Set();
  for (const p of parts) for (const n of melodyMeasureSet(roles[p.instrName]?.melodySections || [])) carried.add(n);
  for (let n = 1; n <= measures; n++) if (!carried.has(n)) m.uncoveredBars++;

  const fit = planChordFit(plan, key, ts);
  m.planChordChecked = fit.checked; m.planChordFlagged = fit.flagged;

  m.clashes = findMelodyClashes({
    parts: parts.map((p) => ({ instrName: p.instrName, abc: p.abc })),
    instrumentRoles: roles, chords, concertKey: key, timeSignature: ts, limit: Infinity,
  }).length;

  // meta = null: analyzeVoicing then skips its own clash check, which
  // findMelodyClashes above already counts. Never count clashes twice.
  // Infinity: the UI stops at 8 mud / dynamics warnings; a score must not.
  const voicing = analyzeVoicing(
    parts.map((p) => ({ instrName: p.instrName, baseName: p.instrName.replace(/\s+\d+$/, ""), abcText: p.abc, status: "done" })),
    plan, null, Infinity,
  );
  for (const v of voicing) {
    const kind = Object.keys(VOICING_KINDS).find((k) => VOICING_KINDS[k].test(v));
    m[kind || "voicingOther"]++;
  }

  return { metrics: m, perPart, served, planChordBars: fit.bars };
}

// The metrics a report compares, each with the direction that is better and
// how to normalise it so a 16-bar and a 32-bar case compare fairly.
export const REPORT_METRICS = [
  { key: "missingParts", label: "missing parts", per: null },
  { key: "lengthErrors", label: "wrong-length parts", per: null },
  { key: "barErrors", label: "bad bars /100 part-bars", per: "partBars" },
  { key: "melodyMismatch", label: "melody mismatch % of owed bars", per: "melodyBars" },
  { key: "harmonyFlagged", label: "off-chord % of checked bars", per: "harmonyChecked" },
  { key: "clashes", label: "melody clashes /100 part-bars", per: "partBars" },
  { key: "rangeNotes", label: "out-of-range notes /100 part-bars", per: "partBars" },
  { key: "uncoveredBars", label: "bars with no melody", per: null },
  { key: "planChordFlagged", label: "plan: tune off its own chords, % bars", per: "planChordChecked" },
  { key: "mistransposed", label: "mis-transposed parts", per: null },
  { key: "mud", label: "muddy low voicings", per: null },
  { key: "unison", label: "unison doublings", per: null },
  { key: "dynamics", label: "melody drowned (dynamics)", per: null },
];

// One comparable number for a metric in a run (lower is always better): a
// raw count, or per 100 of its base (a percentage when the base is bars that
// could fail, a rate when it is all part-bars). null when the base is 0.
export function metricValue(metrics, spec) {
  const raw = metrics[spec.key];
  if (!spec.per) return raw;
  const base = metrics[spec.per];
  return base ? (100 * raw) / base : null;
}
