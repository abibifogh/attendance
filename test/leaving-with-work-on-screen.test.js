import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Leaving a screen with work on it that has not been saved.
 *
 * The screens hold staged edits in a map or a form, and switching away throws
 * that away without a word. Somebody who has moved six shifts and pressed
 * Workload by mistake should be asked, not simply have the afternoon taken.
 */

// A document just real enough for the watcher: it walks a form for its fields
// and reads a value off each.
function fakeForm(fields) {
  return {
    querySelectorAll: () => fields,
  };
}

const { watchForm } = await import('../public/js/util.js');

test('a form nobody has touched has nothing to lose', () => {
  const guard = watchForm(fakeForm([{ type: 'text', value: 'Kitchen' }]));
  assert.equal(guard.changed(), false);
});

test('a changed field is noticed', () => {
  const field = { type: 'text', value: 'Kitchen' };
  const guard = watchForm(fakeForm([field]));
  field.value = 'F&B';
  assert.equal(guard.changed(), true);
});

test('a ticked box is noticed, and a value that only looks the same is not', () => {
  const box = { type: 'checkbox', checked: false, value: 'on' };
  const guard = watchForm(fakeForm([box]));
  assert.equal(guard.changed(), false);
  box.checked = true;
  assert.equal(guard.changed(), true, 'the tick is what changed, not the value');
});

test('a field added to the form counts as a change', () => {
  const fields = [{ type: 'number', value: '490' }];
  const guard = watchForm(fakeForm(fields));
  fields.push({ type: 'number', value: '110' });
  assert.equal(guard.changed(), true, 'a band added to the tax table is a change');
});

test('a field taken off the form counts too', () => {
  const fields = [{ type: 'number', value: '490' }, { type: 'number', value: '110' }];
  const guard = watchForm(fakeForm(fields));
  fields.pop();
  assert.equal(guard.changed(), true);
});

test('two fields cannot be confused with one', () => {
  // "ab" + "" and "a" + "b" would be the same string joined without a
  // separator, and a form that swapped them would read as unchanged.
  const fields = [{ type: 'text', value: 'ab' }, { type: 'text', value: '' }];
  const guard = watchForm(fakeForm(fields));
  fields[0].value = 'a';
  fields[1].value = 'b';
  assert.equal(guard.changed(), true);
});

test('saving makes what is on the form the new starting point', () => {
  const field = { type: 'text', value: 'Kitchen' };
  const guard = watchForm(fakeForm([field]));
  field.value = 'F&B';
  assert.equal(guard.changed(), true);

  guard.saved();
  assert.equal(guard.changed(), false, 'it is written down now, so leaving loses nothing');

  field.value = 'Bar';
  assert.equal(guard.changed(), true);
});
