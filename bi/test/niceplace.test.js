import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import * as np from '../src/routes/niceplace.js';

const OWNER = { name: 'Test Owner', isOwner: true };

/** The workbook's shape, with made-up figures and names. */
function workbook() {
  return [
    [0, 'Toilet', null, null, null, null, null, 'Shower', null, null, null, null, null, null, null],
    ['Date', 'Day', null, null, 'Night', null, null, 'Day', null, null, 'Night', null, null, 'Shifts', null],
    [null, 'Adult', 'Child', 'Revenue', 'Adult', 'Child', 'Revenue', 'Adult', 'Child', 'Revenue', 'Adult', 'Child', 'Revenue', 'Day', 'Night'],
    [1, 270, 50, 320, 240, 30, 270, 120, 40, 160, 90, 30, 120, 'Abena', 'Efua'],
    [2, 210, 30, 240, 180, 20, 200, 90, 20, 110, 60, 10, 75, 'Abena', 'Efua'],
    [3, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    ['Total', 480, 80, 560, 420, 50, 470, 210, 60, 270, 150, 40, 195, null, null],
    [null, null, null, 'Bonus', 'Abena', 100],
  ];
}

test('the income workbook is read: per date and shift, toilet and shower, adults and children, who was on', () => {
  const out = np.parseIncome(workbook(), { sheetName: 'SEP 26' });
  assert.equal(out.month, '2026-09');
  assert.equal(out.rows.length, 4, 'two dates by two shifts; the empty date and everything from Total down left out');
  const [d1] = out.rows;
  assert.deepEqual(d1, { day: '2026-09-01', shift: 'day', toilet: { adult: 27000, child: 5000, total: 32000 }, shower: { adult: 12000, child: 4000, total: 16000 }, staff: 'Abena' });
  assert.equal(out.rows.find((r) => r.day === '2026-09-02' && r.shift === 'night').shower.total, 7500);
  assert.equal(np.monthOf('Nice_Place_Income_Oct_2026.xlsx'), '2026-10');
  assert.throws(() => np.parseIncome([['a', 'b'], [1, 2], [3, 4]], {}), /not the Nice Place income workbook/);
});

const reading = (day, shift, gb, gt, lb, lt) => ({ day, shift, name: 'Abena', gb, gt, lb, lt, photo_id: 1, sent_at: `${day} 18:00:00`, at: `${day} 18:00:00` });
const money = (day, shift, t, s) => ({ day, shift, toilet_adult: t[0], toilet_child: t[1], toilet_total: t[2], shower_adult: s[0], shower_child: s[1], shower_total: s[2], staff: 'Abena' });

test('the counters against the money: half the movements are people, staff walk-throughs allowed, the money between children’s and adults’ prices', () => {
  const settings = { allowance: 10, adult: 300, child: 100 };
  const readings = [
    reading('2026-09-01', 'day', 300, 440, 200, 400), // from zero: first reading
    reading('2026-09-01', 'night', 520, 840, 360, 720),
  ];
  // Day: toilet 440 + 400 = 840 movements = 420 people, 20 walk-throughs off = 400 paying.
  //   GH₵620 of adults (≈ 206.7) + GH₵180 of children (180) = 387 people: 13 short, within 10% → fits.
  // Night: toilet 400 + 320 = 720 movements = 360 people, 340 paying; GH₵300 only: less than 340 children would bring.
  const revenue = [
    money('2026-09-01', 'day', [62000, 18000, 80000], [36000, 10000, 46000]),
    money('2026-09-01', 'night', [24000, 6000, 30000], [30000, 6000, 36000]),
  ];
  const { rows } = np.analyse({ readings, revenue, settings, from: '2026-09-01', to: '2026-09-01' });
  const [day, night] = rows;
  assert.equal(day.first, true);
  assert.deepEqual([day.facilities.toilet.people, day.facilities.toilet.paying, day.facilities.toilet.reportedPeople], [420, 400, 387]);
  assert.equal(day.facilities.toilet.status, 'good');
  assert.equal(night.facilities.toilet.people, 360);
  assert.equal(night.facilities.toilet.minRevenue, 34000);
  assert.equal(night.facilities.toilet.status, 'bad', 'not adding up');
  assert.equal(night.status, 'bad');
  // Shower night: 220 + 160 = 380 movements = 190 people, 170 paying; GH₵300 adults (100) + GH₵60 children (60) = 160: within tolerance.
  assert.equal(night.facilities.shower.status, 'good');
});

test('more people than paid for, a counter reset, a missed reading and the workbook’s own sums', () => {
  const settings = { allowance: 10, adult: 300, child: 100 };
  const readings = [
    reading('2026-09-01', 'day', 100, 200, 100, 200),
    // Night missed. Day 2 covers both shifts; GT was reset (lower than before).
    reading('2026-09-02', 'day', 300, 40, 300, 600),
  ];
  const revenue = [
    money('2026-09-01', 'day', [30000, 10000, 40000], [15000, 5000, 20000]),
    money('2026-09-01', 'night', [30000, 10000, 40000], [15000, 5000, 20000]),
    // The workbook's adults and children come to more than its revenue.
    money('2026-09-02', 'day', [30000, 10000, 39000], [15000, 5000, 20000]),
  ];
  const { rows } = np.analyse({ readings, revenue, settings, from: '2026-09-01', to: '2026-09-02' });
  const d2 = rows.find((r) => r.day === '2026-09-02' && r.shift === 'day');
  assert.deepEqual(d2.span.map((x) => `${x.day} ${x.shift}`), ['2026-09-01 night', '2026-09-02 day']);
  assert.deepEqual(d2.resets, ['gt']);
  // Toilet: GT 40 (from zero) + LT 400 = 440 movements = 220 people; 2 shifts × 2 counters × 10 = 40 off: 180 paying.
  // Paid: GH₵600 adults (200) + GH₵200 children (200) over two shifts = 400 people reported, more than counted: fine.
  assert.deepEqual([d2.facilities.toilet.people, d2.facilities.toilet.paying, d2.facilities.toilet.revenue], [220, 180, 79000]);
  assert.equal(d2.facilities.toilet.sheetGap, -1000, 'the adults and children add up to GH₵10 more than the revenue');
  // Shower: GB 200 + LB 200 = 400 movements = 200 people, 160 paying; reported 2 × (50 + 50) = 200: fits.
  assert.equal(d2.facilities.shower.status, 'good');
  // A shift with money but no reading: no picture.
  assert.equal(rows.find((r) => r.day === '2026-09-01' && r.shift === 'night').status, 'no-reading');

  // Counted far more than paid for: 400 paying, 300 reported.
  const more = np.analyse({
    readings: [reading('2026-09-01', 'day', 0, 420, 0, 420)],
    revenue: [money('2026-09-01', 'day', [60000, 10000, 70000], [0, 0, 0])],
    settings, from: '2026-09-01', to: '2026-09-01',
  }).rows[0];
  assert.deepEqual([more.facilities.toilet.paying, more.facilities.toilet.reportedPeople, more.facilities.toilet.gap, more.facilities.toilet.status], [400, 300, 100, 'warn']);
});

test('the open link: its own token, a name from the list, a picture, and a second send only within the hour', async () => {
  const { db } = freshDb();
  const env = { DB: db };
  await assert.rejects(np.linkForm(env, { t: 'x' }), /no longer in use/);
  await np.saveSettings(env, { newLink: true, addName: 'Abena' });
  await np.saveSettings(env, { addName: 'Efua' });
  const { token } = await np.settingsOf(env);
  const form = await np.linkForm(env, { t: token });
  assert.deepEqual(form.staff, ['Abena', 'Efua']);
  const today = new Date().toISOString().slice(0, 10);
  const pic = `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;
  const body = { t: token, name: 'Abena', day: today, shift: 'day', gb: '1,200', gt: 3400, lb: 900, lt: 2700, photo: pic };
  await assert.rejects(np.sendReading(env, { ...body, name: 'Somebody' }), /Choose your name/);
  await assert.rejects(np.sendReading(env, { ...body, photo: '' }), /picture/);
  await assert.rejects(np.sendReading(env, { ...body, gt: '34OO' }), /GT/);
  await assert.rejects(np.sendReading(env, { ...body, day: '2020-01-01' }), /date/);
  const out = await np.sendReading(env, body);
  assert.equal(out.ok, true);
  const row = await env.DB.prepare('SELECT * FROM np_reading').first();
  assert.deepEqual([row.gb, row.gt, row.name], [1200, 3400, 'Abena']);
  // Sent again at once: replaced, the old picture gone.
  await np.sendReading(env, { ...body, gt: 3401 });
  assert.equal((await env.DB.prepare('SELECT gt FROM np_reading').first()).gt, 3401);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM np_photo').first()).n, 1);
  // An hour on, or once the manager has corrected it: no.
  await env.DB.prepare("UPDATE np_reading SET sent_at = datetime('now', '-2 hours')").run();
  await assert.rejects(np.sendReading(env, body), /ask the manager/);
  // A new link: the old one stops.
  await np.saveSettings(env, { newLink: true });
  await assert.rejects(np.linkForm(env, { t: token }), /no longer in use/);
  // The next shift is suggested after the last one sent.
  assert.deepEqual(np.suggest({ day: today, shift: 'day' }, new Date(`${today}T19:00:00Z`)), { day: today, shift: 'night' });
});

test('the workbook saved, the page’s sums, an answer and a fix', async () => {
  const { db } = freshDb();
  const env = { DB: db };
  const saved = await np.saveIncome(env, { rows: workbook(), sheetName: 'SEP 26' }, OWNER);
  assert.deepEqual([saved.month, saved.saved, saved.from, saved.to], ['2026-09', 4, '2026-09-01', '2026-09-02']);
  await np.editReading(env, { day: '2026-09-01', shift: 'day', gb: 300, gt: 440, lb: 200, lt: 400, name: 'Abena' }, OWNER);
  await np.answer(env, { day: '2026-09-01', shift: 'day', answer: 'Counter fault', note: 'GT door sticks' }, OWNER);
  const view = await np.npView(env, { from: '2026-09-01', to: '2026-09-02' }, OWNER, { admin: true });
  const d1 = view.rows.find((r) => r.key === '2026-09-01|day');
  assert.equal(d1.reading.editedBy, 'Test Owner');
  assert.equal(d1.answer.answer, 'Counter fault');
  assert.equal(d1.staff, 'Abena');
  assert.equal(view.rows.find((r) => r.key === '2026-09-02|day').status, 'no-reading');
  // Saved again: replaced, not doubled.
  await np.saveIncome(env, { rows: workbook(), sheetName: 'SEP 26' }, OWNER);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM np_revenue').first()).n, 4);
});

test('the counters read off the picture: filled in, a number not read asks for the picture again, typed differently is shown', async () => {
  const { db } = freshDb();
  let answer = { response: '{"GB": 1200, "GT": 3400, "LB": 900, "LT": 2700, "problem": ""}' };
  const asked = [];
  const env = {
    DB: db,
    AI: { run: async (model, input) => { asked.push([model, input]); if (answer instanceof Error) throw answer; return answer; } },
  };
  await np.saveSettings(env, { newLink: true, addName: 'Abena', layout: 'left to right: GB, GT, LB, LT' });
  const { token } = await np.settingsOf(env);
  const pic = (s) => `data:image/jpeg;base64,${Buffer.from(s).toString('base64')}`;

  await assert.rejects(np.readCounters(env, { t: 'wrong', photo: pic('a') }), /no longer in use/);
  await assert.rejects(np.readCounters(env, { t: token, photo: '' }), /picture/);

  let out = await np.readCounters(env, { t: token, photo: pic('one') });
  assert.deepEqual(out, { available: true, values: { gb: 1200, gt: 3400, lb: 900, lt: 2700 }, unreadable: [], problem: '', lower: [] });
  assert.equal(asked[0][0], np.READ_MODEL);
  const user = asked[0][1].messages[1].content;
  assert.match(user[0].text, /left to right: GB, GT, LB, LT/, 'the layout the manager gave is told');
  assert.equal(user[1].image_url.url, pic('one'), 'the picture goes as it was taken');
  // The same picture again: read once.
  await np.readCounters(env, { t: token, photo: pic('one') });
  assert.equal(asked.length, 1);

  // One not read for certain, as an object this time: the page asks for the picture again.
  answer = { response: { GB: 1200, GT: null, LB: '900', LT: 2700, problem: 'glare on GT' } };
  out = await np.readCounters(env, { t: token, photo: pic('two') });
  assert.deepEqual([out.values, out.unreadable, out.problem], [{ gb: 1200, gt: null, lb: 900, lt: 2700 }, ['gt'], 'glare on GT']);

  // Not answering, or answering nonsense: the numbers are typed, as before.
  answer = new Error('down');
  assert.deepEqual(await np.readCounters(env, { t: token, photo: pic('three') }), { available: false });
  answer = { response: 'I cannot help with that.' };
  assert.deepEqual(await np.readCounters(env, { t: token, photo: pic('four') }), { available: false });
  assert.deepEqual(await np.readCounters({ DB: db }, { t: token, photo: pic('five') }), { available: false }, 'no reader bound');

  // Sent with GB typed differently from the picture: kept, and shown.
  const today = new Date().toISOString().slice(0, 10);
  await np.sendReading(env, { t: token, name: 'Abena', day: today, shift: 'day', gb: 1250, gt: 3400, lb: 900, lt: 2700, photo: pic('one') });
  const view = await np.npView(env, { from: today, to: today }, OWNER, { admin: true });
  const r = view.rows.find((x) => x.reading).reading;
  assert.deepEqual([r.read.gb, r.differs, r.unread], [1200, ['gb'], []]);

  // Lower than the last reading: said, not refused.
  answer = { response: '{"GB": 1100, "GT": 3500, "LB": 950, "LT": 2800, "problem": ""}' };
  out = await np.readCounters(env, { t: token, photo: pic('six') });
  assert.deepEqual(out.lower, [{ counter: 'gb', was: 1250, now: 1100 }]);
});

test('the reader’s answer, however it comes back', () => {
  assert.deepEqual(np.parseRead({ response: 'Here: {"GB": "1,200", "GT": 3400, "LB": -1, "LT": 2.5, "problem": "LB cut off"}' }),
    { gb: 1200, gt: 3400, lb: null, lt: null, problem: 'LB cut off' });
  assert.equal(np.parseRead({ response: 'no' }), null);
  assert.equal(np.parseRead(null), null);
});
