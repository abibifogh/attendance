/**
 * Reading a name and a number off a CV.
 *
 * WHAT THIS IS AND WHAT IT IS NOT. It is a way of not typing twenty names off
 * twenty CVs. It is not a parser, it does not understand a CV, and it will get
 * some of them wrong. Everything it finds is shown for somebody to correct
 * before a single row is written, exactly as the pasted list and the rota
 * import already work, because a wrong name entered silently is worse than no
 * name at all.
 *
 * THE THREE THINGS ARE NOT EQUALLY RELIABLE, and the screen should say so.
 *
 * An **email address** is a shape, and a shape is either there or it is not.
 * This one is as close to certain as anything here gets.
 *
 * A **phone number** is nearly as good, with one trap worth naming: a CV is
 * full of numbers that are not phone numbers, and the worst of them are years
 * and Ghana Card numbers. So it wants the length and the shape of a number
 * somebody could actually ring.
 *
 * A **name** is a guess. There is no marker for it: it is simply the first
 * thing on the page, usually, in the largest type, usually. So this takes the
 * best of three signals — the biggest text on the first page, the first line
 * that reads like a name, and the file's own name — and says which one it
 * used, so whoever is checking knows how much to trust it.
 *
 * AND A PHOTOGRAPH CANNOT BE READ AT ALL. Half the CVs at a property like this
 * arrive as a picture taken on a phone. There is no text in a picture, and
 * this does not pretend otherwise: the file is still attached to the
 * candidate, and the name is left for somebody to type. Saying "could not read
 * this one, here it is, type the name" is honest and useful. Guessing would be
 * neither.
 */

/** Where the name came from, so the screen can say how much to trust it. */
export const NAME_SOURCE = {
  heading: 'the heading',
  line: 'the first line',
  filename: 'the file name',
  none: null,
};

/**
 * What can be read off one CV.
 *
 * `pages` is what the PDF extractor returns. Pass `null` for a file whose text
 * could not be read at all — a photograph — and the filename still gives a
 * name worth offering.
 */
export function readCv({ pages = null, filename = '' } = {}) {
  const items = (pages ?? []).flatMap((page, at) => (page.items ?? [])
    .map((item) => ({ ...item, page: at })));
  const text = linesFrom(items);
  const joined = text.join('\n');

  const fromFile = nameFromFilename(filename);
  const heading = nameFromHeading(items);
  const firstLine = text.slice(0, 6).map(looksLikeName).find(Boolean) ?? null;

  // The heading first: the largest text on page one is the name on almost
  // every CV anybody has ever laid out. Then the first line that reads like
  // one. The file name last, because "cv-final-2.pdf" is not a person, but
  // "ama-mensah-cv.pdf" is better than nothing.
  const [name, source] = heading
    ? [heading, 'heading']
    : firstLine
      ? [firstLine, 'line']
      : fromFile
        ? [fromFile, 'filename']
        : [null, 'none'];

  return {
    name,
    nameFrom: NAME_SOURCE[source] ?? null,
    email: findEmail(joined),
    phone: findPhone(joined),
    // Whether there was anything to read at all, so a photograph is reported
    // as a photograph rather than as a CV with nothing in it.
    readable: items.length > 0,
    words: text.length,
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * The runs of text turned back into lines.
 *
 * The extractor gives every run with the point it was drawn at, because a rota
 * is a table. A CV is not: what is wanted here is reading order, which is
 * down the page and then across.
 */
function linesFrom(items) {
  const sorted = [...items].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines = [];
  let band = null;

  for (const item of sorted) {
    const text = String(item.text ?? '');
    if (!text.trim()) continue;

    // Within a couple of points is the same line. A CV sets its name in 20
    // point and its body in 10, so the tolerance follows the type size rather
    // than being a constant that is wrong for one of them.
    const near = band && item.page === band.page
      && Math.abs(item.y - band.y) <= Math.max(2, (item.size ?? 10) * 0.4);

    if (near) {
      band.parts.push(item);
    } else {
      if (band) lines.push(join(band));
      band = { page: item.page, y: item.y, parts: [item] };
    }
  }
  if (band) lines.push(join(band));

  return lines.filter(Boolean);
}

function join(band) {
  return band.parts
    .sort((a, b) => a.x - b.x)
    .map((p) => p.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// The name
// ---------------------------------------------------------------------------

/**
 * The largest text on the first page.
 *
 * Which is the name on almost every CV that has ever been laid out, and is the
 * single most reliable signal available without understanding anything.
 */
function nameFromHeading(items) {
  const firstPage = items.filter((item) => item.page === 0 && String(item.text ?? '').trim());
  if (!firstPage.length) return null;

  const biggest = Math.max(...firstPage.map((item) => Number(item.size) || 0));
  if (!biggest) return null;

  // Everything set at the biggest size, in reading order, joined. A name split
  // across two runs by kerning is still one name.
  const heading = firstPage
    .filter((item) => Math.abs((Number(item.size) || 0) - biggest) < 0.6)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => item.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  return looksLikeName(heading);
}

/**
 * Whether a line could be somebody's name.
 *
 * Two to four words of letters. Deliberately strict, because the cost of a
 * wrong guess is somebody's record created under the word "CURRICULUM".
 */
export function looksLikeName(line) {
  const raw = String(line ?? '');
  // An address and a web page both survive having their punctuation stripped
  // and come back out looking like two words. "ama@example.com" becoming
  // "Ama Example.com" is a candidate created under a mangled email.
  if (/[@]|\bhttps?:|\bwww\./i.test(raw)) return null;

  const text = raw
    .replace(/\b(cv|c\.v\.?|curriculum vitae|resume|résumé|profile)\b/gi, ' ')
    .replace(/[^\p{L}\s'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  const words = text.split(' ').filter((w) => w.replace(/[.'-]/g, '').length > 1);
  if (words.length < 2 || words.length > 4) return null;

  // Nothing that is obviously a heading rather than a person.
  if (/^(personal|contact|curriculum|application|name|details|address|objective)\b/i.test(text)) {
    return null;
  }
  if (!words.every((w) => /^\p{L}/u.test(w))) return null;

  return words
    .map((w) => w.charAt(0).toUpperCase() + (w === w.toUpperCase() ? w.slice(1).toLowerCase() : w.slice(1)))
    .join(' ')
    .slice(0, 120);
}

/**
 * A name out of the file's own name.
 *
 * Worth trying, and worth trying last. People name a CV after themselves far
 * more often than not, and the ones who do not name it "cv final 2", which
 * this refuses.
 */
export function nameFromFilename(filename) {
  const base = String(filename ?? '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(cv|resume|curriculum|vitae|application|final|new|copy|updated?|doc|scan)\b/gi, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return looksLikeName(base);
}

// ---------------------------------------------------------------------------
// The ways of reaching them
// ---------------------------------------------------------------------------

const EMAIL = /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/u;

export function findEmail(text) {
  const found = EMAIL.exec(String(text ?? ''));
  if (!found) return null;
  return found[0].replace(/[.,;]+$/, '').toLowerCase().slice(0, 160);
}

/**
 * A number somebody could actually ring.
 *
 * A CV is full of numbers that are not phone numbers, and two of them do real
 * damage: a year of employment, and a Ghana Card number. So this wants nine to
 * fifteen digits, and prefers a line that says what it is.
 */
export function findPhone(text) {
  const source = String(text ?? '');

  // A line that announces itself first. "Tel: 024 111 2222" is a phone number
  // in a way that a bare run of digits in the middle of a paragraph is not.
  const labelled = /(?:tel|phone|mobile|mob|cell|contact|whatsapp)[^\p{L}0-9+]{0,4}([+()\d][\d\s()+.-]{7,})/iu
    .exec(source);
  if (labelled) {
    const cleaned = tidyPhone(labelled[1]);
    if (cleaned) return cleaned;
  }

  for (const match of source.matchAll(/[+(]?\d[\d\s()+.-]{7,}\d/g)) {
    const cleaned = tidyPhone(match[0]);
    if (cleaned) return cleaned;
  }
  return null;
}

function tidyPhone(raw) {
  const text = String(raw).trim();
  const digits = text.replace(/\D/g, '');

  // Nine is a Ghanaian number without its leading zero; fifteen is the most
  // any number on earth has. A four-digit year and a fifteen-digit card number
  // both fall outside.
  if (digits.length < 9 || digits.length > 15) return null;
  // A run of digits with no separators at all and more than eleven of them is
  // an identity number far more often than a phone number.
  if (digits.length > 12 && !/[\s()+.-]/.test(text)) return null;

  return text.replace(/[.\s]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}
