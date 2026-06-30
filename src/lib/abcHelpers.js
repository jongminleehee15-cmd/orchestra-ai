// Wrap the bare canonical melody body (single ABC note line from the blueprint)
// in proper ABC headers so abcjs can render the lead-sheet preview.
export function buildLeadSheetAbc(melodyAbc, { key, timeSig, bpm }) {
  if (!melodyAbc) return null;
  return `X:1\nT:Main Melody\nM:${timeSig}\nL:1/8\nQ:1/4=${bpm}\nK:${key}\n${melodyAbc}`;
}

// Concatenate the lead sheet + every generated part into one downloadable .abc.
export function buildScoreAbc(leadSheetAbc, parts) {
  const header = leadSheetAbc ? leadSheetAbc + "\n\n" : "";
  return header + parts.filter((p) => p.abcText).map((p) => p.abcText).join("\n\n");
}
