import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { looksLikeImage, looksLikePdf, noWayBack } from '../public/js/file-view.js';

/**
 * Opening a file without being stranded in it.
 *
 * Every file in the app was a link with target="_blank". At a desk that is a
 * tab you close. Installed on an iPhone there is no browser chrome at all: the
 * standalone window keeps the link, the CV fills the screen, and there is no
 * back button, no tab strip and no ✕ anywhere, so the app is gone until
 * somebody force-quits it.
 */

test('a window with nothing to come back through is the case that needs help', () => {
  assert.equal(noWayBack({ narrow: true, standalone: false }), true, 'a phone');
  assert.equal(noWayBack({ narrow: false, standalone: true }), true, 'the installed app');
  assert.equal(noWayBack({ narrow: false, standalone: false }), false, 'a desk, where a tab is right');
  assert.equal(noWayBack({}), false);
});

test('a photograph is known from its type or, failing that, its name', () => {
  // Most of these files are pictures of Ghana Cards and receipts taken on a
  // phone, and a picture is the one thing every browser will show inline.
  assert.equal(looksLikeImage('card.JPG'), true);
  assert.equal(looksLikeImage('scan', 'image/png'), true);
  assert.equal(looksLikeImage('receipt.heic'), true, 'which is what an iPhone sends');
  assert.equal(looksLikeImage('cv.pdf'), false);
  assert.equal(looksLikeImage(''), false);
});

test('a PDF is known the same way', () => {
  assert.equal(looksLikePdf('cv.pdf'), true);
  assert.equal(looksLikePdf('CV.PDF'), true);
  assert.equal(looksLikePdf('no extension', 'application/pdf'), true);
  assert.equal(looksLikePdf('card.jpg'), false);
});

test('no file link is left opening in a window with no way out of it', () => {
  // The point of the module is that it is used. A file link that kept
  // target="_blank" would be the same trap, on a screen nobody thought about.
  const skip = new Set(['file-view.js', 'sign.js', 'invite.js', 'hiring.js']);
  const offSite = /wa\.me|google\.com\/maps|slot\.directions|siteUrl|https?:\/\//;

  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(`${dir}/${entry.name}`)
      : entry.name.endsWith('.js') && !skip.has(entry.name) ? [`${dir}/${entry.name}`] : []));

  const offenders = [];
  for (const path of walk('public/js')) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes("target: '_blank'")) return;
      // The link's own line, and the two above it, are where the href is.
      const around = lines.slice(Math.max(0, i - 3), i + 2).join(' ');
      if (offSite.test(around)) return;                     // somewhere else entirely
      if (/#\/|location\.hash/.test(around)) return;        // another screen in here
      offenders.push(`${path}:${i + 1}`);
    });
  }

  assert.deepEqual(offenders, []);
});
