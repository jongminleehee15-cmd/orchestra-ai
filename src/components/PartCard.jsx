import { INSTRUMENT_GROUPS, groupColor, SERIF } from "../lib/constants.js";
import AbcRenderer from "./AbcRenderer.jsx";

const STATUS_COLOR = { idle: "#9a8868", loading: "#c8a050", done: "#6ab898", error: "#d47878" };
const STATUS_ICON = { idle: "○", loading: "⏳", done: "✓", error: "⚠" };

export default function PartCard({ part, idx, isActive, role, S, onSelect, onGenerate }) {
  const grp = Object.entries(INSTRUMENT_GROUPS).find(([, v]) => v.includes(part.baseName || part.instrName))?.[0];
  const col = groupColor(grp);
  const statusColor = STATUS_COLOR[part.status];
  const statusIcon = STATUS_ICON[part.status];

  return (
    <div style={{ border: `1px solid ${isActive ? col + "80" : S.border}`, borderRadius: "6px", background: S.surface, overflow: "hidden", transition: "border-color 0.2s" }}>
      <div onClick={() => onSelect(idx)} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 16px", cursor: "pointer", background: isActive ? col + "10" : "transparent", transition: "background 0.2s" }}>
        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: col, flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: "15px", color: S.text, fontWeight: isActive ? 700 : 400 }}>
          {part.instrName}
          {part.instrCount > 1 && <span style={{ color: S.muted, fontSize: "13px", fontWeight: 400 }}> ×{part.instrCount}</span>}
          {role?.primaryRole && (
            <span style={{ marginLeft: "10px", fontSize: "11px", color: col, border: `1px solid ${col}55`, background: col + "18", borderRadius: "10px", padding: "1px 8px", letterSpacing: "0.04em" }}>
              {role.primaryRole}
            </span>
          )}
        </span>
        <span style={{ fontSize: "13px", color: statusColor, marginRight: "8px" }}>{statusIcon} {part.status}</span>

        {(part.status === "idle" || part.status === "error") && (
          <button onClick={(e) => { e.stopPropagation(); onSelect(idx); onGenerate(idx); }} style={{ padding: "5px 14px", background: S.gold + "22", border: `1px solid ${S.gold}`, color: S.gold, borderRadius: "3px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF, whiteSpace: "nowrap" }}>
            {part.status === "error" ? "↻ Retry" : "▶ Generate"}
          </button>
        )}
        {part.status === "loading" && <span style={{ fontSize: "12px", color: S.gold, animation: "pulse 1s ease-in-out infinite" }}>generating…</span>}
        {part.status === "done" && (
          <button onClick={(e) => { e.stopPropagation(); onGenerate(idx); }} style={{ padding: "5px 14px", background: "transparent", border: `1px solid ${S.border}`, color: S.muted, borderRadius: "3px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF }}>
            ↻ Regenerate
          </button>
        )}
      </div>

      {isActive && (
        <div style={{ padding: "0 16px 16px" }}>
          {role?.melodySections?.length > 0 && (
            <p style={{ margin: "0 0 8px", fontSize: "11px", color: S.muted, letterSpacing: "0.03em" }}>
              Carries the melody in: <span style={{ color: S.gold }}>{role.melodySections.join(", ")}</span>
            </p>
          )}
          {part.status === "loading" && (
            <div style={{ padding: "24px", textAlign: "center", color: S.muted, fontSize: "13px", borderTop: `1px solid ${S.border}` }}>
              <div style={{ fontSize: "28px", marginBottom: "8px", animation: "spin 2s linear infinite", display: "inline-block" }}>𝄞</div>
              <div>Generating {part.instrName} part…</div>
            </div>
          )}
          {part.status === "idle" && (
            <div style={{ padding: "20px", textAlign: "center", border: `1px dashed ${S.border}`, borderRadius: "4px", color: S.muted, fontSize: "13px", marginTop: "4px" }}>
              Click <strong style={{ color: S.gold }}>▶ Generate</strong> to create this part
            </div>
          )}
          {part.status === "error" && (
            <div style={{ padding: "14px", background: "rgba(200,80,80,0.08)", border: "1px solid rgba(200,80,80,0.2)", borderRadius: "4px", color: "#d47878", fontSize: "13px", marginTop: "4px" }}>
              ⚠ {part.errMsg}
            </div>
          )}
          {part.status === "done" && part.abcText && (
            <div style={{ marginTop: "4px" }}>
              {part.melodyWarnings?.length > 0 && (
                <div style={{ padding: "10px 12px", marginBottom: "8px", background: "rgba(200,160,80,0.08)", border: `1px solid ${S.gold}44`, borderRadius: "4px", fontSize: "12px", color: S.gold }}>
                  ⚠ The melody in this part still deviates from the score in {part.melodyWarnings.length} spot{part.melodyWarnings.length > 1 ? "s" : ""} — try Regenerate.
                  <details style={{ marginTop: "4px" }}>
                    <summary style={{ cursor: "pointer", fontSize: "11px", color: S.muted }}>details</summary>
                    <ul style={{ margin: "6px 0 0", paddingLeft: "18px", color: S.muted, fontSize: "11px" }}>
                      {part.melodyWarnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </details>
                </div>
              )}
              <AbcRenderer abcText={part.abcText} uid={`${idx}-${part.instrName.replace(/\s/g, "-")}`} />
              <details style={{ marginTop: "8px" }}>
                <summary style={{ fontSize: "11px", color: S.muted, cursor: "pointer", letterSpacing: "0.04em" }}>View ABC source</summary>
                <pre style={{ marginTop: "6px", padding: "12px", background: S.surface2, border: `1px solid ${S.border}`, borderRadius: "3px", fontSize: "11px", color: S.text, overflowX: "auto", fontFamily: "'Courier New',monospace", lineHeight: "1.5", whiteSpace: "pre-wrap" }}>
                  {part.abcText}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
