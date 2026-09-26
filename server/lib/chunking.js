// Chunked part generation for long pieces.
//
// A single call asked for 64 measures reliably under-writes (12–20 bars came
// back in practice) — long generations degrade. So above CHUNK_THRESHOLD
// measures, /api/part writes the part in sections of ~CHUNK_SIZE measures:
// every call still sees the full musical context (song, role, whole melody,
// all chords) plus the tail of what's already written, but only has to
// produce one section, which stays inside the model's reliable window. The
// sections are validated/repaired individually and stitched back into one
// part. These pure helpers do the splitting/stitching; the orchestration
// lives in server/index.js.

import { parseMeasureRange, scanMeasure, measureUnits, barUnitsFor, hasTuplet, roundUnits, UNIT_EPSILON } from "./abcMelody.js";
import { restTokens, lenSuffix } from "./symbolic.js";

export const CHUNK_THRESHOLD = 24; // single-call parts up to here
export const CHUNK_SIZE = 16; // target measures per chunk
const MIN_TAIL = 8; // a final chunk smaller than this folds into the previous one

// 1-based inclusive [start, end] ranges covering 1..measures.
export function chunkRanges(measures) {
  const ranges = [];
  let start = 1;
  while (start <= measures) {
    let end = Math.min(start + CHUNK_SIZE - 1, measures);
    if (measures - end > 0 && measures - end < MIN_TAIL) end = measures;
    ranges.push([start, end]);
    start = end + 1;
  }
  return ranges;
}

// Clip section labels ("mm.5-12") to a chunk window. `toLocal` re-numbers the
// result relative to the chunk (piece measure `start` → 1) for validators that
// only see the chunk's measures; otherwise piece numbering is kept for prompts.
export function intersectSections(sections, start, end, toLocal = false) {
  const out = [];
  for (const label of sections || []) {
    const r = parseMeasureRange(label);
    if (!r) continue;
    const a = Math.max(r.start, start);
    const b = Math.min(r.end, end);
    if (a > b) continue;
    out.push(toLocal ? `mm.${a - start + 1}-${b - start + 1}` : `mm.${a}-${b}`);
  }
  return out;
}

// The ABC header of a part: everything up to and including the K: line.
export function headerOf(abc) {
  const lines = String(abc).split(/\r?\n/);
  const kIdx = lines.findIndex((l) => /^K:/.test(l.trim()));
  return kIdx >= 0 ? lines.slice(0, kIdx + 1).join("\n") : String(abc);
}

// One whole-measure rest for a meter, in L:1/8 units (4/4 → "z8", 3/4 → "z6").
export function restMeasure(timeSignature) {
  const [num, den] = String(timeSignature || "4/4").split("/").map((x) => parseInt(x, 10));
  const units = ((num || 4) * 8) / (den || 4);
  return `z${Number.isInteger(units) && units > 0 ? units : 8}`;
}

// Force a part to EXACTLY `target` measures: pad the tail with whole-measure
// rests when the model stopped writing early, trim extras when it overran.
// Explicit rests keep the notation honest and every part aligned bar-for-bar.
// Returns { measures, padded, trimmed }.
export function fitMeasureCount(measureArr, target, timeSignature) {
  const padded = Math.max(0, target - measureArr.length);
  const trimmed = Math.max(0, measureArr.length - target);
  const out = measureArr.slice(0, target);
  const rest = restMeasure(timeSignature);
  while (out.length < target) out.push(rest);
  return { measures: out, padded, trimmed };
}

// Structural damage = the wrong number of bars, or bars that don't hold the
// right number of beats. Both break alignment with every other part, unlike a
// melody/range problem which is confined to this one line.
const structuralCount = (r) => r.structure.length + (r.bars?.length || 0);

// Decide whether a repair-retry attempt should replace the original, given
// each attempt's check results ({ structure: [], bars: [], total: <number> },
// plus whatever else the caller's checkAll()/check() includes in the count).
// Structural problems dominate the comparison: a flat total-count tie-break
// lets a retry that fixes the length but trades for an equal-or-worse
// melody/range count get rejected, keeping the wrong-length attempt — which
// then gets rest-padded, i.e. a block of silence in the shipped part. Shared
// by both the non-chunked and chunked `/api/part` paths so the two can't
// drift apart again (see ENGINE_NOTES.md "Length is a retryable problem" —
// this exact bug existed on the chunked path until it was pulled out into
// this one function both call).
export function isBetterAttempt(candidate, original) {
  const cs = structuralCount(candidate);
  const os = structuralCount(original);
  if (cs !== os) return cs < os;
  return candidate.total < original.total;
}

// Rewrite one note/chord/rest token to an exact duration in L:1/8 units.
// Returns null when the duration isn't representable in ABC (true tuplet
// values) — the caller then falls back to dropping the event.
function resizeEvent(tokenText, units) {
  const suf = lenSuffix(units);
  if (suf === null) return null;
  if (tokenText.startsWith("[")) {
    const close = tokenText.indexOf("]");
    if (close === -1) return null;
    // Normalize "[C2E2G2]" to "[CEG]<len>" so the length is stated once.
    const inner = tokenText.slice(1, close).replace(/(\d+\/\d+|\d+|\/+)/g, "");
    return `[${inner}]${suf}`;
  }
  return tokenText.replace(/(\d+\/\d+|\d+|\/+)$/, "") + suf;
}

// Append rests totalling `deficit` eighth-units to a measure's text.
function padMeasure(text, deficit) {
  if (deficit <= UNIT_EPSILON) return text;
  const rests = restTokens(deficit);
  if (rests.length === 0) return text;
  const head = text.trimEnd();
  return head ? `${head} ${rests.join(" ")}` : rests.join(" ");
}

// Deterministic last-resort repair for bars that STILL don't sum to the meter
// after the model's repair retry. A wrong-length bar is not cosmetic: it
// pushes that part progressively out of alignment with every other part, so
// the line drifts late and appears to end in the wrong place.
//
// ASYMMETRIC BY DESIGN. A measure where this part carries the MELODY is never
// rewritten — padding or trimming it would alter the tune itself and
// manufacture a checkPartMelody rhythm/contour failure on a part that had
// none (the same self-inflicted damage as fitMeasureCount's cadence-deleting
// trim; see ENGINE_NOTES.md). Those bars are reported instead, so the user
// can regenerate rather than receive a silently mangled melody.
//
// Accompaniment bars ARE repaired: a short bar gains rests; an overfull one
// keeps every event that fits, shortens the one straddling the barline to
// fill the remaining room exactly, and drops the rest. A bar containing a
// TUPLET may be padded (rests go after the group, never inside it) but is
// never trimmed — cutting into a tuplet would orphan the group.
//
// Returns { measures, repaired[], unrepairable[] }.
export function repairPartBars({ measures, timeSignature, melodySet = new Set(), measureOffset = 0 }) {
  const expected = barUnitsFor(timeSignature);
  const out = [];
  const repaired = [];
  const unrepairable = [];

  measures.forEach((meas, i) => {
    const pieceNo = i + 1 + measureOffset;
    const units = measureUnits(meas, timeSignature);
    if (Math.abs(units - expected) <= UNIT_EPSILON) { out.push(meas); return; }

    if (melodySet.has(pieceNo)) {
      unrepairable.push(
        `measure ${pieceNo}: this part carries the melody here and the bar totals ${roundUnits(units)} eighth-note units instead of ${expected}, and was left exactly as written rather than altering the tune (Regenerate to fix)`,
      );
      out.push(meas);
      return;
    }

    if (units < expected) {
      // Appending rests after the existing notes is safe even when the bar
      // contains a tuplet — it never reaches inside the group.
      out.push(padMeasure(meas, expected - units));
      repaired.push(`measure ${pieceNo}: padded from ${roundUnits(units)} to ${expected} eighth-note units with rests`);
      return;
    }

    // Overfull AND containing a tuplet: trimming would cut into the tuplet
    // group (or shorten one of its notes), leaving an orphaned "(3" whose
    // remaining notes no longer add up. Report it instead of mangling it.
    if (hasTuplet(meas)) {
      unrepairable.push(
        `measure ${pieceNo}: the bar totals ${roundUnits(units)} eighth-note units instead of ${expected} and contains a tuplet, so it was left as written rather than cut into the tuplet group (Regenerate to fix)`,
      );
      out.push(meas);
      return;
    }

    // Overfull: keep whole events while they fit, then fit the straddler.
    const events = scanMeasure(meas, timeSignature);
    let acc = 0;
    let straddler = -1;
    for (let k = 0; k < events.length; k++) {
      if (acc + events[k].units > expected + UNIT_EPSILON) { straddler = k; break; }
      acc += events[k].units;
    }
    if (straddler === -1) { out.push(meas); return; } // defensive: nothing to cut
    const head = meas.slice(0, events[straddler].start).trimEnd();
    const room = expected - acc;
    let text = head;
    if (room > UNIT_EPSILON) {
      const ev = events[straddler];
      const shortened = resizeEvent(meas.slice(ev.start, ev.end), room);
      text = shortened
        ? (head ? `${head} ${shortened}` : shortened)
        : padMeasure(head, room);
    }
    out.push(text);
    repaired.push(`measure ${pieceNo}: trimmed from ${roundUnits(units)} to ${expected} eighth-note units`);
  });

  return { measures: out, repaired, unrepairable };
}

// One concise user-facing line summarising deterministic bar repairs. A
// single warning rather than one per bar, so a part whose rhythm needed a lot
// of patching doesn't bury its other warnings. Surfaced for the same reason
// the length fix is: the notation shipped is not quite what the model wrote,
// and the user should be able to choose to regenerate instead.
export function barRepairNote(repaired) {
  if (!repaired || repaired.length === 0) return null;
  const n = repaired.length;
  return `${n} bar${n > 1 ? "s" : ""} didn't add up to a full measure and ${n > 1 ? "were" : "was"} padded or trimmed to fit so this part stays in time with the rest of the ensemble (Regenerate for a cleaner take)`;
}

// Reassemble stitched measures into a body: 4 bars per line, final |].
export function stitchBody(measures) {
  const lines = [];
  for (let i = 0; i < measures.length; i += 4) {
    const last = i + 4 >= measures.length;
    lines.push(measures.slice(i, i + 4).join(" | ") + (last ? " |]" : " |"));
  }
  return lines.join("\n");
}
