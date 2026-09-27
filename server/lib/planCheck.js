// Validate and repair the blueprint's melody hand-off plan.
//
// The blueprint prompt asks that every measure be carried by EXACTLY ONE
// instrument, but until now nothing checked it. Two silent failures follow
// when the model gets it wrong: a measure nobody was assigned has no melody
// in ANY part (the tune just drops out), and a measure assigned twice has two
// instruments playing the tune in parallel. A role keyed by a name that is not
// one of the selected voices ("Violin" when the voices are "Violin 1" and
// "Violin 2") is the same gap in disguise: the client looks roles up by exact
// voice name, so that melody reaches no part at all.
//
// Repair is deterministic and never retries the (blocking, paid) blueprint
// call. It only changes WHO carries the melody, never which notes — the result
// is shown in each part card ("Carries the melody in") and every change is
// reported to the user as a plan warning.

import { parseMeasureRange } from "./abcMelody.js";

// The section boundaries the blueprint prompts suggest: one section per
// voice, but at least 4 measures each. Shared so the prompts and the
// no-carrier fallback below cannot drift apart.
export function suggestedSections(measures, voiceCount) {
  const targetSections = Math.max(1, Math.min(voiceCount || 1, Math.floor(measures / 4)));
  const sectionSize = Math.max(4, Math.round(measures / Math.max(1, targetSections)));
  const sections = [];
  for (let m = 1; m <= measures; m += sectionSize) {
    sections.push({ start: m, end: Math.min(m + sectionSize - 1, measures) });
  }
  return sections;
}

const hasOwn = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// A set of measure numbers → contiguous "mm.a-b" labels ("mm.a" for one bar).
export function rangesToLabels(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const labels = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    labels.push(i === j ? `mm.${sorted[i]}` : `mm.${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return labels;
}

// "measures 5-8" / "measure 5" for user-facing text.
function describeMeasures(nums) {
  const labels = rangesToLabels(nums).map((l) => l.slice(3));
  const single = labels.length === 1 && !labels[0].includes("-");
  return `${single ? "measure" : "measures"} ${labels.join(", ")}`;
}

// Map each instrumentRoles key onto a selected voice name: exact match first,
// then trimmed and case-insensitive. Deliberately NO guessing across numbered
// voices ("Violin" → "Violin 1"): which of two violins was meant is unknowable.
function matchVoice(key, voiceNames) {
  if (voiceNames.includes(key)) return key;
  const norm = String(key).trim().toLowerCase();
  return voiceNames.find((v) => v.trim().toLowerCase() === norm) || null;
}

// Check the plan's melody coverage and repair it if needed.
//
//   instrumentRoles: the blueprint's { [name]: { primaryRole, melodySections, instruction } }
//   voiceNames:      the selected voices, in order, exactly as the client names them
//   measures:        the piece length
//
// Returns { instrumentRoles, warnings }. When the plan is already valid the
// SAME object comes back untouched with no warnings.
//
// Repair rules (each a judgment call, see ENGINE_NOTES.md):
//   - Unparseable labels are dropped; ranges are clipped to 1..measures.
//   - Overlap: the measure goes to the carrier whose claimed range STARTS
//     LATEST (ties: the shorter range, then voice order). That honours the
//     hand-off point the incoming section declared, and keeps a short feature
//     nested inside a long section ("Flute mm.5-8" inside "Violin mm.1-16")
//     instead of erasing it.
//   - Gap: the preceding carrier continues through it; a gap at the very start
//     goes to the first carrier after it.
//   - No carrier at all: the melody rotates through the voices, one per
//     suggested section, the same boundaries the prompt proposed.
export function repairMelodyCoverage({ instrumentRoles, voiceNames, measures }) {
  const warnings = [];
  const roles = instrumentRoles && typeof instrumentRoles === "object" && !Array.isArray(instrumentRoles)
    ? instrumentRoles
    : {};
  const voices = (voiceNames || []).map(String);
  if (voices.length === 0 || !Number.isInteger(measures) || measures < 1) {
    return { instrumentRoles, warnings };
  }

  // Claims per voice: { voice, start, end, order } after clipping.
  const claims = [];
  const renamed = {}; // voice → the role key it was found under, when not exact
  let changed = false;
  const outOfRange = new Set();
  const unknownKeys = [];

  for (const [key, role] of Object.entries(roles)) {
    const voice = matchVoice(key, voices);
    if (!voice) {
      if (Array.isArray(role?.melodySections) && role.melodySections.length > 0) unknownKeys.push(key);
      continue;
    }
    if (voice !== key) {
      // An exact key for the same voice wins over a case-variant one, and the
      // first case-variant wins over any later one.
      changed = true;
      if (hasOwn(roles, voice) || hasOwn(renamed, voice)) continue;
      renamed[voice] = key;
    }
    const sections = Array.isArray(role?.melodySections) ? role.melodySections : [];
    for (const label of sections) {
      const r = parseMeasureRange(label);
      if (!r) { changed = true; continue; }
      const start = Math.max(1, r.start);
      const end = Math.min(measures, r.end);
      for (let n = r.start; n <= r.end; n++) if (n < 1 || n > measures) outOfRange.add(n);
      if (start > end) { changed = true; continue; }
      if (start !== r.start || end !== r.end) changed = true;
      claims.push({ voice, start, end, order: voices.indexOf(voice) });
    }
  }

  if (unknownKeys.length > 0) {
    changed = true;
    warnings.push(
      `The plan gave melody measures to ${unknownKeys.map((k) => `"${k}"`).join(", ")}, which ${unknownKeys.length > 1 ? "are" : "is"} not one of the selected instruments, so no part would have played ${unknownKeys.length > 1 ? "them" : "it"}. That part of the plan was ignored.`,
    );
  }
  if (outOfRange.size > 0) {
    warnings.push(`The plan assigned melody to ${describeMeasures(outOfRange)}, outside this ${measures}-measure piece. That part of the plan was ignored.`);
  }

  // Resolve each measure to one owner.
  const owner = new Array(measures + 1).fill(null);
  const overlapNotes = new Map(); // "a,b→winner" → measure numbers, for reporting
  for (let n = 1; n <= measures; n++) {
    const here = claims.filter((c) => c.start <= n && n <= c.end);
    if (here.length === 0) continue;
    const distinct = [...new Set(here.map((c) => c.voice))];
    here.sort((a, b) => (b.start - a.start) || ((a.end - a.start) - (b.end - b.start)) || (a.order - b.order));
    owner[n] = here[0].voice;
    if (distinct.length > 1) {
      changed = true;
      const k = `${distinct.sort((a, b) => voices.indexOf(a) - voices.indexOf(b)).join(" and ")}→${owner[n]}`;
      if (!overlapNotes.has(k)) overlapNotes.set(k, []);
      overlapNotes.get(k).push(n);
    }
  }
  for (const [k, nums] of overlapNotes) {
    const [both, winner] = k.split("→");
    warnings.push(`The plan gave ${describeMeasures(nums)} to both ${both}. ${winner} keeps the melody there so it is carried by one instrument at a time.`);
  }

  // Fill gaps.
  if (owner.slice(1).every((o) => o === null)) {
    changed = true;
    const sections = suggestedSections(measures, voices.length);
    sections.forEach((s, i) => {
      for (let n = s.start; n <= s.end; n++) owner[n] = voices[i % voices.length];
    });
    warnings.push("The plan did not give the melody to any instrument, so it was passed around the ensemble section by section instead.");
  } else {
    const gaps = [];
    for (let n = 1; n <= measures; n++) if (owner[n] === null) gaps.push(n);
    if (gaps.length > 0) {
      changed = true;
      const firstOwned = owner.findIndex((o, n) => n >= 1 && o !== null);
      const filledBy = new Map(); // voice → measures it took over
      for (const n of gaps) {
        const v = n < firstOwned ? owner[firstOwned] : owner[n - 1];
        owner[n] = v;
        if (!filledBy.has(v)) filledBy.set(v, []);
        filledBy.get(v).push(n);
      }
      for (const [v, nums] of filledBy) {
        warnings.push(`The plan left ${describeMeasures(nums)} with no instrument carrying the melody. ${v} now carries it there, continuing from the neighbouring section.`);
      }
    }
  }

  if (!changed) return { instrumentRoles, warnings };

  // Rebuild. Every matched role is carried over under its exact voice name;
  // only melodySections changes, and only for voices whose measures changed.
  const out = {};
  for (const [key, role] of Object.entries(roles)) {
    if (matchVoice(key, voices) === null) out[key] = role; // unknown: left as-is, it is never looked up
  }
  for (const voice of voices) {
    const key = hasOwn(roles, voice) ? voice : hasOwn(renamed, voice) ? renamed[voice] : undefined;
    const role = key !== undefined ? roles[key] : undefined;
    const nums = [];
    for (let n = 1; n <= measures; n++) if (owner[n] === voice) nums.push(n);
    const labels = rangesToLabels(nums);
    const before = role && Array.isArray(role.melodySections) ? role.melodySections : [];
    const same = before.length === labels.length && before.every((l, i) => l === labels[i]);
    if (role && typeof role === "object") {
      out[voice] = same ? role : { ...role, melodySections: labels };
    } else if (labels.length > 0) {
      out[voice] = { primaryRole: "melody", melodySections: labels, instruction: "" };
    }
  }
  return { instrumentRoles: out, warnings };
}
