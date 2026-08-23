import abcjs from "abcjs";

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Print one or more ABC tunes as clean sheet music: renders each to SVG
// off-screen in THIS document (abcjs needs a live element), then prints via
// a HIDDEN SAME-PAGE IFRAME styled for paper (white, black ink, one tune per
// page). items: {abc, subtitle?} or an array.
//
// Deliberately NOT window.open(): an empty-URL window.open("", "_blank") is
// aggressively popup-blocked by Chrome — it reads exactly like popup spam —
// so this silently did nothing for real users, or (worse) hit the old
// alert() fallback, which is a NATIVE blocking dialog that freezes the whole
// page/tab until manually dismissed. An iframe on the current page needs no
// popup permission and can't hit either failure mode.
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

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(docTitle || "Sheet music")}</title>
<style>
  body { font-family: 'Palatino Linotype', Palatino, Georgia, serif; color: #000; background: #fff; margin: 24px; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .sub { font-size: 12px; color: #444; margin: 0 0 2px; }
  svg { max-width: 100%; height: auto; }
  @page { margin: 14mm; }
  @media print { body { margin: 0; } }
</style></head><body>${pages.join("\n")}</body></html>`;

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener("focus", cleanup);
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
  };

  iframe.onload = () => {
    try {
      // Removing the iframe re-focuses the page — that's the reliable
      // cross-browser signal that the print dialog/preview closed. A
      // timeout is still a fallback in case focus never fires (e.g. the
      // print was silently cancelled without ever showing a dialog).
      window.addEventListener("focus", cleanup, { once: true });
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.warn("print:", e);
      cleanup();
    }
    setTimeout(cleanup, 15000);
  };
  iframe.srcdoc = html;
}
