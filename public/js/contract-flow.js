/**
 * A contract's words, set for reading on a screen.
 *
 * Templates are written with hard line breaks at about eighty characters,
 * which on a phone wrap a second time and read as ragged half-lines. For
 * reading, the lines of each paragraph are joined again. A line stays on its
 * own where it starts a clause ("1.2", "(a)", "-"), follows a heading in
 * capitals or a line ending in a colon, or is a rule of dots or dashes to
 * sign on.
 *
 * Only the display changes. What is signed, and the fingerprint kept with
 * it, are the stored words exactly; this never sends anything back.
 */

const CLAUSE = /^\s*(\d+(\.\d+)*\.?|\([a-z0-9]+\)|[a-z]\)|[-•*])\s/i;
const RULE = /^[._\s-]{4,}$/;
const standsAlone = (line) => /^[A-Z0-9 ,.'"&()\-]{3,}$/.test(line) || /:$/.test(line) || RULE.test(line);

/** The paragraphs, each with its own line breaks only where they mean something. */
export function flowParagraphs(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((para) => {
    const out = [];
    for (const raw of para.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const before = out.length ? out[out.length - 1] : '';
      if (!out.length || CLAUSE.test(raw) || standsAlone(before) || RULE.test(line)) out.push(line);
      else out[out.length - 1] = `${before} ${line}`;
    }
    return out.join('\n');
  }).filter(Boolean);
}

/** The same, as an element, with `h` from util.js. */
export const contractFlow = (h, text) => h('div.contract-flow', flowParagraphs(text).map((p) => h('p', p)));
