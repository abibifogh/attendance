import { api } from '../api.js';
import { fmtDay, h, toast } from '../util.js';
import { field, formDialog } from './att-shared.js';

/**
 * Punches from a number nobody here has.
 *
 * Somebody enrolled on the terminal under one number and put into HIVE under
 * another (Hire gives a number of its own) clocks in every day and appears
 * nowhere. Their punches are kept under the terminal's number; this is where
 * they are matched to the person, or the person is added.
 */

/** "6 punches, 3 Nov to today. Latest: 6 Nov 08:02, 5 Nov 17:31" */
export function sayNumber(row) {
  const span = row.first_seen === row.last_seen
    ? fmtDay(row.first_seen)
    : `${fmtDay(row.first_seen)} to ${fmtDay(row.last_seen)}`;
  const latest = (row.recent ?? []).slice(0, 4)
    .map((t) => `${fmtDay(t.slice(0, 10))} ${t.slice(11, 16)}`).join(' · ');
  return `${row.punches} punch${row.punches === 1 ? '' : 'es'}, ${span}.${latest ? ` Latest: ${latest}.` : ''}`;
}

/**
 * Give the terminal's number to somebody already on the staff list. Returns
 * what the server said, or null when cancelled.
 */
export async function matchNumberDialog(row) {
  const { staff = [] } = await api.attStaff();
  const people = staff.filter((s) => s.active && String(s.employee_no) !== String(row.employee_no))
    // Whoever has no punches yet first, newest start first: almost always the
    // new starter this number belongs to.
    .sort((a, b) => (Number(a.punch_count) > 0) - (Number(b.punch_count) > 0)
      || String(b.hired_on ?? '').localeCompare(String(a.hired_on ?? ''))
      || a.name.localeCompare(b.name));
  if (!people.length) { toast('Nobody active on the staff list to match it to.', 'warn'); return null; }

  const option = (s) => h('option', { value: s.id },
    `${s.name} · now no. ${s.employee_no}${Number(s.punch_count) ? '' : ' · no punches yet'}`);
  const fresh = people.filter((s) => !Number(s.punch_count));
  const rest = people.filter((s) => Number(s.punch_count));

  const done = await formDialog({
    title: `Whose is number ${row.employee_no}?`,
    submitLabel: 'Give them these punches',
    body: h('div',
      h('p.muted', sayNumber(row)),
      field('Who it is', h('select', { name: 'staffId', required: true },
        fresh.length ? h('optgroup', { label: 'No punches yet' }, fresh.map(option)) : null,
        rest.length ? h('optgroup', { label: 'Everybody else' }, rest.map(option)) : null)),
      h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
        `Their employee number becomes ${row.employee_no}, the number the terminal knows them by. `
        + 'These punches become theirs and their days are worked out again. Anything under their '
        + 'old number stops being theirs.'),
    ),
    onSubmit: async (form) => api.attMatchUnknown(row.employee_no, Number(form.get('staffId'))),
  });
  if (done) {
    toast(`${done.claimed} punch${done.claimed === 1 ? '' : 'es'} now with ${done.name}.`, 'good');
  }
  return done;
}

/**
 * A leaver's number given to somebody else on the terminal: the punches from
 * the day it changed hands go to the new holder, and so does the number. The
 * leaver keeps every punch before it.
 */
export async function handNumberDialog(person) {
  const { staff = [] } = await api.attStaff();
  const people = staff.filter((s) => s.active && Number(s.id) !== Number(person.id))
    .sort((a, b) => (Number(a.punch_count) > 0) - (Number(b.punch_count) > 0)
      || String(b.hired_on ?? '').localeCompare(String(a.hired_on ?? ''))
      || a.name.localeCompare(b.name));
  const nextDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const from = person.leftOn ? nextDay(person.leftOn) : new Date().toISOString().slice(0, 10);
  const option = (s) => h('option', { value: s.id },
    `${s.name} · now no. ${s.employee_no}${Number(s.punch_count) ? '' : ' · no punches yet'}`);
  const fresh = people.filter((s) => !Number(s.punch_count));
  const rest = people.filter((s) => Number(s.punch_count));
  const done = await formDialog({
    title: `Number ${person.employeeNo} is someone else's now`,
    submitLabel: 'Move the punches',
    body: h('div',
      field('Who has it now', h('select', { name: 'toStaffId', required: true },
        fresh.length ? h('optgroup', { label: 'No punches yet' }, fresh.map(option)) : null,
        rest.length ? h('optgroup', { label: 'Everybody else' }, rest.map(option)) : null)),
      field('Theirs from', h('input', { type: 'date', name: 'from', value: from, required: true }),
        person.leftOn ? `${person.name} left on ${fmtDay(person.leftOn)}` : 'The first day they punched in with it'),
      h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
        `Punches under ${person.employeeNo} from that day on go to them, and the number becomes theirs. `
        + `${person.name} keeps every punch before it, under a retired copy of the number, `
        + 'so it can never claim another. Both sets of days are worked out again.'),
    ),
    onSubmit: async (form) => api.attHandNumber(person.id, { toStaffId: Number(form.get('toStaffId')), from: form.get('from') }),
  });
  if (done) toast(`${done.moved} punch${done.moved === 1 ? '' : 'es'} moved to ${done.to}. ${done.was} keeps the earlier ones.`, 'good');
  return done;
}
