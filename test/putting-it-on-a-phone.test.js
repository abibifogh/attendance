import { test } from 'node:test';
import assert from 'node:assert/strict';

import { browserName, inAnotherApp, isAndroid, openInChromeUrl } from '../public/js/install.js';

/**
 * Putting HIVE on a phone.
 *
 * Half the property never manages it, and the reason is not that they cannot
 * follow instructions. On Android the menu item sits below "Desktop site",
 * past the bottom of a screen nobody thinks to scroll. On an iPhone it is
 * behind an icon Apple never names in words. And a link sent on WhatsApp opens
 * inside WhatsApp, where the option does not exist at all and the page looks
 * completely normal while it does not.
 *
 * So the app has to know which of those it is looking at before it can say
 * anything useful. These are the strings real handsets send.
 */

const UA = {
  chrome: 'Mozilla/5.0 (Linux; Android 13; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/131.0.0.0 Mobile Safari/537.36',
  webview: 'Mozilla/5.0 (Linux; Android 13; SM-A125F Build/TP1A; wv) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36',
  facebook: 'Mozilla/5.0 (Linux; Android 13; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/131.0.0.0 Mobile Safari/537.36 [FBAN/FB4A;FBAV/450.0.0.0]',
  instagram: 'Mozilla/5.0 (Linux; Android 13; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/131.0.0.0 Mobile Safari/537.36 Instagram 300.0.0.0 Android',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  opera: 'Mozilla/5.0 (Linux; Android 13; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/131.0.0.0 Mobile Safari/537.36 OPR/86.0.0.0',
  edge: 'Mozilla/5.0 (Linux; Android 13; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0',
  firefox: 'Mozilla/5.0 (Android 13; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
};

// ---------------------------------------------------------------------------
// Which browser is this
// ---------------------------------------------------------------------------

test('every browser on Android says Chrome, so Chrome is what is left', () => {
  // Each of these carries the word Chrome in its own user agent, and naming
  // them by the first match would call all of them Chrome.
  assert.equal(browserName(UA.samsung), 'samsung');
  assert.equal(browserName(UA.opera), 'opera');
  assert.equal(browserName(UA.edge), 'edge');
  assert.equal(browserName(UA.chrome), 'chrome');
});

test('an iPhone is told apart from Chrome pretending to be one', () => {
  assert.equal(browserName(UA.safari), 'safari');
  // Chrome on an iPhone is Safari underneath and cannot install anything, so
  // it must not be given Chrome's instructions.
  assert.equal(browserName(UA.chromeIos), 'chrome-ios');
});

test('firefox is itself', () => {
  assert.equal(browserName(UA.firefox), 'firefox');
});

// ---------------------------------------------------------------------------
// Opened inside another app
// ---------------------------------------------------------------------------

test('a window opened by another app is recognised as one', () => {
  assert.equal(inAnotherApp(UA.webview), true, 'the wv flag every Android webview carries');
  assert.equal(inAnotherApp(UA.facebook), true);
  assert.equal(inAnotherApp(UA.instagram), true);
});

test('a real browser is not mistaken for one', () => {
  for (const key of ['chrome', 'samsung', 'opera', 'edge', 'firefox', 'safari', 'chromeIos']) {
    assert.equal(inAnotherApp(UA[key]), false, key);
  }
});

test('android is android whatever is drawing the page', () => {
  assert.equal(isAndroid(UA.chrome), true);
  assert.equal(isAndroid(UA.webview), true);
  assert.equal(isAndroid(UA.safari), false);
});

// ---------------------------------------------------------------------------
// The way out of a webview
// ---------------------------------------------------------------------------

test('the intent keeps its instructions in the only fragment it has', () => {
  const url = openInChromeUrl('https://staff.niceoperation.com/#/att-me');

  // One # only. The page's own fragment in front of the intent's would be
  // read as part of it, and Android answers a broken intent by doing nothing.
  assert.equal(url.split('#').length - 1, 1, url);
  assert.match(url, /^intent:\/\/staff\.niceoperation\.com\/#Intent;/);
  assert.match(url, /package=com\.android\.chrome;/);
  assert.match(url, /;end$/);
});

test('a phone without Chrome still lands on the right page', () => {
  const url = openInChromeUrl('https://staff.niceoperation.com/?x=1#/att-me');
  const fallback = decodeURIComponent(url.match(/S\.browser_fallback_url=([^;]+);/)[1]);
  assert.equal(fallback, 'https://staff.niceoperation.com/?x=1#/att-me',
    'the whole address, fragment and all');
});

test('the scheme is carried across rather than assumed', () => {
  assert.match(openInChromeUrl('https://x.test/'), /scheme=https;/);
  assert.match(openInChromeUrl('http://127.0.0.1:8901/'), /scheme=http;/);
});
