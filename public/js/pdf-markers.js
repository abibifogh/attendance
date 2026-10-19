/**
 * Places to sign, marked in the document itself.
 *
 * Whoever writes a letter in Word types [sign:1] where the first person
 * should sign, [sign:2] for the second, [initials:1] or [date:1] likewise,
 * and saves it as a PDF. When it is chosen here, the browser reads the PDF,
 * finds those markers and where they sit, and they become the places to sign.
 * The number is the person's place in the list it is sent to; 0 is the
 * property.
 *
 * The PDF is read with pdf.js, fetched only when a PDF is chosen, so nobody
 * else pays for it.
 */
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
export const MARKER = /\[(sign|initials|date):(\d{1,2})\]/gi;

let loading = null;
export function pdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  loading ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = PDFJS;
    tag.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
      resolve(window.pdfjsLib);
    };
    tag.onerror = () => reject(new Error('Could not read the PDF to look for places to sign.'));
    document.head.append(tag);
  });
  return loading;
}

/** Where a marker sits, as a place on the page in percentages, from the top left. */
export function placeFor({ kind, signer, x, y, pageWidth, pageHeight }) {
  const field = kind.toLowerCase() === 'sign' ? 'signature' : kind.toLowerCase();
  const w = field === 'signature' ? 28 : 14;
  const h = field === 'signature' ? 6 : 3;
  const round = (n) => Math.round(n * 100) / 100;
  return {
    field,
    signer: Number(signer),
    x: round(Math.max(0, Math.min(100 - w, (x / pageWidth) * 100))),
    // The box sits on the marker's baseline and rises above it, where a
    // signature goes on a line.
    y: round(Math.max(0, Math.min(99 - h, ((pageHeight - y) / pageHeight) * 100 - h + 1))),
    w,
    h,
  };
}

/** Every marker in a PDF file, as places to sign. */
export async function findMarkers(file) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, 20); n += 1) {
    const page = await doc.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const text = await page.getTextContent();
    for (const item of text.items) {
      for (const m of String(item.str ?? '').matchAll(MARKER)) {
        const [, , , , e, f] = item.transform;
        // Roughly where in the run of text the marker starts.
        const share = item.str.length ? m.index / item.str.length : 0;
        out.push({ page: n, ...placeFor({
          kind: m[1], signer: m[2], x: e + share * (item.width ?? 0), y: f,
          pageWidth: view.width, pageHeight: view.height,
        }) });
      }
    }
  }
  return out;
}
