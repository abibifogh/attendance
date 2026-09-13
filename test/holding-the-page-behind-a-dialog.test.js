import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Nothing behind a dialog moves while it is open.
 *
 * The version that only set `overflow: hidden` looked right on a desk and did
 * nothing on a phone: Safari on iOS scrolls the document anyway, and so does
 * anything else once the swipe starts on a dialog that has nowhere of its own
 * to go. A short form, entirely on screen, is the case that breaks, which is
 * the opposite of what anybody expects — a long form scrolls itself and hides
 * the fault.
 *
 * So the body is pinned at the offset it was already at, and put back there
 * when the dialog closes. Both halves matter: without the second one the page
 * jumps to the top every time somebody presses Cancel.
 */

const script = readFileSync('public/js/util.js', 'utf8');
const styles = readFileSync('public/styles.css', 'utf8');

test('the body is pinned, not merely told not to overflow', () => {
  assert.match(styles, /html\.has-modal body \{[^}]*position: fixed/);
  // The hidden that was there before is kept: it is what stops the scrollbar
  // on the handsets wide enough to have one.
  assert.match(styles, /html\.has-modal \{ overflow: hidden; \}/);
});

test('where the page was is remembered, and given back', () => {
  assert.match(script, /heldAt = Math\.round\(window\.scrollY/);
  assert.match(script, /document\.body\.style\.top = `-\$\{heldAt\}px`/);
  assert.match(script, /window\.scrollTo\(0, back\)/);
  // And the class only comes off with the pin, or the page is left fixed at a
  // negative offset with nothing holding it there.
  assert.match(script, /classList\.remove\('has-modal'\)[\s\S]{0,120}style\.top = ''/);
});

test('it watches for any dialog, rather than each place one is opened', () => {
  // Eight places open a modal and the one that gets forgotten is the one
  // somebody is stuck inside.
  assert.match(script, /new MutationObserver\(sync\)/);
  assert.match(script, /querySelector\('dialog\[open\]'\)/);
});

test('a dialog contains its own overscroll', () => {
  assert.match(styles, /\.app-dialog \{[\s\S]*?overscroll-behavior: contain;/);
});
