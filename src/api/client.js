// Frontend API client. Talks ONLY to our Express proxy (/api/*) — never to
// api.anthropic.com directly, so the key stays server-side. Prompt construction
// also lives on the server; the client just sends structured params.
//
// In dev, API_BASE is empty and Vite's proxy forwards /api/* to localhost:3001
// same-origin. In production, VITE_API_BASE_URL points at the deployed Render
// backend, so these become real cross-origin requests — that's required for
// the backend's CORS allowlist (FRONTEND_ORIGIN) to actually be enforced by
// the browser; see README "Deployment".
import { fitContext } from "../lib/context.js";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

async function postJson(path, body) {
  const resp = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await resp.json();
  } catch {
    // non-JSON response
  }
  if (!resp.ok) {
    throw new Error(data?.error || `Request failed (${resp.status})`);
  }
  return data;
}

// → array of song objects
export async function searchSongs(query) {
  const { songs } = await postJson("/api/search", { query });
  return songs || [];
}

// → { ok, model, hasKey, importEnabled }. importEnabled is false when
// /api/import is disabled server-side (production, pending abuse-check).
export async function getHealth() {
  const resp = await fetch(API_BASE + "/api/health");
  return resp.json();
}

// → array of public-domain library songs (exact score data, no LLM involved)
export async function getLibrary() {
  const resp = await fetch(API_BASE + "/api/library");
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
  return data?.songs || [];
}

// Upload a MusicXML/MIDI score file; the server converts it once into its
// canonical verified melody form. → song object (source: "import")
export async function importScore(file) {
  const resp = await fetch(`${API_BASE}/api/import?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.error || `Import failed (${resp.status})`);
  return data.song;
}

// → blueprint plan { melodyAbc, chords, sections, instrumentRoles, melodySummary, planWarnings? }
// planWarnings: changes the server made so every measure has exactly one
// melody carrier among the selected instruments.
export async function generateBlueprint(params) {
  const { plan } = await postJson("/api/blueprint", params);
  return plan;
}

// → { abc, melodyWarnings?, rangeWarnings? } for a single instrument part.
//
// `abc` is a complete, header-included ABC tune assembled server-side. The
// server asks the model for bare measures and builds the header itself, so
// raw model output never reaches the browser — this shape is unaffected by
// how generation is prompted.
//
// melodyWarnings: everything the user should know about this part after the
// server's automatic repair pass — not only melody deviations, but also bars
// padded or trimmed to fit the meter, a part padded or trimmed to the
// requested measure count, and melody-carrying bars left wrong on purpose
// rather than rewritten. rangeWarnings: notes still outside the instrument's
// realistic playable range. harmonyWarnings: accompaniment bars whose notes
// mostly don't belong to that bar's chord (informational, never auto-fixed).
// adjustments: what the server changed for the better, e.g. a melody phrase
// moved to an octave the instrument plays comfortably (information only).
//
// contextParts: the parts already finished, so this one is written hearing
// them; trimmed to the server's body budget by fitContext.
export async function generateInstrumentABC(params) {
  const body = { ...params, contextParts: fitContext(params.contextParts) };
  const { abc, melodyWarnings, rangeWarnings, harmonyWarnings, adjustments } = await postJson("/api/part", body);
  return {
    abc,
    melodyWarnings: melodyWarnings || [],
    rangeWarnings: rangeWarnings || [],
    harmonyWarnings: harmonyWarnings || [],
    adjustments: adjustments || [],
  };
}
