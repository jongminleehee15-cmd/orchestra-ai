import abcjs from "abcjs";

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Print one or more ABC tunes as clean sheet music: renders each to SVG
// off-screen in THIS document (abcjs needs a live element), copies the markup
// into a new window styled for paper (white, black ink, one tune per page),
// and opens the browser's print dialog. items: {abc, subtitle?} or an array.
export function printAbc(items, docTitle) {
  const tunes = (Array.isArray(items) ? items : [items]).filter((i) => i && i.abc);
  if (tunes.length === 0) return;

  const scratch = document.createElement("div");
  scratch.style.cssText = "position:absolute;left:-9999px;top:0;width:760px;";
  document.body.appendChild(scratch);
  const pages = tunes.map(({ abc, subtitle }) => {
    scratch.innerHTML = "";
    const withNumbers = /%%\s*measurenb/.test(abc) ? abc : `%%measurenb 0\n${abc}`;
    try {
      abcjs.renderAbc(scratch, withNumbers, {
        staffwidth: 700,
        wrap: { minSpacing: 1.8, maxSpacing: 2.7, preferredMeasuresPerLine: 4 },
        scale: 1.0,
        paddingleft: 0, paddingright: 0, paddingtop: 10, paddingbottom: 10,
      });
    } catch (e) {
      console.warn("print render:", e);
    }
    return `<section class="page">${subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : ""}${scratch.innerHTML}</section>`;
  });
  document.body.removeChild(scratch);

  const w = window.open("", "_blank", "width=840,height=1000");
  if (!w) {
    alert("Please allow pop-ups to print — the print view opens in a new window.");
    return;
  }
  w.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(docTitle || "Sheet music")}</title>
<style>
  body { font-family: 'Palatino Linotype', Palatino, Georgia, serif; color: #000; background: #fff; margin: 24px; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .sub { font-size: 12px; color: #444; margin: 0 0 2px; }
  svg { max-width: 100%; height: auto; }
  @page { margin: 14mm; }
  @media print { body { margin: 0; } }
</style></head><body>${pages.join("\n")}</body></html>`);
  w.document.close();
  // Let the new window lay out before opening the print dialog.
  setTimeout(() => {
    try { w.focus(); w.print(); } catch { /* window closed before printing */ }
  }, 300);
}
