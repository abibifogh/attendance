import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flatten, fromXml, listeningHostSettings, readNotification } from '../src/lib/push-events.js';
import { normaliseEvent } from '../src/lib/attendance-ingest.js';

/**
 * What the terminal posts when nobody is asking.
 *
 * Three shapes arrive depending on model, firmware and configuration, and the
 * point of these tests is that all three end up as the same punch. The device
 * cannot be asked to send something tidier, and a shape that arrives unhandled
 * fails silently — the terminal gets its 200 and nobody finds out for a month.
 */

const JSON_EVENT = {
  ipAddress: '192.168.1.64',
  portNo: 80,
  protocol: 'HTTP',
  macAddress: 'ac:cb:51:00:00:00',
  channelID: 1,
  dateTime: '2026-06-16T06:03:12+00:00',
  activePostCount: 1,
  eventType: 'AccessControllerEvent',
  eventState: 'active',
  eventDescription: 'Access Controller Event',
  deviceID: 'DS-K1T321MFWX20241227',
  AccessControllerEvent: {
    deviceName: 'Access Controller',
    majorEventType: 5,
    subEventType: 75,
    cardNo: '1234567',
    cardType: 1,
    name: 'Henry Aryee',
    employeeNoString: '1001',
    serialNo: 4821,
    userType: 'normal',
    currentVerifyMode: 'cardOrFaceOrFp',
    attendanceStatus: 'checkIn',
    mask: 'no',
  },
};

const XML_EVENT = `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0">
  <ipAddress>192.168.1.64</ipAddress>
  <portNo>80</portNo>
  <channelID>1</channelID>
  <dateTime>2026-06-16T14:05:47+00:00</dateTime>
  <eventType>AccessControllerEvent</eventType>
  <eventState>active</eventState>
  <deviceID>DS-K1T321MFWX20241227</deviceID>
  <AccessControllerEvent>
    <majorEventType>5</majorEventType>
    <subEventType>75</subEventType>
    <name>Vivian Mensah</name>
    <employeeNoString>1002</employeeNoString>
    <serialNo>4822</serialNo>
    <attendanceStatus>checkOut</attendanceStatus>
    <currentVerifyMode>face</currentVerifyMode>
  </AccessControllerEvent>
</EventNotificationAlert>`;

/** A request the way the Worker will actually receive one. */
function post(body, contentType) {
  return new Request('https://staff.example.test/api/att/push/tok', {
    method: 'POST',
    headers: contentType ? { 'Content-Type': contentType } : {},
    body,
  });
}

// ---------------------------------------------------------------------------
// The three shapes
// ---------------------------------------------------------------------------

test('a JSON notification becomes an event', async () => {
  const events = await readNotification(post(JSON.stringify(JSON_EVENT), 'application/json'));

  assert.equal(events.length, 1);
  assert.equal(events[0].employeeNoString, '1001');
  assert.equal(events[0].time, '2026-06-16T06:03:12+00:00', 'the clock is on the envelope');
  assert.equal(events[0].attendanceStatus, 'checkIn');
  assert.equal(events[0].serialNo, 4821);
  assert.equal(events[0].major, 5, 'majorEventType, renamed to what the ingest speaks');
  assert.equal(events[0].minor, 75);
});

test('an XML notification becomes the same event', async () => {
  const events = await readNotification(post(XML_EVENT, 'application/xml'));

  assert.equal(events.length, 1);
  assert.equal(events[0].employeeNoString, '1002');
  assert.equal(events[0].time, '2026-06-16T14:05:47+00:00');
  assert.equal(events[0].attendanceStatus, 'checkOut');
  assert.equal(events[0].minor, '75');
});

test('a multipart notification is unwrapped', async () => {
  const form = new FormData();
  form.append('event_log', JSON.stringify(JSON_EVENT));
  const events = await readNotification(post(form));

  assert.equal(events.length, 1);
  assert.equal(events[0].employeeNoString, '1001');
});

test('the face photograph in a multipart post is ignored', async () => {
  const form = new FormData();
  form.append('event_log', JSON.stringify(JSON_EVENT));
  form.append('Picture', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'face.jpg');

  const events = await readNotification(post(form));
  assert.equal(events.length, 1, 'the event, and not the picture');
});

test('an XML part inside a multipart post is read too', async () => {
  const form = new FormData();
  form.append('event_log', XML_EVENT);
  const events = await readNotification(post(form));
  assert.equal(events[0].employeeNoString, '1002');
});

test('a body with no content type is sniffed rather than refused', async () => {
  const events = await readNotification(post(JSON.stringify(JSON_EVENT), 'text/plain'));
  assert.equal(events.length, 1);
});

// ---------------------------------------------------------------------------
// Everything else the terminal sends down the same pipe
// ---------------------------------------------------------------------------

test('a heartbeat is not an attendance event', async () => {
  const events = await readNotification(post(JSON.stringify({
    ipAddress: '192.168.1.64',
    dateTime: '2026-06-16T06:00:00+00:00',
    eventType: 'videoloss',
    eventState: 'inactive',
    eventDescription: 'videoloss alarm',
  }), 'application/json'));

  assert.deepEqual(events, []);
});

test('a door event with nobody attached is not an attendance event', async () => {
  const events = await readNotification(post(JSON.stringify({
    dateTime: '2026-06-16T06:00:00+00:00',
    eventType: 'AccessControllerEvent',
    AccessControllerEvent: { majorEventType: 5, subEventType: 1, doorNo: 1 },
  }), 'application/json'));

  assert.deepEqual(events, [], 'no employee number, so no punch');
});

test('a body that makes no sense is shrugged off, not thrown', async () => {
  assert.deepEqual(await readNotification(post('', 'application/json')), []);
  assert.deepEqual(await readNotification(post('not json at all', 'application/json')), []);
  assert.deepEqual(await readNotification(post('<html><body>hello</body></html>', 'text/html')), []);
});

test('several events in one post are all read', () => {
  const events = flatten({
    dateTime: '2026-06-16T06:03:12+00:00',
    AccessControllerEvent: [
      { employeeNoString: '1001', serialNo: 1, attendanceStatus: 'checkIn' },
      { employeeNoString: '1002', serialNo: 2, attendanceStatus: 'checkIn' },
    ],
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.employeeNoString), ['1001', '1002']);
});

test('an escaped name survives the XML', () => {
  const events = fromXml(XML_EVENT.replace('Vivian Mensah', 'Vivian &amp; Co'));
  assert.equal(events[0].name, 'Vivian & Co');
});

// ---------------------------------------------------------------------------
// And out the other side
// ---------------------------------------------------------------------------

test('a pushed event and a polled event produce the same punch', async () => {
  const [pushed] = await readNotification(post(JSON.stringify(JSON_EVENT), 'application/json'));

  const fromPush = normaliseEvent(pushed, { deviceSerial: 'DS-TEST', timezone: 'UTC', source: 'push' });
  const fromPoll = normaliseEvent({
    major: 5,
    minor: 75,
    time: '2026-06-16T06:03:12+00:00',
    employeeNoString: '1001',
    attendanceStatus: 'checkIn',
    serialNo: 4821,
  }, { deviceSerial: 'DS-TEST', timezone: 'UTC', source: 'poller' });

  // The one field that must match, because it is what stops the same tap being
  // stored twice when both feeds are running.
  assert.equal(fromPush.dedupe_key, fromPoll.dedupe_key);
  assert.equal(fromPush.at_utc, fromPoll.at_utc);
  assert.equal(fromPush.direction, fromPoll.direction);
  assert.equal(fromPush.source, 'push');
  assert.equal(fromPoll.source, 'poller');
});

// ---------------------------------------------------------------------------
// What to type into the terminal
// ---------------------------------------------------------------------------

test('the listening host settings are assembled, not left to be typed', () => {
  const settings = listeningHostSettings({
    siteUrl: 'https://staff.niceoperation.com',
    token: 'abc123',
  });

  assert.equal(settings.url, 'https://staff.niceoperation.com/api/att/push/abc123');
  assert.equal(settings.protocolType, 'HTTPS');
  assert.equal(settings.hostName, 'staff.niceoperation.com');
  assert.equal(settings.portNo, 443);
  assert.equal(settings.urlPath, '/api/att/push/abc123');
  assert.equal(settings.addressingFormatType, 'hostname');
});

test('a trailing slash on the site address does not double up', () => {
  const settings = listeningHostSettings({ siteUrl: 'https://staff.example.com/', token: 'x' });
  assert.equal(settings.url, 'https://staff.example.com/api/att/push/x');
});

test('a plain http deployment is described as one', () => {
  const settings = listeningHostSettings({ siteUrl: 'http://192.168.1.5:8787', token: 'x' });
  assert.equal(settings.protocolType, 'HTTP');
  assert.equal(settings.portNo, 80);
});
