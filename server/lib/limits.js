// Server-side input limits. The client already restricts these via UI (measure
// chips, a per-instrument count cap of 16), but nothing enforced them against a
// direct or tampered API call — `Number(p.measures) || 8` accepted 10000, and
// instrument count was unbounded. A 128-measure request with a large instrument
// roster is ~17 Opus calls approaching 100k tokens for one button press.
export const ALLOWED_MEASURES = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
export const MAX_INSTRUMENTS = 16;

export function isValidMeasures(m) {
  return ALLOWED_MEASURES.includes(Number(m));
}

// /api/part carries the parts already written as context. Its body cap is
// larger than every other route's (see index.js), sized for the worst case:
// 15 context parts × 128 bars of decorated ABC. The client trims context to
// CONTEXT_BUDGET characters first (src/lib/context.js), well inside this.
export const PART_BODY_LIMIT = "512kb";
export const MAX_CONTEXT_ABC = 40000; // characters per context part

// Keep only well-formed context entries. A malformed entry is DROPPED, never
// a 400: context is an aid, and losing it must not cost the user the part.
// Returns null when nothing usable is left.
export function sanitizeContextParts(raw, selfName) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const c of raw.slice(0, MAX_INSTRUMENTS)) {
    if (!c || typeof c.instrName !== "string" || typeof c.abc !== "string") continue;
    const name = c.instrName.slice(0, 100);
    if (name === selfName || seen.has(name) || c.abc.length > MAX_CONTEXT_ABC) continue;
    seen.add(name);
    out.push({ instrName: name, abc: c.abc });
  }
  return out.length ? out : null;
}
