import { S, SERIF } from "../lib/constants.js";

// Shared inline-style input base.
export const inputStyle = {
  background: S.surface2, border: `1px solid ${S.border}`, color: S.text,
  padding: "9px 12px", borderRadius: "4px", fontFamily: SERIF, fontSize: "14px",
  outline: "none", width: "100%", boxSizing: "border-box",
};

// Section heading.
export function SecH({ children }) {
  return (
    <h3 style={{ margin: "0 0 14px", fontFamily: SERIF, fontSize: "16px", fontWeight: 400, color: S.gold, letterSpacing: "0.08em", borderBottom: `1px solid ${S.border}`, paddingBottom: "8px" }}>
      {children}
    </h3>
  );
}

// Pill toggle chip.
export function Chip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 12px", borderRadius: "20px", fontSize: "12px", cursor: "pointer",
        border: `1px solid ${active ? S.gold : S.border}`,
        background: active ? S.gold + "22" : "transparent",
        color: active ? S.gold : S.muted, fontFamily: SERIF, transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );
}

// Outline nav button with gold hover.
export function NavBtn({ onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 20px", background: "transparent", border: `1px solid ${S.border}`,
        color: S.muted, borderRadius: "4px", cursor: "pointer",
        fontFamily: SERIF, fontSize: "13px", transition: "all 0.2s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = S.gold; e.currentTarget.style.color = S.gold; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = S.border; e.currentTarget.style.color = S.muted; }}
    >
      {children}
    </button>
  );
}
