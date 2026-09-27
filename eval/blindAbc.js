// A saved run as the app's full score renders it, with nothing that could
// identify the engine version: parts keep their instrument names (both sides
// of a pair have the same ones), and the title line is replaced. Pure, so the
// blind-test pages can be checked for leaks in a unit test.
import { buildFullScoreAbc } from "../src/lib/abcHelpers.js";

export function blindAbc(run, title) {
  const parts = (run.parts || []).filter((p) => p.abc).map((p) => ({
    instrName: p.instrName, baseName: p.instrName.replace(/\s+\d+$/, ""), abcText: p.abc, status: "done",
  }));
  const abc = buildFullScoreAbc(parts, { title: "x", timeSig: run.common.timeSignature, bpm: run.common.bpm, key: run.common.key });
  return abc && abc.replace(/^T:.*$/m, `T:${title}`);
}
