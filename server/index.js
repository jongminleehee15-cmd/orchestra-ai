import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { PORT, MODEL, ANTHROPIC_API_KEY, tokensForMeasures } from "./config.js";
import { callAnthropic, extractJson } from "./anthropic.js";
import {
  buildSearchPrompt, buildBlueprintPrompt, buildPartPrompt, buildMelodyCheckPrompt,
  buildGroundTruthPrompt, buildLibraryBlueprintPrompt,
} from "./prompts.js";
import { analyzeMelody } from "./lib/abcMelody.js";
import { loadLibrary, getWork, searchLibrary, workToSong } from "./lib/library.js";
import { checkPartMelody } from "./lib/partCheck.js";

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
  const prompt = buildPartPrompt({ ...p, measures });
  let abc = cleanAbc(await callAnthropic({ prompt, maxTokens: tokensForMeasures(measures) }));

  // Arrangement accuracy: in the measures this part carries the melody it must
  // reproduce the canonical tune (rhythm exactly; contour exactly — the check
  // is transposition-invariant, so Bb/F/Eb parts and octave shifts pass). One
  // repair attempt with the precise diffs; keep whichever version is cleaner.
  const melodySections = p.role?.melodySections || [];
  let warnings = [];
  if (p.melodyAbc && melodySections.length > 0) {
    const first = checkPartMelody(abc, p.melodyAbc, melodySections);
    if (!first.ok) {
      console.warn(`[part:${p.instrName}] melody check failed (${first.problems.length}):\n  ${first.problems.join("\n  ")}`);
      try {
        const retryAbc = cleanAbc(await callAnthropic({
          prompt: `${prompt}

YOUR PREVIOUS ATTEMPT GOT THE MELODY WRONG. These exact problems were detected by comparing your output against the canonical melody — fix EVERY one of them while keeping the rest of your arrangement:
- ${first.problems.join("\n- ")}

Output the FULL corrected ABC part again, raw ABC only.`,
          maxTokens: tokensForMeasures(measures),
        }));
        const second = checkPartMelody(retryAbc, p.melodyAbc, melodySections);
        if (second.problems.length < first.problems.length) {
          abc = retryAbc;
          warnings = second.problems;
        } else {
          warnings = first.problems;
        }
      } catch {
        warnings = first.problems; // retry failed — keep first attempt
      }
      if (warnings.length > 0) {
        console.warn(`[part:${p.instrName}] still ${warnings.length} melody problem(s) after repair`);
      }
    }
  }

  res.json({ abc, melodyWarnings: warnings.length ? warnings : undefined });
}));

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
