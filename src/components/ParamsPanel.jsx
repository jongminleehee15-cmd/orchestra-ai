import { STYLES, DENSITIES, TEMPOS_FEEL, MEASURE_OPTIONS, S as theme } from "../lib/constants.js";
import { SecH, Chip, NavBtn, inputStyle } from "./ui.jsx";

const Label = ({ children, S }) => (
  <label style={{ display: "block", fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", color: S.muted, marginBottom: "7px" }}>
    {children}
  </label>
);

export default function ParamsPanel({
  S, style, setStyle, density, setDensity, tempoFeel, setTempoFeel,
  measures, setMeasures, songNotes, setSongNotes,
  songTitle, songKey, timeSig, bpm, selectedInstrs, error, onBack, onGenerate,
}) {
  return (
    <div style={{ display: "grid", gap: "20px" }}>
      <SecH>Arrangement Parameters</SecH>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "18px" }}>
        <div>
          <Label S={S}>Style / Mood</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
            {STYLES.map((s) => <Chip key={s} label={s} active={style === s} onClick={() => setStyle(s)} />)}
          </div>
        </div>
        <div>
          <Label S={S}>Texture Density</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
            {DENSITIES.map((d) => <Chip key={d} label={d} active={density === d} onClick={() => setDensity(d)} />)}
          </div>
        </div>
        <div>
          <Label S={S}>Tempo Feel</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
            {TEMPOS_FEEL.map((t) => <Chip key={t} label={t} active={tempoFeel === t} onClick={() => setTempoFeel(t)} />)}
          </div>
        </div>
      </div>

      <div>
        <Label S={S}>Measures to Write</Label>
        <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
          {MEASURE_OPTIONS.map((m) => <Chip key={m} label={`${m}`} active={measures === m} onClick={() => setMeasures(m)} />)}
        </div>
      </div>

      <div>
        <Label S={S}>Additional Notes for Arranger</Label>
        <textarea
          value={songNotes}
          onChange={(e) => setSongNotes(e.target.value)}
          placeholder="Any specific requests, mood details, or sections to emphasise…"
          rows={3}
          style={{ ...inputStyle, resize: "vertical", lineHeight: "1.6" }}
        />
      </div>

      <div style={{ padding: "16px 20px", background: S.surface2, border: `1px solid ${S.border}`, borderRadius: "6px" }}>
        <p style={{ margin: "0 0 10px", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", color: S.muted }}>Ready to Generate</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", fontSize: "13px" }}>
          {[
            ["Song", songTitle || "—"],
            ["Key / Time", `${songKey} ${timeSig}`],
            ["Tempo", `${bpm} BPM`],
            ["Style", style],
            ["Density", density],
            ["Parts", selectedInstrs.length || "—"],
          ].map(([l, v]) => (
            <div key={l}>
              <span style={{ color: S.muted }}>{l}: </span>
              <span style={{ color: S.text }}>{v}</span>
            </div>
          ))}
        </div>
        <p style={{ margin: "10px 0 0", fontSize: "12px", color: S.muted }}>
          We compose one canonical melody first, then generate each part against it so the tune stays consistent across hand-offs.
        </p>
      </div>

      {error && (
        <div style={{ padding: "11px 14px", background: "rgba(200,80,80,0.1)", border: "1px solid rgba(200,80,80,0.25)", borderRadius: "5px", color: "#d47878", fontSize: "13px" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <NavBtn onClick={onBack}>← Orchestra</NavBtn>
        <button
          onClick={onGenerate}
          style={{
            padding: "13px 36px", background: S.gold, color: "#140f08", border: "none", borderRadius: "4px",
            cursor: "pointer", fontFamily: "'Palatino Linotype',Palatino,serif", fontSize: "17px", fontWeight: 700,
            letterSpacing: "0.08em", transition: "all 0.2s", boxShadow: `0 4px 18px ${S.gold}44`,
          }}
        >
          ✦ Open Score View
        </button>
      </div>
    </div>
  );
}
