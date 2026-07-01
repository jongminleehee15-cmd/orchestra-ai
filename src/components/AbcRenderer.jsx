import { useEffect, useRef } from "react";
import abcjs from "abcjs";

// Renders an ABC string to engraved notation. abcjs is now an npm import — the
// old runtime <script> CDN hack is gone.
export default function AbcRenderer({ abcText, uid }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !abcText) return;
    // "%%measurenb 0" prints a measure number at the start of every staff line.
    const abc = /%%\s*measurenb/.test(abcText) ? abcText : `%%measurenb 0\n${abcText}`;
    // Fit the staff to the actual container width so wrapping breaks lines sensibly.
    const containerWidth = ref.current.offsetWidth || 660;
    const staffwidth = Math.max(320, Math.min(900, containerWidth - 24));
    try {
      abcjs.renderAbc(ref.current, abc, {
        responsive: "resize",
        staffwidth,
        // Reflow measures across multiple lines instead of cramming the whole
        // piece onto one squished staff line.
        wrap: { minSpacing: 1.8, maxSpacing: 2.7, preferredMeasuresPerLine: 4 },
        scale: 1.1,
        paddingright: 20,
        paddingleft: 20,
        paddingbottom: 20,
        paddingtop: 15,
        add_classes: true,
        foregroundColor: "#1a1208",
      });
    } catch (e) {
      console.warn("ABC render:", e);
    }
  }, [abcText, uid]);

  if (!abcText) return null;
  return (
    <div
      style={{
        background: "#fffef8",
        borderRadius: "4px",
        border: "1px solid #d8c8a0",
        padding: "8px",
        minHeight: "120px",
        boxShadow: "inset 0 1px 4px rgba(0,0,0,0.06)",
      }}
    >
      <div ref={ref} />
    </div>
  );
}
