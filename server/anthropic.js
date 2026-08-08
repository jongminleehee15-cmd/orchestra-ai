import {
  ANTHROPIC_API_KEY, ANTHROPIC_URL, ANTHROPIC_VERSION, MODEL,
} from "./config.js";

// Single place that talks to the Anthropic Messages API. Adds the headers the
// artifact runtime omitted (x-api-key, anthropic-version) and returns the
// concatenated text of the response.
//
// webSearch: true enables the Anthropic server-side web_search tool so the
// model can look up real song data (chords, key, structure) instead of relying
// on memory. Server tools may return stop_reason "pause_turn" mid-loop — the
// API expects us to echo the assistant turn back and re-request to resume.
export async function callAnthropic({ prompt, maxTokens, webSearch = false, maxSearches = 5, model = MODEL }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("Server is missing ANTHROPIC_API_KEY. Set it in server/.env.");
    err.status = 500;
    err.code = "NO_API_KEY";
    throw err;
  }

  const messages = [{ role: "user", content: prompt }];
  const tools = webSearch
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }]
    : undefined;

  let text = "";
  for (let turn = 0; turn < 6; turn++) {
    const data = await postMessages({ messages, maxTokens, tools, model });
    text += (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }
  return text;
}

async function postMessages({ messages, maxTokens, tools, model }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (tools) body.tools = tools;

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let detail = "";
    try {
      const errBody = await resp.json();
      detail = errBody?.error?.message || JSON.stringify(errBody);
    } catch {
      detail = await resp.text().catch(() => "");
    }
    // If the configured model doesn't support this web_search tool version,
    // degrade gracefully to a plain (memory-only) request instead of failing.
    if (resp.status === 400 && tools && /web_search/i.test(detail)) {
      console.warn("web_search tool rejected by model — retrying without it:", detail);
      return postMessages({ messages, maxTokens, model });
    }
    const err = new Error(`Anthropic API ${resp.status}: ${detail}`);
    err.status = resp.status === 401 ? 500 : 502; // 401 = our key problem
    throw err;
  }

  return resp.json();
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
