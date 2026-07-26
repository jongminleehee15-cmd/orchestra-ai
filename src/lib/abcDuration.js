// ─────────────────────────────────────────────────────────────────────────────
// abcDuration.js — correct ABC note-length arithmetic.
//
// Client-side duplicate of server/lib/abcDuration.js so the manual editor can
// validate offline without a backend round-trip. Kept in sync by hand for now
// (see Stage 8 about de-duplicating these permanently).
// ─────────────────────────────────────────────────────────────────────────────

// Parse the length suffix of a note: "", "2", "/", "//", "/2", "3/2", "3/".
//   ""    -> 1        "2"  -> 2       "/"   -> 1/2
//   "//"  -> 1/4      "/2" -> 1/2     "3/2" -> 1.5      "/4" -> 1/4
export function parseLen(s) {
  if (!s) return 1;
  const m = String(s).match(/^(\d*)(\/*)(\d*)$/);
  if (!m) return 1;
  const num = m[1] ? parseInt(m[1], 10) : 1;
  const slashes = m[2].length;
  if (slashes === 0) return num;
  const den = m[3] ? parseInt(m[3], 10) : Math.pow(2, slashes);
  return den ? num / den : num;
}

// Default tuplet ratio per ABC 2.1: (p means "p notes in the time of q".
// q depends on p, and for p in {5,7,9} on whether the meter is compound.
function defaultQ(p, compound) {
  switch (p) {
    case 2: return 3;
    case 3: return 2;
    case 4: return 3;
    case 6: return 2;
    case 8: return 3;
    case 5: case 7: case 9: return compound ? 3 : 2;
    default: return 2;
  }
}

const NOTE_OR_REST = /(\[[^\]]*\]|[_^=]*[a-gA-G][,']*|[zx])((?:\d*\/*\d*))?/g;

// Total duration of one measure's note text, in L units.
// `compound` should be true for 6/8, 9/8, 12/8 (affects default tuplet ratios).
export function measureUnits(measureStr, { compound = false, barUnits = 8 } = {}) {
  let s = String(measureStr ?? "")
    .replace(/!.*?!/g, "")        // !mf! decorations
    .replace(/\+.*?\+/g, "")      // legacy +mf+ decorations
    .replace(/"[^"]*"/g, "")      // "Cmaj7" chord symbols / annotations
    .replace(/\{[^}]*\}/g, "")    // {grace notes} carry no bar time
    .replace(/%.*$/gm, "");       // trailing comments

  // Whole-bar rests: Z = one bar, Zn = n bars.
  const wholeBar = s.match(/Z(\d*)/);
  if (wholeBar) return barUnits * (wholeBar[1] ? parseInt(wholeBar[1], 10) : 1);

  // Pull out tuplet declarations first, recording where each starts and how
  // many of the following notes it scales.
  const tuplets = [];
  s = s.replace(/\((\d)(?::(\d*))?(?::(\d*))?/g, (full, p, q, r, offset) => {
    const P = parseInt(p, 10);
    const Q = q ? parseInt(q, 10) : defaultQ(P, compound);
    const R = r ? parseInt(r, 10) : P;
    tuplets.push({ at: offset, notes: R, ratio: Q / P });
    return " ".repeat(full.length); // preserve offsets
  });

  s = s.replace(/[()\-><~.]/g, " ");   // slurs, ties, broken rhythm, staccato

  let total = 0;
  let pending = null; // active tuplet: { left, ratio }
  let m;
  NOTE_OR_REST.lastIndex = 0;
  while ((m = NOTE_OR_REST.exec(s)) !== null) {
    // Activate a tuplet whose declaration sits before this note.
    while (tuplets.length && tuplets[0].at <= m.index) {
      const t = tuplets.shift();
      pending = { left: t.notes, ratio: t.ratio };
    }
    let dur;
    if (m[1].startsWith("[")) {
      // Chord: outer length wins; otherwise take the first inner note's length.
      dur = m[2] ? parseLen(m[2]) : parseLen((m[1].match(/[a-gA-G][,']*(\d*\/*\d*)/) || [])[1]);
    } else {
      dur = parseLen(m[2]);
    }
    if (pending && pending.left > 0) {
      dur *= pending.ratio;
      pending.left -= 1;
      if (pending.left === 0) pending = null;
    }
    total += dur;
  }
  return total;
}

export function barUnitsFor(timeSignature) {
  const [num, den] = String(timeSignature || "4/4").split("/").map((n) => parseInt(n, 10));
  return (num || 4) * 8 / (den || 4);
}
export function isCompound(timeSignature) {
  const [num, den] = String(timeSignature || "4/4").split("/").map((n) => parseInt(n, 10));
  return den === 8 && num % 3 === 0 && num > 3;
}
