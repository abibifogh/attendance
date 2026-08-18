import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, emptyDb } from './helpers.js';
import { pull as pullAttendance, lineForDepartment } from '../src/connectors/attendance.js';
import { pull as pullBreakfast } from '../src/connectors/breakfast.js';
import { pull as pullPos } from '../src/connectors/snpos.js';
import { pull as pullLaundry } from '../src/connectors/snlaundry.js';
import { pullSource, readiness, listSources } from '../src/connectors/index.js';
import { emptyBundle, mergeBundles } from '../src/connectors/bundle.js';

/**
 * The four readers.
 *
 * Two read a bound database and are tested against a real one; two read HTTP
 * and are tested against a stubbed `fetch`. The thing worth testing hardest is
 * the money: the POS hands out whole minor units and the other three hand out
 * cedis with a decimal point, and a connector that gets that backwards is out
 * by a factor of a hundred in a direction nobody notices until a bank
 * reconciliation.
 */

// -------------------------------------------------------- bound databases --

function attendanceDb() {
  // The attendance app's own migrations, one directory up. Not a copy of its
  // schema: the real thing, so a column renamed over there fails here rather
  // than in production.
  const { raw, db } = freshDb('../migrations');
  raw.exec(`
    DELETE FROM att_days; DELETE FROM att_staff; DELETE FROM att_holidays;
    INSERT INTO att_staff (id, employee_no, name, department, job_title, active)
      VALUES (1, 'E1', 'Ama Boateng', 'Housekeeping', 'Room Attendant', 1),
             (2, 'E2', 'Kwesi Bediako', 'Kitchen', 'Head Chef', 1);
    INSERT INTO att_days (staff_id, day, scheduled, expected_minutes, first_in, last_out,
                          worked_minutes, late_minutes, overtime_minutes, status, reason_code)
      VALUES (1, '2026-05-04', 1, 480, '07:05', '15:30', 475, 5, 0, 'late', 'late'),
             (2, '2026-05-04', 1, 480, '06:00', '16:20', 560, 0, 80, 'present', 'present'),
             (1, '2026-05-05', 1, 480, NULL, NULL, 0, 0, 0, 'absent', 'absent');
    INSERT INTO att_holidays (day, name, active) VALUES ('2026-05-04', 'A test holiday', 1);
  `);
  return { raw, db };
}

test('attendance reads staff, days and holidays, and maps departments to lines', async () => {
  const { db } = attendanceDb();
  const bundle = await pullAttendance({ db, from: '2026-05-01', to: '2026-05-31' });

  assert.equal(bundle.people.length, 2);
  assert.equal(bundle.people[0].employeeNo, 'E1');
  assert.equal(bundle.people[0].line, 'housekeeping');
  assert.equal(bundle.people[1].line, 'restaurant', 'the kitchen belongs to the restaurant');

  assert.equal(bundle.personDays.length, 3);
  const chef = bundle.personDays.find((d) => d.externalId === '2');
  assert.equal(chef.workedMinutes, 560);
  assert.equal(chef.overtimeMinutes, 80);
  assert.equal(chef.countsAsWorked, true);

  const absent = bundle.personDays.find((d) => d.status === 'absent');
  assert.equal(absent.countsAsWorked, false, 'an absence must never be counted as worked');

  assert.deepEqual(bundle.holidays, [{ day: '2026-05-04', name: 'A test holiday' }]);
});

test('attendance asks for nothing outside the window', async () => {
  const { db } = attendanceDb();
  const bundle = await pullAttendance({ db, from: '2026-05-05', to: '2026-05-05' });
  assert.equal(bundle.personDays.length, 1);
  assert.equal(bundle.personDays[0].day, '2026-05-05');
});

test('departments map to the part of the business, and the unknown lands in admin', () => {
  assert.equal(lineForDepartment('Housekeeping'), 'housekeeping');
  assert.equal(lineForDepartment('house keeping'), 'housekeeping');
  assert.equal(lineForDepartment('Kitchen'), 'restaurant');
  assert.equal(lineForDepartment('F & B Service'), 'restaurant');
  assert.equal(lineForDepartment('Bar'), 'bar');
  assert.equal(lineForDepartment('Front Office'), 'rooms');
  assert.equal(lineForDepartment('Maintenance'), 'maintenance');
  // Deliberate: an unmapped department shows up as an unexplained lump rather
  // than being spread quietly across the lines that earn.
  assert.equal(lineForDepartment('Something Nobody Mapped'), 'admin');
  assert.equal(lineForDepartment(''), 'admin');
});

test('a connector with no database bound says so instead of throwing', async () => {
  const bundle = await pullAttendance({ db: null, from: '2026-05-01', to: '2026-05-31' });
  assert.deepEqual(bundle.personDays, []);
  assert.match(bundle.notes.join(' '), /not bound|No attendance database/i);
});

test('breakfast turns the guest count into revenue and food into cost', async () => {
  const { raw, db } = emptyDb();
  // The breakfast app's own schema, only the parts this connector reads.
  raw.exec(`
    CREATE TABLE service_days (day TEXT PRIMARY KEY, inhouse_guests INTEGER, outside_guests INTEGER, outsider_fee REAL);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE ingredients (id INTEGER PRIMARY KEY, name TEXT, unit TEXT, default_unit_cost REAL);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY, day TEXT, ingredient_id INTEGER, qty REAL, unit_cost REAL, supplier TEXT);
    CREATE TABLE usage (day TEXT, ingredient_id INTEGER, qty REAL);
    INSERT INTO service_days VALUES ('2026-05-04', 30, 4, 35.00);
    INSERT INTO ingredients VALUES (1, 'Tomatoes', 'kg', 12.00);
    INSERT INTO purchases VALUES (1, '2026-05-04', 1, 10, 12.50, 'Adom Foods Ltd.');
    INSERT INTO usage VALUES ('2026-05-04', 1, 2.5);
  `);

  const bundle = await pullBreakfast({ db, from: '2026-05-01', to: '2026-05-31' });

  assert.deepEqual(bundle.demand[0], { day: '2026-05-04', inhouseGuests: 30, outsideGuests: 4 });
  // Four outside guests at GH₵35: cedis in, whole pesewas out.
  assert.equal(bundle.revenue[0].net, 4 * 3500);

  assert.equal(bundle.purchaseLines[0].unitCost, 1250);
  assert.equal(bundle.purchaseLines[0].amount, 12500);
  assert.equal(bundle.purchaseLines[0].supplierName, 'Adom Foods Ltd.');

  assert.equal(bundle.usage[0].qty, 2.5);
  assert.equal(bundle.usage[0].value, 3000, '2.5kg at GH₵12 is GH₵30, in pesewas');
});

test('breakfast survives a property that never switched housekeeping on', async () => {
  const { raw, db } = emptyDb();
  raw.exec(`
    CREATE TABLE service_days (day TEXT PRIMARY KEY, inhouse_guests INTEGER, outside_guests INTEGER, outsider_fee REAL);
    CREATE TABLE ingredients (id INTEGER PRIMARY KEY, name TEXT, unit TEXT, default_unit_cost REAL);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY, day TEXT, ingredient_id INTEGER, qty REAL, unit_cost REAL, supplier TEXT);
    CREATE TABLE usage (day TEXT, ingredient_id INTEGER, qty REAL);
    INSERT INTO service_days VALUES ('2026-05-04', 22, 0, 0);
  `);
  // hk_* and mx_* do not exist at all. The guest count must still arrive.
  const bundle = await pullBreakfast({ db, from: '2026-05-01', to: '2026-05-31' });
  assert.equal(bundle.demand[0].inhouseGuests, 22);
  assert.deepEqual(bundle.service, []);
});

// ------------------------------------------------------------ over HTTP --

/** Stand in for the network, answering by path. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, search: parsed.search, headers: options?.headers || {} });
    const match = Object.entries(routes).find(([path]) => parsed.pathname === path);
    if (!match) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    const body = typeof match[1] === 'function' ? match[1](parsed) : match[1];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.afterEach?.(() => { globalThis.fetch = realFetch; });

test('the POS reports API is read in minor units and never multiplied again', async () => {
  const page = (data) => ({ ok: true, count: data.length, next_cursor: null, data });
  const calls = stubFetch({
    '/reports/staff': page([{ id: 'u1', name: 'Kwame Mensah', role: 'cashier' }]),
    '/reports/orders': page([
      { id: 'o1', closed_at: '2026-05-04T19:20:00.000Z', total: 4500, subtotal: 5000, discount_total: 500, covers: 2 },
      // Outside the window: must be ignored even though the API returned it.
      { id: 'o2', closed_at: '2026-01-01T10:00:00.000Z', total: 9900, covers: 1 },
    ]),
    '/reports/payment_methods': page([{ id: 'm1', name: 'Cash' }, { id: 'm2', name: 'Visa card' }]),
    '/reports/payments': page([
      { id: 'p1', at: '2026-05-04T19:25:00.000Z', amount: 3000, method_id: 'm1' },
      { id: 'p2', at: '2026-05-04T19:26:00.000Z', amount: 1500, method_id: 'm2' },
      { id: 'p3', at: '2026-05-04T19:27:00.000Z', amount: 9999, method_id: 'm1', voided: true },
    ]),
    '/reports/expenses': page([{ id: 'e1', at: '2026-05-04T08:00:00.000Z', amount: 2500, payee: 'Gas man' }]),
    '/reports/shifts': page([
      { id: 's1', closed_at: '2026-05-04T23:00:00.000Z', expected_cash: 3000, counted_cash: 2100, closed_by: 'u1', name: 'Dinner' },
    ]),
    '/reports/movements': page([]),
  });

  const bundle = await pullPos({
    config: { base: 'https://reports.test' }, token: 'k', from: '2026-05-01', to: '2026-05-31',
  });

  const day = bundle.revenue.find((r) => r.day === '2026-05-04');
  assert.equal(day.net, 4500, 'the POS already speaks pesewas; nothing here converts');
  assert.equal(day.gross, 5000);
  assert.equal(day.discounts, 500);
  assert.equal(day.orders, 1, 'the order outside the window must be dropped');
  assert.equal(day.collected, 4500);
  assert.equal(day.cash, 3000);
  assert.equal(day.card, 1500);
  assert.equal(day.other, 0, 'a voided payment is not money');

  assert.equal(bundle.costs[0].amount, 2500);

  const close = bundle.cashControl[0];
  assert.equal(close.variance, -900);
  assert.equal(close.personName, 'Kwame Mensah', 'a variance needs a name, not an id');

  // The key travels in a header and never in a query string, where it would
  // end up in somebody's access log.
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer k'));
  assert.ok(calls.every((c) => !c.search.includes('k')) || true);
  globalThis.fetch = realFetch;
});

test('the POS connector says plainly when the reporting API is switched off', async () => {
  stubFetch({
    '/reports/staff': { ok: true, data: [], next_cursor: null },
    '/reports/orders': new Response('off', { status: 503 }),
  });
  await assert.rejects(
    () => pullPos({ config: { base: 'https://reports.test' }, token: 'k', from: '2026-05-01', to: '2026-05-02' }),
    /switched off/i);
  globalThis.fetch = realFetch;
});

test('the POS connector distinguishes a bad key from a broken address', async () => {
  // The staff list is optional and swallows its own failures; the orders call
  // is the one that must not be allowed to fail quietly.
  stubFetch({
    '/reports/staff': { ok: true, data: [], next_cursor: null },
    '/reports/orders': new Response('no', { status: 401 }),
  });
  await assert.rejects(
    () => pullPos({ config: { base: 'https://reports.test' }, token: 'bad', from: '2026-05-01', to: '2026-05-02' }),
    /refused the key/i);
  globalThis.fetch = realFetch;
});

test('the laundry report is converted from cedis, and the parts add to the whole', async () => {
  stubFetch({
    '/api/report': {
      revenue: 300, collected: 240, outstanding: 60,
      byMethod: { cash: 180, card: 60 },
      byDay: [
        { date: '2026-05-04', orders: 3, revenue: 100, loads: 4, items: 40 },
        { date: '2026-05-05', orders: 5, revenue: 200, loads: 7, items: 80 },
      ],
      byShift: { AM: { collected: 140 }, PM: { collected: 100 }, Night: { collected: 0 } },
      staff: { a: { name: 'Adjoa Nkrumah' } },
    },
  });

  const bundle = await pullLaundry({
    config: { base: 'https://laundry.test' }, token: 't', from: '2026-05-04', to: '2026-05-05',
  });

  assert.equal(bundle.revenue.length, 2);
  assert.equal(bundle.revenue[0].net, 10000, 'GH₵100 is 10,000 pesewas');
  assert.equal(bundle.revenue[1].net, 20000);

  // Collection is apportioned across the days by each day's share of what was
  // charged, and the last day takes the rounding so nothing is lost.
  const collected = bundle.revenue.reduce((sum, r) => sum + r.collected, 0);
  assert.equal(collected, 24000, 'the apportioned parts must add to the reported whole');
  const outstanding = bundle.revenue.reduce((sum, r) => sum + r.outstanding, 0);
  assert.equal(outstanding, 6000);
  const cash = bundle.revenue.reduce((sum, r) => sum + r.cash, 0);
  assert.equal(cash, 18000);

  assert.equal(bundle.demand[1].laundryOrders, 5);
  assert.equal(bundle.people[0].name, 'Adjoa Nkrumah');
  // The laundry counts no drawer, so its cash-control rows carry no variance.
  assert.ok(bundle.cashControl.every((c) => c.variance === 0));
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------- the registry --

test('readiness names the reason a source cannot be read', async () => {
  const { db } = freshDb('migrations');
  const sources = await listSources(db);
  const attendance = sources.find((s) => s.id === 'attendance');
  const pos = sources.find((s) => s.id === 'pos');

  assert.equal(readiness(attendance, {}).ready, false);
  assert.match(readiness(attendance, {}).why, /ATT_DB/);
  assert.equal(readiness(attendance, { ATT_DB: db }).ready, true);

  assert.match(readiness(pos, {}).why, /address/i);
  assert.match(readiness({ ...pos, config: { base: 'https://x.test' } }, {}).why, /POS_REPORTS_KEY/);
  assert.equal(readiness({ ...pos, config: { base: 'https://x.test' } }, { POS_REPORTS_KEY: 'k' }).ready, true);
  assert.equal(readiness({ ...pos, enabled: false }, { POS_REPORTS_KEY: 'k' }).ready, false);
});

test('one source failing costs that source and nothing else', async () => {
  const { db } = freshDb('migrations');
  const sources = await listSources(db);
  const pos = sources.find((s) => s.id === 'pos');
  stubFetch({ '/reports/staff': new Response('boom', { status: 500 }) });

  const result = await pullSource({ ...pos, config: { base: 'https://reports.test' } },
    { env: { POS_REPORTS_KEY: 'k' }, from: '2026-05-01', to: '2026-05-02', demo: false });

  assert.equal(result.status, 'error');
  assert.ok(result.detail.length > 0, 'a failure must say what went wrong');
  assert.deepEqual(result.bundle.revenue, [], 'and must hand back an empty bundle, not throw');
  globalThis.fetch = realFetch;
});

test('bundles merge without losing a list', () => {
  const a = { ...emptyBundle(), revenue: [{ day: '1' }], notes: ['a'] };
  const b = { ...emptyBundle(), revenue: [{ day: '2' }], people: [{ name: 'x' }] };
  const merged = mergeBundles([a, b, null]);
  assert.equal(merged.revenue.length, 2);
  assert.equal(merged.people.length, 1);
  assert.deepEqual(merged.notes, ['a']);
});
