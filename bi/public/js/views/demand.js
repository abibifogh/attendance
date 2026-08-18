import { add, h, money, num, percent, dayRange } from '../util.js';
import { api } from '../api.js';
import { lineChart, smallMultiples } from '../charts.js';
import { table, banner, caveats } from './components.js';

/**
 * The guest, as the denominator of everything.
 *
 * Every number on this screen is something-per-guest. That is what turns "the
 * restaurant is down" into either "the hotel is emptier" or "the restaurant is
 * selling to fewer of the people who are here", which are different problems
 * with different answers, and which no single system in the group can tell
 * apart.
 */
export async function renderDemand(root, { range }) {
  const data = await api(`/demand?from=${range.from}&to=${range.to}`);
  const s = data.summary;

  add(root, 
    data.demoMode ? banner('demo', h('strong', 'Demonstration data.'), ' Not the business.') : null,

    h('div.card',
      h('h2', 'How full the hotel was'),
      h('p.sub', data.note),
      h('div.grid.three',
        h('div.tile', h('div.label', 'Guest nights'), h('div.value', num(s.guestNights)),
          h('div.note', `Median ${num(s.medianGuests)} a night.`)),
        h('div.tile', h('div.label', 'Restaurant covers per guest'), h('div.value', num(s.captureRate, 2)),
          h('div.note', 'How much of the house eats in. The POS has never been able to compute this.')),
        h('div.tile', h('div.label', 'Laundry orders per guest'), h('div.value', num(s.attachRate, 2)),
          h('div.note', 'One in six is typical for a property that mentions it at check-in.'))),
      lineChart(data.daily, [
        { key: 'guests', label: 'Guests in house', colour: 'var(--series-3)', value: (r) => r.guests },
      ], { height: 190, format: (v) => num(v) })),

    h('div.card',
      h('h2', 'What a guest spends, beyond the room'),
      h('p.sub', 'Each line\'s revenue divided by guest nights.'),
      table([
        { label: 'Line', get: (r) => r.label },
        { label: 'Per guest night', num: true, get: (r) => money(r.value) },
      ], [
        { label: 'Restaurant', value: s.spendPerGuest.restaurant },
        { label: 'Bar', value: s.spendPerGuest.bar },
        { label: 'Laundry', value: s.spendPerGuest.laundry },
        { label: 'Breakfast (outside guests)', value: s.spendPerGuest.breakfast },
      ])),

    h('div.card',
      h('h2', 'Capture and attach, day by day'),
      h('p.sub', 'Covers per guest and laundry orders per guest, each on its own scale.'),
      smallMultiples(data.daily, [
        { key: 'capture', title: 'Restaurant covers per guest', colour: 'var(--series-1)', value: (r) => r.captureRate, format: (v) => num(v, 2) },
        { key: 'attach', title: 'Laundry orders per guest', colour: 'var(--series-2)', value: (r) => r.attachRate, format: (v) => num(v, 2) },
      ])),

    h('div.card',
      h('h2', 'Every day'),
      table([
        { label: 'Day', get: (r) => r.day },
        { label: '', get: (r) => r.dow },
        { label: 'Guests', num: true, get: (r) => num(r.guests) },
        { label: 'Outside guests', num: true, get: (r) => num(r.outsideGuests) },
        { label: 'Covers', num: true, get: (r) => num(r.covers) },
        { label: 'Laundry orders', num: true, get: (r) => num(r.laundryOrders) },
        { label: 'Beds checked', num: true, get: (r) => num(r.roomsCleaned) },
        { label: 'Revenue', num: true, get: (r) => money(r.net) },
        { label: 'Per guest', num: true, get: (r) => money(r.spendPerGuest) },
      ], data.daily)),
  );
}
