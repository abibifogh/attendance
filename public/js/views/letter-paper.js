import { h } from '../util.js';

/**
 * A letter, drawn as the page it will be.
 *
 * ONE RENDERER, FOUR PLACES. The composer, the preview, the letter's own page
 * and the signing page a supplier opens all draw the letter through this. It
 * is the only way the thing somebody signs is provably the thing somebody
 * wrote: four renderers would agree until the day one of them did not, and
 * that day would be a dispute about a signed document.
 *
 * THE PAGE IS A FIXED SIZE AND THE ZOOM IS A TRANSFORM. Everything inside is
 * laid out against a 794 by 1123 pixel A4 — the size a browser prints at 96
 * dots to the inch — and shrinking it for a phone or a side panel is a scale
 * on the outside. Nothing inside reflows, so what is on screen at 40% is what
 * comes out of the printer.
 */

export const PAGE_W = 794;
export const PAGE_H = 1123;

const FACES = {
  serif: 'Georgia, "Times New Roman", Times, serif',
  sans: '-apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  mono: 'ui-monospace, "Courier New", monospace',
};

export const faceCss = (key) => FACES[key] ?? FACES.serif;

/**
 * One page of a letter.
 *
 * `interactive` is what the composer passes: it wants the blocks as buttons it
 * can select and drag. Everywhere else they are just words on paper.
 */
export function paperPage(letter, page = 1, {
  scale = 1, interactive = false, onBlock = null, selected = null,
} = {}) {
  const layout = letter.layout ?? { blocks: [] };
  const head = letter.letterhead ?? null;
  const showHead = head && (page === 1 || head.laterPages);

  const blocks = (layout.blocks ?? []).filter((b) => (b.page ?? 1) === page);

  const sheet = h('div.paper-page', {
    style: {
      width: `${PAGE_W}px`,
      height: `${PAGE_H}px`,
      ...(showHead ? { backgroundImage: `url(${head.image})` } : {}),
    },
  },
  blocks.map((block) => {
    const el = h(interactive ? 'div.paper-block.paper-live' : 'div.paper-block', {
      'data-block': block.id,
      class: selected === block.id ? 'paper-on' : '',
      style: {
        left: `${block.x}%`,
        top: `${block.y}%`,
        width: `${block.w}%`,
        fontFamily: faceCss(block.face),
        fontSize: `${block.size}pt`,
        lineHeight: String(block.line),
        textAlign: block.align,
        fontWeight: block.bold ? '700' : '400',
      },
      html: block.html || (interactive ? '<p><br></p>' : ''),
    });
    if (interactive && onBlock) onBlock(block, el);
    return el;
  }),

  // Where the signature goes, once there is one. Drawn rather than stored as
  // a block, because it is not something anybody may move after the fact.
  page === lastPage(layout) ? signatures(letter) : null);

  if (scale === 1) return sheet;

  return h('div.paper-scale', {
    style: {
      width: `${Math.round(PAGE_W * scale)}px`,
      height: `${Math.round(PAGE_H * scale)}px`,
    },
  },
  h('div.paper-scale-inner', {
    style: { transform: `scale(${scale})`, width: `${PAGE_W}px`, height: `${PAGE_H}px` },
  }, sheet));
}

export const lastPage = (layout) => Math.max(1, ...(layout?.blocks ?? []).map((b) => b.page ?? 1));

/** Every page of the letter, in order. */
export function paper(letter, options = {}) {
  const pages = lastPage(letter.layout);
  return h('div.paper-stack',
    Array.from({ length: pages }, (_, i) => paperPage(letter, i + 1, options)));
}

/**
 * The signatures, at the foot of the last page.
 *
 * The property's own on the left where somebody has signed for it, and
 * whoever signed from outside beneath. Ink is an image drawn by a person;
 * everything under it is the record of when and by whom, which is the part
 * that matters if it is ever questioned.
 */
function signatures(letter) {
  const rows = [];

  if (letter.signature_ink || letter.signed_by) {
    rows.push(oneSignature({
      ink: letter.signature_ink,
      name: letter.signed_by,
      title: letter.signed_title,
      at: letter.signed_at,
      stamp: letter.stamp,
    }));
  }

  for (const person of letter.signedRecipients ?? []) {
    rows.push(oneSignature({
      ink: person.signatureInk,
      name: person.signerName || person.name,
      title: person.organisation,
      at: person.signedAt,
    }));
  }

  if (!rows.length) return null;
  return h('div.paper-signatures', rows);
}

const oneSignature = ({ ink, name, title, at, stamp }) => h('div.paper-sign',
  ink ? h('img.paper-ink', { src: ink, alt: '' }) : h('div.paper-ink-space'),
  stamp ? h('img.paper-stamp', { src: stamp, alt: '' }) : null,
  h('div.paper-sign-rule'),
  h('div.paper-sign-name', name || ''),
  title ? h('div.paper-sign-title', title) : null,
  at ? h('div.paper-sign-when', String(at).slice(0, 10)) : null);
