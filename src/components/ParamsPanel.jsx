import { STYLES, DENSITIES, TEMPOS_FEEL, MEASURE_OPTIONS, estimateDuration, tempoTerm, SERIF } from "../lib/constants.js";
import { SecH, Chip, NavBtn, inputStyle } from "./ui.jsx";

const Label = ({ children, S }) => (
  <label style={{ display: "block", fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", color: S.muted, marginBottom: "7px" }}>
    {children}
  </label>
);

export default function ParamsPanel({
  S, style, setStyle, density, setDensity, tempoFeel, setTempoFeel,
  measures, setMeasures, songNotes, setSongNotes,
  songTitle, songKey, timeSig, bpm, setBpm, songBpm, selectedInstrs, error, onBack, onGenerate,
}) {
  const clampBpm = (v) => Math.max(30, Math.min(240, Math.round(v)));
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
        <Label S={S}>Tempo</Label>
        <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
          <input
            type="range" min={40} max={208} step={1}
            value={Math.max(40, Math.min(208, bpm))}
            onChange={(e) => setBpm(Number(e.target.value))}
            style={{ flex: 1, minWidth: "200px", accentColor: S.gold, cursor: "pointer" }}
          />
          <input
            type="number" min={30} max={240}
            value={bpm}
            onChange={(e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) setBpm(v); }}
            onBlur={() => setBpm(clampBpm(bpm))}
            style={{ ...inputStyle, width: "76px", textAlign: "center" }}
          />
          <span style={{ fontSize: "13px", color: S.gold, fontStyle: "italic", minWidth: "72px" }}>{tempoTerm(bpm)}</span>
          {Boolean(songBpm) && bpm !== songBpm && (
            <button
              onClick={() => setBpm(songBpm)}
              title="Back to the song's documented tempo"
              style={{ padding: "5px 10px", background: "transparent", border: `1px solid ${S.border}`, color: S.muted, borderRadius: "3px", cursor: "pointer", fontSize: "11px", fontFamily: SERIF, whiteSpace: "nowrap" }}
            >
              ↺ song default ({songBpm})
            </button>
          )}
        </div>
        <p style={{ margin: "8px 0 0", fontSize: "12px", color: S.muted }}>
          Quarter notes per minute — the score's Q: marking and audio playback both use exactly this.
        </p>
      </div>

      <div>
        <Label S={S}>Measures to Write</Label>
        <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
          {MEASURE_OPTIONS.map((m) => <Chip key={m} label={`${m}`} active={measures === m} onClick={() => setMeasures(m)} />)}
        </div>
        <p style={{ margin: "8px 0 0", fontSize: "12px", color: S.muted }}>
          ≈ <span style={{ color: S.gold, fontWeight: 700 }}>{estimateDuration(measures, timeSig, bpm).clock}</span> playing time
          <span style={{ opacity: 0.7 }}> · {measures} bars of {timeSig} at {bpm} BPM</span>
        </p>
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
            ["Length", `≈ ${estimateDuration(measures, timeSig, bpm).clock}`],
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
