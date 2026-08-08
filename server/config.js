import "dotenv/config";

// Central config so the model can be upgraded via env var without code changes.
export const MODEL = process.env.MODEL || "claude-opus-4-8";
// Search and the ground-truth lookup are formatting/retrieval, not composition —
// run them on a cheaper model than the composition calls.
export const RETRIEVAL_MODEL = process.env.RETRIEVAL_MODEL || "claude-sonnet-5";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const PORT = Number(process.env.PORT) || 3001;
// Locks CORS to the deployed frontend so a stranger who finds the backend URL
// can't spend the API budget from a browser. Defaults to the Vite dev origin.
export const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

// Scale max_tokens with measure count so longer scores don't get truncated.
export function tokensForMeasures(m) {
  if (m <= 16) return 1000;
  if (m <= 32) return 2000;
  if (m <= 64) return 4000;
  if (m <= 96) return 6000;
  return 8000;
}
