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

/**
 * How much of full size fits in the room there is, never more than all of it.
 *
 * A sheet of A4 is 794 pixels across and a phone is not. Shown at full size in
 * a box a third as wide, what a reader gets is the left-hand third of the
 * document: on a payslip that is every label with no figure beside it, and
 * "NET PAY" with nothing after it. So the sheet is scaled to the room rather
 * than scrolled sideways inside it.
 *
 * Never above 1, whatever room there is. A page blown up to fill a wide screen
 * stops matching the sheet it prints on, and somebody holding the paper beside
 * the screen has to be looking at the same document.
 */
export function widthScale(room, pageWidth = PAGE_W) {
  if (!Number.isFinite(room) || room <= 0) return 1;
  return Math.min(1, room / pageWidth);
}

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
  scale = 1, interactive = false, onBlock = null, selected = null, mine = null,
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
    const el = block.role === 'field'
      ? fieldBlock(block, letter, { interactive, selected, mine })
      : h(interactive ? 'div.paper-block.paper-live' : 'div.paper-block', {
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

  // Where the signatures go when the page does not say. A letter with places
  // marked on it puts them there instead; stacking them at the foot as well
  // would print every signature twice.
  page === lastPage(layout) && !hasFields(layout) ? signatures(letter) : null);

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

export const hasFields = (layout) => (layout?.blocks ?? []).some((b) => b.role === 'field');

/**
 * A place on the page for somebody to put their name.
 *
 * Three states and they read differently on purpose. Empty, it is a dashed
 * box saying whose it is, because a signer opening a two-page agreement should
 * be able to find their line without reading it twice. Theirs to fill, it is
 * highlighted and nobody else's is. Filled, it is the ink, over a rule, with
 * the name and the date under it — which is what it will look like on paper
 * and therefore what everybody has to agree it looks like now.
 */
function fieldBlock(block, letter, { interactive, selected, mine }) {
  const filled = fillFor(block, letter);
  const isMine = mine != null && block.signer === mine;

  const classes = [
    'paper-field',
    interactive ? 'paper-live' : '',
    selected === block.id ? 'paper-on' : '',
    filled ? 'is-filled' : '',
    isMine && !filled ? 'is-mine' : '',
  ].filter(Boolean).join(' ');

  return h('div', {
    class: classes,
    'data-block': block.id,
    'data-field': block.field,
    style: {
      left: `${block.x}%`,
      top: `${block.y}%`,
      width: `${block.w}%`,
      height: `${block.h ?? 7}%`,
    },
  },
  filled
    ? filledField(block, filled)
    : h('div.paper-field-empty',
      h('div.paper-field-what', labelOf(block, letter)),
      isMine ? h('div.paper-field-cue', 'Sign here') : null));
}

const labelOf = (block, letter) => block.label
  || `${FIELD_WORDS[block.field] ?? 'Signature'} · ${whose(block, letter)}`;

const FIELD_WORDS = { signature: 'Signature', initials: 'Initials', date: 'Date signed' };

function whose(block, letter) {
  if (block.signer === 0) return letter.property || 'The property';
  const person = (letter.recipients ?? [])[block.signer - 1];
  return person?.name || `Signer ${block.signer}`;
}

/** What has landed in this place, if anything. */
function fillFor(block, letter) {
  if (block.signer === 0) {
    if (!letter.signature_ink && !letter.signed_at) return null;
    return {
      ink: letter.signature_ink,
      name: letter.signed_by,
      title: letter.signed_title,
      at: letter.signed_at,
      stamp: letter.stamp,
    };
  }
  const person = (letter.recipients ?? [])[block.signer - 1];
  if (!person || person.status !== 'signed') return null;
  return {
    ink: person.signatureInk ?? null,
    name: person.signerName || person.name,
    title: person.organisation,
    at: person.signedAt,
  };
}

function filledField(block, fill) {
  if (block.field === 'date') {
    return h('div.paper-field-date', String(fill.at ?? '').slice(0, 10));
  }
  return h('div.paper-field-ink',
    fill.ink ? h('img', { src: fill.ink, alt: '' }) : h('span.paper-field-typed', fill.name || ''),
    fill.stamp ? h('img.paper-field-stamp', { src: fill.stamp, alt: '' }) : null,
    h('div.paper-field-rule'),
    h('div.paper-field-name', [fill.name, fill.title].filter(Boolean).join(' · ')),
    fill.at ? h('div.paper-field-when', String(fill.at).slice(0, 10)) : null);
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
