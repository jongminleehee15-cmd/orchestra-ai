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

// → array of public-domain library songs (exact score data, no LLM involved)
export async function getLibrary() {
  const resp = await fetch("/api/library");
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
  return data?.songs || [];
}

// Upload a MusicXML/MIDI score file; the server converts it once into its
// canonical verified melody form. → song object (source: "import")
export async function importScore(file) {
  const resp = await fetch(`/api/import?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.error || `Import failed (${resp.status})`);
  return data.song;
}

// → blueprint plan { melodyAbc, chords, sections, instrumentRoles, melodySummary }
export async function generateBlueprint(params) {
  const { plan } = await postJson("/api/blueprint", params);
  return plan;
}

// → { abc, melodyWarnings?, rangeWarnings? } for a single instrument part.
// melodyWarnings: spots where the part still deviates from the canonical melody
// after the server's automatic repair pass. rangeWarnings: notes still outside
// the instrument's realistic playable range.
export async function generateInstrumentABC(params) {
  const { abc, melodyWarnings, rangeWarnings } = await postJson("/api/part", params);
  return { abc, melodyWarnings: melodyWarnings || [], rangeWarnings: rangeWarnings || [] };
}
