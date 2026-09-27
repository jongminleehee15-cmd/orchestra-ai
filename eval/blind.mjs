// Blind A/B listening test between two engine versions. Offline and free.
//
//   node eval/blind.mjs make <labelA> <labelB> [--cases id1,id2] [--repeat 1]
//     Writes eval/blind/<timestamp>/ with one page per case (pair-01.html...),
//     in shuffled order, each playing the two arrangements as "X" and "Y"
//     with the sides assigned at random. Which label is X is ONLY in key.json:
//     don't open it until every pair is rated.
//   node eval/blind.mjs score <dir>
//     Reads <dir>/results.csv (filled in by the listener) and key.json, and
//     prints how often each version was preferred.
//
// Nothing on a page names a version: no labels, file names or run metadata,
// and the score title is replaced. The pages need a connection the first time
// they play, to fetch instrument sounds (as the app does).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";
import { blindAbc } from "./blindAbc.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
const die = (msg) => { console.error(`eval/blind: ${msg}`); process.exit(1); };

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

function page(n, total, x, y) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair ${n} of ${total}</title>
<style>
  body { font-family: Georgia, serif; margin: 0 auto; max-width: 60rem; padding: 1.5rem 1rem; background: #fbfaf7; color: #222; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
  button { font: inherit; padding: .4rem 1rem; margin-right: .5rem; cursor: pointer; }
  .status { color: #666; margin-left: .5rem; }
  .score { overflow-x: auto; background: #fff; border: 1px solid #ddd; margin-top: .75rem; }
  p.help { color: #444; }
</style></head><body>
<h1>Pair ${n} of ${total}</h1>
<p class="help">Listen to both versions, as often as you like. Then write in results.csv, on the row for pair ${n}, which one you would rather hand to players: X, Y, or same. Judge the whole arrangement (does the tune come through, do the parts fit together, would it sound good played live), not the synth sound.</p>
<section><h2>Version X</h2><button data-v="x">Play</button><button data-stop="x">Stop</button><span class="status" id="st-x"></span><div class="score" id="score-x"></div></section>
<section><h2>Version Y</h2><button data-v="y">Play</button><button data-stop="y">Stop</button><span class="status" id="st-y"></span><div class="score" id="score-y"></div></section>
<script src="abcjs-basic-min.js"></script>
<script>
const TUNES = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
const synths = {};
const visual = {};
for (const v of ["x", "y"]) visual[v] = ABCJS.renderAbc("score-" + v, TUNES[v], { responsive: "resize" })[0];
function stopAll() { for (const v in synths) { try { synths[v].stop(); } catch (e) {} document.getElementById("st-" + v).textContent = ""; } }
document.querySelectorAll("[data-stop]").forEach((b) => b.onclick = () => stopAll());
document.querySelectorAll("[data-v]").forEach((b) => b.onclick = async () => {
  const v = b.dataset.v, st = document.getElementById("st-" + v);
  stopAll();
  try {
    if (!ABCJS.synth.supportsAudio()) throw new Error("This browser can't play audio.");
    if (!synths[v]) {
      st.textContent = "Loading sounds...";
      const s = new ABCJS.synth.CreateSynth();
      await s.init({ visualObj: visual[v], options: { chordsOff: true } });
      await s.prime();
      synths[v] = s;
    }
    synths[v].start();
    st.textContent = "Playing";
  } catch (e) { st.textContent = "Playback failed: " + e.message; }
});
</script></body></html>
`;
}

function make() {
  const labels = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
  if (labels.length !== 2) die("usage: node eval/blind.mjs make <labelA> <labelB> [--cases id1,id2] [--repeat 1]");
  const repeat = Number(opt("--repeat", "1"));
  const only = opt("--cases") ? new Set(opt("--cases").split(",")) : null;
  const load = (label, caseId) => {
    const f = join(ROOT, "eval", "runs", label, `${caseId}-r${repeat}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  };
  const caseIds = [...new Set(labels.flatMap((l) => {
    const dir = join(ROOT, "eval", "runs", l);
    if (!existsSync(dir)) die(`no runs for label "${l}"`);
    return readdirSync(dir).map((f) => f.match(/^(.+)-r\d+\.json$/)?.[1]).filter(Boolean);
  }))].filter((id) => (!only || only.has(id)) && labels.every((l) => load(l, id)));
  if (!caseIds.length) die(`no case has a repeat ${repeat} run under both labels`);

  const dir = join(ROOT, "eval", "blind", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, "node_modules", "abcjs", "dist", "abcjs-basic-min.js"), join(dir, "abcjs-basic-min.js"));
  const order = shuffle(caseIds);
  const key = { labels, repeat, pairs: {} };
  const csv = ["pair,preferred (X / Y / same),notes"];
  order.forEach((caseId, i) => {
    const n = i + 1;
    const [xLabel, yLabel] = randomInt(2) ? [labels[1], labels[0]] : [labels[0], labels[1]];
    const x = blindAbc(load(xLabel, caseId), `Pair ${n}, version X`);
    const y = blindAbc(load(yLabel, caseId), `Pair ${n}, version Y`);
    if (!x || !y) die(`case ${caseId}: a run has no finished parts`);
    writeFileSync(join(dir, `pair-${String(n).padStart(2, "0")}.html`), page(n, order.length, x, y));
    key.pairs[n] = { caseId, X: xLabel, Y: yLabel };
    csv.push(`${n},,`);
  });
  writeFileSync(join(dir, "key.json"), JSON.stringify(key, null, 2) + "\n");
  writeFileSync(join(dir, "results.csv"), csv.join("\n") + "\n");
  console.log(`Wrote ${order.length} pair(s) to ${dir}\nOpen pair-01.html onward in a browser and fill in results.csv. Don't open key.json until you're done; then run:\n  node eval/blind.mjs score "${dir}"`);
}

function score() {
  const dir = rest[0] || die("usage: node eval/blind.mjs score <dir>");
  const key = JSON.parse(readFileSync(join(dir, "key.json"), "utf8"));
  const tally = Object.fromEntries([...key.labels, "same", "unrated"].map((k) => [k, 0]));
  const rows = [];
  const lines = readFileSync(join(dir, "results.csv"), "utf8").split(/\r?\n/).slice(1).filter((l) => l.trim());
  for (const line of lines) {
    const [pair, choiceRaw = "", ...notes] = line.split(",");
    const k = key.pairs[pair.trim()];
    if (!k) die(`results.csv names pair "${pair}", which key.json doesn't have`);
    const choice = choiceRaw.trim().toUpperCase();
    const winner = choice === "X" ? k.X : choice === "Y" ? k.Y : choice === "SAME" ? "same" : "unrated";
    tally[winner]++;
    rows.push({ pair: Number(pair), case: k.caseId, preferred: winner, notes: notes.join(",").trim() });
  }
  console.table(rows);
  console.table(tally);
  console.log("One listener and a handful of pairs is a direction, not proof. Repeat with other listeners before acting on a close result.");
}

if (cmd === "make") make();
else if (cmd === "score") score();
else die("usage: node eval/blind.mjs make <labelA> <labelB> ... | score <dir>");
