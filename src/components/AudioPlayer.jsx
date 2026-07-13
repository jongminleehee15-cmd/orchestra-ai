import { useEffect, useRef, useState } from "react";
import abcjs from "abcjs";
import { SERIF } from "../lib/constants.js";

// Only one player makes sound at a time — starting any player pauses whichever
// one was playing (the melody player and every part card have their own).
let activePlayer = null; // { token, pause }

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

// Compact play/pause/stop + seek bar for one ABC tune, styled to the app
// palette. The synth (and its soundfont download — needs network) is created
// lazily on the first ▶ press, then cached until the ABC or sound changes.
//   program        General MIDI instrument used for playback
//   midiTranspose  semitones applied at playback only (transposing parts are
//                  WRITTEN above concert pitch; a negative shift plays them
//                  back in concert so they match the melody and other parts)
//   chordsOff      true = ignore chord symbols (no auto-accompaniment)
//   hint           small label shown at the right edge (e.g. concert-pitch note)
//   downloadName   when set, shows a ⬇ button that saves the rendered audio
//                  as "<downloadName>.wav" (the recording of the tune)
export default function AudioPlayer({ abcText, S, program = 0, midiTranspose = 0, chordsOff = false, hint, downloadName }) {
  const [status, setStatus] = useState("idle"); // idle | loading | playing | paused | error
  const [progress, setProgress] = useState(0); // 0..1 of duration
  const [duration, setDuration] = useState(0); // seconds
  const [errMsg, setErrMsg] = useState("");
  const [volume, setVolume] = useState(100); // 0..100
  const synthRef = useRef(null);
  const gainRef = useRef(null);
  const volumeRef = useRef(1); // 0..1, read inside applyVolume
  const durRef = useRef(0);
  const tokenRef = useRef({}); // stable identity in the one-at-a-time registry
  const rafRef = useRef(null);
  const startWallRef = useRef(0); // performance.now() at tune position 0
  const busyRef = useRef(false); // re-entrancy guard while init/prime awaits
  const firstRef = useRef(true);

  const stopTicker = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  // abcjs connects its buffer sources straight to the speakers and recreates
  // them on every start/resume/seek — reroute them through our GainNode each
  // time so the volume slider works (and keeps working mid-playback).
  const applyVolume = () => {
    const synth = synthRef.current;
    if (!synth?.directSource?.length) return;
    try {
      const ac = abcjs.synth.activeAudioContext();
      if (!ac) return;
      if (!gainRef.current || gainRef.current.context !== ac) {
        gainRef.current = ac.createGain();
        gainRef.current.connect(ac.destination);
      }
      gainRef.current.gain.value = volumeRef.current;
      synth.directSource.forEach((src) => {
        try {
          src.disconnect();
          src.connect(gainRef.current);
        } catch { /* source already ended */ }
      });
    } catch (e) {
      console.warn("volume:", e);
    }
  };

  const onVolume = (e) => {
    const v = Number(e.target.value);
    setVolume(v);
    volumeRef.current = v / 100;
    if (gainRef.current) gainRef.current.gain.value = volumeRef.current;
  };

  const tick = () => {
    const dur = durRef.current;
    const t = (performance.now() - startWallRef.current) / 1000;
    if (dur > 0 && t >= dur) {
      // Reached the end: reset to the top, keep the primed synth for replay.
      stopTicker();
      try { synthRef.current?.stop(); } catch { /* already ended */ }
      setProgress(0);
      setStatus("idle");
      return;
    }
    setProgress(dur > 0 ? t / dur : 0);
    rafRef.current = requestAnimationFrame(tick);
  };

  const doPause = () => {
    if (!synthRef.current) return;
    let at;
    try { at = synthRef.current.pause(); } catch { /* not started */ }
    stopTicker();
    // pause() reports the true tune position — resync our clock to it.
    if (Number.isFinite(at)) startWallRef.current = performance.now() - at * 1000;
    setStatus("paused");
  };

  const claimFocus = () => {
    if (activePlayer && activePlayer.token !== tokenRef.current) activePlayer.pause();
    activePlayer = { token: tokenRef.current, pause: doPause };
  };

  // Refs-only teardown (also runs on unmount, where setState is not allowed).
  const halt = () => {
    stopTicker();
    try { synthRef.current?.stop(); } catch { /* never started */ }
    synthRef.current = null;
    durRef.current = 0;
    if (activePlayer?.token === tokenRef.current) activePlayer = null;
  };

  // A new tune or sound invalidates the prepared audio.
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    halt();
    setStatus("idle");
    setProgress(0);
    setDuration(0);
    setErrMsg("");
  }, [abcText, program, midiTranspose, chordsOff]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => halt(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e) => {
    console.warn("playback:", e);
    halt();
    const msg = String(e?.message || e) || "Playback failed";
    setErrMsg(/load|fetch|network/i.test(msg) ? "Couldn't load instrument sounds — check your connection" : msg);
    setStatus("error");
  };

  // Build + prime the synth (downloads soundfonts on first use), cache it.
  // Leaves status at "loading" — the caller decides where to land.
  async function ensureSynth() {
    if (synthRef.current) return synthRef.current;
    setStatus("loading");
    if (!abcjs.synth.supportsAudio()) throw new Error("This browser doesn't support audio playback");
    // "*" parses without touching the page layout.
    const visualObj = abcjs.renderAbc("*", abcText, {})[0];
    if (!visualObj) throw new Error("Couldn't parse the notation for playback");
    const synth = new abcjs.synth.CreateSynth();
    await synth.init({ visualObj, options: { program, midiTranspose, chordsOff } });
    const primed = await synth.prime();
    durRef.current = primed?.duration || synth.duration || 0;
    setDuration(durRef.current);
    synthRef.current = synth;
    return synth;
  }

  async function onPlayPause() {
    if (status === "loading" || busyRef.current) return;
    if (status === "playing") { doPause(); return; }
    if (status === "paused" && synthRef.current) {
      claimFocus();
      try { synthRef.current.resume(); } catch (e) { return fail(e); }
      applyVolume();
      stopTicker();
      rafRef.current = requestAnimationFrame(tick);
      setStatus("playing");
      return;
    }
    // idle (or retry after error) → build the synth if needed, start from the top
    busyRef.current = true;
    try {
      setErrMsg("");
      const synth = await ensureSynth();
      claimFocus();
      synth.start();
      applyVolume();
      startWallRef.current = performance.now();
      setProgress(0);
      stopTicker();
      rafRef.current = requestAnimationFrame(tick);
      setStatus("playing");
    } catch (e) {
      fail(e);
    } finally {
      busyRef.current = false;
    }
  }

  // Save the tune as a WAV file (primes the synth first if never played).
  async function onDownload() {
    if (busyRef.current || status === "loading") return;
    busyRef.current = true;
    const hadSynth = !!synthRef.current;
    try {
      const synth = await ensureSynth();
      const a = document.createElement("a");
      a.href = synth.download();
      a.download = `${downloadName}.wav`;
      a.click();
      if (!hadSynth) setStatus("idle"); // ensureSynth left us at "loading"
    } catch (e) {
      fail(e);
    } finally {
      busyRef.current = false;
    }
  }

  function onStop() {
    if (!synthRef.current) return;
    stopTicker();
    try { synthRef.current.stop(); } catch { /* never started */ }
    setProgress(0);
    setStatus("idle");
  }

  const active = status === "playing" || status === "paused";
  const canSeek = active && durRef.current > 0;

  function onSeek(e) {
    if (!canSeek || !synthRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    try { synthRef.current.seek(ratio * durRef.current, "seconds"); } catch { return; }
    applyVolume(); // seeking while playing recreates the audio sources
    startWallRef.current = performance.now() - ratio * durRef.current * 1000;
    setProgress(ratio);
  }

  if (!abcText) return null;
  const playing = status === "playing";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 10px", margin: "8px 0", background: S.surface2, border: `1px solid ${S.border}`, borderRadius: "4px" }}>
      <button
        onClick={onPlayPause}
        title={playing ? "Pause" : "Play"}
        style={{
          width: "30px", height: "30px", borderRadius: "50%", flexShrink: 0,
          background: playing ? S.gold : S.gold + "22", border: `1px solid ${S.gold}`,
          color: playing ? "#140f08" : S.gold, cursor: status === "loading" ? "wait" : "pointer",
          fontSize: "12px", lineHeight: 1, fontFamily: SERIF,
        }}
      >
        {status === "loading" ? (
          <span style={{ display: "inline-block", animation: "spin 1.2s linear infinite" }}>◌</span>
        ) : playing ? "❚❚" : "▶"}
      </button>
      {active && (
        <button onClick={onStop} title="Stop (back to start)" style={{ width: "24px", height: "24px", borderRadius: "3px", flexShrink: 0, background: "transparent", border: `1px solid ${S.border}`, color: S.muted, cursor: "pointer", fontSize: "10px", lineHeight: 1 }}>
          ■
        </button>
      )}
      {status === "error" ? (
        <span style={{ flex: 1, fontSize: "12px", color: "#d47878" }}>⚠ {errMsg} — press ▶ to retry</span>
      ) : (
        <>
          {/* Tall click strip around the thin bar so seeking is easy to hit. */}
          <div onClick={onSeek} style={{ flex: 1, height: "16px", display: "flex", alignItems: "center", cursor: canSeek ? "pointer" : "default" }}>
            <div style={{ flex: 1, height: "5px", background: S.border, borderRadius: "3px", overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, progress * 100)}%`, height: "100%", background: S.gold, transition: playing ? "none" : "width 0.15s" }} />
            </div>
          </div>
          <span style={{ fontSize: "11px", color: S.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {duration ? `${fmt(progress * duration)} / ${fmt(duration)}` : status === "loading" ? "loading sounds…" : " "}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "5px", flexShrink: 0 }} title={`Volume ${volume}%`}>
            <span style={{ fontSize: "11px", lineHeight: 1 }}>{volume === 0 ? "🔇" : volume < 50 ? "🔉" : "🔊"}</span>
            <input
              type="range" min={0} max={100} step={1}
              value={volume}
              onChange={onVolume}
              style={{ width: "60px", accentColor: S.gold, cursor: "pointer" }}
            />
          </span>
        </>
      )}
      {hint && status !== "error" && (
        <span style={{ fontSize: "10px", color: S.muted, whiteSpace: "nowrap", letterSpacing: "0.03em", borderLeft: `1px solid ${S.border}`, paddingLeft: "8px" }}>{hint}</span>
      )}
      {downloadName && status !== "error" && (
        <button
          onClick={onDownload}
          title="Save a recording of this as a .wav file"
          style={{ padding: "4px 10px", flexShrink: 0, background: "transparent", border: `1px solid ${S.goldDim}`, color: S.gold, borderRadius: "3px", cursor: status === "loading" ? "wait" : "pointer", fontSize: "11px", fontFamily: SERIF, whiteSpace: "nowrap" }}
        >
          ⬇ wav
        </button>
      )}
    </div>
  );
}
