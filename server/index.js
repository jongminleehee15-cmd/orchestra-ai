import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { PORT, MODEL, ANTHROPIC_API_KEY, tokensForMeasures } from "./config.js";
import { callAnthropic, extractJson } from "./anthropic.js";
import {
  buildSearchPrompt, buildBlueprintPrompt, buildPartPrompt,
} from "./prompts.js";

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

// ── Song search ──────────────────────────────────────────────────────────────
app.post("/api/search", handler(async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) throw Object.assign(new Error("query is required"), { status: 400 });

  const text = await callAnthropic({ prompt: buildSearchPrompt(query), maxTokens: 1000 });
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
  const text = await callAnthropic({
    prompt: buildBlueprintPrompt({ ...p, measures }),
    maxTokens: Math.min(8000, 2500 + measures * 30),
  });
  const plan = extractJson(text);
  res.json({ plan });
}));

// ── Single instrument part ───────────────────────────────────────────────────
app.post("/api/part", handler(async (req, res) => {
  const p = req.body || {};
  if (!p.instrName) throw Object.assign(new Error("instrName is required"), { status: 400 });
  const measures = Number(p.measures) || 8;
  const abc = await callAnthropic({
    prompt: buildPartPrompt({ ...p, measures }),
    maxTokens: tokensForMeasures(measures),
  });
  res.json({ abc: cleanAbc(abc) });
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
