import { useState } from "react";
import { S, SERIF, genreColor } from "./lib/constants.js";
import { generateBlueprint, generateInstrumentABC } from "./api/client.js";
import SongSearchPanel from "./components/SongSearchPanel.jsx";
import OrchestraBuilder from "./components/OrchestraBuilder.jsx";
import ParamsPanel from "./components/ParamsPanel.jsx";
import ScoreView from "./components/ScoreView.jsx";

// Expand [{name, count}] into distinct numbered voices so duplicate instruments
// (e.g. 2 Trumpets) each get an independent part — Trumpet 1, Trumpet 2 — instead
// of one shared line. `base` keeps the catalogue name for clef/group lookup.
function expandVoices(instrs) {
  const out = [];
  for (const i of instrs) {
    const n = Math.max(1, i.count || 1);
    if (n === 1) out.push({ name: i.name, base: i.name });
    else for (let k = 1; k <= n; k++) out.push({ name: `${i.name} ${k}`, base: i.name });
  }
  return out;
}

export default function App() {
  // Song (auto-filled from search)
  const [songTitle, setSongTitle] = useState("");
  const [songArtist, setSongArtist] = useState("");
  const [songGenre, setSongGenre] = useState("");
  const [songNotes, setSongNotes] = useState("");
  const [key, setKey] = useState("C");
  const [timeSig, setTimeSig] = useState("4/4");
  const [bpm, setBpm] = useState(100);
  const [measures, setMeasures] = useState(8);
  const [selectedSong, setSelectedSong] = useState(null);

  // Orchestra
  const [selectedInstrs, setSelectedInstrs] = useState([]);

  // Params
  const [style, setStyle] = useState("Cinematic");
  const [density, setDensity] = useState("Full");
  const [tempoFeel, setTempoFeel] = useState("Moderate");

  // UI
  const [tab, setTab] = useState("song");
  const [error, setError] = useState(null);

  // Score
  const [scoreParts, setScoreParts] = useState([]);
  const [melodyPlan, setMelodyPlan] = useState(null);
  const [planStatus, setPlanStatus] = useState("idle"); // idle|loading|done|error
  const [showScore, setShowScore] = useState(false);
  const [viewIdx, setViewIdx] = useState(0);

  function handleSongSelect(song) {
    setSongTitle(song.title);
    setSongArtist(song.artist);
    setSongGenre(song.genre);
    setKey(song.key || "C");
    setTimeSig(song.timeSignature || "4/4");
    setBpm(song.bpm || 100);
    setSelectedSong(song);
    setTab("orchestra");
  }

  function clearSong() {
    setSelectedSong(null);
    setSongTitle(""); setSongArtist(""); setSongGenre("");
    setTab("song");
  }

  async function initScore() {
    if (!songTitle.trim()) { setError("Please select a song first."); return; }
    if (selectedInstrs.length === 0) { setError("Please add at least one instrument."); return; }
    setError(null);
    setMelodyPlan(null);
    setPlanStatus("loading");
    const voices = expandVoices(selectedInstrs);
    setScoreParts(voices.map((v) => ({ instrName: v.name, baseName: v.base, status: "idle", abcText: null, errMsg: null })));
    setViewIdx(0);
    setShowScore(true);
    setTab("score");

    try {
      const plan = await generateBlueprint({
        songTitle, songArtist, songGenre, songNotes,
        instruments: voices.map((v) => ({ name: v.name, count: 1 })),
        style, density, key, timeSignature: timeSig, bpm, measures,
      });
      setMelodyPlan(plan);
      setPlanStatus("done");
    } catch (e) {
      setPlanStatus("error");
      // Parts still generate as independent voices (graceful degradation).
    }
  }

  // `plan` defaults to the current melodyPlan state, but callers (e.g. the manual
  // melody editor) can pass a freshly-edited plan to avoid a stale-state read.
  async function generatePart(idx, plan = melodyPlan) {
    const part = scoreParts[idx];
    if (!part || part.status === "loading") return;
    setScoreParts((prev) => prev.map((p, i) => (i === idx ? { ...p, status: "loading", abcText: null, errMsg: null, conformance: null } : p)));
    const otherInstruments = expandVoices(selectedInstrs).map((v) => v.name).join(", ");
    try {
      const { abc, conformance } = await generateInstrumentABC({
        songTitle, songArtist, songGenre, songNotes,
        instrName: part.instrName,
        style, density, tempoFeel, key,
        timeSignature: timeSig, bpm, measures, otherInstruments,
        role: plan?.instrumentRoles?.[part.instrName] || null,
        melodyAbc: plan?.melodyAbc,
        chords: plan?.chords,
      });
      setScoreParts((prev) => prev.map((p, i) => (i === idx ? { ...p, status: "done", abcText: abc, conformance } : p)));
    } catch (e) {
      setScoreParts((prev) => prev.map((p, i) => (i === idx ? { ...p, status: "error", errMsg: e.message } : p)));
    }
  }

  async function generateAll() {
    for (let i = 0; i < scoreParts.length; i++) {
      if (scoreParts[i].status === "idle" || scoreParts[i].status === "error") {
        // re-read latest status via closure-safe guard inside generatePart
        await generatePart(i);
      }
    }
  }

  // Manual melody override: replace the canonical tune with the user's edited ABC
  // and re-generate every part against it, so their exact melody is the source.
  async function applyMelodyEdit(newMelodyAbc) {
    const newPlan = { ...(melodyPlan || {}), melodyAbc: newMelodyAbc };
    setMelodyPlan(newPlan);
    setScoreParts((prev) => prev.map((p) => ({ ...p, status: "idle", abcText: null, errMsg: null, conformance: null })));
    setViewIdx(0);
    const count = scoreParts.length;
    for (let i = 0; i < count; i++) {
      await generatePart(i, newPlan); // instrName is stable; pass the edited plan explicitly
    }
  }

  function resetArrangement() {
    setScoreParts([]);
    setShowScore(false);
    setMelodyPlan(null);
    setPlanStatus("idle");
    setTab("song");
  }

  const doneCount = scoreParts.filter((p) => p.status === "done").length;
  const totalCount = scoreParts.length;

  const TabBtn = ({ id, label, icon, badge, disabled }) => (
    <button
      onClick={() => !disabled && setTab(id)}
      style={{
        padding: "10px 18px", border: "none", cursor: disabled ? "default" : "pointer",
        fontFamily: SERIF, fontSize: "14px", letterSpacing: "0.05em",
        fontWeight: tab === id ? 700 : 400,
        background: tab === id ? S.gold + "22" : "transparent",
        color: disabled ? S.border : tab === id ? S.gold : S.muted,
        borderBottom: `2px solid ${tab === id ? S.gold : "transparent"}`,
        transition: "all 0.2s",
      }}
    >
      {icon} {label}
      {badge && <span style={{ marginLeft: "6px", background: S.gold, color: "#140f08", borderRadius: "10px", padding: "1px 7px", fontSize: "11px", fontWeight: 700 }}>{badge}</span>}
    </button>
  );

  return (
    <div style={{ minHeight: "100vh", background: S.bg, color: S.text, fontFamily: SERIF }}>
      <div style={{ position: "fixed", inset: 0, backgroundImage: "radial-gradient(ellipse at 15% 15%,rgba(200,160,80,0.05) 0%,transparent 55%),radial-gradient(ellipse at 85% 85%,rgba(90,159,212,0.03) 0%,transparent 55%)", pointerEvents: "none", zIndex: 0 }} />

      <header style={{ borderBottom: `1px solid ${S.border}`, padding: "18px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(13,11,8,0.97)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
          <span style={{ fontSize: "24px", fontWeight: 400, color: S.gold, letterSpacing: "0.15em" }}>ORCHESTRA</span>
          <span style={{ fontSize: "24px", fontWeight: 700, color: S.text }}>AI</span>
          <span style={{ fontSize: "11px", letterSpacing: "0.18em", color: S.muted, marginLeft: "6px", textTransform: "uppercase" }}>Sheet Music Generator</span>
        </div>
        {selectedSong && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "6px 14px", background: S.surface2, border: `1px solid ${S.border}`, borderRadius: "20px" }}>
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: S.gold }} />
            <span style={{ fontSize: "13px", color: S.text }}>{selectedSong.title}</span>
            <span style={{ fontSize: "12px", color: S.muted }}>— {selectedSong.artist}</span>
            <button onClick={clearSong} style={{ background: "none", border: "none", color: S.muted, cursor: "pointer", fontSize: "14px", padding: "0 0 0 4px" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#d07070")}
              onMouseLeave={(e) => (e.currentTarget.style.color = S.muted)}>✕</button>
          </div>
        )}
      </header>

      <main style={{ maxWidth: "900px", margin: "0 auto", padding: "28px 20px", position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", borderBottom: `1px solid ${S.border}`, marginBottom: "26px", gap: "2px" }}>
          <TabBtn id="song" label="Search Song" icon="🔍" />
          <TabBtn id="orchestra" label="Orchestra" icon="𝄞" disabled={!selectedSong} />
          <TabBtn id="params" label="Parameters" icon="⚙" disabled={!selectedSong} />
          {showScore && <TabBtn id="score" label="Score" icon="📄" badge={`${doneCount}/${totalCount}`} />}
        </div>

        {tab === "song" && (
          <div>
            <div style={{ marginBottom: "24px" }}>
              <h2 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: 300, color: S.gold }}>Find Your Song</h2>
              <p style={{ margin: 0, fontSize: "14px", color: S.muted }}>Search any song and we'll look up its key, tempo, and time signature automatically.</p>
            </div>
            <SongSearchPanel onSelect={handleSongSelect} S={S} />
          </div>
        )}

        {tab === "orchestra" && (
          <OrchestraBuilder
            S={S}
            selectedSong={selectedSong}
            songKey={key}
            timeSig={timeSig}
            bpm={bpm}
            selectedInstrs={selectedInstrs}
            setSelectedInstrs={setSelectedInstrs}
            onBack={() => setTab("song")}
            onNext={() => setTab("params")}
            onChangeSong={() => setTab("song")}
          />
        )}

        {tab === "params" && (
          <ParamsPanel
            S={S}
            style={style} setStyle={setStyle}
            density={density} setDensity={setDensity}
            tempoFeel={tempoFeel} setTempoFeel={setTempoFeel}
            measures={measures} setMeasures={setMeasures}
            songNotes={songNotes} setSongNotes={setSongNotes}
            songTitle={songTitle} songKey={key} timeSig={timeSig} bpm={bpm}
            selectedInstrs={selectedInstrs}
            error={error}
            onBack={() => setTab("orchestra")}
            onGenerate={initScore}
          />
        )}

        {tab === "score" && showScore && (
          <ScoreView
            S={S}
            songTitle={songTitle} songArtist={songArtist}
            songKey={key} timeSig={timeSig} bpm={bpm} style={style} measures={measures}
            scoreParts={scoreParts}
            melodyPlan={melodyPlan}
            planStatus={planStatus}
            viewIdx={viewIdx} setViewIdx={setViewIdx}
            onGeneratePart={generatePart}
            onGenerateAll={generateAll}
            onApplyMelody={applyMelodyEdit}
            onRetryPlan={initScore}
            onReset={resetArrangement}
          />
        )}
      </main>
    </div>
  );
}
