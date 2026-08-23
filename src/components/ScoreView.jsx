import { useState } from "react";
import { SERIF } from "../lib/constants.js";
import { buildFullScoreAbc, buildLeadSheetAbc, buildScoreAbc } from "../lib/abcHelpers.js";
import { printAbc } from "../lib/print.js";
import { analyzeVoicing } from "../lib/voicing.js";
import { SecH } from "./ui.jsx";
import AbcRenderer from "./AbcRenderer.jsx";
import AudioPlayer from "./AudioPlayer.jsx";
import PartCard from "./PartCard.jsx";
import VisualMelodyEditor from "./VisualMelodyEditor.jsx";

export default function ScoreView({
  S, songTitle, songArtist, songKey, timeSig, bpm, style, measures,
  scoreParts, melodyPlan, planStatus, viewIdx, setViewIdx,
  onGeneratePart, onGenerateAll, onApplyMelody, onRetryPlan, onReset,
}) {
  const [editing, setEditing] = useState(false);
  const doneCount = scoreParts.filter((p) => p.status === "done").length;
  const totalCount = scoreParts.length;
  const anyLoading = scoreParts.some((p) => p.status === "loading");
  const planBusy = planStatus === "loading";

  const leadSheetAbc = buildLeadSheetAbc(melodyPlan?.melodyAbc, { key: songKey, timeSig, bpm });

  // Full score appears once there's an ensemble to stack (or the whole — solo —
  // arrangement is done). Rebuilt from the current parts on every render.
  const fullScoreAbc =
    doneCount >= Math.min(2, totalCount) && doneCount > 0
      ? buildFullScoreAbc(scoreParts, { title: songTitle, timeSig, bpm, key: songKey })
      : null;

  // Cross-part orchestration checks (register crowding, unison doubling) —
  // only meaningful once there's more than one finished part to compare.
  // Re-derived on every render, same as fullScoreAbc.
  const voicingWarnings = doneCount >= 2 ? analyzeVoicing(scoreParts, melodyPlan) : [];

  const allDisabled = anyLoading || doneCount === totalCount || planBusy;

  function downloadAbc() {
    const all = buildScoreAbc(leadSheetAbc, scoreParts);
    const a = document.createElement("a");
    a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(all);
    a.download = `${songTitle.replace(/\s+/g, "-")}-score.abc`;
    a.click();
  }

  const songLabel = `${songTitle}${songArtist ? ` — ${songArtist}` : ""}`;

  // One print job: lead-sheet melody first, then every finished part, each on
  // its own page — the stack you'd hand out at a rehearsal.
  function printParts() {
    printAbc(
      [
        leadSheetAbc && { abc: leadSheetAbc, subtitle: `${songLabel} · melody reference` },
        ...scoreParts.filter((p) => p.status === "done" && p.abcText).map((p) => ({ abc: p.abcText, subtitle: songLabel })),
      ].filter(Boolean),
      `${songLabel} · parts`,
    );
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
            <>
              <button onClick={printParts} title="Print the melody + every finished part, one per page" style={{ padding: "8px 16px", background: "transparent", border: `1px solid ${S.goldDim}`, color: S.gold, borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF }}>
                🖨 Print parts
              </button>
              <button onClick={downloadAbc} style={{ padding: "8px 16px", background: "transparent", border: `1px solid ${S.goldDim}`, color: S.gold, borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF }}>
                ↓ Download .abc
              </button>
            </>
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
              <button onClick={() => setEditing(true)} style={{ padding: "5px 12px", background: "transparent", border: `1px solid ${S.goldDim}`, color: S.gold, borderRadius: "3px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF, whiteSpace: "nowrap" }}>
                ✎ Edit melody
              </button>
            )}
          </div>

          {!editing && melodyPlan?.melodyAbc && (
            ["library", "corpus", "import"].includes(melodyPlan.source) ? (
              <p style={{ margin: "2px 2px 8px", fontSize: "12px", color: "#7fc491", lineHeight: 1.5 }}>
                ✓ {melodyPlan.source === "library"
                  ? "Verified melody — taken note-for-note from public-domain score data."
                  : melodyPlan.source === "import"
                    ? "Verified melody — taken note-for-note from your imported score file."
                    : "Verified melody — converted note-for-note from an engraved public-domain MusicXML score."}
              </p>
            ) : (
              <p style={{ margin: "2px 2px 8px", fontSize: "12px", color: "#c8a050", lineHeight: 1.5 }}>
                ≈ AI-recalled melody — no score data was available, so this tune is reconstructed from the model's memory and may differ from the original. Use ✎ Edit melody to correct anything that sounds off.
              </p>
            )
          )}

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
              <AbcRenderer uid="lead-melody" abcText={leadSheetAbc} />
              <AudioPlayer abcText={leadSheetAbc} S={S} />
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
            songLabel={songLabel}
            onSelect={setViewIdx}
            onGenerate={onGeneratePart}
          />
        ))}
      </div>

      {voicingWarnings.length > 0 && (
        <div style={{ marginTop: "20px", padding: "10px 12px", background: "rgba(200,160,80,0.08)", border: `1px solid ${S.gold}44`, borderRadius: "4px", fontSize: "12px", color: S.gold }}>
          ⚠ {voicingWarnings.length} orchestration note{voicingWarnings.length > 1 ? "s" : ""} across parts (register crowding or unison doubling) — informational, not blocking.
          <details style={{ marginTop: "4px" }}>
            <summary style={{ cursor: "pointer", fontSize: "11px", color: S.muted }}>details</summary>
            <ul style={{ margin: "6px 0 0", paddingLeft: "18px", color: S.muted, fontSize: "11px" }}>
              {voicingWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </details>
        </div>
      )}

      {fullScoreAbc && (
        <div style={{ marginTop: "28px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            <SecH>
              Full Score <span style={{ fontSize: "12px", color: S.muted, fontWeight: 400 }}>— {doneCount < totalCount ? `${doneCount} of ${totalCount} parts so far` : "all parts"}, stacked and playing together</span>
            </SecH>
            <button
              onClick={() => printAbc({ abc: fullScoreAbc, subtitle: songLabel }, `${songLabel} · Full Score`)}
              title="Print the full score"
              style={{ padding: "5px 12px", background: "transparent", border: `1px solid ${S.goldDim}`, color: S.gold, borderRadius: "3px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF, whiteSpace: "nowrap" }}
            >
              🖨 Print
            </button>
          </div>
          <AudioPlayer
            abcText={fullScoreAbc}
            S={S}
            chordsOff
            hint="full ensemble · concert pitch"
            downloadName={`${songTitle.replace(/\s+/g, "-")}-full-score`}
          />
          <AbcRenderer uid={`full-score-${doneCount}`} abcText={fullScoreAbc} />
        </div>
      )}

      <div style={{ marginTop: "28px", textAlign: "center" }}>
        <button onClick={onReset} style={{ padding: "9px 22px", background: "transparent", border: `1px solid ${S.border}`, color: S.muted, borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF }}>
          ← New Arrangement
        </button>
      </div>
    </div>
  );
}
