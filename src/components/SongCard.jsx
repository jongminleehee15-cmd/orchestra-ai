import { useState } from "react";
import { genreColor, SERIF } from "../lib/constants.js";

export default function SongCard({ song, onSelect, S }) {
  const [hovered, setHovered] = useState(false);
  const gc = genreColor(song.genre);

  return (
    <div
      onClick={() => onSelect(song)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "16px 18px", borderRadius: "6px", cursor: "pointer",
        background: hovered ? S.surface2 : S.surface,
        border: `1px solid ${hovered ? S.gold + "60" : S.border}`,
        transition: "all 0.2s", position: "relative", overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", top: 0, left: 0, width: "3px", height: "100%", background: gc, borderRadius: "6px 0 0 6px" }} />

      <div style={{ paddingLeft: "8px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", marginBottom: "3px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: hovered ? S.gold : S.text, fontFamily: SERIF, transition: "color 0.2s", lineHeight: 1.2 }}>{song.title}</h3>
          {song.year && <span style={{ fontSize: "11px", color: S.muted, flexShrink: 0 }}>{song.year}</span>}
        </div>

        <p style={{ margin: "0 0 8px", fontSize: "13px", color: S.muted, fontStyle: "italic" }}>{song.artist}</p>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", letterSpacing: "0.04em", background: gc + "22", color: gc, border: `1px solid ${gc}44` }}>{song.genre}</span>
          {song.source === "library" && (
            <span
              title="Melody comes verbatim from a real public-domain score. Never reconstructed by AI."
              style={{ display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", letterSpacing: "0.04em", background: "#4a8a5a22", color: "#7fc491", border: "1px solid #4a8a5a55" }}
            >
              ✓ Exact score
            </span>
          )}
          {song.source === "import" && song.format === "midi" ? (
            <span
              title="Melody guessed from your uploaded MIDI by highest-note extraction. Reliable for simple, clearly voice-led tunes, but can mistake accompaniment or arpeggios for the melody in denser pieces. Spot-check it in the melody editor before trusting."
              style={{ display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", letterSpacing: "0.04em", background: "#a8842a22", color: "#c8a050", border: "1px solid #a8842a55" }}
            >
              ♪ MIDI-derived (verify)
            </span>
          ) : song.source === "import" && (
            <span
              title="Melody taken note-for-note from your uploaded MusicXML score. Never reconstructed by AI."
              style={{ display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", letterSpacing: "0.04em", background: "#4a8a5a22", color: "#7fc491", border: "1px solid #4a8a5a55" }}
            >
              ✓ Imported score
            </span>
          )}
          {song.source === "corpus" && (
            <span
              title="Melody converted note-for-note from an engraved public-domain MusicXML score and validated. Not reconstructed by AI."
              style={{ display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", letterSpacing: "0.04em", background: "#4a7a9a22", color: "#7fb4d4", border: "1px solid #4a7a9a55" }}
            >
              ✓ MusicXML score
            </span>
          )}
          {song.source === "hymnal" && (
            <span
              title="Melody converted note-for-note from a public-domain hymn score (Open Hymnal Project) and validated. Not reconstructed by AI."
              style={{ display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", letterSpacing: "0.04em", background: "#4a7a9a22", color: "#7fb4d4", border: "1px solid #4a7a9a55" }}
            >
              ✓ Verified hymn score
            </span>
          )}
          {!song.source && (
            <span
              title="No score data was found for this song. The melody will be reconstructed by AI from memory and may differ from the original. You can correct it afterwards in the melody editor."
              style={{ display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", letterSpacing: "0.04em", background: "#a8842a22", color: "#c8a050", border: "1px solid #a8842a55" }}
            >
              ≈ AI-recalled melody
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
          {[
            ["♩", song.key],
            ["𝄴", song.timeSignature],
            ["♩=", `${song.bpm} bpm`],
          ].map(([icon, val]) => (
            <span key={icon} style={{ fontSize: "11px", color: S.muted, background: S.surface2, border: `1px solid ${S.border}`, padding: "2px 8px", borderRadius: "3px" }}>
              <span style={{ color: S.goldDim, marginRight: "3px" }}>{icon}</span>
              {val}
            </span>
          ))}
        </div>

        {song.mood && <p style={{ margin: "0 0 8px", fontSize: "12px", color: S.muted, fontStyle: "italic" }}>"{song.mood}"</p>}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <span style={{ fontSize: "12px", color: hovered ? S.gold : S.muted + "80", transition: "color 0.2s", letterSpacing: "0.06em" }}>
            {hovered ? "✦ Select this song" : "click to select"}
          </span>
        </div>
      </div>
    </div>
  );
}
