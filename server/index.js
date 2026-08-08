import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import {
  PORT, MODEL, RETRIEVAL_MODEL, ANTHROPIC_API_KEY, FRONTEND_ORIGIN, tokensForMeasures,
} from "./config.js";
import { callAnthropic, extractJson } from "./anthropic.js";
import {
  buildSearchPrompt, buildBlueprintPrompt, buildPartPrompt, buildMelodyCheckPrompt,
  buildGroundTruthPrompt, buildPartCorrectionPrompt, resolveTransposition,
} from "./prompts.js";
// analyzeMelody comes from abcValidate.js (not abcMelody.js) because it's the
// anacrusis-aware version — the old one flagged pickup tunes (Happy Birthday,
// most hymns) as broken and burned correction calls fixing bars that were fine.
import { analyzeMelody, checkPartAgainstMelody } from "./lib/abcValidate.js";
import { ALLOWED_MEASURES, MAX_INSTRUMENTS, isValidMeasures } from "./lib/limits.js";

const app = express();

// Behind a platform proxy (Render/Railway/Vercel) every request otherwise looks
// like it comes from the proxy's IP, so the rate limiter below either buckets
// every user together or throws. Must be set before the limiter is mounted.
app.set("trust proxy", 1);

// Body size cap so a stranger can't post a giant payload (Phase 2 hardening).
app.use(express.json({ limit: "64kb" }));
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: MODEL, hasKey: Boolean(ANTHROPIC_API_KEY) });
});

// ── Song search ──────────────────────────────────────────────────────────────
app.post("/api/search", handler(async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) throw Object.assign(new Error("query is required"), { status: 400 });

  const text = await callAnthropic({
    prompt: buildSearchPrompt(query),
    maxTokens: 2000,
    webSearch: true,
    maxSearches: 3,
    model: RETRIEVAL_MODEL, // formatting/retrieval, not composition — no need for Opus
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

// Ground truth is identical for every user and never changes — cache it by
// title|artist for the life of the process instead of re-researching the same
// song (and re-spending the web-search budget) on every arrangement request.
const groundTruthCache = new Map();
const groundTruthKey = (p) => `${String(p.songTitle || "").trim().toLowerCase()}|${String(p.songArtist || "").trim().toLowerCase()}`;

// Fetch documented song data (key, per-section chords, structure, melody facts)
// via web search. Returns null when nothing reliable was found or the call fails —
// callers must treat null as "fall back to model memory".
async function lookupGroundTruth(p) {
  const key = groundTruthKey(p);
  if (groundTruthCache.has(key)) {
    console.log(`[ground-truth] cache hit for "${p.songTitle}"`);
    return groundTruthCache.get(key);
  }
  try {
    const text = await callAnthropic({
      prompt: buildGroundTruthPrompt(p),
      maxTokens: 3000,
      webSearch: true,
      maxSearches: 5,
      model: RETRIEVAL_MODEL, // formatting/retrieval, not composition — no need for Opus
    });
    const gt = extractJson(text);
    if (!gt || gt.found === false) {
      console.log(`[ground-truth] no reliable data for "${p.songTitle}"`);
      groundTruthCache.set(key, null);
      return null;
    }
    console.log(`[ground-truth] "${p.songTitle}": key=${gt.key} conf=${gt.confidence} sources=${(gt.sources || []).length}`);
    groundTruthCache.set(key, gt);
    return gt;
  } catch (err) {
    console.warn(`[ground-truth] lookup failed for "${p.songTitle}":`, err.message);
    return null; // not cached — a transient failure shouldn't poison future lookups
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
  if (!isValidMeasures(p.measures)) {
    throw Object.assign(new Error(`measures must be one of: ${ALLOWED_MEASURES.join(", ")}`), { status: 400 });
  }
  const measures = Number(p.measures);
  let abc = cleanAbc(await callAnthropic({
    prompt: buildPartPrompt({ ...p, measures }),
    maxTokens: tokensForMeasures(measures),
  }));

  // If the model returned prose with no X: header, cleanAbc passes it through
  // unchanged and the renderer would silently show an empty box — catch that
  // here and return a real error instead.
  if (!/^X:\d/.test(abc.trim())) {
    throw Object.assign(new Error("The model did not return valid ABC notation for this part."), { status: 502 });
  }
  const measureCountProblem = analyzeMelody(stripAbcHeaders(abc), p.timeSignature, measures)
    .problems.some((msg) => /must have exactly/.test(msg));
  if (measureCountProblem) {
    throw Object.assign(new Error(`Generated part has the wrong number of measures (expected ${measures}).`), { status: 502 });
  }

  // Verify the part actually reproduces the canonical melody in the measures it
  // was assigned to carry it — bar math alone can't catch a wrong-but-well-formed
  // tune. One targeted retry naming the exact failing measures if it doesn't.
  let conformance = null;
  const melodySections = p.role?.melodySections || [];
  if (melodySections.length > 0 && p.melodyAbc) {
    const { concertKey, writtenKey, transposes, transposeSpec } = resolveTransposition(p.key, p.instrName);
    const checkArgs = {
      melodyAbc: p.melodyAbc,
      melodySections,
      concertKey,
      transposition: transposes && transposeSpec
        ? { diatonic: transposeSpec.diatonic, semitones: transposeSpec.semitones, writtenKey }
        : null,
      timeSignature: p.timeSignature,
    };
    conformance = checkPartAgainstMelody(abc, checkArgs);

    if (!conformance.ok) {
      try {
        const retryAbc = cleanAbc(await callAnthropic({
          prompt: buildPartCorrectionPrompt({
            instrName: p.instrName, writtenKey, previousAbc: abc, mismatches: conformance.mismatches,
          }),
          maxTokens: tokensForMeasures(measures),
        }));
        const retryConformance = checkPartAgainstMelody(retryAbc, checkArgs);
        if ((retryConformance.accuracy ?? -1) >= (conformance.accuracy ?? -1)) {
          abc = retryAbc;
          conformance = retryConformance;
        }
      } catch {
        // network/model error on the retry — keep the original part + its conformance result
      }
    }
  }

  res.json({ abc, conformance });
}));

// Strip any stray fences/prose before the leading X: header.
function cleanAbc(text) {
  let t = (text || "").replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
  const idx = t.indexOf("X:");
  if (idx > 0) t = t.slice(idx);
  return t;
}

// Drop ABC header lines (X:/T:/K:/…) so what's left is pure note text, ready
// for analyzeMelody. Same filter checkPartAgainstMelody uses internally.
function stripAbcHeaders(abc) {
  return String(abc).split(/\r?\n/).filter((l) => l.trim() && !/^[A-Za-z]:/.test(l) && !/^%%/.test(l)).join(" ");
}

app.listen(PORT, () => {
  console.log(`OrchestraAI proxy on http://localhost:${PORT}  (model: ${MODEL}, key: ${ANTHROPIC_API_KEY ? "set" : "MISSING"})`);
});
