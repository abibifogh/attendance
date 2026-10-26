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

/**
 * The employee's particulars, where a contract starts with them: the lines
 * under EMPLOYEE PARTICULARS up to the first blank line, each "Label: value".
 * The same reading as the server's, in src/lib/particulars.js.
 */
export function splitParticulars(text) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!body.startsWith('EMPLOYEE PARTICULARS\n')) return { rows: [], rest: body };
  const end = body.indexOf('\n\n');
  const block = end === -1 ? body : body.slice(0, end);
  const rows = block.split('\n').slice(1).map((line) => {
    const at = line.indexOf(': ');
    return at === -1 ? { label: line, value: '' } : { label: line.slice(0, at), value: line.slice(at + 2) };
  });
  return { rows, rest: end === -1 ? '' : body.slice(end + 2) };
}

/** The particulars as a box. `own` is the person reading their own, who is told what to do if one is wrong. */
export function particularsBox(h, rows, { own = false } = {}) {
  if (!rows?.length) return null;
  return h('section.particulars-box',
    h('div.pb-head', own ? 'YOUR PARTICULARS' : 'EMPLOYEE PARTICULARS'),
    h('dl.pb-rows', ...rows.flatMap((r) => [h('dt', r.label), h('dd', r.value || '—')])),
    own ? h('p.pb-note', 'Something wrong here? Tell the office before you sign, and they will send it again.') : null);
}

/** The same, as an element, with `h` from util.js: the particulars box first, where there is one. */
export const contractFlow = (h, text, { own = false } = {}) => {
  const { rows, rest } = splitParticulars(text);
  return h('div.contract-flow',
    particularsBox(h, rows, { own }),
    flowParagraphs(rest).map((p) => h('p', p)));
};
