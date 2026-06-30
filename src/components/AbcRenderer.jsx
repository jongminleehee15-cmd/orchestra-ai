import { useEffect, useRef } from "react";
import abcjs from "abcjs";

// Renders an ABC string to engraved notation. abcjs is now an npm import — the
// old runtime <script> CDN hack is gone.
export default function AbcRenderer({ abcText, uid }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !abcText) return;
    try {
      abcjs.renderAbc(ref.current, abcText, {
        responsive: "resize",
        staffwidth: 660,
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
