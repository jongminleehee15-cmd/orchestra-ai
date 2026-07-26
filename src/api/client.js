// Frontend API client. Talks ONLY to our Express proxy (/api/*) — never to
// api.anthropic.com directly, so the key stays server-side. Prompt construction
// also lives on the server; the client just sends structured params.

async function postJson(path, body) {
  const resp = await fetch(path, {
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

// → blueprint plan { melodyAbc, chords, sections, instrumentRoles, melodySummary }
export async function generateBlueprint(params) {
  const { plan } = await postJson("/api/blueprint", params);
  return plan;
}

// → { abc, conformance } for a single instrument part. conformance is null when
// the part carries no melody sections; otherwise { ok, checked, accuracy, mismatches }.
export async function generateInstrumentABC(params) {
  const { abc, conformance } = await postJson("/api/part", params);
  return { abc, conformance };
}
