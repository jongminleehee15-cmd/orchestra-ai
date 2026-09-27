// Generate evaluation runs through the real API, exactly as the app does.
// THIS COSTS MONEY (Anthropic API calls). Nothing is spent without --yes.
//
//   node eval/generate.mjs --label <name> [--cases id1,id2] [--repeats 2]
//                          [--no-context] [--allow-dirty] [--dry-run] [--yes]
//
// Safety, because of this repo's environment traps (CLAUDE.md):
// - It starts its OWN server (plain `node index.js`, never --watch) on a free
//   port and talks only to that, so a stale server on :3001 can never answer
//   with old code. If the child exits early (a crash, a bad .env) it stops.
// - It records the git SHA and refuses a dirty working tree unless
//   --allow-dirty, so every saved run names the code that produced it.
// - --dry-run starts the server and checks health and the library (both
//   free), then stops. Without --yes it only prints what it would do.
//
// Mirrors App.jsx: one /api/blueprint, then one /api/part per voice, in
// voice order, each sent the parts finished before it (trimmed by the app's
// own fitContext) plus the plan's instrumentRoles. Existing run files are
// skipped, so an interrupted batch resumes where it stopped.
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import { fitContext } from "../src/lib/context.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = JSON.parse(readFileSync(join(ROOT, "eval", "suite.json"), "utf8"));

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`${name} needs a value`);
  return v;
};
const label = opt("--label");
const repeats = Number(opt("--repeats", "2"));
const context = !flag("--no-context");
const dryRun = flag("--dry-run");
const casesOpt = opt("--cases", "all");
const caseIds = casesOpt === "all" ? SUITE.cases.map((c) => c.id) : casesOpt.split(",");
const cases = caseIds.map((id) => SUITE.cases.find((c) => c.id === id) || die(`unknown case "${id}"`));
if (!dryRun && (!label || !/^[\w.-]+$/.test(label))) die("--label <name> is required (letters, digits, . _ -)");
if (!Number.isInteger(repeats) || repeats < 1) die("--repeats must be a positive integer");

function die(msg) { console.error(`eval/generate: ${msg}`); process.exit(1); }

// ── provenance ───────────────────────────────────────────────────────────────
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const gitSha = git("rev-parse", "HEAD");
// Saved runs and listening sessions are this harness's own output, not code:
// they must not make the tree "dirty", or the second label could never run.
// --untracked-files=all lists new files one by one, so the excludes apply
// even while a whole new folder is untracked.
const gitDirty = git("status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)eval/runs", ":(exclude)eval/blind").length > 0;

// ── the plan, and what it could cost ─────────────────────────────────────────
const voicesOf = (c) => c.instruments.flatMap((i) => (i.count > 1 ? Array.from({ length: i.count }, (_, k) => `${i.name} ${k + 1}`) : [i.name]));
const outDir = label ? join(ROOT, "eval", "runs", label) : null;
const todo = [];
for (const c of cases) for (let r = 1; r <= repeats; r++) {
  const file = outDir ? join(outDir, `${c.id}-r${r}.json`) : null;
  if (file && existsSync(file)) continue;
  todo.push({ c, r, file });
}
const parts = todo.reduce((a, t) => a + voicesOf(t.c).length, 0);
// Per arrangement: the blueprint, plus a melody-extension call for library
// works asked for more bars than the source, plus web-search ground truth on
// the free-text path. Each part is one call, up to two with its repair retry;
// long parts are generated in ~16-bar chunks, each with its own call(s).
console.log(`Plan: ${todo.length} arrangement(s) to generate (${cases.length} case(s) x ${repeats} repeat(s), existing files skipped), ${parts} part(s), context ${context ? "ON" : "OFF"}.`);
console.log(`Model calls: roughly ${todo.length * 2 + parts} to ${todo.length * 3 + parts * 4}. Check your Anthropic console for the actual cost after a first small run (--cases <one id> --repeats 1).`);
console.log(`Code: ${gitSha.slice(0, 7)}${gitDirty ? " + UNCOMMITTED changes" : ""}.`);
if (!dryRun && !flag("--yes")) {
  console.log("\nNothing was generated. Re-run with --yes to spend the API calls, or --dry-run to check the setup for free.");
  process.exit(0);
}
if (gitDirty && !dryRun && !flag("--allow-dirty")) {
  die(`the working tree has uncommitted changes, so these runs could not be tied to a commit. Commit first, or pass --allow-dirty (recorded in every run as gitDirty: true).`);
}

// ── our own server ───────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// node:http rather than fetch: fetch gives up after 300 s without response
// headers, and a long chunked part can legitimately take longer than that.
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port, path, method,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (ch) => { text += ch; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* reported below */ }
        if (res.statusCode >= 400 || !json) reject(new Error(`${method} ${path} -> ${res.statusCode}: ${json?.error || text.slice(0, 200)}`));
        else resolve(json);
      });
    });
    req.on("error", reject);
    // Generous: a long chunked part with retries can take many minutes. This
    // only stops a request that will never answer from hanging the batch.
    req.setTimeout(20 * 60 * 1000, () => req.destroy(new Error(`${method} ${path}: no response in 20 minutes`)));
    if (data) req.write(data);
    req.end();
  });
}

async function startServer() {
  const port = await freePort();
  mkdirSync(outDir || join(ROOT, "eval", "runs"), { recursive: true });
  const logFile = join(outDir || join(ROOT, "eval", "runs"), `server-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const log = createWriteStream(logFile);
  const child = spawn(process.execPath, ["index.js"], { cwd: join(ROOT, "server"), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exited = null;
  child.once("exit", (code) => { exited = code ?? "signal"; });
  for (let i = 0; i < 60; i++) {
    if (exited !== null) throw new Error(`the server exited during startup (code ${exited}); see ${logFile}`);
    try {
      const health = await request(port, "GET", "/api/health");
      // Answered, but our child is gone: something else holds the port.
      // Never trust that answer.
      if (exited !== null) throw new Error(`port ${port} answered but our server had exited (code ${exited}); see ${logFile}`);
      return { port, child, health, logFile, alive: () => exited === null };
    } catch (e) {
      if (/answered but our server/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  child.kill();
  throw new Error(`the server never answered on port ${port}; see ${logFile}`);
}

// ── one arrangement, as the app makes it ─────────────────────────────────────
async function arrange(srv, c, library) {
  const song = c.free
    ? { title: c.free.title, artist: "", genre: "", key: c.free.key, timeSignature: c.free.timeSignature, bpm: c.free.bpm }
    : library.find((s) => s.libraryId === c.libraryId);
  if (!song) throw new Error(`library work "${c.libraryId}" is not in /api/library`);
  const voices = voicesOf(c);
  const common = {
    songTitle: song.title, songArtist: song.artist || "", songGenre: song.genre || "", songNotes: "",
    style: c.style, density: c.density, tempoFeel: c.tempoFeel || "Moderate",
    key: song.key || "C", timeSignature: song.timeSignature || "4/4", bpm: song.bpm || 100, measures: c.measures,
  };
  const t0 = Date.now();
  const { plan } = await request(srv.port, "POST", "/api/blueprint", {
    ...common, instruments: voices.map((name) => ({ name, count: 1 })),
    ...(c.libraryId ? { libraryId: c.libraryId } : {}),
  });
  // The app keeps its measure count in sync with the plan's (App.jsx).
  const measures = plan?.measures || c.measures;
  const done = [];
  for (const instrName of voices) {
    if (!srv.alive()) throw new Error("the server died mid-run");
    const finished = done.filter((p) => p.abc).map((p) => ({ instrName: p.instrName, abc: p.abc }));
    const t1 = Date.now();
    try {
      const r = await request(srv.port, "POST", "/api/part", {
        ...common, measures, instrName, otherInstruments: voices.join(", "),
        role: plan?.instrumentRoles?.[instrName] || null,
        melodyAbc: plan?.melodyAbc, chords: plan?.chords,
        instrumentRoles: plan?.instrumentRoles || null,
        contextParts: context ? fitContext(finished) : [],
      });
      done.push({ instrName, abc: r.abc, melodyWarnings: r.melodyWarnings || [], rangeWarnings: r.rangeWarnings || [], harmonyWarnings: r.harmonyWarnings || [] });
      console.log(`    ${instrName}: ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    } catch (e) {
      // The app marks the part as failed and carries on; so does this.
      done.push({ instrName, abc: null, error: e.message });
      console.log(`    ${instrName}: FAILED ${e.message}`);
    }
  }
  return { common: { ...common, measures }, voices, plan, parts: done, seconds: Math.round((Date.now() - t0) / 1000) };
}

// ── main ─────────────────────────────────────────────────────────────────────
const srv = await startServer();
const stop = () => { if (srv.alive()) srv.child.kill(); };
process.on("SIGINT", () => { stop(); process.exit(130); });
try {
  console.log(`\nServer: pid ${srv.child.pid} on port ${srv.port}, model ${srv.health.model}, API key ${srv.health.hasKey ? "set" : "MISSING"}. Log: ${srv.logFile}`);
  const { songs } = await request(srv.port, "GET", "/api/library");
  const missing = cases.filter((c) => c.libraryId && !songs.some((s) => s.libraryId === c.libraryId));
  if (missing.length) throw new Error(`library work(s) missing: ${missing.map((c) => c.libraryId).join(", ")}`);
  if (dryRun) {
    console.log(`Dry run OK: our own server answered, and all ${cases.filter((c) => c.libraryId).length} library case(s) resolve. Nothing was generated.`);
  } else {
    if (!srv.health.hasKey) throw new Error("the server has no ANTHROPIC_API_KEY (server/.env)");
    mkdirSync(outDir, { recursive: true });
    const failed = [];
    for (const { c, r, file } of todo) {
      console.log(`\n${c.id} r${r}`);
      if (!srv.alive()) throw new Error("the server died; re-run the same command to resume");
      let run;
      try {
        run = await arrange(srv, c, songs);
      } catch (e) {
        // Nothing is saved, so re-running the same command retries it.
        console.log(`  FAILED, not saved: ${e.message}`);
        failed.push(`${c.id} r${r}`);
        continue;
      }
      const meta = {
        label, caseId: c.id, repeat: r, context, date: new Date().toISOString(),
        gitSha, gitDirty, model: srv.health.model, legacy: false, seconds: run.seconds,
      };
      delete run.seconds;
      writeFileSync(file, JSON.stringify({ meta, ...run }, null, 2) + "\n");
      console.log(`  saved ${file} (${meta.seconds}s)`);
    }
    if (failed.length) {
      console.log(`\n${failed.length} arrangement(s) failed and were not saved: ${failed.join(", ")}. Re-run the same command to retry them.`);
      process.exitCode = 1;
    }
    console.log(`\nDone. Score it with: node eval/report.mjs ${label}`);
  }
} catch (e) {
  console.error(`\neval/generate: ${e.message}`);
  process.exitCode = 1;
} finally {
  stop();
}
