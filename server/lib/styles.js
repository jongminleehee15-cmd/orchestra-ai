// Concrete arranging directives per style and density.
//
// A bare style word buried in a header line ("STYLE: Jazz") changed almost
// nothing about the output — the model needs to be told WHAT to do
// differently. Each entry spells out rhythm feel, harmony, texture,
// articulation, and dynamics in the model's working vocabulary (ABC
// decorations, chord extensions, note values). Keys must match STYLES /
// DENSITIES in src/lib/constants.js.

export const STYLE_DIRECTIVES = {
  Original: `- Match how the song ACTUALLY sounds — its genre (see the SONG line), groove, and characteristic accompaniment patterns ARE the style guide
- Reproduce the original recording's feel translated to this ensemble: its rhythmic signature (straight vs swung, driving vs laid-back), its typical voicings, its idiomatic backing figures
- Impose NO outside aesthetic; when in doubt, write what the original artist's band would have played`,
  Cinematic: `- Long-breathed lines over sustained low pads; build in waves toward ONE big climax about two-thirds through, then resolve
- Wide dynamic range — !p! swells to !ff! — with low brass/timpani reinforcing arrival points
- At climaxes, countermelodies soar ABOVE the tune and peak measures get octave doublings`,
  Romantic: `- Espressivo singing lines with written-in flexibility: dotted values, ties across barlines, phrase-end lingering
- Rich chromatic inner voices — suspensions resolving down, secondary dominants and borrowed chords between the given harmonies
- Accompaniment in flowing arpeggios or gently repeated chords; hairpin dynamics (!p!→!f!→!p!) shaping every phrase`,
  Baroque: `- Continuous eighth-note motion; melodic SEQUENCES (repeat a figure a step higher/lower); imitative entries — accompaniment voices echo the melody's opening a bar later
- Strictly functional harmony and a walking bass in steady quarters or eighths
- Terraced dynamics: whole phrases at !f! or !p! with NO gradual crescendos; trills at cadences`,
  Jazz: `- Swing the eighths: use dotted-eighth+sixteenth pairs and off-beat syncopation everywhere; accent weak beats
- Extend EVERY chord (7ths, 9ths, 13ths) and insert ii–V motion between the given chords; blue notes (♭3, ♭7) in the fills
- Bass WALKS in quarters; comping voices hit short syncopated chord stabs with rests between — never held pads`,
  Minimalist: `- Build from short repeating cells (1–2 bars) that evolve GRADUALLY — add or drop one note per repetition, never a wholesale change
- Static or glacially slow harmony; an unbroken steady pulse; layered ostinati that interlock rhythmically across instruments
- Dynamics shift by long, patient degrees; no dramatic gestures, no big cadences`,
  Epic: `- Massive block scoring: tutti unison/octave statements of the tune answered by full-ensemble chord hits
- Driving low-voice ostinati (relentless eighths or dotted figures); brass and percussion lead the texture
- Start big and GROW: the final section lands at sustained !ff! with the melody doubled across three octaves`,
  Playful: `- Light staccato articulation (.), grace notes, sudden !p!/!f! flips, hiccup syncopations and surprise rests mid-phrase
- Bouncing accompaniment — off-beat chords, oom-pah figures; melody fragments tossed between instruments
- Quick ornamental turns; clip phrase endings short instead of holding them`,
  Mysterious: `- Sink into low, dark registers (within each range); sustained open fifths, minor and half-diminished colors
- SPARSE texture — silence is the main effect: isolated solo entrances, tremolo shimmer, whole measures of rest
- Chromatic neighbor tones and phrase endings left unresolved; hold dynamics between !pp! and !mp! with rare swells`,
  Impressionist: `- Plane chords in PARALLEL motion (triads/7ths sliding whole steps); color the given harmony with pentatonic and whole-tone tones
- Washy, blurred accompaniment: rolled arpeggios, overlapping sustained tones, avoid a hard bass downbeat
- Soft palette (!pp!–!mf!); let phrases float in and out rather than cadence firmly`,
};

export const DENSITY_DIRECTIVES = {
  Sparse: "THIN texture: only 1–2 voices sounding at any moment; generous rests — whole tacet measures are welcome; accompaniment enters only where it truly matters",
  Moderate: "Balanced texture: melody and bass always present, 1–2 inner voices active at a time; every instrument gets some resting measures",
  Full: "Full texture: all voices active most of the time, each with INDEPENDENT material; short rests only for breathing",
  Lush: "Maximum richness: thick divisi-style voicings, lines doubled an octave apart, overlapping countermelodies — nearly continuous contribution from every instrument",
};

// Prompt block combining both. Unknown labels degrade to a generic-but-firm
// instruction so custom values still steer the output.
export function styleBlock(style, density) {
  const lines = [];
  const s = STYLE_DIRECTIVES[style];
  if (s) lines.push(`STYLE — make this unmistakably ${style}; these directives OVERRIDE generic habits:\n${s}`);
  else if (style) lines.push(`STYLE — lean strongly into a "${style}" character in rhythm, harmony, articulation, and dynamics; it must be audible, not cosmetic.`);
  const d = DENSITY_DIRECTIVES[density];
  if (d) lines.push(`DENSITY (${density}): ${d}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}
