// Client-side arrangement history — localStorage only, nothing server-side.
// Keeps the last MAX_HISTORY generated arrangements (song + params + the
// generated parts themselves) so a user can flip back without regenerating.

const STORAGE_KEY = "orchestraai:history";
const MAX_HISTORY = 5;

function readRaw() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded or storage unavailable (e.g. private browsing) — history
    // just won't persist across reloads. Not worth surfacing to the user.
  }
}

export function getHistory() {
  return readRaw();
}

export function newHistoryId() {
  return `h_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Insert or update by id, most-recently-touched first, capped at MAX_HISTORY.
export function saveArrangement(entry) {
  const next = [entry, ...readRaw().filter((e) => e.id !== entry.id)].slice(0, MAX_HISTORY);
  writeRaw(next);
  return next;
}

export function deleteArrangement(id) {
  const next = readRaw().filter((e) => e.id !== id);
  writeRaw(next);
  return next;
}

export function clearAllArrangements() {
  writeRaw([]);
  return [];
}

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
