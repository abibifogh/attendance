import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The phones that can never show an alert, and being straight about it.
 *
 * Apple added notifications for a web app on the Home Screen in iOS 16.4. Every
 * iPhone before the XS stops at iOS 15, and a good few of those are in pockets
 * here. The screen used to tell whoever was holding one to add HIVE to the Home
 * Screen — which they then did, twice, before deciding the app was broken.
 *
 * The check is one line of user agent parsing, which is exactly the sort of
 * thing that is written once, read wrong by a version number nobody expected,
 * and never looked at again. So it is read here against the real strings.
 */

// Node defines its own `navigator` and will not let it be replaced, so the
// phone is put in place with a property definition rather than an assignment.
const asDevice = (userAgent, maxTouchPoints = 0) => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent, maxTouchPoints },
    configurable: true,
    writable: true,
  });
};

asDevice('');
const { tooOldForAlerts } = await import('../public/js/push.js');

const IPHONE_7_PLUS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';
const IPHONE_NEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A155F) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test('an iPhone stuck on iOS 15 is told the truth', () => {
  asDevice(IPHONE_7_PLUS);
  assert.equal(tooOldForAlerts(), true);
});

test('and the same phone with HIVE on the Home Screen, which drops the Safari version', () => {
  // The case actually reported: added to the Home Screen as instructed, opened
  // from the icon, and still nothing. In standalone the user agent carries no
  // "Version/" at all, so the OS token is the only thing left to read.
  asDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Mobile/15E148');
  assert.equal(tooOldForAlerts(), true);
});

test('16.4 is the line, and it is drawn on the right side of it', () => {
  const on = (version) => {
    asDevice(`Mozilla/5.0 (iPhone; CPU iPhone OS ${version} like Mac OS X) AppleWebKit/605.1.15`);
    return tooOldForAlerts();
  };

  assert.equal(on('16_3'), true, 'the update before it cannot');
  assert.equal(on('16_4'), false, 'the one that added them can');
  assert.equal(on('16_5'), false);
  assert.equal(on('15_8'), true);
  assert.equal(on('12_5'), true, 'and everything older still');
});

test('a current iPhone is left alone', () => {
  asDevice(IPHONE_NEW);
  assert.equal(tooOldForAlerts(), false);
});

test('an iPad reporting itself as a Mac is still an iPad', () => {
  // iPadOS 13 and later claim to be a Macintosh; the touch points give it away,
  // and the version in the string is the iPad's.
  asDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/15.6 Safari/605.1.15', 5);
  assert.equal(tooOldForAlerts(), true, 'reading 10_15 as older than 16.4');
});

test('a real Mac and an Android phone are not iPhones', () => {
  asDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.4 Safari/605.1.15', 0);
  assert.equal(tooOldForAlerts(), false, 'a desktop Safari has had alerts for years');

  asDevice(ANDROID);
  assert.equal(tooOldForAlerts(), false);
});

test('a user agent with no version in it makes no claim either way', () => {
  asDevice('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15');
  assert.equal(tooOldForAlerts(), false, 'and the general message is shown instead');
});
