import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  NO_DEPARTMENT, byDepartment, sayHowItStands, standing, toDealWith,
} from '../public/js/today-groups.js';

/**
 * The morning screen, arranged the way somebody walks the building.
 *
 * It was four lists by state: waiting on a decision, absent, late, everybody
 * else. That is the right order for one person clearing a queue at a desk and
 * the wrong shape for everybody else who opens it. A head of housekeeping does
 * not want the property's absences, she wants her floor, and "is my department
 * all in" took reading four lists and remembering which names were in which.
 *
 * What is kept is the order inside a department, because within one that
 * ordering was doing real work.
 */

const someone = (name, department, over = {}) => ({
  staff: { id: name.length, name, department, employee_no: name },
  colour: 'green',
  label: 'Present',
  ...over,
});

test('a held day outranks the colour it would otherwise have', () => {
  // A day held because a punch is missing is not an absence and must never be
  // counted as one. It is also the only state here that somebody has to
  // answer, so it comes first wherever it is.
  assert.equal(standing({ open: true, colour: 'red' }), 'open');
  assert.equal(standing({ colour: 'red' }), 'red');
  assert.equal(standing({ colour: 'amber' }), 'amber');
  assert.equal(standing({ colour: 'green' }), 'green');
  assert.equal(standing({ colour: 'grey' }), 'grey');
  assert.equal(standing(null), 'grey');
});

test('a shift that has not come round yet is nobody’s job this morning', () => {
  assert.equal(toDealWith({ open: true }), true);
  assert.equal(toDealWith({ colour: 'red' }), true);
  assert.equal(toDealWith({ colour: 'amber' }), true);
  assert.equal(toDealWith({ colour: 'green' }), false);
  assert.equal(toDealWith({ colour: 'grey' }), false);
});

test('everybody appears once, under their own department', () => {
  const groups = byDepartment([
    someone('Ama', 'Housekeeping'),
    someone('Kofi', 'Kitchen'),
    someone('Esi', 'Housekeeping'),
  ]);

  assert.deepEqual(groups.map((g) => g.department), ['Housekeeping', 'Kitchen']);
  assert.deepEqual(groups[0].rows.map((r) => r.staff.name), ['Ama', 'Esi']);
  assert.equal(groups.flatMap((g) => g.rows).length, 3);
});

test('departments come in the same order every morning', () => {
  // Alphabetical rather than worst-first: an order that rearranged itself
  // every day would have people hunting for their own department, and what
  // they are looking for is a card in the same place as yesterday.
  const groups = byDepartment([
    someone('A', 'Security'),
    someone('B', 'F&B', { colour: 'red' }),
    someone('C', 'Front Office'),
  ]);
  assert.deepEqual(groups.map((g) => g.department), ['F&B', 'Front Office', 'Security']);
});

test('nobody without a department is dropped, and they go last', () => {
  const groups = byDepartment([
    someone('Ama', null),
    someone('Kofi', 'Kitchen'),
    someone('Esi', '   '),
  ]);
  assert.deepEqual(groups.map((g) => g.department), ['Kitchen', NO_DEPARTMENT]);
  assert.deepEqual(groups[1].rows.map((r) => r.staff.name), ['Ama', 'Esi']);
});

test('inside a department it is still the order to deal with them in', () => {
  const groups = byDepartment([
    someone('Green', 'Housekeeping'),
    someone('NotDue', 'Housekeeping', { colour: 'grey' }),
    someone('Late', 'Housekeeping', { colour: 'amber' }),
    someone('Absent', 'Housekeeping', { colour: 'red' }),
    someone('Held', 'Housekeeping', { open: true, colour: 'red' }),
  ]);
  assert.deepEqual(groups[0].rows.map((r) => r.staff.name),
    ['Held', 'Absent', 'Late', 'Green', 'NotDue']);
});

test('two people in the same state are in the order their names are', () => {
  const groups = byDepartment([
    someone('Yaw', 'Kitchen', { colour: 'red' }),
    someone('Adjoa', 'Kitchen', { colour: 'red' }),
  ]);
  assert.deepEqual(groups[0].rows.map((r) => r.staff.name), ['Adjoa', 'Yaw']);
});

test('a department with nothing wrong says so in two words', () => {
  // Eleven quiet departments each saying "nothing to deal with" is eleven
  // lines nobody reads.
  const [quiet] = byDepartment([someone('Ama', 'Kitchen'), someone('Esi', 'Kitchen')]);
  assert.equal(sayHowItStands(quiet), '2 people, all in');

  const [one] = byDepartment([someone('Ama', 'Kitchen')]);
  assert.equal(sayHowItStands(one), '1 person, all in');
});

test('nothing wrong is not the same as everybody being here', () => {
  // A whole floor on a rest day is a department with nobody in it, and "all
  // in" over nine dashes is the screen saying something plainly untrue.
  const [nobody] = byDepartment([
    someone('Ama', 'Kitchen', { colour: 'grey', label: 'Rest day' }),
    someone('Esi', 'Kitchen', { colour: 'grey', label: 'Rest day' }),
  ]);
  assert.equal(sayHowItStands(nobody), '2 people, none on today');

  const [some] = byDepartment([
    someone('Ama', 'Kitchen'),
    someone('Esi', 'Kitchen', { colour: 'grey', label: 'Rest day' }),
    someone('Yaw', 'Kitchen', { colour: 'grey', label: 'Rest day' }),
  ]);
  assert.equal(sayHowItStands(some), '1 in, 2 off');
});

test('and a department with something wrong says only what is wrong', () => {
  const [group] = byDepartment([
    someone('A', 'Housekeeping'),
    someone('B', 'Housekeeping', { colour: 'red' }),
    someone('C', 'Housekeeping', { colour: 'amber' }),
    someone('D', 'Housekeeping', { open: true }),
    someone('E', 'Housekeeping', { colour: 'grey' }),
  ]);
  assert.equal(sayHowItStands(group), '5 people · 1 to confirm, 1 absent, 1 late or early');
  assert.equal(group.waiting, 3);
  assert.deepEqual(group.counts, { open: 1, red: 1, amber: 1, green: 1, grey: 1 });
});

test('the screen is built from the departments and not from the old four lists', () => {
  const view = readFileSync('public/js/views/att-today.js', 'utf8');
  assert.match(view, /byDepartment\(data\.rows\)/);
  assert.match(view, /sayHowItStands\(group\)/);
  // The colour beside the name, which is the whole point of the change.
  assert.match(view, /today-dot/);
  assert.match(view, /is-\$\{standing\(r\)\}/);

  for (const gone of ["section('Absent'", "section('Late or left early'", "section('Everybody else'"]) {
    assert.equal(view.includes(gone), false, `${gone} should be gone`);
  }

  // Every dot has to have a colour behind it, or it is not saying anything.
  const css = readFileSync('public/styles.css', 'utf8');
  for (const state of ['red', 'amber', 'green', 'open', 'grey']) {
    assert.match(css, new RegExp(`\\.today-dot\\.is-${state}`), state);
  }
});

test('the download still carries everything with something against it', () => {
  const rows = [
    someone('A', 'Kitchen'),
    someone('B', 'Kitchen', { colour: 'red' }),
    someone('C', 'Kitchen', { open: true }),
    someone('D', 'Kitchen', { colour: 'grey' }),
  ];
  assert.deepEqual(rows.filter(toDealWith).map((r) => r.staff.name), ['B', 'C']);
});
