import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The stylesheet closes every brace it opens.
 *
 * There is no build step here — the browser reads what is written — and an
 * unclosed media query is the one mistake in CSS that does not look like a
 * mistake. Everything after it is swallowed into the block, so a rule meant
 * for a phone silently takes the toolbar off a desk, and the page it breaks is
 * never the page being edited. One count catches it, so it is counted.
 */
test('every brace in the stylesheet is closed', () => {
  const css = readFileSync('public/styles.css', 'utf8');

  let depth = 0;
  let line = 1;
  let stray = null;
  for (const ch of css) {
    if (ch === '\n') line += 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0 && stray == null) stray = line;
    }
  }

  assert.equal(stray, null, `a closing brace with nothing open, at line ${stray}`);
  assert.equal(depth, 0, `${depth} block${depth === 1 ? '' : 's'} left open`);
});

test('every media query closes before the next one opens', () => {
  const css = readFileSync('public/styles.css', 'utf8');
  const lines = css.split('\n');

  // Depth at the point each @media starts. A second one opening while the
  // first is still open is the shape of the bug: the rules underneath belong
  // to both conditions at once.
  let depth = 0;
  const nested = [];
  lines.forEach((text, index) => {
    if (/^\s*@media/.test(text) && depth !== 0) nested.push(index + 1);
    for (const ch of text) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  });

  assert.deepEqual(nested, [], 'a media query opened inside another block');
});
