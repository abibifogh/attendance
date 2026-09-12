import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  NO_DEPARTMENT, countByDepartment, departmentOf, departmentsIn, filterPeople,
} from '../public/js/directory-list.js';

/**
 * Finding one name among twenty-four.
 *
 * The page used to be a search box and a run of names. Two things were missing
 * and neither was the search: a way to say "reception" without typing it, and
 * any sign of how much of the list is left when you have. Both are decisions
 * about which names survive, which is worth pinning down away from the screen
 * that draws them.
 */

const PEOPLE = [
  { name: 'Ama Mensah', department: 'Reception' },
  { name: 'Kofi Boateng', department: 'Housekeeping' },
  { name: 'Yaa Dede', department: 'Reception' },
  { name: 'Kwesi Owusu', department: null },
];

test('somebody with no department gathers under one heading of their own', () => {
  assert.equal(departmentOf(PEOPLE[3]), NO_DEPARTMENT);
  assert.equal(departmentOf({ name: 'Nobody', department: '' }), NO_DEPARTMENT);
  assert.deepEqual(departmentsIn(PEOPLE),
    ['Housekeeping', 'No department', 'Reception']);
});

test('nothing chosen and nothing typed is everybody', () => {
  assert.equal(filterPeople(PEOPLE).length, 4);
  assert.equal(filterPeople(PEOPLE, { needle: '   ' }).length, 4);
});

test('a department leaves that department', () => {
  assert.deepEqual(
    filterPeople(PEOPLE, { department: 'Reception' }).map((p) => p.name),
    ['Ama Mensah', 'Yaa Dede'],
  );
  assert.deepEqual(
    filterPeople(PEOPLE, { department: NO_DEPARTMENT }).map((p) => p.name),
    ['Kwesi Owusu'],
  );
});

test('typing looks at the name and the department both', () => {
  assert.deepEqual(filterPeople(PEOPLE, { needle: 'kofi' }).map((p) => p.name),
    ['Kofi Boateng']);
  // Somebody who types what they want rather than looking for the chip above
  // the box still gets it.
  assert.deepEqual(filterPeople(PEOPLE, { needle: 'recep' }).map((p) => p.name),
    ['Ama Mensah', 'Yaa Dede']);
  assert.deepEqual(filterPeople(PEOPLE, { needle: 'MENSAH' }).map((p) => p.name),
    ['Ama Mensah']);
});

test('a department and a name narrow together', () => {
  assert.deepEqual(
    filterPeople(PEOPLE, { department: 'Reception', needle: 'yaa' }).map((p) => p.name),
    ['Yaa Dede'],
  );
  assert.deepEqual(
    filterPeople(PEOPLE, { department: 'Housekeeping', needle: 'yaa' }), [],
  );
});

test('nothing at all is a safe answer', () => {
  assert.deepEqual(filterPeople(), []);
  assert.deepEqual(departmentsIn(), []);
  assert.deepEqual([...countByDepartment().entries()], []);
});

test('each heading counts its own', () => {
  const counts = countByDepartment(PEOPLE);
  assert.equal(counts.get('Reception'), 2);
  assert.equal(counts.get('Housekeeping'), 1);
  assert.equal(counts.get(NO_DEPARTMENT), 1);
});

// ---------------------------------------------------------------------------
// And what the screen makes of it
// ---------------------------------------------------------------------------

test('the screen asks this module rather than working it out again', () => {
  const view = readFileSync('public/js/views/directory.js', 'utf8');
  assert.match(view, /from '\.\.\/directory-list\.js'/);
  assert.match(view, /filterPeople\(data\.people, showing\)/);
});

test('a card each, with a face on it', () => {
  const view = readFileSync('public/js/views/directory.js', 'utf8');
  assert.match(view, /h\('div\.dir-grid'/);
  assert.match(view, /face\(person\.name, \{/);
  assert.match(view, /\/api\/directory\/photo\/\$\{person\.id\}/);

  const css = readFileSync('public/styles.css', 'utf8');
  assert.match(css, /\.dir-grid \{[\s\S]*?auto-fill/);
});

test('the number dials and the address writes', () => {
  const view = readFileSync('public/js/views/directory.js', 'utf8');
  assert.match(view, /href: `tel:/);
  assert.match(view, /href: `mailto:/);
});

test('the copy button belongs to a desk, and a phone never draws it', () => {
  const view = readFileSync('public/js/views/directory.js', 'utf8');
  assert.match(view, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(view, /'aria-label': `Copy /, 'a button reading Copy four times over needs one');

  const css = readFileSync('public/styles.css', 'utf8');
  assert.match(css, /@media \(hover: none\) \{\s*\.dir-copy \{ display: none; \}/);
});
