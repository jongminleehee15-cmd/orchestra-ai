// Score saved runs and compare engine versions. Offline and free: no API.
//
//   node eval/report.mjs <label>                 one version, per case
//   node eval/report.mjs <labelA> <labelB>       A vs B, per case + summary
//   ... --cases id1,id2                          only these cases
//
// Runs live in eval/runs/<label>/<caseId>-r<n>.json (see eval/README.md).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreRun, REPORT_METRICS, metricValue } from "./score.js";
import { summarize, verdict, fmt } from "./compare.js";

const RUNS = join(dirname(fileURLToPath(import.meta.url)), "runs");

const args = process.argv.slice(2);
const casesArg = args.indexOf("--cases");
const onlyCases = casesArg >= 0 ? new Set(args[casesArg + 1].split(",")) : null;
const labels = args.filter((a, i) => !a.startsWith("--") && (casesArg < 0 || i !== casesArg + 1));
if (labels.length < 1 || labels.length > 2) {
  console.error("usage: node eval/report.mjs <label> [<labelB>] [--cases id1,id2]");
  process.exit(1);
}

function load(label) {
  const dir = join(RUNS, label);
  if (!existsSync(dir)) throw new Error(`no runs for label "${label}" (looked in ${dir})`);
  const byCase = new Map();
  const provenance = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const run = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const caseId = run.meta?.caseId || f.replace(/-r\d+\.json$/, "");
    if (onlyCases && !onlyCases.has(caseId)) continue;
    const m = run.meta || {};
    provenance.add(m.legacy ? "legacy (no SHA recorded)" : `${m.gitSha?.slice(0, 7) || "?"}${m.gitDirty ? "+dirty" : ""} ${m.model || "?"} context=${m.context}`);
    if (!byCase.has(caseId)) byCase.set(caseId, []);
    byCase.get(caseId).push({ file: f, ...scoreRun(run) });
  }
  return { byCase, provenance };
}

const data = labels.map((l) => ({ label: l, ...load(l) }));
for (const d of data) {
  console.log(`${d.label}: ${[...d.byCase.values()].reduce((a, r) => a + r.length, 0)} run(s); ${[...d.provenance].join(" | ")}`);
  if (d.provenance.size > 1) console.log(`  WARNING: ${d.label} mixes runs from different code or settings; its numbers are not one version.`);
}

const caseIds = [...new Set(data.flatMap((d) => [...d.byCase.keys()]))].sort();
const tally = { better: 0, worse: 0, "within spread": 0, same: 0, "no verdict (n=1)": 0, "no data": 0 };

for (const caseId of caseIds) {
  console.log(`\n## ${caseId}`);
  const rows = {};
  for (const spec of REPORT_METRICS) {
    const s = data.map((d) => summarize((d.byCase.get(caseId) || []).map((r) => metricValue(r.metrics, spec))));
    const row = {};
    data.forEach((d, i) => { row[d.label] = fmt(s[i]); });
    if (data.length === 2) {
      const v = verdict(s[0], s[1]);
      row[`${labels[1]} vs ${labels[0]}`] = v;
      tally[v]++;
    }
    rows[spec.label] = row;
  }
  console.table(rows);
  // Transposition suspects need a by-hand look (see TRANSPOSED_OK_MIN in
  // score.js): print each one's three readings of its accompaniment.
  const pct = (x) => (x === null ? "-" : `${Math.round(x * 100)}%`);
  for (const d of data) {
    for (const r of d.byCase.get(caseId) || []) {
      for (const p of r.perPart) {
        if (!p.transposition || p.transposition.ok) continue;
        const t = p.transposition;
        console.log(`  transposition suspect: ${d.label} ${r.file} ${p.instrName}: chord fit read correctly ${pct(t.right)}, at concert pitch ${pct(t.none)}, shifted twice ${pct(t.twice)}`);
      }
    }
  }
}

if (data.length === 2) {
  console.log(`\n## Summary: ${labels[1]} vs ${labels[0]}, over ${caseIds.length} case(s) x ${REPORT_METRICS.length} metrics`);
  console.table(tally);
  console.log("A metric counts as better or worse only when the two versions' ranges across repeats do not overlap. With one run on either side there is no verdict: run more repeats (eval/generate.mjs --repeats).");
}
console.log("\nThese numbers measure consistency with the plan (melody, chords, length, range, clashes), not musical quality. Pair them with a blind listening test (eval/blind.mjs).");
