import { h } from './util.js';
import { pdfjs } from './pdf-markers.js';
import { PAGE_H, PAGE_W, paperPage, lastPage } from './views/letter-paper.js';

/**
 * The pages of a document, each with a layer on top for boxes.
 *
 * A PDF is drawn page by page with pdf.js; a letter written in HIVE is drawn
 * from its layout. Either way every page is a sheet that keeps its shape at
 * any width, and a box is placed on it in percentages of the page, which is
 * how it is stored and how the signed copy draws it.
 */

/** Each page as { sheet, layer, page }. `layer` is where boxes go. */
export async function drawPages({ fileUrl = null, headers = {}, letter = null }) {
  if (fileUrl) return pdfPages(fileUrl, headers);
  return letterPages(letter);
}

async function pdfPages(fileUrl, headers) {
  const response = await fetch(fileUrl, { headers, credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'The document could not be opened.');
  }
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const view = page.getViewport({ scale: Math.min(2, 1100 / base.width) });
    const canvas = h('canvas.doc-canvas', { width: Math.round(view.width), height: Math.round(view.height) });
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
    const layer = h('div.doc-layer');
    const sheet = h('div.doc-sheet', {
      style: { aspectRatio: `${base.width} / ${base.height}` },
      'aria-label': `Page ${n} of ${doc.numPages}`,
    }, canvas, layer);
    out.push({ sheet, layer, page: n });
  }
  return out;
}

function letterPages(letter) {
  const pages = lastPage(letter?.layout);
  return Array.from({ length: pages }, (_, i) => {
    const inner = h('div.doc-paper', paperPage(letter, i + 1, { bare: true }));
    const layer = h('div.doc-layer');
    const sheet = h('div.doc-sheet', {
      style: { aspectRatio: `${PAGE_W} / ${PAGE_H}` },
      'aria-label': `Page ${i + 1} of ${pages}`,
    }, inner, layer);
    // The letter is laid out at A4's pixel size; it is shrunk to the sheet.
    const fit = () => {
      const w = sheet.clientWidth;
      if (w) inner.style.transform = `scale(${w / PAGE_W})`;
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(sheet);
    requestAnimationFrame(fit);
    return { sheet, layer, page: i + 1 };
  });
}

/** Where a pointer is on a sheet, in percentages from the top left. */
export function pointOn(sheet, event) {
  const box = sheet.getBoundingClientRect();
  return {
    x: ((event.clientX - box.left) / box.width) * 100,
    y: ((event.clientY - box.top) / box.height) * 100,
  };
}

/** The colour each person's boxes are drawn in. None of them red. */
export const SIGNER_COLOURS = ['#2f6df6', '#12a594', '#8b5cf6', '#0891b2', '#65a30d', '#db2777', '#4338ca', '#8a5a2b', '#0f766e', '#6d28d9'];
export const PROPERTY_COLOUR = '#d18617';

export const FIELD_TEXT = {
  signature: 'Signature', initials: 'Initials', date: 'Date signed', name: 'Full name',
  title: 'Job title', text: 'Text they fill in', checkbox: 'Checkbox', stamp: 'Company stamp',
};

/** A new box's size, in percentages of the page. */
export const FIELD_SIZE = {
  signature: [28, 6], initials: [10, 4], date: [18, 3.5], name: [28, 3.5],
  title: [24, 3.5], text: [30, 3.5], checkbox: [3, 2.2], stamp: [16, 11],
};
