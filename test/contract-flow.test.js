import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flowParagraphs } from '../public/js/contract-flow.js';
import { STANDARD_TEMPLATES } from '../src/lib/ghana-templates.js';

/**
 * A contract's hard-wrapped lines, joined back into paragraphs for a phone,
 * without losing, adding or reordering a single word.
 */

const words = (text) => String(text).split(/\s+/).filter(Boolean);

test('lines of a paragraph are joined, and clauses, headings and rules keep their own line', () => {
  const text = [
    'CONTRACT OF EMPLOYMENT',
    '',
    'This Contract is made between the Company and',
    'the Employee, who agrees to be bound by it.',
    '',
    '1. TERM AND COMMENCEMENT',
    '',
    '1.1 The term shall commence on the Start',
    '    Date and continue until ended.',
    '1.2 The first months are a probationary',
    '    period.',
    '   (a) one thing;',
    '   (b) another.',
    '',
    'SIGNED by the Employee:',
    '..............................',
    'Name: Position: Date:',
  ].join('\n');
  assert.deepEqual(flowParagraphs(text), [
    'CONTRACT OF EMPLOYMENT',
    'This Contract is made between the Company and the Employee, who agrees to be bound by it.',
    '1. TERM AND COMMENCEMENT',
    '1.1 The term shall commence on the Start Date and continue until ended.\n'
      + '1.2 The first months are a probationary period.\n(a) one thing;\n(b) another.',
    'SIGNED by the Employee:\n..............................\nName: Position: Date:',
  ]);
});

test('every standard template keeps every word, in order', () => {
  for (const t of STANDARD_TEMPLATES.filter((x) => x.body)) {
    assert.deepEqual(words(flowParagraphs(t.body).join('\n')), words(t.body), t.code);
  }
});

test('nothing at all is nothing', () => {
  assert.deepEqual(flowParagraphs(''), []);
  assert.deepEqual(flowParagraphs(null), []);
});
