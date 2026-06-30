import {
  ANTHROPIC_API_KEY, ANTHROPIC_URL, ANTHROPIC_VERSION, MODEL,
} from "./config.js";

// Single place that talks to the Anthropic Messages API. Adds the headers the
// artifact runtime omitted (x-api-key, anthropic-version) and returns the
// concatenated text of the response.
export async function callAnthropic({ prompt, maxTokens }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("Server is missing ANTHROPIC_API_KEY. Set it in server/.env.");
    err.status = 500;
    err.code = "NO_API_KEY";
    throw err;
  }

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    let detail = "";
    try {
      const body = await resp.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = await resp.text().catch(() => "");
    }
    const err = new Error(`Anthropic API ${resp.status}: ${detail}`);
    err.status = resp.status === 401 ? 500 : 502; // 401 = our key problem
    throw err;
  }

  const data = await resp.json();
  return data.content?.map((b) => b.text || "").join("") || "";
}

// Strip markdown fences and pull the first balanced JSON value out of the model
// output. More forgiving than a bare JSON.parse so a stray prose sentence or
// code fence doesn't blow up the whole request.
export function extractJson(text) {
  let t = (text || "").replace(/```json|```/gi, "").trim();

  // Find the first { or [ and parse from there to the matching close.
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);

  if (start === -1) {
    return JSON.parse(t); // let it throw with the original text
  }

  const candidate = t.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    // Walk back from the end trimming trailing junk until it parses.
    const open = candidate[0];
    const close = open === "{" ? "}" : "]";
    const lastClose = candidate.lastIndexOf(close);
    if (lastClose > 0) {
      return JSON.parse(candidate.slice(0, lastClose + 1));
    }
    throw new Error("Could not parse JSON from model response.");
  }
}
