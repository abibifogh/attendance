import { state } from './app.js';
import { BRAND, brandMark } from './brand.js';
import { h } from './util.js';

/**
 * Turning a report into a PDF.
 *
 * This goes through the browser's own print dialog ("Save as PDF") rather than
 * a PDF library. That is a deliberate choice, not a shortcut:
 *
 *  - the charts are already SVG, so they come out as vector — sharp at any
 *    zoom, and selectable text rather than a screenshot;
 *  - no 500KB dependency to download, and nothing fetched from a CDN, which
 *    matters because the whole app is served from one origin;
 *  - page size, margins and orientation stay under the reader's control.
 *
 * What this file adds is everything the browser cannot know: a proper title
 * block, and a print stylesheet that hides the furniture. It matters more here
 * than most places — a per-person attendance slip exists to be printed and
 * handed over.
 */

let cleanup = null;

export function printReport({ title, subtitle, note, footer, onePage = false }) {
  // A second click while the dialog is open would stack two headers.
  if (cleanup) cleanup();

  const generated = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const header = h('div.print-header',
    h('div.print-brand',
      brandMark('1.05em'),
      h('strong', state.settings.property_name || BRAND.name),
      state.settings.property_name
        ? h('span', { style: { color: '#6b7280', fontWeight: 400 } }, ` · ${BRAND.name}`)
        : null,
    ),
    h('h1.print-title', title),
    subtitle ? h('div.print-subtitle', subtitle) : null,
    note ? h('div.print-note', note) : null,
    h('div.print-meta', `Prepared ${generated}${state.name ? ` · ${state.name}` : ''}`),
  );

  // The provenance line. Worth carrying on most reports because a printed one
  // outlives the screen it came from, and somebody handed it deserves to know
  // which parts a machine observed and which a person decided.
  //
  // `footer: false` leaves it off. A note explaining how the figures were
  // arrived at earns its space on a report that is read; on a one-page record
  // handed to the person it is about, it is three lines of small print that
  // push the last week of their month onto a second sheet.
  const footerEl = footer === false || footer === null
    ? null
    : h('div.print-footer', footer
      || 'Clock times come from the attendance terminal. Where a punch was missing, the time shown '
        + 'was supplied by a supervisor and is noted as such.');

  document.body.prepend(header);
  if (footerEl) document.body.append(footerEl);
  document.body.classList.add('printing');
  if (onePage) document.body.classList.add('printing-one-page');

  cleanup = () => {
    header.remove();
    footerEl?.remove();
    document.body.classList.remove('printing', 'printing-one-page');
    cleanup = null;
  };

  // Chrome fires this after the dialog closes; Safari may not, so also clean up
  // on a timer as a backstop. Either way the page must not be left altered.
  const after = () => {
    window.removeEventListener('afterprint', after);
    if (cleanup) cleanup();
  };
  window.addEventListener('afterprint', after);
  setTimeout(() => { if (cleanup) cleanup(); }, 60_000);

  // Give the browser a frame to lay the header out before the dialog opens.
  requestAnimationFrame(() => window.print());
}

/** The button every report screen carries. */
export function printButton({ title, subtitle, note, footer, label, onePage }) {
  return h('button.btn-sm', {
    title: 'Opens your print dialog — choose “Save as PDF” as the destination',
    onclick: () => printReport({ title, subtitle, note, footer, onePage }),
    // No emoji on the label. A phone draws it in full colour and it reads as
    // decoration on a button that is doing a job.
  }, label || 'Save as PDF');
}
