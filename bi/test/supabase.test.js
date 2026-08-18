import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pull, check, validateMapping } from '../src/connectors/supabase.js';

/**
 * Reading a database this code has never seen.
 *
 * The four built-in connectors each know their system's schema because that
 * schema is in a repository. A Supabase database is somebody's own Postgres,
 * so the mapping is configuration — which means the mapping itself is the
 * thing that can be wrong, and most of these tests are about saying so before
 * a night's load quietly brings back nothing.
 */

const realFetch = globalThis.fetch;

/** Stand in for PostgREST, answering by table name. */
function stubRest(tables) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, params: parsed.searchParams, headers: options?.headers || {} });
    const table = parsed.pathname.replace('/rest/v1/', '');
    const rows = tables[table] ?? [];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const MAPPING = {
  base: 'https://abcdefgh.supabase.co',
  schema: 'public',
  tables: [
    {
      fact: 'revenue',
      from: 'daily_sales',
      day: 'sale_date',
      line: 'restaurant',
      money: 'major',
      columns: { net: 'total', collected: 'paid', cash: 'cash_taken', orders: 'tickets', covers: 'guests' },
    },
    {
      fact: 'demand',
      from: 'occupancy',
      day: 'night',
      columns: { inhouseGuests: 'guests_in_house', roomsTracked: 'rooms' },
    },
  ],
};

test('a mapped table becomes warehouse rows, with the money converted once', async () => {
  stubRest({
    daily_sales: [
      { sale_date: '2026-05-04', total: 1234.56, paid: 1000.00, cash_taken: 600.5, tickets: 18, guests: 31 },
      { sale_date: '2026-05-05T18:00:00+00:00', total: 900, paid: 900, cash_taken: 400, tickets: 12, guests: 20 },
    ],
    occupancy: [{ night: '2026-05-04', guests_in_house: 28, rooms: 34 }],
  });

  const bundle = await pull({ config: MAPPING, token: 'service-role-key', from: '2026-05-01', to: '2026-05-31' });

  assert.equal(bundle.revenue.length, 2);
  assert.equal(bundle.revenue[0].net, 123456, 'GH₵1,234.56 is 123,456 pesewas');
  assert.equal(bundle.revenue[0].collected, 100000);
  assert.equal(bundle.revenue[0].cash, 60050);
  assert.equal(bundle.revenue[0].orders, 18);
  assert.equal(bundle.revenue[0].line, 'restaurant');

  // A timestamptz reduces to the day it falls on.
  assert.equal(bundle.revenue[1].day, '2026-05-05');

  assert.equal(bundle.demand[0].inhouseGuests, 28);
  assert.equal(bundle.demand[0].roomsTracked, 34);
  globalThis.fetch = realFetch;
});

test('a table that already holds whole pesewas is not multiplied again', async () => {
  stubRest({ daily_sales: [{ sale_date: '2026-05-04', total: 123456 }] });
  const minorMapping = {
    ...MAPPING,
    tables: [{ ...MAPPING.tables[0], money: 'minor', columns: { net: 'total' } }],
  };
  const bundle = await pull({ config: minorMapping, token: 'k', from: '2026-05-01', to: '2026-05-31' });
  assert.equal(bundle.revenue[0].net, 123456,
    'the commonest and most expensive mistake in this whole application');
  globalThis.fetch = realFetch;
});

test('the window is asked for in the query, not filtered afterwards', async () => {
  const calls = stubRest({ daily_sales: [], occupancy: [] });
  await pull({ config: MAPPING, token: 'k', from: '2026-05-01', to: '2026-05-31' });

  const sales = calls.find((c) => c.path.endsWith('daily_sales'));
  assert.deepEqual(sales.params.getAll('sale_date'), ['gte.2026-05-01', 'lte.2026-05-31']);
  // Supabase needs the key both ways: `apikey` picks the project, the bearer
  // is what a row-level-security policy reads.
  assert.equal(sales.headers.apikey, 'k');
  assert.equal(sales.headers.Authorization, 'Bearer k');
  assert.equal(sales.headers['Accept-Profile'], 'public');
  globalThis.fetch = realFetch;
});

test('extra filters are passed through in PostgREST\'s own syntax', async () => {
  const calls = stubRest({ daily_sales: [] });
  await pull({
    config: { ...MAPPING, tables: [{ ...MAPPING.tables[0], where: { status: 'eq.settled', voided: 'is.false' } }] },
    token: 'k', from: '2026-05-01', to: '2026-05-31',
  });
  const call = calls[0];
  assert.equal(call.params.get('status'), 'eq.settled');
  assert.equal(call.params.get('voided'), 'is.false');
  globalThis.fetch = realFetch;
});

test('rows kept at their own grain get a stable identity, so a reload cannot double them', async () => {
  stubRest({
    invoices: [
      { id: 91, bought_on: '2026-05-04', item: 'Tomatoes', qty: 10, unit_price: 12.5, supplier: 'Adom Foods' },
    ],
  });
  const bundle = await pull({
    config: {
      base: MAPPING.base,
      tables: [{
        fact: 'purchaseLines', from: 'invoices', day: 'bought_on', line: 'restaurant', money: 'major',
        columns: { itemName: 'item', qty: 'qty', unitCost: 'unit_price', supplierName: 'supplier' },
      }],
    },
    token: 'k', from: '2026-05-01', to: '2026-05-31',
  });
  assert.equal(bundle.purchaseLines[0].externalId, 'supabase:invoices:91');
  assert.equal(bundle.purchaseLines[0].unitCost, 1250);
  globalThis.fetch = realFetch;
});

test('paging follows PostgREST to the end', async () => {
  const page = (n, offset) => Array.from({ length: n }, (_, i) => ({ sale_date: '2026-05-04', total: offset + i }));
  let call = 0;
  globalThis.fetch = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    call += 1;
    // Two full pages then a short one, which is where the walk stops.
    const rows = offset >= 2000 ? page(7, offset) : page(1000, offset);
    return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
  };
  const bundle = await pull({
    config: { base: MAPPING.base, tables: [{ ...MAPPING.tables[0], columns: { net: 'total' } }] },
    token: 'k', from: '2026-05-01', to: '2026-05-31',
  });
  assert.equal(call, 3);
  assert.equal(bundle.revenue.length, 2007);
  globalThis.fetch = realFetch;
});

// ------------------------------------------------------- refusing to guess --

test('a mapping is checked before it is ever used', () => {
  assert.deepEqual(validateMapping(MAPPING), []);

  assert.match(validateMapping({ tables: [] })[0], /No address/);
  assert.match(validateMapping({ base: 'http://x.supabase.co', tables: MAPPING.tables })[0], /https/);
  assert.match(validateMapping({ base: MAPPING.base, tables: [] })[0], /No tables mapped/);

  const badFact = validateMapping({ base: MAPPING.base, tables: [{ fact: 'profit', from: 't', day: 'd' }] });
  assert.match(badFact[0], /not something this warehouse holds/);

  const noLine = validateMapping({ base: MAPPING.base, tables: [{ fact: 'revenue', from: 't', day: 'd', money: 'major' }] });
  assert.match(noLine[0], /needs a business line/);

  const noDay = validateMapping({ base: MAPPING.base, tables: [{ fact: 'revenue', from: 't', line: 'bar', money: 'major' }] });
  assert.match(noDay[0], /needs a column holding the day/);

  const unknownField = validateMapping({
    base: MAPPING.base,
    tables: [{ fact: 'demand', from: 't', day: 'd', columns: { profit: 'p' } }],
  });
  assert.match(unknownField[0], /not a field of demand/);
});

test('money must be declared, because guessing it is out by a hundredfold', () => {
  const problems = validateMapping({
    base: MAPPING.base,
    tables: [{ fact: 'revenue', from: 't', day: 'd', line: 'bar', columns: { net: 'total' } }],
  });
  assert.match(problems[0], /"major".*"minor"/);
  assert.match(problems[0], /no safe default/);
});

test('a broken mapping fails loudly rather than loading nothing', async () => {
  await assert.rejects(
    () => pull({ config: { base: MAPPING.base, tables: [{ fact: 'nonsense', from: 't' }] }, token: 'k', from: '2026-05-01', to: '2026-05-02' }),
    /not usable/);
});

test('a source with no key, or no address, says which', async () => {
  const noKey = await pull({ config: MAPPING, token: null, from: '2026-05-01', to: '2026-05-02' });
  assert.deepEqual(noKey.revenue, []);
  assert.match(noKey.notes.join(' '), /No Supabase key/);

  const noBase = await pull({ config: { tables: [] }, token: 'k', from: '2026-05-01', to: '2026-05-02' });
  assert.match(noBase.notes.join(' '), /No Supabase address/);
});

test('the setup check reports what it actually found', async () => {
  stubRest({ daily_sales: [{ sale_date: '2026-05-04', total: 1 }] });
  const result = await check({ config: MAPPING, token: 'k' });
  assert.equal(result.ok, true);
  assert.match(result.detail, /daily_sales answered/);

  const noKey = await check({ config: MAPPING, token: null });
  assert.equal(noKey.ok, false);
  globalThis.fetch = realFetch;
});
