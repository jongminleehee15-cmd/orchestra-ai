// The parts already finished, sent with each /api/part request so the next
// part is written hearing them (see server/lib/ensemble.js).
//
// The server caps /api/part bodies at 512kb (server/lib/limits.js). Context
// over this budget is dropped from the END rather than letting the request
// fail with a 413: losing some context must never cost the user the part.
export const CONTEXT_BUDGET = 400_000; // characters of serialized context

export function fitContext(contextParts, budget = CONTEXT_BUDGET) {
  const out = [...(contextParts || [])];
  while (out.length > 0 && JSON.stringify(out).length > budget) out.pop();
  return out;
}
