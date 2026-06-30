import { useState } from "react";
import {
  INSTRUMENT_GROUPS, ALL_INSTRUMENTS, ENSEMBLE_PRESETS, groupColor, genreColor, SERIF,
} from "../lib/constants.js";
import { SecH, NavBtn, inputStyle } from "./ui.jsx";

export default function OrchestraBuilder({
  S, selectedSong, songKey, timeSig, bpm,
  selectedInstrs, setSelectedInstrs, onBack, onNext, onChangeSong,
}) {
  const [instrSearch, setInstrSearch] = useState("");
  const [activeGroup, setActiveGroup] = useState("Strings");

  const addInstr = (name) =>
    setSelectedInstrs((prev) => {
      const ex = prev.find((i) => i.name === name);
      if (ex) return prev.map((i) => (i.name === name ? { ...i, count: Math.min(i.count + 1, 16) } : i));
      return [...prev, { name, count: 1 }];
    });
  const removeInstr = (name) => setSelectedInstrs((prev) => prev.filter((i) => i.name !== name));
  const setCount = (name, v) =>
    setSelectedInstrs((prev) => prev.map((i) => (i.name === name ? { ...i, count: Math.max(1, Math.min(16, parseInt(v) || 1)) } : i)));
  const totalPlayers = () => selectedInstrs.reduce((s, i) => s + i.count, 0);

  const filteredInstrs = instrSearch
    ? ALL_INSTRUMENTS.filter((i) => i.toLowerCase().includes(instrSearch.toLowerCase()))
    : INSTRUMENT_GROUPS[activeGroup] || [];

  return (
    <div style={{ display: "grid", gap: "18px" }}>
      {selectedSong && (
        <div style={{ padding: "14px 18px", background: S.surface, border: `1px solid ${S.border}`, borderRadius: "6px", display: "flex", alignItems: "center", gap: "16px", marginBottom: "4px" }}>
          <div style={{ width: "3px", height: "48px", background: genreColor(selectedSong.genre), borderRadius: "2px", flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "16px", fontWeight: 700, color: S.text }}>
              {selectedSong.title} <span style={{ fontWeight: 400, color: S.muted, fontSize: "14px" }}>— {selectedSong.artist}</span>
            </div>
            <div style={{ fontSize: "12px", color: S.muted, marginTop: "3px" }}>
              {selectedSong.genre} · Key of {songKey} · {timeSig} · {bpm} BPM
            </div>
          </div>
          <button onClick={onChangeSong} style={{ padding: "5px 12px", background: "transparent", border: `1px solid ${S.border}`, color: S.muted, borderRadius: "3px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF }}>
            Change song
          </button>
        </div>
      )}

      <SecH>Ensemble Presets</SecH>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
        {ENSEMBLE_PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => setSelectedInstrs(p.instruments.map((i) => ({ ...i })))}
            style={{ padding: "6px 13px", background: S.surface2, border: `1px solid ${S.border}`, color: S.muted, borderRadius: "3px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF, transition: "all 0.15s" }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = S.gold; e.currentTarget.style.color = S.gold; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = S.border; e.currentTarget.style.color = S.muted; }}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
        <div>
          <SecH>Instrument Browser</SecH>
          <input value={instrSearch} onChange={(e) => setInstrSearch(e.target.value)} placeholder="Search…" style={{ ...inputStyle, marginBottom: "10px", fontSize: "13px" }} />
          {!instrSearch && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: "10px" }}>
              {Object.keys(INSTRUMENT_GROUPS).map((g) => (
                <button
                  key={g}
                  onClick={() => setActiveGroup(g)}
                  style={{
                    padding: "3px 9px", fontSize: "11px", borderRadius: "3px", cursor: "pointer", fontFamily: SERIF,
                    border: `1px solid ${activeGroup === g ? groupColor(g) : S.border}`,
                    background: activeGroup === g ? groupColor(g) + "28" : "transparent",
                    color: activeGroup === g ? groupColor(g) : S.muted, transition: "all 0.15s",
                  }}
                >
                  {g}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: "3px", maxHeight: "240px", overflowY: "auto" }}>
            {filteredInstrs.map((name) => {
              const added = selectedInstrs.find((i) => i.name === name);
              return (
                <button
                  key={name}
                  onClick={() => addInstr(name)}
                  style={{
                    padding: "7px 10px", background: added ? S.gold + "12" : S.surface2,
                    border: `1px solid ${added ? S.goldDim : S.border}`,
                    color: added ? S.gold : S.muted, borderRadius: "3px", cursor: "pointer",
                    textAlign: "left", fontSize: "13px", fontFamily: SERIF, transition: "all 0.15s",
                    display: "flex", justifyContent: "space-between",
                  }}
                >
                  <span>{name}</span>
                  {added ? <span style={{ fontSize: "11px" }}>✓ ×{added.count}</span> : <span style={{ fontSize: "11px", opacity: 0.4 }}>+</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <SecH>
            Your Orchestra {totalPlayers() > 0 && <span style={{ color: S.gold, fontSize: "13px" }}>({totalPlayers()} players)</span>}
          </SecH>
          {selectedInstrs.length === 0 ? (
            <div style={{ padding: "36px 16px", textAlign: "center", border: `1px dashed ${S.border}`, borderRadius: "5px", color: S.muted, fontSize: "13px" }}>
              Select a preset or add instruments
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "5px", maxHeight: "280px", overflowY: "auto" }}>
              {selectedInstrs.map(({ name, count }) => {
                const grp = Object.entries(INSTRUMENT_GROUPS).find(([, v]) => v.includes(name))?.[0];
                return (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", background: S.surface2, borderRadius: "3px", border: `1px solid ${S.border}` }}>
                    <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: groupColor(grp), flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: "13px", color: S.text }}>{name}</span>
                    <input type="number" min={1} max={16} value={count} onChange={(e) => setCount(name, e.target.value)} style={{ ...inputStyle, width: "46px", padding: "3px 6px", textAlign: "center", fontSize: "12px" }} />
                    <button onClick={() => removeInstr(name)} style={{ background: "none", border: "none", color: S.muted, cursor: "pointer", fontSize: "15px", padding: "0 3px" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#d07070")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = S.muted)}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <NavBtn onClick={onBack}>← Search Song</NavBtn>
        <NavBtn onClick={onNext}>Next: Parameters →</NavBtn>
      </div>
    </div>
  );
}
