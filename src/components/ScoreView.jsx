import { useState } from "react";
import { SERIF } from "../lib/constants.js";
import { buildLeadSheetAbc, buildScoreAbc } from "../lib/abcHelpers.js";
import { annotateAbcWithSyllables } from "../lib/singable.js";
import { SecH } from "./ui.jsx";
import AbcRenderer from "./AbcRenderer.jsx";
import PartCard from "./PartCard.jsx";
import VisualMelodyEditor from "./VisualMelodyEditor.jsx";

const SING_SYSTEMS = [
  { value: "solfege", label: "Solfege (do re mi)" },
  { value: "solfa", label: "Tonic sol-fa (d r m)" },
  { value: "degrees", label: "Scale degrees (1 2 3)" },
];

export default function ScoreView({
  S, songTitle, songArtist, songKey, timeSig, bpm, style, measures,
  scoreParts, melodyPlan, planStatus, viewIdx, setViewIdx,
  onGeneratePart, onGenerateAll, onApplyMelody, onRetryPlan, onReset,
}) {
  const [editing, setEditing] = useState(false);
  const [singing, setSinging] = useState(false);
  const [singSystem, setSingSystem] = useState("solfege");
  const doneCount = scoreParts.filter((p) => p.status === "done").length;
  const totalCount = scoreParts.length;
  const anyLoading = scoreParts.some((p) => p.status === "loading");
  const planBusy = planStatus === "loading";

  const leadSheetAbc = buildLeadSheetAbc(melodyPlan?.melodyAbc, { key: songKey, timeSig, bpm });
  // No AI, no tokens — solfege is a pure function of (notes, key), computed
  // client-side from the ABC the app already has.
  const displayAbc = singing && leadSheetAbc
    ? annotateAbcWithSyllables(leadSheetAbc, { key: songKey, system: singSystem })
    : leadSheetAbc;

  const allDisabled = anyLoading || doneCount === totalCount || planBusy;

  function downloadAbc() {
    const all = buildScoreAbc(leadSheetAbc, scoreParts);
    const a = document.createElement("a");
    a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(all);
    a.download = `${songTitle.replace(/\s+/g, "-")}-score.abc`;
    a.click();
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "22px", fontWeight: 400, color: S.gold }}>
            {songTitle}{songArtist ? ` — ${songArtist}` : ""}
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: "13px", color: S.muted }}>
            Key of {songKey} · {timeSig} · {bpm} BPM · {style} · {measures} measures
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            onClick={onGenerateAll}
            disabled={allDisabled}
            style={{
              padding: "8px 16px",
              background: allDisabled ? "transparent" : S.gold + "22",
              border: `1px solid ${allDisabled ? S.border : S.gold}`,
              color: allDisabled ? S.muted : S.gold,
              borderRadius: "4px", cursor: allDisabled ? "not-allowed" : "pointer",
              fontSize: "13px", fontFamily: SERIF, transition: "all 0.2s",
            }}
          >
            {planBusy ? "⏳ Composing melody…" : anyLoading ? "⏳ Generating…" : doneCount === totalCount ? "✓ All Generated" : `▶ Generate All (${totalCount - doneCount} remaining)`}
          </button>
          {doneCount > 0 && (
            <button onClick={downloadAbc} style={{ padding: "8px 16px", background: "transparent", border: `1px solid ${S.goldDim}`, color: S.gold, borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF }}>
              ↓ Download .abc
            </button>
          )}
        </div>
      </div>

      {planBusy && (
        <div style={{ padding: "18px", marginBottom: "16px", textAlign: "center", border: `1px dashed ${S.border}`, borderRadius: "6px", color: S.muted, fontSize: "13px" }}>
          <span style={{ fontSize: "22px", marginRight: "8px", animation: "spin 2s linear infinite", display: "inline-block" }}>𝄞</span>
          Composing the canonical melody &amp; distribution plan…
        </div>
      )}
      {planStatus === "error" && (
        <div style={{ padding: "12px 16px", marginBottom: "16px", background: "rgba(200,80,80,0.08)", border: "1px solid rgba(200,80,80,0.2)", borderRadius: "6px", color: "#d47878", fontSize: "13px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <span>⚠ Couldn't build the shared melody plan — parts will still generate, but each as an independent voice.</span>
          <button onClick={onRetryPlan} style={{ padding: "5px 12px", background: "transparent", border: `1px solid ${S.goldDim}`, color: S.gold, borderRadius: "3px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF, whiteSpace: "nowrap" }}>
            ↻ Retry plan
          </button>
        </div>
      )}

      {leadSheetAbc && (
        <div style={{ marginBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            <SecH>
              Canonical Melody <span style={{ fontSize: "12px", color: S.muted, fontWeight: 400 }}>— shared reference for every part</span>
            </SecH>
            {!editing && melodyPlan?.melodyAbc && (
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {singing && (
                  <select
                    value={singSystem}
                    onChange={(e) => setSingSystem(e.target.value)}
                    style={{ padding: "5px 8px", background: S.surface2, border: `1px solid ${S.border}`, color: S.text, borderRadius: "3px", fontSize: "12px", fontFamily: SERIF }}
                  >
                    {SING_SYSTEMS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                )}
                <button
                  onClick={() => setSinging((v) => !v)}
                  title="Show do-re-mi syllables under the melody — no AI, computed from the notes"
                  style={{
                    padding: "5px 12px", borderRadius: "3px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF, whiteSpace: "nowrap",
                    background: singing ? S.gold + "22" : "transparent",
                    border: `1px solid ${singing ? S.gold : S.goldDim}`,
                    color: S.gold,
                  }}
                >
                  🎤 Sing
                </button>
                <button onClick={() => setEditing(true)} style={{ padding: "5px 12px", background: "transparent", border: `1px solid ${S.goldDim}`, color: S.gold, borderRadius: "3px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF, whiteSpace: "nowrap" }}>
                  ✎ Edit melody
                </button>
              </div>
            )}
          </div>

          {editing ? (
            <VisualMelodyEditor
              S={S}
              melodyAbc={melodyPlan?.melodyAbc || ""}
              songKey={songKey}
              timeSig={timeSig}
              bpm={bpm}
              measures={measures}
              onApply={(bodyAbc) => { onApplyMelody(bodyAbc); setEditing(false); }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <AbcRenderer uid={`lead-melody-${singing ? singSystem : "plain"}`} abcText={displayAbc} />
              {melodyPlan?.melodySummary && (
                <p style={{ margin: "10px 2px 0", fontSize: "12px", color: S.muted, fontStyle: "italic", lineHeight: 1.6 }}>{melodyPlan.melodySummary}</p>
              )}
            </>
          )}
        </div>
      )}

      <div style={{ display: "grid", gap: "10px" }}>
        {scoreParts.map((part, idx) => (
          <PartCard
            key={idx}
            part={part}
            idx={idx}
            isActive={viewIdx === idx}
            role={melodyPlan?.instrumentRoles?.[part.instrName]}
            S={S}
            onSelect={setViewIdx}
            onGenerate={onGeneratePart}
          />
        ))}
      </div>

      <div style={{ marginTop: "28px", textAlign: "center" }}>
        <button onClick={onReset} style={{ padding: "9px 22px", background: "transparent", border: `1px solid ${S.border}`, color: S.muted, borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF }}>
          ← New Arrangement
        </button>
      </div>
    </div>
  );
}
