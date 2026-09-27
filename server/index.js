import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { PORT, MODEL, RETRIEVAL_MODEL, ANTHROPIC_API_KEY, FRONTEND_ORIGIN, tokensForMeasures } from "./config.js";
import { callAnthropic, extractJson } from "./anthropic.js";
import {
  buildSearchPrompt, buildBlueprintPrompt, buildPartPrompt, buildMelodyCheckPrompt,
  buildGroundTruthPrompt, buildLibraryBlueprintPrompt, buildLibraryExtensionPrompt,
  buildHarmonizePrompt,
} from "./prompts.js";
import { analyzeMelody, splitMelodyIntoMeasures, barUnitsFor } from "./lib/abcMelody.js";
import { loadLibrary, getWork, searchLibrary, workToSong } from "./lib/library.js";
import { searchCorpus, getCorpusWork } from "./lib/corpus.js";
import { searchOpenScore, getOpenScoreWork } from "./lib/openscore.js";
import { searchOpenHymnal, getOpenHymnalWork } from "./lib/openhymnal.js";
import { tonicChord } from "./lib/symbolic.js";
import { loadImports, getImportedWork, searchImports, ingestScore, saveImportChords, importToSong } from "./lib/imports.js";
import { checkPartMelody, partMeasures, checkPartBars, melodyMeasureSet } from "./lib/partCheck.js";
import { checkPartRange, enforceRange, placeMelodyPhrases } from "./lib/ranges.js";
import { partHeader, responseToPartAbc } from "./lib/partFormat.js";
import { writtenKeyFor, keyFifths, writtenMelodyFor } from "./lib/transpose.js";
import { CHUNK_THRESHOLD, CHUNK_SIZE, chunkRanges, intersectSections, headerOf, stitchBody, fitMeasureCount, isBetterAttempt, repairPartBars, barRepairNote } from "./lib/chunking.js";
import { ALLOWED_MEASURES, MAX_INSTRUMENTS, isValidMeasures, sanitizeContextParts, PART_BODY_LIMIT } from "./lib/limits.js";
import { repairMelodyCoverage } from "./lib/planCheck.js";
import { checkPartHarmony, harmonyWarnings } from "./lib/harmony.js";

const app = express();

// Render/Vercel/etc. sit behind a reverse proxy — without this, every request
// looks like it comes from the proxy's IP, so the per-IP rate limiter below
// either buckets all users together or throws on the untrusted X-Forwarded-For
// header. Must be set before the limiter is registered.
app.set("trust proxy", 1);

// Body size cap so a stranger can't post a giant payload (Phase 2 hardening).
// /api/part alone gets a larger cap: it now carries the parts already written
// as context (up to 15 parts × 128 bars of decorated ABC). Every other route
// keeps the 64kb limit.
const jsonSmall = express.json({ limit: "64kb" });
const jsonPart = express.json({ limit: PART_BODY_LIMIT });
app.use((req, res, next) => (req.path === "/api/part" ? jsonPart : jsonSmall)(req, res, next));
// Locked to the deployed frontend — app.use(cors()) was wide open, letting
// anyone who found the backend URL spend the API budget from a browser.
app.use(cors({ origin: FRONTEND_ORIGIN }));

// Per-IP rate limit so deployment doesn't burn API credits to abusers.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 generation requests/min/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});
app.use("/api/", limiter);

// Wrap an async route so thrown errors become clean JSON responses.
const handler = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.status || 500;
    console.error(`[${req.path}]`, err.message);
    res.status(status).json({ error: err.message, code: err.code });
  });
};

// /api/import is disabled in production (see the route below) — surfaced here
// so the frontend can hide/disable the upload UI instead of offering a button
// that 503s.
const IMPORT_ENABLED = process.env.NODE_ENV !== "production";

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL, hasKey: Boolean(ANTHROPIC_API_KEY), importEnabled: IMPORT_ENABLED });
});

// ── Public-domain score library ──────────────────────────────────────────────
// Real symbolic melody data — the accuracy-first path. See server/lib/library.js.
app.get("/api/library", (req, res) => {
  res.json({ songs: [...loadLibrary().map(workToSong), ...loadImports().map(importToSong)] });
});

// ── Score import (MusicXML / MIDI upload) ────────────────────────────────────
// Convert an uploaded score into the canonical verified representation. The
// file is parsed, validated with the same bar-math gate as the library, and
// persisted — from then on every arrangement of this song starts from it.
//
// This is the largest unguarded surface on a public deploy: it accepts a raw
// 10mb upload and parses it (zip inflate for .mxl, MIDI parsing) before any
// bot-check exists. Disabled in production until it's gated behind the same
// abuse check as /api/blueprint (Turnstile) — re-enable by removing this guard
// once that's wired up.
app.post("/api/import", express.raw({ type: () => true, limit: "10mb" }), handler(async (req, res) => {
  if (!IMPORT_ENABLED) {
    throw Object.assign(new Error("Score upload is temporarily disabled."), { status: 503 });
  }
  const filename = String(req.query.filename || "");
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw Object.assign(new Error("empty upload"), { status: 400 });
  }
  const work = ingestScore(filename, req.body);
  console.log(`[import] "${work.title}" ← ${filename} (${work.measures} bars, ${work.key} ${work.timeSignature})`);
  res.json({ song: importToSong(work) });
}));

// ── Song search ──────────────────────────────────────────────────────────────
// Library matches (exact score data) come back instantly and skip the LLM
// entirely; only unknown songs fall through to the model + web search.
app.post("/api/search", handler(async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) throw Object.assign(new Error("query is required"), { status: 400 });

  const libraryHits = [
    ...searchLibrary(query).map(workToSong),
    ...searchImports(query).map(importToSong),
  ];
  if (libraryHits.length > 0) {
    res.json({ songs: libraryHits });
    return;
  }

  // Engraved MusicXML corpora next — real note-level score data, converted and
  // validated before it is ever shown. Network failure degrades to the LLM.
  try {
    const corpusHits = await searchCorpus(query);
    if (corpusHits.length > 0) {
      console.log(`[search] "${query}": ${corpusHits.length} validated MusicXML hit(s) from the music21 corpus`);
      res.json({ songs: corpusHits });
      return;
    }
  } catch (err) {
    console.warn(`[search] music21 corpus lookup failed: ${err.message}`);
  }
  try {
    const openScoreHits = await searchOpenScore(query);
    if (openScoreHits.length > 0) {
      console.log(`[search] "${query}": ${openScoreHits.length} validated MusicXML hit(s) from OpenScore Lieder`);
      res.json({ songs: openScoreHits });
      return;
    }
  } catch (err) {
    console.warn(`[search] OpenScore lookup failed: ${err.message}`);
  }
  try {
    const hymnalHits = await searchOpenHymnal(query);
    if (hymnalHits.length > 0) {
      console.log(`[search] "${query}": ${hymnalHits.length} validated hymn(s) from the Open Hymnal Project`);
      res.json({ songs: hymnalHits });
      return;
    }
  } catch (err) {
    console.warn(`[search] Open Hymnal lookup failed: ${err.message}`);
  }

  const text = await callAnthropic({
    prompt: buildSearchPrompt(query),
    maxTokens: 2000,
    webSearch: true,
    maxSearches: 3,
    model: RETRIEVAL_MODEL,
  });
  const songs = extractJson(text);
  res.json({ songs: Array.isArray(songs) ? songs : [] });
}));

// ── Arrangement blueprint (canonical melody + chords + distribution) ─────────
app.post("/api/blueprint", handler(async (req, res) => {
  const p = req.body || {};
  if (!p.songTitle) throw Object.assign(new Error("songTitle is required"), { status: 400 });
  if (!Array.isArray(p.instruments) || p.instruments.length === 0) {
    throw Object.assign(new Error("instruments are required"), { status: 400 });
  }
  if (p.instruments.length > MAX_INSTRUMENTS) {
    throw Object.assign(new Error(`Too many instruments (max ${MAX_INSTRUMENTS}).`), { status: 400 });
  }
  if (!isValidMeasures(p.measures)) {
    throw Object.assign(new Error(`measures must be one of: ${ALLOWED_MEASURES.join(", ")}`), { status: 400 });
  }
  const measures = Number(p.measures);

  // Library path: the melody is REAL symbolic data — use it verbatim. The LLM
  // never touches the theme's own notes; no refine pass, no web lookup. But the
  // requested length is not truncated down to the theme's literal length either —
  // when the user asks for more, extendLibraryMelody composes additional
  // measures (real development, not a copy-paste loop) to reach it.
  if (p.libraryId) {
    const work = getWork(p.libraryId) || getImportedWork(p.libraryId);
    if (!work) throw Object.assign(new Error(`unknown library work: ${p.libraryId}`), { status: 404 });
    // Imported works may arrive without chords — harmonize ONCE (the melody
    // stays untouched) and persist, so the song is never solved twice.
    if (!work.chords) {
      work.chords = await harmonizeWork(work);
      if (work.sourceType === "import") saveImportChords(work.id, work.chords);
    }
    const plan = await planFromWork(work, measures, p);
    plan.source = work.sourceType || "library";
    plan.libraryId = work.id;
    res.json({ plan });
    return;
  }

  // Corpus path: same verbatim-melody contract as the library — the MusicXML
  // was fetched, converted, and validated at search time; here we (re)use the
  // cached work, harmonize it once (engraved parts carry no chord symbols),
  // and run the identical orchestration-only pipeline. Path prefixes from the
  // three corpora never collide (music21/corpus/... vs scores/... vs
  // Complete/...), so trying all three is unambiguous.
  if (p.corpusId) {
    const work = (await getCorpusWork(p.corpusId)) || (await getOpenScoreWork(p.corpusId)) || (await getOpenHymnalWork(p.corpusId));
    if (!work) throw Object.assign(new Error(`unknown or unusable corpus score: ${p.corpusId}`), { status: 404 });
    if (!work.chords) work.chords = await harmonizeWork(work);
    const plan = await planFromWork(work, measures, p);
    plan.source = work.sourceType; // "corpus" (music21/OpenScore) or "hymnal" (Open Hymnal) — see ScoreView's honesty labeling
    plan.corpusId = work.corpusId;
    plan.sourceUrl = work.sourceUrl;
    res.json({ plan });
    return;
  }

  // Ground-truth research pass — look the song up on public chord/tab sources
  // with the web_search tool so the blueprint starts from documented key/chords/
  // structure instead of the model's memory. Failure degrades to memory-only.
  const groundTruth = await lookupGroundTruth(p);

  const text = await callAnthropic({
    prompt: buildBlueprintPrompt({ ...p, measures, groundTruth }),
    maxTokens: Math.min(8000, 2500 + measures * 30),
  });
  const plan = extractJson(text);

  // Melody accuracy pass — the canonical tune is the source of truth for every
  // part, so verify/correct its pitches and rhythm before returning it.
  if (plan && typeof plan.melodyAbc === "string") {
    plan.melodyAbc = await refineMelody(plan.melodyAbc, { ...p, measures, groundTruth });
  }
  if (plan && groundTruth) plan.groundTruth = groundTruth; // surface sources/confidence to the UI
  enforceMelodyCoverage(plan, p, measures);
  res.json({ plan });
}));

// Shared verbatim-melody blueprint: extend the work's real melody to the
// requested length, then ask the model ONLY for the orchestration plan. The
// melody/chords in the returned plan are overwritten with the real data
// unconditionally — they are never the model's to change.
async function planFromWork(work, measures, p) {
  const { melodyMeasures, chords } = await extendLibraryMelody(work, measures, p);
  const useMeasures = melodyMeasures.length;
  const melodyAbc = `${melodyMeasures.join(" | ")} |]`;

  const text = await callAnthropic({
    prompt: buildLibraryBlueprintPrompt({
      songTitle: work.title, songArtist: work.composer, songGenre: work.genre,
      instruments: p.instruments, style: p.style, density: p.density,
      key: work.key, timeSignature: work.timeSignature, bpm: p.bpm || work.bpm,
      measures: useMeasures, melodyAbc, chords,
    }),
    maxTokens: Math.min(8000, 2500 + useMeasures * 30),
  });
  const plan = extractJson(text) || {};
  plan.melodyAbc = melodyAbc;
  plan.chords = chords;
  plan.key = work.key;
  plan.timeSignature = work.timeSignature;
  plan.measures = useMeasures;
  enforceMelodyCoverage(plan, p, useMeasures);
  return plan;
}

// Every measure must have exactly one melody carrier among the SELECTED
// voices. The prompt asks for this; this makes it true, deterministically,
// and tells the user what was changed (see server/lib/planCheck.js).
function enforceMelodyCoverage(plan, p, measures) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return;
  const voiceNames = p.instruments.map((i) => String(i?.name ?? ""));
  const { instrumentRoles, warnings } = repairMelodyCoverage({
    instrumentRoles: plan.instrumentRoles, voiceNames, measures,
  });
  plan.instrumentRoles = instrumentRoles;
  if (warnings.length > 0) {
    plan.planWarnings = warnings;
    console.warn(`[blueprint] "${p.songTitle}": melody coverage repaired:\n  ${warnings.join("\n  ")}`);
  }
}

// Assign one chord per measure to a chord-less external melody. The melody is
// fixed; only the harmonization is the model's. Falls back to the tonic triad
// throughout on any failure so the pipeline never stalls on this step.
async function harmonizeWork(work) {
  try {
    const text = await callAnthropic({
      prompt: buildHarmonizePrompt({
        songTitle: work.title, key: work.key, timeSignature: work.timeSignature,
        melodyAbc: work.melodyAbc, measures: work.measures,
      }),
      maxTokens: Math.min(4000, 500 + work.measures * 12),
    });
    const parsed = extractJson(text);
    if (
      Array.isArray(parsed?.chords) && parsed.chords.length === work.measures &&
      parsed.chords.every((c) => typeof c === "string" && c.trim())
    ) {
      return parsed.chords.map((c) => c.trim());
    }
    console.warn(`[harmonize] "${work.title}": bad chord array from model — using tonic fallback`);
  } catch (err) {
    console.warn(`[harmonize] "${work.title}" failed: ${err.message} — using tonic fallback`);
  }
  return work.melodyMeasures.map(() => tonicChord(work.key));
}

// Reach a library work's requested length without shrinking the request to fit
// the theme. If the theme is already long enough, truncate to it (unchanged
// behavior). Otherwise compose additional measures past the theme — real
// development (variation, sequence, modulation), not a verbatim loop — in
// chunks of CHUNK_SIZE so each call stays inside the model's reliable window.
// A failed/invalid chunk falls back to literal repeats of the theme so the
// result is always exactly `targetMeasures` of musically valid material.
async function extendLibraryMelody(work, targetMeasures, p) {
  if (targetMeasures <= work.measures) {
    return {
      melodyMeasures: work.melodyMeasures.slice(0, targetMeasures),
      chords: work.chords.slice(0, targetMeasures),
    };
  }

  const melodyMeasures = [...work.melodyMeasures];
  const chords = [...work.chords];
  const timeSignature = work.timeSignature;

  while (melodyMeasures.length < targetMeasures) {
    const remaining = targetMeasures - melodyMeasures.length;
    const n = Math.min(remaining, CHUNK_SIZE);
    const isFinalSection = melodyMeasures.length + n >= targetMeasures;

    let best = null;
    let bestScore = Infinity;
    for (let attempt = 0; attempt < 2 && bestScore > 0; attempt++) {
      let text;
      try {
        text = await callAnthropic({
          prompt: buildLibraryExtensionPrompt({
            songTitle: work.title, songArtist: work.composer,
            key: work.key, timeSignature, bpm: p.bpm || work.bpm,
            style: p.style, density: p.density,
            themeMelodyAbc: `${melodyMeasures.join(" | ")} |]`,
            themeChords: chords,
            extraMeasures: n,
            isFinalSection,
          }),
          maxTokens: tokensForMeasures(n),
        });
      } catch {
        break; // network/model error — fall through to the repeat fallback below
      }
      const parsed = extractJson(text);
      if (!parsed || typeof parsed.melodyAbc !== "string" || !Array.isArray(parsed.chords)) continue;
      const score = analyzeMelody(parsed.melodyAbc, timeSignature, n).problems.length;
      if (score < bestScore) { best = parsed; bestScore = score; }
    }

    const extMeasures = best ? splitMelodyIntoMeasures(best.melodyAbc).slice(0, n) : [];
    const extChords = best ? best.chords.slice(0, n) : [];
    // Repair/pad: guarantee exactly n valid measures by cycling the theme's own
    // (already bar-math-valid) measures for anything the model didn't provide.
    while (extMeasures.length < n) {
      const i = extMeasures.length % work.measures;
      extMeasures.push(work.melodyMeasures[i]);
      extChords.push(work.chords[i]);
    }
    melodyMeasures.push(...extMeasures);
    chords.push(...extChords);
  }

  return { melodyMeasures, chords };
}

// Fetch documented song data (key, per-section chords, structure, melody facts)
// via web search. Returns null when nothing reliable was found or the call fails —
// callers must treat null as "fall back to model memory".
async function lookupGroundTruth(p) {
  try {
    const text = await callAnthropic({
      prompt: buildGroundTruthPrompt(p),
      maxTokens: 3000,
      webSearch: true,
      maxSearches: 5,
      model: RETRIEVAL_MODEL,
    });
    const gt = extractJson(text);
    if (!gt || gt.found === false) {
      console.log(`[ground-truth] no reliable data for "${p.songTitle}"`);
      return null;
    }
    console.log(`[ground-truth] "${p.songTitle}": key=${gt.key} conf=${gt.confidence} sources=${(gt.sources || []).length}`);
    return gt;
  } catch (err) {
    console.warn(`[ground-truth] lookup failed for "${p.songTitle}":`, err.message);
    return null;
  }
}

// Run the melody through a focused correction pass, then validate its bar math.
// Keeps whichever version is most correct (never returns something worse than the
// original blueprint melody). Up to two correction attempts.
async function refineMelody(melodyAbc, p) {
  const ts = p.timeSignature || "4/4";
  let best = melodyAbc;
  let bestScore = analyzeMelody(best, ts, p.measures).problems.length;

  for (let attempt = 0; attempt < 2; attempt++) {
    const analysis = analyzeMelody(best, ts, p.measures);
    let corrected;
    try {
      corrected = cleanMelodyLine(await callAnthropic({
        prompt: buildMelodyCheckPrompt({ ...p, melodyAbc: best, problems: analysis.problems }),
        maxTokens: 1500,
      }));
    } catch {
      break; // network/model error — keep best so far
    }
    if (!corrected) break;
    const score = analyzeMelody(corrected, ts, p.measures).problems.length;
    if (score < bestScore || (score === 0 && attempt === 0)) {
      best = corrected;
      bestScore = score;
    }
    if (bestScore === 0) break; // clean — stop early
  }
  return best;
}

// Pull the single ABC melody line out of a model reply: drop fences and any
// header lines (X:/T:/K:/…), then keep the line with the most barlines.
function cleanMelodyLine(text) {
  const t = (text || "").replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[A-Za-z]:/.test(l));
  if (lines.length === 0) return "";
  return lines.sort((a, b) => b.split("|").length - a.split("|").length)[0];
}

// ── Single instrument part ───────────────────────────────────────────────────
app.post("/api/part", handler(async (req, res) => {
  const body = req.body || {};
  const p = {
    ...body,
    contextParts: sanitizeContextParts(body.contextParts, body.instrName),
    instrumentRoles: body.instrumentRoles && typeof body.instrumentRoles === "object" && !Array.isArray(body.instrumentRoles)
      ? body.instrumentRoles : null,
  };
  if (p.contextParts) {
    console.log(`[part:${p.instrName}] written against ${p.contextParts.length} finished part(s): ${p.contextParts.map((c) => c.instrName).join(", ")}`);
  }
  if (!p.instrName) throw Object.assign(new Error("instrName is required"), { status: 400 });
  if (!isValidMeasures(p.measures)) {
    throw Object.assign(new Error(`measures must be one of: ${ALLOWED_MEASURES.join(", ")}`), { status: 400 });
  }
  const measures = Number(p.measures);

  // Long parts degrade in a single call (a 64-bar request came back with 12) —
  // above the threshold, write the part in validated ~16-measure sections.
  if (measures > CHUNK_THRESHOLD) {
    res.json(await generatePartChunked(p, measures));
    return;
  }

  const prompt = buildPartPrompt({ ...p, measures });
  const header = partHeader(p, p.instrName);
  let abc = responseToPartAbc(await callAnthropic({ prompt, maxTokens: tokensForMeasures(measures) }), header);

  // Arrangement accuracy: in the measures this part carries the melody it must
  // reproduce the canonical tune (rhythm exactly; contour exactly — the check
  // is transposition-invariant, so Bb/F/Eb parts and octave shifts pass), and
  // EVERY note must sit inside the instrument's realistic written range. One
  // repair attempt with the precise diffs; keep whichever version is cleaner.
  const melodySections = p.role?.melodySections || [];
  // The canonical melody is written at concert pitch; this part is written in
  // its own key. Both signatures are needed to resolve written notes to true
  // pitches so intervals can be compared exactly — passing the wrong one (or
  // none) for a transposing instrument mis-reads every accidental.
  const concertFifths = keyFifths(p.key);
  const writtenFifths = writtenKeyFor(p.key, p.instrName).fifths;
  const melodyRef = p.melodyAbc ? melodyReference(p) : null;
  const checkAll = (candidate) => {
    const melody = p.melodyAbc && melodySections.length > 0
      ? checkPartMelody(candidate, melodyRef.abc, melodySections, 0, p.timeSignature, melodyRef.fifths, writtenFifths)
      : { problems: [] };
    const range = checkPartRange(candidate, p.instrName);
    // A part that stops writing early (or runs long) is a retryable problem,
    // not just something to silently pad/trim after the fact — mirrors the
    // chunked path's `structure` check, which already gets this right.
    const got = partMeasures(candidate).length;
    const structure = got === measures
      ? []
      : [`you wrote ${got} measures but this part must contain EXACTLY ${measures} — ${got < measures ? "continue the piece to its actual end, don't stop early" : "you went past the end; stop exactly at the final barline"}`];
    // Every bar must hold exactly the meter's worth of beats. Nothing checked
    // this before, so a bar with an extra or missing beat shipped silently and
    // dragged that part out of alignment with the rest of the ensemble.
    const bars = checkPartBars(candidate, p.timeSignature).problems;
    return {
      melody: melody.problems, range: range.problems, structure, bars,
      lengthOff: Math.abs(got - measures), // measures to pad or cut (isBetterAttempt)
      total: melody.problems.length + range.problems.length + structure.length + bars.length,
    };
  };

  let issues = checkAll(abc);
  if (issues.total > 0) {
    console.warn(`[part:${p.instrName}] checks failed (${issues.melody.length} melody, ${issues.range.length} range, ${issues.structure.length} structure, ${issues.bars.length} bar-length):\n  ${[...issues.structure, ...issues.bars, ...issues.melody, ...issues.range].join("\n  ")}`);
    try {
      const fixList = [
        ...issues.structure.map((x) => `- [structure] ${x}`),
        ...issues.bars.map((x) => `- [bar length] ${x}`),
        ...issues.melody.map((x) => `- [melody] ${x}`),
        ...issues.range.map((x) => `- [range] ${x}`),
      ].join("\n");
      const retryAbc = responseToPartAbc(await callAnthropic({
        prompt: `${prompt}

YOUR PREVIOUS ATTEMPT HAD ERRORS, detected by automated checks against the canonical melody, the instrument's real playable range, and the required length. Fix EVERY one of them while keeping the rest of your arrangement:
${fixList}
${issues.range.length ? "\nRange errors are notes a real player physically cannot play — move that whole passage up or down an octave (or revoice the chord) so it fits the PLAYABLE RANGE; never just clip single notes." : ""}
${issues.structure.length ? "\nA part shorter than the requested length will otherwise be padded with silent rests to fill it out, which sounds broken next to the other instruments — actually write real music all the way to the final barline instead." : ""}
${issues.bars.length ? `\nBar-length errors mean those measures hold the wrong number of beats, which drags this part out of time with every other instrument. Re-count each flagged bar: in L:1/8 units a plain letter = 1 (eighth), C2 = 2 (quarter), C3 = 3 (dotted quarter), C4 = 4 (half), C6 = 6 (dotted half), C8 = 8 (whole). Every bar must total exactly ${barUnitsFor(p.timeSignature)}. Fix the rhythm inside the bar — do NOT just delete notes to make the count work.` : ""}
Return the FULL corrected part again as the same JSON object, nothing else.`,
        maxTokens: tokensForMeasures(measures),
      }), header);
      const second = checkAll(retryAbc);
      if (isBetterAttempt(second, issues)) {
        abc = retryAbc;
        issues = second;
      }
    } catch {
      // retry failed — keep first attempt and its warnings
    }
    if (issues.total > 0) {
      console.warn(`[part:${p.instrName}] still ${issues.melody.length} melody / ${issues.range.length} range / ${issues.structure.length} structure / ${issues.bars.length} bar-length problem(s) after repair`);
    }
  }

  // Each melody phrase at a playable octave, moved WHOLE (ranges.js), before
  // the per-measure last resort below. Live, a Cello played Canon in D at the
  // violin's octave. The user is told: the part is not what the model wrote.
  const placed = placeMelodyPhrases(abc, p.instrName, melodySections);
  if (placed.changes.length) {
    abc = placed.abc;
    console.log(`[part:${p.instrName}] melody placed: ${placed.changes.join("; ")}`);
  }

  // Deterministic last resort: the prompt + retry can still ship unplayable
  // notes (seen live: flute/oboe below their floor) — octave-correct them.
  const enforced = enforceRange(abc, p.instrName);
  if (enforced.changed) {
    abc = enforced.abc;
    console.log(`[part:${p.instrName}] range auto-fix: ${enforced.changes.join("; ")}`);
  }

  // Exact-length guarantee: a part that stops writing early gets explicit
  // whole-measure rests to the requested length (and overruns get trimmed),
  // so the notation stays honest and parts align bar-for-bar.
  // The header is always ours now (see partHeader), so the only failure left
  // here is the wrong NUMBER of measures — including zero, when the response
  // was empty, refused, or truncated before any usable notation.
  let lengthNote = null;
  const got = partMeasures(abc);
  if (got.length !== measures) {
    const fitted = fitMeasureCount(got, measures, p.timeSignature);
    abc = `${header}\n${stitchBody(fitted.measures)}`;
    lengthNote = got.length === 0
      ? `the model didn't return usable notation for this part, so all ${measures} measures are written as rests (Regenerate for a real take)`
      : fitted.padded
        ? `the part stopped at measure ${got.length}; measures ${got.length + 1}-${measures} are written as rests (Regenerate for a full take)`
        : `the part ran ${fitted.trimmed} measure(s) long; measure${fitted.trimmed > 1 ? "s" : ""} ${measures + 1}-${got.length} (including the part's final bar) were deleted to fit; the ending may now cut off early relative to other parts (Regenerate for a proper ending)`;
    console.warn(`[part:${p.instrName}] length fix: ${lengthNote}`);
  }

  // Deterministic bar-length repair, after the retry has had its chance.
  // Accompaniment bars that still hold the wrong number of beats are padded
  // or trimmed to the meter; bars carrying the MELODY are never rewritten
  // (that would alter the tune) and are surfaced as warnings instead.
  const barFix = repairPartBars({
    measures: partMeasures(abc),
    timeSignature: p.timeSignature,
    melodySet: melodyMeasureSet(melodySections),
  });
  if (barFix.repaired.length > 0) {
    abc = `${headerOf(abc)}\n${stitchBody(barFix.measures)}`;
    console.warn(`[part:${p.instrName}] bar-length auto-fix: ${barFix.repaired.join("; ")}`);
  }

  if (placed.changes.length || enforced.changed || lengthNote || barFix.repaired.length > 0) {
    issues = checkAll(abc); // recompute warnings on the corrected part
  }

  const repairNote = barRepairNote(barFix.repaired);
  const melodyOut = [
    ...(lengthNote ? [lengthNote] : []),
    ...(repairNote ? [repairNote] : []),
    ...barFix.unrepairable,
    ...issues.melody,
  ];
  const harmony = harmonyFor(abc, p, melodySections, concertFifths, writtenFifths);
  res.json({
    abc,
    melodyWarnings: melodyOut.length ? melodyOut : undefined,
    rangeWarnings: issues.range.length ? issues.range : undefined,
    // Things the server changed for the better (a melody phrase moved to a
    // playable octave): shown as information, not as a reason to Regenerate.
    adjustments: placed.changes.length ? placed.changes : undefined,
    harmonyWarnings: harmony.length ? harmony : undefined,
  });
}));

// The melody a part is checked against, and the key signature it is read in.
// A transposing part's prompt shows the tune in its WRITTEN pitch
// (writtenMelodyFor), so it is checked against that same text: the verdicts
// are identical (intervals and rhythm are unchanged; 59 saved transposing
// parts, 68 flagged bars, no difference), and the notes a failed check quotes
// back in the retry prompt then match the melody the part was given.
function melodyReference(p) {
  const w = writtenKeyFor(p.key, p.instrName);
  return w.transposes
    ? { abc: writtenMelodyFor(p.melodyAbc, p.key, p.instrName), fifths: w.fifths }
    : { abc: p.melodyAbc, fifths: keyFifths(p.key) };
}

// Informational chord-fit check on the part exactly as it ships, after every
// repair. Deliberately outside checkAll/isBetterAttempt and the retry prompt:
// its false-positive rate is unmeasured, and suspensions and passing tones
// are what the prompt asks for (see server/lib/harmony.js). The log line is
// the measurement.
function harmonyFor(abc, p, melodySections, concertFifths, writtenFifths) {
  const result = checkPartHarmony({
    partAbc: abc, chords: p.chords, timeSignature: p.timeSignature,
    melodyAbc: p.melodyAbc, melodySections, writtenFifths, concertFifths,
  });
  if (result.checked > 0 || result.unreadable > 0 || result.chordSuspect > 0) {
    console.log(`[part:${p.instrName}] harmony: ${result.flagged} of ${result.checked} accompaniment bar(s) flagged${result.unreadable ? `, ${result.unreadable} skipped (unreadable chord symbol)` : ""}${result.chordSuspect ? `, ${result.chordSuspect} skipped (the plan's chord doesn't fit its own melody there)` : ""}`);
  }
  return harmonyWarnings(result);
}

// Chunked generation for long parts: one model call per ~16-measure section,
// each validated (measure count + melody + range) and repaired individually,
// then stitched into a single part. Every call keeps the FULL musical context
// (whole melody, all chords, role) plus the previous section's tail, so the
// result stays one coherent line rather than disjoint fragments.
async function generatePartChunked(p, measures) {
  const sections = p.role?.melodySections || [];
  const melodyRef = p.melodyAbc ? melodyReference(p) : null;
  const canonical = melodyRef ? splitMelodyIntoMeasures(melodyRef.abc) : [];
  const stitched = [];
  // Built server-side once and reused for every section — the model returns
  // bare measures, so no chunk can contribute a wrong or missing header.
  const header = partHeader(p, p.instrName);
  // Key signatures for interval-exact melody validation: the canonical tune is
  // at concert pitch, the part is written in its own key.
  const concertFifths = keyFifths(p.key);
  const writtenFifths = writtenKeyFor(p.key, p.instrName).fifths;
  const structureWarnings = [];

  for (const [start, end] of chunkRanges(measures)) {
    const n = end - start + 1;
    const offset = start - 1;
    // Piece-numbered sections for the prompt; chunk-local ones for validation.
    const absSections = intersectSections(sections, start, end, false);
    const localSections = intersectSections(sections, start, end, true);
    const chunkMelody = canonical.slice(start - 1, end).join(" | ");
    const prevTail = stitched.slice(-2).join(" | ") || null;

    const prompt = buildPartPrompt({
      ...p,
      measures,
      role: p.role ? { ...p.role, melodySections: absSections } : null,
      chunk: { start, end, prevTail },
    });

    const check = (candidate) => {
      const got = partMeasures(candidate).length;
      const structure = got === n
        ? []
        : [`you wrote ${got} measures but this section must contain EXACTLY ${n} (piece measures ${start}-${end})`];
      const melody = p.melodyAbc && localSections.length > 0
        ? checkPartMelody(candidate, chunkMelody, localSections, offset, p.timeSignature, melodyRef.fifths, writtenFifths).problems
        : [];
      const range = checkPartRange(candidate, p.instrName, offset).problems;
      const bars = checkPartBars(candidate, p.timeSignature, offset).problems;
      return {
        structure, melody, range, bars,
        lengthOff: Math.abs(got - n), // measures to pad or cut (isBetterAttempt)
        total: structure.length + melody.length + range.length + bars.length,
      };
    };

    let abcChunk = responseToPartAbc(await callAnthropic({ prompt, maxTokens: tokensForMeasures(n) }), header);
    let issues = check(abcChunk);
    if (issues.total > 0) {
      console.warn(`[part:${p.instrName}] section ${start}-${end} checks failed (${issues.structure.length} structure, ${issues.melody.length} melody, ${issues.range.length} range, ${issues.bars.length} bar-length)`);
      try {
        const fixList = [
          ...issues.structure.map((x) => `- [structure] ${x}`),
          ...issues.bars.map((x) => `- [bar length] ${x}`),
          ...issues.melody.map((x) => `- [melody] ${x}`),
          ...issues.range.map((x) => `- [range] ${x}`),
        ].join("\n");
        const retryAbc = responseToPartAbc(await callAnthropic({
          prompt: `${prompt}

YOUR PREVIOUS ATTEMPT HAD ERRORS, detected by automated checks. Fix EVERY one of them while keeping the rest of your writing:
${fixList}
${issues.range.length ? "\nRange errors are notes a real player physically cannot play — move that whole passage up or down an octave (or revoice the chord) so it fits the PLAYABLE RANGE; never just clip single notes." : ""}
${issues.bars.length ? `\nBar-length errors mean those measures hold the wrong number of beats, which drags this part out of time with every other instrument. Re-count each flagged bar: in L:1/8 units a plain letter = 1 (eighth), C2 = 2 (quarter), C3 = 3 (dotted quarter), C4 = 4 (half), C6 = 6 (dotted half), C8 = 8 (whole). Every bar must total exactly ${barUnitsFor(p.timeSignature)}. Fix the rhythm inside the bar — do NOT just delete notes to make the count work.` : ""}
Return THIS SECTION again as the same JSON object (exactly ${n} measure strings, piece measures ${start}-${end}), nothing else.`,
          maxTokens: tokensForMeasures(n),
        }), header);
        const second = check(retryAbc);
        if (isBetterAttempt(second, issues)) {
          abcChunk = retryAbc;
          issues = second;
        }
      } catch {
        // retry failed — keep the first attempt
      }
    }

    // Exact-length guarantee per section: pad a short section with explicit
    // whole-measure rests (trim an overrun) so every later section still
    // lands on its correct piece measures and the notation stays honest.
    const got = partMeasures(abcChunk);
    if (got.length !== n) {
      const fitted = fitMeasureCount(got, n, p.timeSignature);
      structureWarnings.push(
        fitted.padded
          ? `measures ${start}-${end}: the section stopped ${fitted.padded} measure(s) early, so the gap is written as rests (Regenerate for a full take)`
          : `measures ${start}-${end}: the section ran ${fitted.trimmed} measure(s) long and was trimmed to fit`,
      );
      console.warn(`[part:${p.instrName}] section ${start}-${end} length fix: ${got.length} → ${n} measures`);
      stitched.push(...fitted.measures);
    } else {
      stitched.push(...got);
    }
  }

  // Deterministic last resort on the assembled part: octave-correct anything
  // still out of range, then derive the final warning lists from the ABC that
  // actually ships (per-chunk problems may have been fixed along the way).
  let abc = `${header}\n${stitchBody(stitched)}`;
  // Melody phrases to a playable octave first, whole (as the single-call path).
  const placed = placeMelodyPhrases(abc, p.instrName, sections);
  if (placed.changes.length) {
    abc = placed.abc;
    console.log(`[part:${p.instrName}] melody placed: ${placed.changes.join("; ")}`);
  }
  const enforced = enforceRange(abc, p.instrName);
  if (enforced.changed) {
    abc = enforced.abc;
    console.log(`[part:${p.instrName}] range auto-fix: ${enforced.changes.join("; ")}`);
  }

  // Bar-length repair across the whole assembled part (piece numbering), on
  // the same asymmetric terms as the non-chunked path: accompaniment bars are
  // fitted to the meter, melody bars are reported rather than rewritten.
  const barFix = repairPartBars({
    measures: partMeasures(abc),
    timeSignature: p.timeSignature,
    melodySet: melodyMeasureSet(sections),
  });
  if (barFix.repaired.length > 0) {
    abc = `${headerOf(abc)}\n${stitchBody(barFix.measures)}`;
    console.warn(`[part:${p.instrName}] bar-length auto-fix: ${barFix.repaired.join("; ")}`);
  }

  const melodyProblems = p.melodyAbc && sections.length > 0
    ? checkPartMelody(abc, melodyRef.abc, sections, 0, p.timeSignature, melodyRef.fifths, writtenFifths).problems
    : [];
  const rangeProblems = checkPartRange(abc, p.instrName).problems;

  const chunkRepairNote = barRepairNote(barFix.repaired);
  const allMelody = [
    ...structureWarnings,
    ...(chunkRepairNote ? [chunkRepairNote] : []),
    ...barFix.unrepairable,
    ...melodyProblems,
  ];
  const harmony = harmonyFor(abc, p, sections, concertFifths, writtenFifths);
  return {
    abc,
    melodyWarnings: allMelody.length ? allMelody : undefined,
    rangeWarnings: rangeProblems.length ? rangeProblems : undefined,
    adjustments: placed.changes.length ? placed.changes : undefined,
    harmonyWarnings: harmony.length ? harmony : undefined,
  };
}


app.listen(PORT, () => {
  console.log(`OrchestraAI proxy on http://localhost:${PORT}  (model: ${MODEL}, key: ${ANTHROPIC_API_KEY ? "set" : "MISSING"})`);
});
