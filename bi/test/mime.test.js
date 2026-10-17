import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEmail, parseParams, decodeWords, addressOf } from '../src/lib/mime.js';

/** Taking an email apart for its receipts. Every address and name is invented. */

const pdf = Buffer.from('%PDF-1.4 a receipt').toString('base64');
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64');

const email = [
  'From: "Test Owner" <Owner@Example.test>',
  'To: receipts@po.example.test',
  'Subject: =?utf-8?B?ZnVlbCBhbmQgcGFkbG9ja3Mg4oKs?=',
  'Authentication-Results: mx.example; dkim=pass; spf=pass',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'fuel for the generator =E2=80=94 Tuesday',
  '--inner',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<p>fuel for the generator</p>',
  '--inner--',
  '--outer',
  'Content-Type: application/pdf; name="receipt.pdf"',
  'Content-Disposition: attachment; filename="receipt.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  pdf.slice(0, 10),
  pdf.slice(10),
  '--outer',
  'Content-Type: application/octet-stream',
  "Content-Disposition: attachment; filename*=utf-8''re%C3%A7u.JPG",
  'Content-Transfer-Encoding: base64',
  '',
  jpg,
  '--outer--',
  '',
].join('\r\n');

test('an email: who, what about, the words, and each attachment', () => {
  const out = readEmail(new TextEncoder().encode(email));
  assert.equal(out.from, 'owner@example.test');
  assert.equal(out.fromName, 'Test Owner');
  assert.equal(out.subject, 'fuel and padlocks €');
  assert.equal(out.text, 'fuel for the generator — Tuesday');
  assert.match(out.authentication, /dkim=pass/);
  assert.deepEqual(out.files.map((f) => [f.name, f.type, f.data]), [['receipt.pdf', 'application/pdf', pdf], ['reçu.JPG', 'image/jpeg', jpg]]);
});

test('the small parts', () => {
  assert.equal(addressOf('Ama <AMA@x.test>'), 'ama@x.test');
  assert.equal(addressOf('ama@x.test'), 'ama@x.test');
  assert.deepEqual(parseParams('image/png; name="a b.png"'), { value: 'image/png', params: { name: 'a b.png' } });
  assert.equal(decodeWords('=?iso-8859-1?Q?caf=E9_bill?='), 'café bill');
  // Only HTML: its words, without the tags.
  const html = readEmail('From: a@x.test\r\nContent-Type: text/html\r\n\r\n<div>Gas <b>refill</b><br>420</div>');
  assert.equal(html.text, 'Gas refill \n420');
});
