import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { PORT, MODEL, ANTHROPIC_API_KEY, tokensForMeasures } from "./config.js";
import { callAnthropic, extractJson } from "./anthropic.js";
import {
  buildSearchPrompt, buildBlueprintPrompt, buildPartPrompt, buildMelodyCheckPrompt,
  buildGroundTruthPrompt, buildLibraryBlueprintPrompt,
} from "./prompts.js";
import { analyzeMelody, splitMelodyIntoMeasures } from "./lib/abcMelody.js";
import { loadLibrary, getWork, searchLibrary, workToSong } from "./lib/library.js";
import { checkPartMelody, partMeasures } from "./lib/partCheck.js";
import { checkPartRange, enforceRange } from "./lib/ranges.js";
import { CHUNK_THRESHOLD, chunkRanges, intersectSections, headerOf, stitchBody } from "./lib/chunking.js";

const app = express();

// Body size cap so a stranger can't post a giant payload (Phase 2 hardening).
app.use(express.json({ limit: "64kb" }));
app.use(cors());

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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL, hasKey: Boolean(ANTHROPIC_API_KEY) });
});

// ── Public-domain score library ──────────────────────────────────────────────
// Real symbolic melody data — the accuracy-first path. See server/lib/library.js.
app.get("/api/library", (req, res) => {
  res.json({ songs: loadLibrary().map(workToSong) });
});

// ── Song search ──────────────────────────────────────────────────────────────
// Library matches (exact score data) come back instantly and skip the LLM
// entirely; only unknown songs fall through to the model + web search.
app.post("/api/search", handler(async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) throw Object.assign(new Error("query is required"), { status: 400 });

  const libraryHits = searchLibrary(query).map(workToSong);
  if (libraryHits.length > 0) {
    res.json({ songs: libraryHits });
    return;
  }

  const text = await callAnthropic({
    prompt: buildSearchPrompt(query),
    maxTokens: 2000,
    webSearch: true,
    maxSearches: 3,
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
  const measures = Number(p.measures) || 8;

  // Library path: the melody is REAL symbolic data — use it verbatim. The LLM
  // only plans orchestration; no melody generation, no refine pass, no web
  // lookup. This is the accuracy-first pipeline for public-domain works.
  if (p.libraryId) {
    const work = getWork(p.libraryId);
    if (!work) throw Object.assign(new Error(`unknown library work: ${p.libraryId}`), { status: 404 });

    // Use the requested length if the work is long enough, else the full work.
    const useMeasures = Math.min(measures, work.measures);
    const melodyMeasures = work.melodyMeasures.slice(0, useMeasures);
    const melodyAbc = `${melodyMeasures.join(" | ")} |]`;
    const chords = work.chords.slice(0, useMeasures);

    const text = await callAnthropic({
      prompt: buildLibraryBlueprintPrompt({
        songTitle: work.title, songArtist: work.composer, songGenre: work.genre,
        instruments: p.instruments, style: p.style, density: p.density,
        key: work.key, timeSignature: work.timeSignature, bpm: p.bpm || work.bpm,
        measures: useMeasures, melodyAbc, chords,
      }),
      maxTokens: 2500,
    });
    const plan = extractJson(text) || {};
    // The melody is never the model's to change — overwrite unconditionally.
    plan.melodyAbc = melodyAbc;
    plan.chords = chords;
    plan.source = "library";
    plan.libraryId = work.id;
    plan.key = work.key;
    plan.timeSignature = work.timeSignature;
    plan.measures = useMeasures;
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
  res.json({ plan });
}));

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
  const p = req.body || {};
  if (!p.instrName) throw Object.assign(new Error("instrName is required"), { status: 400 });
  const measures = Number(p.measures) || 8;

  // Long parts degrade in a single call (a 64-bar request came back with 12) —
  // above the threshold, write the part in validated ~16-measure sections.
  if (measures > CHUNK_THRESHOLD) {
    res.json(await generatePartChunked(p, measures));
    return;
  }

  const prompt = buildPartPrompt({ ...p, measures });
  let abc = cleanAbc(await callAnthropic({ prompt, maxTokens: tokensForMeasures(measures) }));

  // Arrangement accuracy: in the measures this part carries the melody it must
  // reproduce the canonical tune (rhythm exactly; contour exactly — the check
  // is transposition-invariant, so Bb/F/Eb parts and octave shifts pass), and
  // EVERY note must sit inside the instrument's realistic written range. One
  // repair attempt with the precise diffs; keep whichever version is cleaner.
  const melodySections = p.role?.melodySections || [];
  const checkAll = (candidate) => {
    const melody = p.melodyAbc && melodySections.length > 0
      ? checkPartMelody(candidate, p.melodyAbc, melodySections)
      : { problems: [] };
    const range = checkPartRange(candidate, p.instrName);
    return { melody: melody.problems, range: range.problems, total: melody.problems.length + range.problems.length };
  };

  let issues = checkAll(abc);
  if (issues.total > 0) {
    console.warn(`[part:${p.instrName}] checks failed (${issues.melody.length} melody, ${issues.range.length} range):\n  ${[...issues.melody, ...issues.range].join("\n  ")}`);
    try {
      const fixList = [
        ...issues.melody.map((x) => `- [melody] ${x}`),
        ...issues.range.map((x) => `- [range] ${x}`),
      ].join("\n");
      const retryAbc = cleanAbc(await callAnthropic({
        prompt: `${prompt}

YOUR PREVIOUS ATTEMPT HAD ERRORS, detected by automated checks against the canonical melody and the instrument's real playable range. Fix EVERY one of them while keeping the rest of your arrangement:
${fixList}
${issues.range.length ? "\nRange errors are notes a real player physically cannot play — move that whole passage up or down an octave (or revoice the chord) so it fits the PLAYABLE RANGE; never just clip single notes." : ""}
Output the FULL corrected ABC part again, raw ABC only.`,
        maxTokens: tokensForMeasures(measures),
      }));
      const second = checkAll(retryAbc);
      if (second.total < issues.total) {
        abc = retryAbc;
        issues = second;
      }
    } catch {
      // retry failed — keep first attempt and its warnings
    }
    if (issues.total > 0) {
      console.warn(`[part:${p.instrName}] still ${issues.melody.length} melody / ${issues.range.length} range problem(s) after repair`);
    }
  }

  // Deterministic last resort: the prompt + retry can still ship unplayable
  // notes (seen live: flute/oboe below their floor) — octave-correct them.
  const enforced = enforceRange(abc, p.instrName);
  if (enforced.changed) {
    abc = enforced.abc;
    console.log(`[part:${p.instrName}] range auto-fix: ${enforced.changes.join("; ")}`);
    issues = checkAll(abc); // recompute warnings on the corrected part
  }

  res.json({
    abc,
    melodyWarnings: issues.melody.length ? issues.melody : undefined,
    rangeWarnings: issues.range.length ? issues.range : undefined,
  });
}));

// Chunked generation for long parts: one model call per ~16-measure section,
// each validated (measure count + melody + range) and repaired individually,
// then stitched into a single part. Every call keeps the FULL musical context
// (whole melody, all chords, role) plus the previous section's tail, so the
// result stays one coherent line rather than disjoint fragments.
async function generatePartChunked(p, measures) {
  const sections = p.role?.melodySections || [];
  const canonical = p.melodyAbc ? splitMelodyIntoMeasures(p.melodyAbc) : [];
  const stitched = [];
  let header = null;
  let melodyWarnings = [];
  let rangeWarnings = [];
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
        ? checkPartMelody(candidate, chunkMelody, localSections, offset).problems
        : [];
      const range = checkPartRange(candidate, p.instrName, offset).problems;
      return { structure, melody, range, total: structure.length + melody.length + range.length };
    };

    let abcChunk = cleanAbc(await callAnthropic({ prompt, maxTokens: tokensForMeasures(n) }));
    let issues = check(abcChunk);
    if (issues.total > 0) {
      console.warn(`[part:${p.instrName}] section ${start}-${end} checks failed (${issues.structure.length} structure, ${issues.melody.length} melody, ${issues.range.length} range)`);
      try {
        const fixList = [
          ...issues.structure.map((x) => `- [structure] ${x}`),
          ...issues.melody.map((x) => `- [melody] ${x}`),
          ...issues.range.map((x) => `- [range] ${x}`),
        ].join("\n");
        const retryAbc = cleanAbc(await callAnthropic({
          prompt: `${prompt}

YOUR PREVIOUS ATTEMPT HAD ERRORS, detected by automated checks. Fix EVERY one of them while keeping the rest of your writing:
${fixList}
${issues.range.length ? "\nRange errors are notes a real player physically cannot play — move that whole passage up or down an octave (or revoice the chord) so it fits the PLAYABLE RANGE; never just clip single notes." : ""}
Output the FULL corrected ABC for THIS SECTION again (exactly measures ${start}-${end}), raw ABC only.`,
          maxTokens: tokensForMeasures(n),
        }));
        const second = check(retryAbc);
        if (second.total < issues.total) {
          abcChunk = retryAbc;
          issues = second;
        }
      } catch {
        // retry failed — keep the first attempt
      }
    }

    // A wrong-length section would shift every later measure number — surface
    // it loudly (melodyWarnings is the "arrangement problems" channel in the UI).
    if (issues.structure.length) structureWarnings.push(`measures ${start}-${end}: ${issues.structure[0]}`);
    melodyWarnings.push(...issues.melody);
    rangeWarnings.push(...issues.range);

    if (!header) header = headerOf(abcChunk);
    stitched.push(...partMeasures(abcChunk));
  }

  // Deterministic last resort on the assembled part: octave-correct anything
  // still out of range, then re-derive the warning lists from the final ABC.
  let abc = `${header}\n${stitchBody(stitched)}`;
  const enforced = enforceRange(abc, p.instrName);
  if (enforced.changed) {
    abc = enforced.abc;
    console.log(`[part:${p.instrName}] range auto-fix: ${enforced.changes.join("; ")}`);
    rangeWarnings = checkPartRange(abc, p.instrName).problems;
    melodyWarnings = p.melodyAbc && sections.length > 0
      ? checkPartMelody(abc, p.melodyAbc, sections).problems
      : [];
  }

  const allMelody = [...structureWarnings, ...melodyWarnings];
  return {
    abc,
    melodyWarnings: allMelody.length ? allMelody : undefined,
    rangeWarnings: rangeWarnings.length ? rangeWarnings : undefined,
  };
}

// Strip any stray fences/prose before the leading X: header.
function cleanAbc(text) {
  let t = (text || "").replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
  const idx = t.indexOf("X:");
  if (idx > 0) t = t.slice(idx);
  return t;
}

app.listen(PORT, () => {
  console.log(`OrchestraAI proxy on http://localhost:${PORT}  (model: ${MODEL}, key: ${ANTHROPIC_API_KEY ? "set" : "MISSING"})`);
});
