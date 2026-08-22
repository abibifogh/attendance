/**
 * A letter as a page: what may be on it, and where.
 *
 * THE UNIT IS THE PAGE, NOT THE PIXEL. A block knows where it sits as a
 * percentage of the page. The same numbers then draw the letter in a composer
 * at 40% zoom, in a preview at full size, on a recipient's phone and on A4
 * coming out of a printer, with nothing recomputed on the way and nothing to
 * disagree about between one of those and the next.
 *
 * WHAT A BLOCK IS. A box with words in it: where it starts, how wide it is,
 * and how the words inside it are set — face, size, alignment, line spacing.
 * Everything on a letter is one of these, including the date and the
 * signature line, because the moment one of them is special it is the one
 * somebody needs to move.
 *
 * THE HTML IS CLEANED ON THE WAY IN. What is written here is shown back to
 * people outside the property on a signing page. Cleaning it as it is saved
 * rather than as it is shown is the only version of that which is safe:
 * showing happens in four places and one of them will always be forgotten.
 */

/** A4, in millimetres, and the pixel page every renderer draws at. */
export const PAGE = {
  widthMm: 210,
  heightMm: 297,
  // 96 dots to the inch, which is what a browser means by a CSS pixel.
  widthPx: 794,
  heightPx: 1123,
};

/** The faces on offer. Nothing exotic: a letter has to print on any machine. */
export const FACES = [
  { key: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", Times, serif' },
  { key: 'sans', label: 'Sans', css: '-apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
  { key: 'mono', label: 'Typewriter', css: 'ui-monospace, "Courier New", monospace' },
];

export const faceOf = (key) => FACES.find((f) => f.key === key) ?? FACES[0];

const ALIGN = ['left', 'center', 'right', 'justify'];

/** The tags a letter may contain, and the attributes they may carry. */
const TAGS = new Map([
  ['p', []], ['br', []], ['div', []],
  ['b', []], ['strong', []], ['i', []], ['em', []], ['u', []],
  ['ul', []], ['ol', []], ['li', []],
  ['h1', []], ['h2', []], ['h3', []],
  ['span', []],
]);

/**
 * Words, with the dangerous parts taken out.
 *
 * An allowlist rather than a blocklist, and no attributes at all: everything
 * about how a block looks is a property of the block, so there is nothing a
 * style or a class inside it could legitimately be doing. Anything not on the
 * list has its tags dropped and its words kept, which is what somebody
 * pasting from Word actually wants.
 */
export function sanitiseHtml(input, { max = 20000 } = {}) {
  const text = String(input ?? '').slice(0, max);
  let out = '';
  let at = 0;

  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open === -1) { out += escapeText(text.slice(at)); break; }

    out += escapeText(text.slice(at, open));

    // A "less than" in the middle of a sentence is a "less than". Only a
    // letter or a slash after it makes it a tag, which is also how a browser
    // reads it — and without this, "under 5 < 10 people" quietly loses half
    // the sentence.
    if (!/[a-zA-Z/!?]/.test(text[open + 1] ?? '')) {
      out += '&lt;';
      at = open + 1;
      continue;
    }

    const close = text.indexOf('>', open);
    if (close === -1) { out += escapeText(text.slice(open)); break; }

    const raw = text.slice(open + 1, close).trim();
    at = close + 1;

    // Comments, doctypes and processing instructions: gone entirely, along
    // with anything between a script or style tag and its end.
    if (raw.startsWith('!') || raw.startsWith('?')) continue;

    const closing = raw.startsWith('/');
    const name = (closing ? raw.slice(1) : raw).split(/[\s/>]/)[0].toLowerCase();

    if (name === 'script' || name === 'style') {
      const end = text.toLowerCase().indexOf(`</${name}`, at);
      at = end === -1 ? text.length : text.indexOf('>', end) + 1 || text.length;
      continue;
    }

    if (!TAGS.has(name)) continue;                    // tag dropped, words kept
    out += closing ? `</${name}>` : `<${name}>`;
  }

  return out.trim();
}

const escapeText = (s) => String(s)
  .replace(/&(?![a-zA-Z#][a-zA-Z0-9]{0,8};)/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** Plain words out of a block, for a search box or an email preview. */
export const textOf = (html) => String(html ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li|h[1-3])>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const clamp = (value, low, high, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, Math.round(n * 100) / 100));
};

/**
 * A layout, checked and tidied.
 *
 * Anything a screen sends is treated as a suggestion. Blocks are clamped to
 * the page — a block dragged off the edge would be words nobody can read and
 * nobody can get back — and every setting falls back to something sensible
 * rather than being refused, because a letter half-saved is worse than a
 * letter saved slightly differently from how it was dragged.
 */
export function normaliseLayout(input) {
  const raw = typeof input === 'string' ? safeParse(input) : input;
  if (!raw || !Array.isArray(raw.blocks)) return null;

  const blocks = raw.blocks.slice(0, 40).map((block, i) => {
    const w = clamp(block.w, 5, 100, 80);
    // What the block is for. For everything but a field this is only a label,
    // and nothing behaves differently — but it is what lets the composer offer
    // "add a signature line" rather than "add a block".
    const role = String(block.role ?? 'text').slice(0, 20);
    const field = role === 'field';

    return {
      id: String(block.id ?? `b${i + 1}`).slice(0, 24),
      page: Math.max(1, Math.min(20, Math.round(Number(block.page) || 1))),
      x: clamp(block.x, 0, 100 - w, 10),
      y: clamp(block.y, 0, 99, 20),
      w,
      // Words grow to fit what is in them; a place to sign does not, because
      // its whole job is to reserve a piece of the page.
      h: field ? clamp(block.h, 2, 40, 7) : null,
      face: faceOf(block.face).key,
      size: clamp(block.size, 6, 48, 11),
      line: clamp(block.line, 1, 3, 1.45),
      align: ALIGN.includes(block.align) ? block.align : 'left',
      bold: Boolean(block.bold),
      role,
      // Whose place this is, and what goes in it. Zero is the property's own
      // signature; one upwards is the recipient in that position on the
      // envelope, which is the order they are listed in when it is sent.
      signer: field ? Math.max(0, Math.min(10, Math.round(Number(block.signer) || 0))) : null,
      field: field ? (FIELDS.includes(block.field) ? block.field : 'signature') : null,
      label: field ? (str(block.label, 60) || null) : null,
      html: field ? '' : sanitiseHtml(block.html),
    };
  }).filter((block) => block.html || block.role !== 'text');

  return { blocks, pages: Math.max(1, ...blocks.map((b) => b.page)) };
}

/**
 * What can be asked for in a place on the page.
 *
 * Three, and deliberately not more. Every e-signing product ships a dozen and
 * the other nine are form fields, which is a different product: this one puts
 * a letter on paper and asks somebody to put their name to it.
 */
export const FIELDS = ['signature', 'initials', 'date'];

export const FIELD_LABELS = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date signed',
};

/** Who a field belongs to, in words. */
export function whoseField(block, names = []) {
  if (block.signer === 0) return 'The property';
  return names[block.signer - 1] || `Signer ${block.signer}`;
}

const str = (value, max) => (value == null ? '' : String(value).trim().slice(0, max));

const safeParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * A letter to start from.
 *
 * Not an empty page. Everybody writing a letter here writes the same six
 * things in the same six places, and a composer that opens blank makes each
 * of them a decision. The reference, the date, who it is to, what it is
 * about, the words, and how it is signed off.
 */
export function starterLayout({
  reference = '', date = '', to = '', address = '', subject = '', body = '',
  signOff = 'Yours faithfully,', signer = '', title = '',
} = {}) {
  const line = (text) => sanitiseHtml(String(text ?? '').split('\n')
    .map((part) => `<p>${escapeText(part)}</p>`).join(''));

  return normaliseLayout({
    blocks: [
      { id: 'ref', role: 'reference', x: 10, y: 22, w: 45, size: 10, face: 'sans', html: line(reference) },
      { id: 'date', role: 'date', x: 62, y: 22, w: 28, size: 10, face: 'sans', align: 'right', html: line(date) },
      { id: 'to', role: 'address', x: 10, y: 28, w: 55, size: 11, html: line([to, address].filter(Boolean).join('\n')) },
      { id: 'subject', role: 'subject', x: 10, y: 41, w: 80, size: 11, bold: true, html: line(subject) },
      { id: 'body', role: 'body', x: 10, y: 46, w: 80, size: 11, align: 'justify', html: line(body || 'Dear Sir or Madam,') },
      { id: 'sign', role: 'signature', x: 10, y: 76, w: 45, size: 11, html: line([signOff, '', signer, title].filter((v) => v !== null).join('\n')) },
    ],
  });
}
