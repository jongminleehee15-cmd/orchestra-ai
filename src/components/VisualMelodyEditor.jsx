import { useEffect, useRef, useState, useCallback } from "react";
import abcjs from "abcjs";
import { analyzeMelody } from "../lib/melodyCheck.js";
import { SERIF } from "../lib/constants.js";
import AudioPlayer from "./AudioPlayer.jsx";

// ── ABC note-token helpers ────────────────────────────────────────────────────
// A note token looks like: [accidentals][letter][octave marks][length]
//   e.g. "C", "C2", "^F,2", "c'/2".  Rests are "z"/"x" + length.
const NOTE_RE = /^([_^=]*)([A-Ga-g])([,']*)(\d+\/\d+|\d+|\/+)?$/;
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_VAL = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

const isRest = (t) => /^[zxZ]/.test(String(t).trim());
function parseNote(tok) {
  const m = String(tok).trim().match(NOTE_RE);
  return m ? { acc: m[1] || "", letter: m[2], oct: m[3] || "", len: m[4] || "" } : null;
}
function noteToAbs(letter, oct) {
  let abs = LETTER_VAL[letter.toUpperCase()];
  if (letter === letter.toLowerCase()) abs += 7; // lowercase = one octave up
  for (const ch of oct) abs += ch === "'" ? 7 : ch === "," ? -7 : 0;
  return abs;
}
function absToNote(abs) {
  const idx = ((abs % 7) + 7) % 7;
  const group = Math.floor(abs / 7);
  const upper = LETTERS[idx];
  if (group === 0) return upper;
  if (group === 1) return upper.toLowerCase();
  if (group > 1) return upper.toLowerCase() + "'".repeat(group - 1);
  return upper + ",".repeat(-group);
}
// Transpose a note token by whole diatonic steps (drops explicit accidentals).
function shiftPitch(tok, steps) {
  const p = parseNote(tok);
  if (!p) return tok;
  return absToNote(noteToAbs(p.letter, p.oct) + steps) + p.len;
}
function lenOf(tok) {
  if (isRest(tok)) return String(tok).trim().replace(/^[zxZ]/, "");
  const p = parseNote(tok);
  return p ? p.len : "";
}
function setLen(tok, len) {
  if (isRest(tok)) return String(tok).trim()[0] + len;
  const p = parseNote(tok);
  return p ? p.acc + p.letter + p.oct + len : tok;
}
function setAcc(tok, acc) {
  const p = parseNote(tok);
  return p ? acc + p.letter + p.oct + p.len : tok;
}
function pitchOnly(tok) {
  const p = parseNote(tok);
  return p ? p.letter + p.oct : "C";
}

// Duration palette (in L:1/8 length units).
const DURATIONS = [
  { len: "", label: "♪", title: "eighth" },
  { len: "2", label: "♩", title: "quarter" },
  { len: "3", label: "♩.", title: "dotted quarter" },
  { len: "4", label: "𝅗𝅥", title: "half" },
  { len: "6", label: "𝅗𝅥.", title: "dotted half" },
  { len: "8", label: "○", title: "whole" },
];

function extractBody(fullAbc) {
  return (
    fullAbc
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^[A-Za-z]:/.test(l) && !/^%%/.test(l))
      .sort((a, b) => b.split("|").length - a.split("|").length)[0] || ""
  );
}

export default function VisualMelodyEditor({ S, melodyAbc, songKey, timeSig, bpm, measures, onApply, onCancel }) {
  const build = useCallback(
    (body) => `X:1\nT:Melody\nM:${timeSig}\nL:1/8\nQ:1/4=${bpm}\nK:${songKey}\n${body}`,
    [timeSig, bpm, songKey],
  );
  const [abc, setAbc] = useState(() => build(melodyAbc || ""));
  const [sel, setSel] = useState(null); // { start, end, token, isNote }
  const [textMode, setTextMode] = useState(false);
  const [histLen, setHistLen] = useState(0);
  const ref = useRef(null);
  const abcRef = useRef(abc);
  abcRef.current = abc;
  const historyRef = useRef([]); // stack of previous ABC strings for undo

  const body = extractBody(abc);
  const check = analyzeMelody(body, timeSig, measures);

  // Apply an edit and push the previous ABC onto the undo stack.
  const applyEdit = useCallback((producer) => {
    const cur = abcRef.current;
    const next = producer(cur);
    if (next === cur) return;
    historyRef.current = [...historyRef.current, cur].slice(-100);
    setHistLen(historyRef.current.length);
    setAbc(next);
    setSel(null);
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.length) return;
    historyRef.current = h.slice(0, -1);
    setHistLen(historyRef.current.length);
    setAbc(h[h.length - 1]);
    setSel(null);
  }, []);

  const replaceRange = useCallback((start, end, text) => {
    applyEdit((cur) => cur.slice(0, start) + text + cur.slice(end));
  }, [applyEdit]);

  // Render the interactive score. Re-runs whenever the ABC changes.
  useEffect(() => {
    if (textMode || !ref.current) return;
    const onClick = (abcelem, _tune, _classes, _analysis, drag) => {
      const cur = abcRef.current;
      const hasPos = abcelem && abcelem.startChar >= 0 && abcelem.endChar > abcelem.startChar;
      const note = abcelem && abcelem.el_type === "note" && hasPos;
      if (!note) { setSel(null); return; }
      const tok = cur.slice(abcelem.startChar, abcelem.endChar);
      if (drag && drag.step) {
        // Dragged vertically → transpose (up-drag reports a negative step).
        if (!abcelem.rest) replaceRange(abcelem.startChar, abcelem.endChar, shiftPitch(tok, -drag.step));
        return;
      }
      setSel({ start: abcelem.startChar, end: abcelem.endChar, token: tok.trim(), isNote: !abcelem.rest });
    };
    try {
      // Render the EXACT string we slice for edits — abcjs reports each note's
      // startChar/endChar relative to this input, so any prefix here (e.g. a
      // "%%measurenb 0" line) would offset every edit and corrupt the wrong chars.
      abcjs.renderAbc(ref.current, abc, {
        add_classes: true,
        responsive: "resize",
        staffwidth: Math.max(320, Math.min(900, (ref.current.offsetWidth || 660) - 24)),
        wrap: { minSpacing: 1.8, maxSpacing: 2.7, preferredMeasuresPerLine: 4 },
        scale: 1.15,
        paddingtop: 12, paddingbottom: 16, paddingleft: 16, paddingright: 16,
        foregroundColor: "#1a1208",
        selectionColor: "#b8801f",
        dragColor: "#b06a2a",
        dragging: true,
        clickListener: onClick,
      });
    } catch (e) {
      console.warn("visual editor render:", e);
    }
  }, [abc, textMode, replaceRange]);

  // Toolbar actions operate on the selected token's char range.
  const canPitch = sel && sel.isNote;
  const doPitch = (steps) => canPitch && replaceRange(sel.start, sel.end, shiftPitch(sel.token, steps));
  const doDur = (len) => sel && replaceRange(sel.start, sel.end, setLen(sel.token, len));
  const doAcc = (acc) => canPitch && replaceRange(sel.start, sel.end, setAcc(sel.token, acc));
  const doDelete = () => sel && replaceRange(sel.start, sel.end, "z" + lenOf(sel.token));
  const doAddNote = () => {
    if (!sel) return;
    if (!sel.isNote) {
      // A rest is selected → turn it into a note of the same duration.
      replaceRange(sel.start, sel.end, "c" + lenOf(sel.token));
    } else {
      // A note is selected → insert a new note (same pitch, quarter) right after.
      const insert = pitchOnly(sel.token) + "2";
      applyEdit((cur) => cur.slice(0, sel.end) + insert + cur.slice(sel.end));
    }
  };

  const btn = (extra = {}) => ({
    padding: "5px 10px", background: S.surface2, border: `1px solid ${S.border}`,
    color: S.text, borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF, ...extra,
  });
  const dim = { opacity: 0.35, cursor: "not-allowed" };

  return (
    <div style={{ marginTop: "10px" }}>
      <p style={{ margin: "0 0 10px", fontSize: "12px", color: S.muted, lineHeight: 1.6 }}>
        <strong style={{ color: S.text }}>Click a note</strong> to select it, then use the buttons below, or <strong style={{ color: S.text }}>drag a note up/down</strong> to change its pitch. No ABC needed.
      </p>

      {/* Toolbar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", padding: "10px", background: S.surface, border: `1px solid ${S.border}`, borderRadius: "6px", marginBottom: "10px", opacity: textMode ? 0.4 : 1, pointerEvents: textMode ? "none" : "auto" }}>
        <button title="Undo last edit" style={btn(histLen ? {} : dim)} onClick={undo}>↶ Undo</button>
        <span style={{ width: "1px", height: "20px", background: S.border }} />
        <span style={{ fontSize: "12px", color: S.muted, minWidth: "84px" }}>
          {sel ? (sel.isNote ? `Note: ${sel.token}` : `Rest: ${sel.token}`) : "No selection"}
        </span>
        <span style={{ width: "1px", height: "20px", background: S.border }} />
        <button title="Pitch up a step" style={btn(canPitch ? {} : dim)} onClick={() => doPitch(1)}>▲</button>
        <button title="Pitch down a step" style={btn(canPitch ? {} : dim)} onClick={() => doPitch(-1)}>▼</button>
        <button title="Octave up" style={btn(canPitch ? {} : dim)} onClick={() => doPitch(7)}>8va▲</button>
        <button title="Octave down" style={btn(canPitch ? {} : dim)} onClick={() => doPitch(-7)}>8vb▼</button>
        <span style={{ width: "1px", height: "20px", background: S.border }} />
        {DURATIONS.map((d) => (
          <button key={d.title} title={d.title} style={btn(sel ? {} : dim)} onClick={() => doDur(d.len)}>{d.label}</button>
        ))}
        <span style={{ width: "1px", height: "20px", background: S.border }} />
        <button title="Sharp" style={btn(canPitch ? {} : dim)} onClick={() => doAcc("^")}>♯</button>
        <button title="Natural" style={btn(canPitch ? {} : dim)} onClick={() => doAcc("=")}>♮</button>
        <button title="Flat" style={btn(canPitch ? {} : dim)} onClick={() => doAcc("_")}>♭</button>
        <span style={{ width: "1px", height: "20px", background: S.border }} />
        <button title="Add a note after this one (or turn a selected rest into a note)" style={btn(sel ? {} : dim)} onClick={doAddNote}>＋ note</button>
        <button title="Delete (replace with a rest)" style={btn(sel ? { color: "#d47878" } : dim)} onClick={doDelete}>🗑 delete</button>
      </div>

      {/* Score (interactive) or advanced text mode */}
      {textMode ? (
        <textarea
          value={body}
          onChange={(e) => setAbc(build(e.target.value))}
          rows={4}
          spellCheck={false}
          style={{ width: "100%", boxSizing: "border-box", resize: "vertical", background: "#fffef8", color: "#1a1208", border: `1px solid ${check.ok ? "#8ca86a" : "#d0a24a"}`, borderRadius: "4px", padding: "10px 12px", fontFamily: "'Courier New',monospace", fontSize: "14px", lineHeight: 1.7 }}
        />
      ) : (
        <div style={{ background: "#fffef8", borderRadius: "4px", border: "1px solid #d8c8a0", padding: "8px", minHeight: "120px", boxShadow: "inset 0 1px 4px rgba(0,0,0,0.06)" }}>
          <div ref={ref} />
        </div>
      )}

      {/* Preview the edit by ear before committing to a full regenerate. */}
      <AudioPlayer abcText={abc} S={S} hint="preview your edit" />

      {/* Status + actions */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginTop: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "12px", color: check.ok ? "#8ca86a" : "#d0a24a" }}>
          {check.ok ? `✓ ${check.measureCount} bars, all sum to ${timeSig}` : `⚠ ${check.problems.slice(0, 3).join(" · ")}${check.problems.length > 3 ? " …" : ""}`}
        </span>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button onClick={() => setTextMode((v) => !v)} style={{ padding: "7px 12px", background: "transparent", border: `1px solid ${S.border}`, color: S.muted, borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontFamily: SERIF }}>
            {textMode ? "🎼 Visual" : "⌨ ABC text"}
          </button>
          <button onClick={onCancel} style={{ padding: "7px 14px", background: "transparent", border: `1px solid ${S.border}`, color: S.muted, borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF }}>
            Cancel
          </button>
          <button onClick={() => body && onApply(body)} disabled={!body} style={{ padding: "7px 16px", background: S.gold, color: "#140f08", border: "none", borderRadius: "4px", cursor: body ? "pointer" : "not-allowed", fontSize: "13px", fontWeight: 700, fontFamily: SERIF }}>
            ✦ Apply &amp; regenerate all parts
          </button>
        </div>
      </div>
    </div>
  );
}
