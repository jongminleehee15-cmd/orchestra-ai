import { useEffect, useRef, useState } from "react";
import { searchSongs } from "../api/client.js";
import { SERIF } from "../lib/constants.js";
import SongCard from "./SongCard.jsx";

const SUGGESTIONS = [
  "Beethoven Moonlight Sonata", "Hey Jude Beatles", "Clair de Lune", "Bohemian Rhapsody",
  "Take Five Brubeck", "Autumn Leaves jazz", "Canon in D", "Für Elise",
];

export default function SongSearchPanel({ onSelect, S }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function doSearch() {
    if (!query.trim()) return;
    setLoading(true); setErr(null); setSearched(false); setResults([]);
    try {
      const songs = await searchSongs(query.trim());
      setResults(songs);
      setSearched(true);
    } catch (e) {
      setErr(e.message || "Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const handleKey = (e) => { if (e.key === "Enter") doSearch(); };

  return (
    <div>
      <div style={{ marginBottom: "28px" }}>
        <div style={{ position: "relative", display: "flex", gap: "0" }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search for any song, composer, or artist…"
            style={{
              flex: 1, padding: "16px 20px", fontSize: "16px",
              background: S.surface2, border: `1px solid ${S.border}`,
              borderRight: "none", color: S.text, outline: "none",
              borderRadius: "6px 0 0 6px", fontFamily: SERIF, letterSpacing: "0.02em",
            }}
          />
          <button
            onClick={doSearch}
            disabled={loading}
            style={{
              padding: "16px 28px", background: loading ? S.goldDim : S.gold,
              border: "none", borderRadius: "0 6px 6px 0", cursor: loading ? "not-allowed" : "pointer",
              color: "#140f08", fontSize: "15px", fontWeight: 700,
              fontFamily: SERIF, letterSpacing: "0.05em", transition: "all 0.2s", minWidth: "100px",
            }}
          >
            {loading ? "⏳" : "Search"}
          </button>
        </div>

        {!searched && !loading && (
          <div style={{ marginTop: "14px" }}>
            <p style={{ margin: "0 0 8px", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", color: S.muted }}>Try searching for</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setQuery(s)}
                  style={{
                    padding: "5px 12px", background: S.surface2, border: `1px solid ${S.border}`,
                    color: S.muted, borderRadius: "20px", cursor: "pointer", fontSize: "12px",
                    fontFamily: SERIF, transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = S.gold; e.currentTarget.style.color = S.gold; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = S.border; e.currentTarget.style.color = S.muted; }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {err && (
        <div style={{ padding: "12px", background: "rgba(200,80,80,0.1)", border: "1px solid rgba(200,80,80,0.25)", borderRadius: "5px", color: "#d47878", fontSize: "13px", marginBottom: "16px" }}>
          {err}
        </div>
      )}

      {loading && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} style={{ height: "120px", background: S.surface, borderRadius: "6px", border: `1px solid ${S.border}`, animation: "pulse 1.2s ease-in-out infinite" }} />
          ))}
        </div>
      )}

      {!loading && results.length > 0 && (
        <div>
          <p style={{ margin: "0 0 14px", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", color: S.muted }}>
            {results.length} results for "{query}"
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            {results.map((song, i) => (
              <SongCard key={i} song={song} onSelect={onSelect} S={S} />
            ))}
          </div>
        </div>
      )}

      {!loading && searched && results.length === 0 && (
        <div style={{ padding: "40px", textAlign: "center", color: S.muted, fontSize: "14px" }}>
          No results found for "{query}". Try a different search.
        </div>
      )}
    </div>
  );
}
