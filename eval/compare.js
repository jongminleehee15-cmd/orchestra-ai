// Aggregating repeat runs and comparing two engine versions. Pure.
//
// The rule is deliberately strict because n is small and LLM output varies a
// lot run to run (Canon's chord flags went 5 then 8 on the SAME plan): a
// difference counts only when the two labels' ranges across repeats do not
// overlap at all. With a single run on either side there is no spread to
// compare against, so there is no verdict, only the numbers.

export function summarize(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (!v.length) return { n: 0, mean: null, min: null, max: null };
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
}

// Lower is better for every metric. Returns "better" / "worse" (B relative
// to A), "same", "within spread", or "no verdict (n=1)".
export function verdict(a, b) {
  if (!a.n || !b.n) return "no data";
  if (a.min === a.max && b.min === b.max && a.min === b.min) return "same";
  if (a.n < 2 || b.n < 2) return "no verdict (n=1)";
  if (b.max < a.min) return "better";
  if (b.min > a.max) return "worse";
  return "within spread";
}

export function fmt(s, digits = 1) {
  if (!s.n) return "-";
  const r = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(digits));
  return s.min === s.max ? `${r(s.mean)} (n=${s.n})` : `${r(s.mean)} [${r(s.min)}-${r(s.max)}] (n=${s.n})`;
}
