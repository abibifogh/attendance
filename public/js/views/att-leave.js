import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import { lookOf } from '../leave-looks.js';
import {
  fmtDay, fmtNum, fmtSince, fmtStamp, h, monthOf, mount, shiftDay, shiftMonth, toast, todayISO,
} from '../util.js';
import { card, emptyState, face, table } from './components.js';
import { field, formDialog, monthLabel, signOffDialog } from './att-shared.js';

/**
 * Leave: who is off, who has asked, and how much everybody has left.
 *
 * Balances and requests on one screen deliberately. The question is never "how
 * much leave has Ama left" on its own: it is "can Ama have next Friday off",
 * and answering it means seeing the balance and the request together. So each
 * request is a card that carries its own answer: who else is off those days,
 * against the limit, who else from the same department, and what is left
 * after it.
 */

const DAY_MS = 86400000;
const PATHS = { requests: 'att-leave', booked: 'att-leave-booked', balances: 'att-leave-balances' };

/** Whole days from one date to another, counting both ends. */
const spanOf = (from, to) => Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / DAY_MS) + 1;
/** A figure of days as people say it: 2, 1.5. */
const sayNum = (v) => fmtNum(Number(v), Number(v) % 1 ? 1 : 0);
const plural = (n, word) => `${sayNum(n)} ${word}${Number(n) === 1 ? '' : 's'}`;
const firstName = (name) => String(name || '').split(/\s+/)[0];
const weekday = (day, long = false) => new Date(`${day}T12:00:00Z`)
  .toLocaleDateString('en-GB', { weekday: long ? 'long' : 'short', timeZone: 'UTC' });
const mondayOf = (day) => shiftDay(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
const lookFor = (row) => lookOf({ code: row.reason_code ?? row.code, label: row.reason_label ?? row.label });

/** "a, b and c". */
function listOf(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Thu 12 – Fri 13 Nov", "Mon 2 Nov", "Mon 30 Nov – Fri 4 Dec". */
export function sayDates(from, to) {
  const say = (day, opts) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
  const year = to.slice(0, 4) !== todayISO().slice(0, 4) ? ` ${to.slice(0, 4)}` : '';
  const one = (day, month) => `${say(day, { weekday: 'short' })} ${say(day, { day: 'numeric' })}${month ? ` ${say(day, { month: 'short' })}` : ''}`;
  if (from === to) return `${one(from, true)}${year}`;
  return `${one(from, from.slice(0, 7) !== to.slice(0, 7))} – ${one(to, true)}${year}`;
}

/**
 * A face for somebody on this page: the photograph where there is one, the
 * initials on their own colour where there is not.
 */
export function leaveFace(person, { size = null, photos = null } = {}) {
  const id = Number(person?.id ?? person?.staff_id ?? 0);
  const has = person?.hasPhoto ?? photos?.has(id);
  return face(person?.name ?? person?.staff_name, { src: has && id ? `/api/att/staff/${id}/photo` : null, size });
}

export async function renderAttLeave(params = {}) {
  const host = h('div.lv');
  // One page in three views: what is asked for, what is booked, what is left.
  // Booked and Balances draw the same page, the one asked for first.
  const part = ['booked', 'balances'].includes(params.part) ? params.part : 'requests';
  // Recording leave is for whoever decides it. A rota planner sees what is
  // waiting as well as what is approved, to plan around, and answers none of it.
  const requests = can('att_manage');
  const decides = can('att_manage');
  const reads = can('att_reports');

  const from = params.from || null;
  const [leaveData, balanceData, bootstrap, away] = await Promise.all([
    api.attLeave(),
    reads ? api.attBalances().catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
    api.attBootstrap(),
    part === 'requests' ? api.attAway(from ? { from } : {}).catch(() => null) : Promise.resolve(null),
  ]);

  const reload = async (next = {}) => {
    const merged = { part, ...(from ? { from } : {}), ...next };
    if ('from' in next) replaceParams(PATHS[part], next.from ? { from: next.from } : {});
    mount(host, await renderAttLeave(merged));
  };

  const today = todayISO();
  const leaveKinds = bootstrap.reasons.filter((r) => r.kind === 'leave' && r.active);
  const staffBy = new Map(bootstrap.staff.map((s) => [Number(s.id), s]));
  const pending = leaveData.leave.filter((l) => l.status === 'pending')
    .sort((a, b) => a.from_day.localeCompare(b.from_day));
  const past = leaveData.leave.filter((l) => l.status !== 'pending' && !(l.status === 'approved' && l.to_day >= today));

  // The days each request covers, with everybody else off on them. One window
  // per request, so a request three months out is read against its own days
  // rather than against whatever fortnight the calendar is showing.
  const around = part === 'requests'
    ? await Promise.all(pending.slice(0, 24).map((r) => api.attAway({ from: r.from_day, to: r.to_day }).catch(() => null)))
    : [];
  const photos = new Set();
  for (const set of [away, ...around]) {
    for (const d of set?.days ?? []) for (const p of d.people) if (p.hasPhoto) photos.add(Number(p.id));
  }

  const request = async () => {
    const done = await formDialog({
      title: 'Record leave',
      submitLabel: decides ? 'Approve and record' : 'Send for approval',
      body: h('div',
        field('Who', h('select', { name: 'staffId', required: true },
          h('option', { value: '' }, 'Choose…'),
          bootstrap.staff.filter((s) => s.active).map((s) =>
            h('option', { value: s.id }, s.name)))),
        field('Type', h('select', { name: 'reason', required: true },
          h('option', { value: '' }, 'Choose…'),
          leaveKinds.map((r) => h('option', { value: r.code }, r.label)))),
        h('div.field-row',
          field('First day', h('input', { type: 'date', name: 'from', required: true })),
          field('Last day', h('input', { type: 'date', name: 'to', required: true })),
        ),
        field('Reason', h('input', { type: 'text', name: 'note', maxlength: 500 })),
        // Only for whoever approves it as they record it. Somebody sending it
        // for approval gets the rota's figure, and the approver decides.
        decides
          ? field('Days charged', h('input', {
            type: 'number', name: 'daysCharged', min: 0, step: 0.5, placeholder: 'as the rota says',
          }), 'Leave empty for what the rota says. Fill it in where the rota is not right yet.')
          : null,
        h('p.muted', { style: { fontSize: '.82rem' } },
          'Only rostered days are charged. Rest days and public holidays inside the period cost nothing.'),
      ),
      onSubmit: async (form) => api.attRequestLeave({
        staffId: Number(form.get('staffId')),
        reason: form.get('reason'),
        from: form.get('from'),
        to: form.get('to'),
        note: form.get('note') || null,
        daysCharged: form.get('daysCharged') ? Number(form.get('daysCharged')) : null,
      }),
    });

    if (done) {
      toast(done.status === 'approved'
        ? `${fmtNum(done.days, 1)} day${done.days === 1 ? '' : 's'} recorded.`
        : 'Sent for approval.', 'good');
      await reload();
    }
  };

  /**
   * Approving asks one more thing: how much of it comes off the entitlement.
   *
   * Somebody asks for the week and is given it, but two of those days were
   * always going to be their rest days, or the manager decides to carry part of
   * it. Charging the whole span in that case quietly costs them days they never
   * took.
   */
  const approve = async (row) => {
    const asked = Number(row.days);

    // What the span comes to now. A request made before the rota reached that
    // far carried an estimate, and by the time anybody approves it the real
    // answer usually exists, so it is asked for here rather than trusting a
    // figure frozen in August.
    const now = await api.attLeaveDays(row.id).catch(() => null);
    const suggested = now ? Number(now.days) : asked;
    const ceiling = now ? Number(now.ceiling) : asked;
    const wasGuessed = Boolean(now?.estimated);

    const done = await formDialog({
      title: `Approve ${row.staff_name}'s leave`,
      submitLabel: 'Approve',
      body: h('div',
        h('p', `${fmtDay(row.from_day)} to ${fmtDay(row.to_day)}, `
          + `${fmtNum(suggested, suggested % 1 ? 1 : 0)} rostered day${suggested === 1 ? '' : 's'}.`),
        wasGuessed
          ? h('p.muted', { style: { fontSize: '.82rem' } },
            `They asked for it before the rota reached that far, so ${fmtNum(asked, asked % 1 ? 1 : 0)} `
            + `was an estimate. ${now?.stillEstimated
              ? 'The rota still does not cover it, so this figure is one too. Set it to whatever is right.'
              : 'The rota covers it now, and this is what it says.'}`)
          : null,
        // What they asked for is a suggestion. Whether it is paid, and whether
        // it comes off the entitlement, follows from the type, and that is the
        // property's decision rather than the asker's.
        field('Type', h('select', { name: 'reason' },
          leaveKinds.map((r) => h('option', {
            value: r.code, selected: r.code === row.reason_code,
          }, `${r.label}${r.paid ? '' : ' · unpaid'}${r.deducts_leave ? ' · comes off the entitlement' : ''}`))),
        `They asked for ${(row.reason_label ?? row.reason_code ?? 'leave').toLowerCase()}`),
        field('Charged against the entitlement',
          h('input', {
            type: 'number', name: 'daysCharged', min: 0, max: ceiling, step: 0.5, value: suggested,
          }),
          `of ${fmtNum(ceiling, ceiling % 1 ? 1 : 0)}`),
        h('p.muted', { style: { fontSize: '.82rem' } },
          'Anything you leave out is recorded as an ordinary rest day and costs them nothing.'),
        field('Note', h('input', { type: 'text', name: 'note', maxlength: 500 })),
      ),
      onSubmit: async (form) => api.attDecideLeave(row.id, {
        decision: 'approved',
        reason: form.get('reason'),
        daysCharged: Number(form.get('daysCharged')),
        note: form.get('note') || null,
      }),
    });
    if (!done) return;
    const charged = Number(done.charged ?? suggested);
    toast(charged !== suggested
      ? `Approved. ${fmtNum(charged, charged % 1 ? 1 : 0)} of `
        + `${fmtNum(suggested, suggested % 1 ? 1 : 0)} charged.`
      : 'Approved.', 'good');
    await reload();
  };

  const reject = async (row) => {
    const done = await formDialog({
      title: `Refuse ${row.staff_name}'s leave`,
      submitLabel: 'Refuse',
      body: h('div',
        h('p', `${fmtDay(row.from_day)} to ${fmtDay(row.to_day)}.`),
        field('Why', h('input', { type: 'text', name: 'note', maxlength: 500 }),
          'They see this'),
      ),
      onSubmit: async (form) => api.attDecideLeave(row.id, {
        decision: 'rejected',
        note: form.get('note') || null,
      }),
    });
    if (!done) return;
    toast('Refused.');
    await reload();
  };

  /**
   * Change what kind of leave a record is, after the fact.
   *
   * The type decides what a day costs (paid or not, off the entitlement or
   * not), so it is the one thing on a leave record worth being able to correct
   * without cancelling it and typing the whole thing in again.
   */
  const retype = async (row) => {
    const done = await formDialog({
      title: `${row.staff_name}'s leave`,
      submitLabel: 'Change the type',
      body: h('div',
        h('p', `${fmtDay(row.from_day)} to ${fmtDay(row.to_day)}, `
          + `${fmtNum(row.days, row.days % 1 ? 1 : 0)} day${Number(row.days) === 1 ? '' : 's'}, `
          + `recorded as ${(row.reason_label ?? row.reason_code).toLowerCase()}.`),
        field('Type', h('select', { name: 'reason', required: true },
          leaveKinds.map((r) => h('option', {
            value: r.code, selected: r.code === row.reason_code,
          }, `${r.label}${r.paid ? '' : ' · unpaid'}${r.deducts_leave ? ' · comes off the entitlement' : ''}`)))),
        h('p.muted', { style: { fontSize: '.82rem' } },
          row.status === 'approved'
            ? 'The days are worked out again, so the pay and the balance follow. They are told.'
            : 'They are told, and the days are worked out when it is approved.'),
      ),
      onSubmit: async (form) => api.attSetLeaveType(row.id, { reason: form.get('reason') }),
    });
    if (!done) return;
    toast(`Recorded as ${(done.label ?? 'the new type').toLowerCase()}.`, 'good');
    await reload();
  };

  /**
   * Say what a leave really costs, after it has gone in.
   *
   * The figure is the rota's on the day the leave was recorded, and the rota is
   * not always finished by then. Offered from the figure itself, with what the
   * rota says now beside it, so correcting it is one box rather than
   * cancelling and typing the whole leave in again.
   */
  const redays = async (row) => {
    const now = await api.attLeaveDays(row.id).catch(() => null);
    const span = spanOf(row.from_day, row.to_day);
    const was = Number(row.days);
    const rota = now ? Number(now.days) : null;
    const done = await formDialog({
      title: `${row.staff_name}'s leave`,
      submitLabel: 'Save the days',
      body: h('div',
        h('p', `${fmtDay(row.from_day)} to ${fmtDay(row.to_day)}, recorded as `
          + `${fmtNum(was, was % 1 ? 1 : 0)} day${was === 1 ? '' : 's'}.`),
        rota != null && rota !== was
          ? h('p.muted', { style: { fontSize: '.85rem' } },
            `The rota now makes it ${fmtNum(rota, rota % 1 ? 1 : 0)} day${rota === 1 ? '' : 's'}`
            + `${now?.stillEstimated ? ', though it still does not cover all of it' : ''}.`)
          : null,
        field('Days charged', h('input', {
          type: 'number', name: 'days', min: 0, max: span, step: 0.5, required: true,
          value: rota != null && rota !== was ? rota : was,
        }), `of the ${span} calendar day${span === 1 ? '' : 's'} it covers`),
        field('Why', h('input', { type: 'text', name: 'note', maxlength: 300 }), 'They see this'),
      ),
      onSubmit: async (form) => api.attSetLeaveDays(row.id, {
        days: Number(form.get('days')),
        note: form.get('note') || null,
      }),
    });
    if (!done) return;
    toast(done.unchanged
      ? 'Nothing changed.'
      : `Now ${fmtNum(done.days, done.days % 1 ? 1 : 0)} day${done.days === 1 ? '' : 's'}.`, 'good');
    await reload();
  };

  const cancel = async (row) => {
    if (!window.confirm(
      `Cancel ${row.staff_name}'s ${row.reason_label?.toLowerCase() ?? 'leave'} `
      + `from ${fmtDay(row.from_day)} to ${fmtDay(row.to_day)}?\n\n`
      + 'Those days go back to whatever the terminal recorded, which for days already past '
      + 'usually means they become absences.',
    )) return;
    try {
      await api.attCancelLeave(row.id);
      toast('Cancelled.');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const leftFor = (row) => balanceData.rows.find((b) => b.staff.id === row.staff_id)?.balance;

  /** The kind of leave, in its own colour. Pressable where it can be changed. */
  const typePill = (r) => {
    const label = r.reason_label || r.reason_code;
    return decides && ['pending', 'approved'].includes(r.status)
      ? h('button.lv-type', {
        type: 'button', 'data-leave': lookFor(r), title: 'Change what kind of leave this is', onclick: () => retype(r),
      }, label)
      : h('span.lv-type', { 'data-leave': lookFor(r) }, label);
  };

  // The list of what has been decided, kept as a table: it is a record to
  // look things up in, not a queue to work through.
  const columns = () => [
    {
      key: 'staff_name',
      label: 'Name',
      format: (v, r) => h('div', h('div', v), h('small.muted', `No. ${r.employee_no}`)),
    },
    { key: 'reason_label', label: 'Type', format: (v, r) => typePill(r) },
    {
      key: 'from_day',
      label: 'When',
      // The days, whether they are paid and why, under the dates: one column
      // rather than four, so the record fits beside the calendar.
      format: (v, r) => {
        // A figure asked for before the rota reached that far is a guess, and
        // a guess printed as a fact is the thing somebody argues about later.
        const figure = h('span', r.estimated
          ? { title: 'Estimated: the rota did not reach that far when it was asked for. It is settled when it is approved.' }
          : {}, `${plural(r.days, 'day')}${r.estimated ? ' est.' : ''}`);
        return h('div',
          h('div', v === r.to_day ? fmtDay(v) : `${fmtDay(v)} – ${fmtDay(r.to_day)}`),
          h('small.muted.lv-when-more',
            decides && r.status === 'approved'
              ? h('button.lv-link', { type: 'button', title: 'Correct how many days this costs', onclick: () => redays(r) }, figure)
              : figure,
            ` · ${r.paid ? 'paid' : 'unpaid'}`,
            r.reason ? ` · “${r.reason}”` : ''));
      },
    },
    {
      key: 'requested_at',
      label: 'Recorded',
      format: (v, r) => {
        if (!v) return h('span.muted', '—');
        const by = askedBy(r);
        return h('div', { title: fmtStamp(v) }, h('div', fmtSince(v)), by ? h('small.muted', `by ${by}`) : null);
      },
    },
    {
      key: 'status',
      label: 'Status',
      format: (v) => h(`span.pill${v === 'approved' ? '.good' : v === 'rejected' ? '.bad' : ''}`,
        v === 'rejected' ? 'Refused' : capitalise(v)),
    },
  ];

  const balancesYear = balanceData.rows[0]?.balance;
  const head = h('div.page-head.lv-head',
    h('div',
      h('h1', 'Leave'),
      h('div.sub', part === 'requests'
        ? 'Who is off, and what staff have asked for'
        : balancesYear
          ? `Leave year ${sayYear(balancesYear.from, balancesYear.to)} · as at ${fmtDay(balanceData.asOf)}`
          : 'Who is off, today and coming up'),
    ),
    requests
      ? h('button.btn.btn-primary', { onclick: request },
        decides ? '+ Record leave' : '+ Request leave')
      : null,
  );

  if (part !== 'requests') {
    // What a bar opens: the whole record, and whatever can be done to it.
    const sheet = (row) => {
      const act = (fn) => (e) => { e.target.closest('dialog')?.close(); fn(row); };
      const by = askedBy(row);
      formDialog({
        title: `${row.staff_name}'s leave`,
        submitLabel: 'Close',
        body: h('div.lv-sheet',
          h('div.lv-sheet-top', leaveFace(row, { size: '2.6rem' }),
            h('div', h('strong', sayDates(row.from_day, row.to_day)),
              h('div.muted', `${plural(row.days, 'day')}${row.estimated ? ', estimated' : ''}`)),
            typePill(row)),
          h('dl.lv-facts',
            fact('Status', row.status === 'pending' ? h('span.pill.warn', 'Asked, not decided') : h('span.pill.good', 'Approved')),
            fact('Paid', row.paid ? 'Paid' : 'Unpaid'),
            row.reason ? fact('Why', `“${row.reason}”`) : null,
            row.requested_at ? fact(row.status === 'pending' ? 'Asked' : 'Recorded', `${fmtSince(row.requested_at)}${by ? ` by ${by}` : ''}`) : null),
          decides
            ? h('div.btn-row.lv-sheet-acts',
              row.status === 'pending' ? h('button.btn.btn-primary', { type: 'button', onclick: act(approve) }, 'Approve') : null,
              row.status === 'pending' ? h('button.btn', { type: 'button', onclick: act(reject) }, 'Refuse…') : null,
              h('button.btn-sm', { type: 'button', onclick: act(retype) }, 'Change the type'),
              row.status === 'approved' ? h('button.btn-sm', { type: 'button', onclick: act(redays) }, 'Correct the days') : null,
              row.status === 'approved' && row.to_day >= today
                ? h('button.btn-sm.lv-danger', { type: 'button', onclick: act(cancel) }, 'Cancel it')
                : null)
            : null),
        onSubmit: async () => true,
      });
    };

    const timeline = bookedCard({
      leave: leaveData.leave, from, today, open: sheet, reload, focus: part === 'booked',
    });
    const balances = reads ? balancesCard(balanceData, { focus: part === 'balances', today }) : null;
    const halves = part === 'balances' ? [balances, timeline] : [timeline, balances];
    mount(host, head, h(`div.lv-year${balances ? '' : '.is-single'}`, halves.filter(Boolean)));
    return host;
  }

  /** One request, with everything needed to answer it. */
  const requestCard = (row, i) => {
    const staff = staffBy.get(Number(row.staff_id));
    const dept = staff?.department || null;
    const days = Number(row.days);
    const win = around[i];
    const cap = win?.cap ?? away?.cap ?? null;
    const limited = Number.isFinite(cap) && cap > 0;
    const spanDays = (win?.days ?? []).filter((d) => d.day >= row.from_day && d.day <= row.to_day);
    const perDay = spanDays.map((d) => {
      const others = d.people.filter((p) => Number(p.id) !== Number(row.staff_id) && p.name !== row.staff_name);
      return { day: d.day, others: others.length, same: dept ? others.filter((p) => p.department === dept) : [] };
    });
    const over = limited ? perDay.filter((d) => d.others + 1 > cap) : [];
    const atLimit = limited ? perDay.filter((d) => d.others + 1 === cap) : [];
    const longSpan = perDay.length > 3;
    const dayName = (day, long) => (longSpan ? fmtDay(day) : weekday(day, long));

    // Who else is off, against the limit.
    let offText = null;
    if (perDay.length) {
      if (!longSpan) {
        offText = perDay.map((d) => `${weekday(d.day)}: ${limited ? `${d.others} of ${cap}` : `${d.others} off`}`).join(' · ');
      } else {
        const busiest = perDay.reduce((a, b) => (b.others > a.others ? b : a), perDay[0]);
        offText = busiest.others
          ? `Up to ${limited ? `${busiest.others} of ${cap}` : busiest.others} (${fmtDay(busiest.day)})`
          : `Nobody${limited ? `, ${cap} a day at most` : ''}`;
      }
    }

    // Who else from the same department, and on which of the days.
    const sameBy = new Map();
    for (const d of perDay) {
      for (const p of d.same) {
        if (!sameBy.has(p.name)) sameBy.set(p.name, []);
        sameBy.get(p.name).push(d.day);
      }
    }
    const sameText = sameBy.size
      ? listOf([...sameBy].map(([name, list]) => (perDay.length > 1 && list.length < perDay.length && list.length <= 3
        ? `${firstName(name)} (${list.map((d) => weekday(d)).join(', ')})`
        : firstName(name)))) + (sameBy.size === 1 ? ' is off too' : ' are off too')
      : 'Nobody else off';

    const b = leftFor(row);
    const after = b ? b.remaining - (row.deducts_leave ? days : 0) : null;
    const by = askedBy(row);
    const sick = lookFor(row) === 'sick';

    return h(`article.lv-req${over.length ? '.is-over' : ''}`,
      h('div.lv-req-top',
        leaveFace(row, { size: '2.5rem', photos }),
        h('div.lv-req-who',
          h('strong', row.staff_name),
          h('small', [dept, row.requested_at ? `asked ${fmtSince(row.requested_at)}${by ? ` by ${by}` : ''}` : null]
            .filter(Boolean).join(' · '))),
        typePill(row)),
      h('div.lv-req-when', sayDates(row.from_day, row.to_day),
        h('span', ` · ${plural(days, 'day')}`),
        row.estimated
          ? h('small.muted', { title: 'Estimated: the rota did not reach that far when it was asked for. It is settled when it is approved.' }, ' est.')
          : null),
      h('dl.lv-facts',
        offText ? fact('Off those days already', h(`b${over.length ? '.is-bad' : atLimit.length ? '.is-warn' : ''}`, offText)) : null,
        dept && perDay.length ? fact(`${dept} those days`, h('b', sameText)) : null,
        b
          ? fact('Leave left after this', h(`b${after < 0 ? '.is-bad' : after < 3 ? '.is-warn' : '.is-good'}`, {
            title: `Annual leave left before this request: ${sayNum(b.remaining)}`,
          }, row.deducts_leave
            ? `${sayNum(after)} of ${plural(b.available, 'day')}`
            : `Not charged · ${sayNum(b.remaining)} left`))
          : null,
        row.reason ? fact('Why', h('span', `“${row.reason}”`)) : null),
      over.length
        ? h('div.lv-warn', `${listOf(over.map((d) => dayName(d.day, true)))} would go over the limit of ${cap} a day. Approving it is still allowed.`)
        : null,
      decides
        ? h('div.lv-req-acts',
          h('button.btn.btn-primary', { type: 'button', onclick: () => approve(row) }, 'Approve'),
          sick ? h('button.btn', { type: 'button', onclick: () => navigate('att-rota', { from: row.from_day }) }, 'Find cover on the rota') : null,
          h('button.btn', { type: 'button', onclick: () => reject(row) }, 'Refuse…'))
        : h('div.lv-req-acts', h('span.pill.warn', 'Waiting')));
  };

  const calendar = whoIsOff(away, reload, photos);
  mount(host, head,
    h(`div.lv-req-grid${calendar ? '' : '.is-single'}`,
      calendar,
      h('div.lv-wait',
        h('div.lv-label', `${decides ? 'Waiting on you' : 'Waiting for a decision'} · ${pending.length}`),
        decides || !pending.length ? null : h('p.muted.lv-wait-note',
          'Shown so the rota can be planned around them. A supervisor or manager approves or refuses them.'),
        pending.length
          ? pending.map((row, i) => requestCard(row, i))
          : emptyState('Nothing waiting', 'A request for leave or for a day off shows here until it is decided.')),

      // What was decided, under the calendar on a wide screen so the queue
      // beside it can run as long as it needs to.
      past.length
        ? card('Earlier', { note: `${past.length}`, cls: 'lv-earlier' }, table(columns(), past.slice(0, 60)))
        : null),
  );

  return host;
}

/** One line of facts: a label and what it says. */
function fact(label, value) {
  return h('div.lv-fact', h('dt', label), h('dd', value));
}

/** Who put it in, where that was somebody other than the person off. */
function askedBy(r) {
  const by = String(r.requested_by ?? '').replace(/\s*\([^)]*\)$/, '').trim();
  return by && by.toLowerCase() !== String(r.staff_name ?? '').toLowerCase() ? by : null;
}

/** "January to December 2026", "April 2026 to March 2027". */
function sayYear(from, to) {
  if (!from || !to) return '';
  const month = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${month(from)} to ${month(to)} ${to.slice(0, 4)}`
    : `${month(from)} ${from.slice(0, 4)} to ${month(to)} ${to.slice(0, 4)}`;
}

/**
 * Who is off, a fortnight at a time.
 *
 * A card for each day with the faces of the people away, leave and unavailable
 * days together, which is what the property's limit is held against. What is
 * only asked for wears a dashed ring, so a request can be read against the
 * days it would fill before it is approved. The bar fills towards the limit,
 * and a day at it or over it is tinted. A day is pressed for the names.
 */
function whoIsOff(away, reload, photos) {
  if (!away?.days?.length) return null;
  const { cap, today } = away;
  const limited = Number.isFinite(cap) && cap > 0;
  const names = h('div.away-names.lv-off-names');
  const first = away.days[0].day;
  const last = away.days[away.days.length - 1].day;

  const show = (d) => {
    for (const el of grid.querySelectorAll('.lv-day')) el.classList.toggle('on', el.dataset.day === d.day);
    mount(names, d.people.length
      ? [h('strong', fmtDay(d.day)),
        h('ul', d.people.map((p) => h('li', p.name,
          h('small.muted', ` · ${p.why === 'leave' ? (p.label || 'leave').toLowerCase() : 'cannot work'}${p.department ? ` · ${p.department}` : ''}`),
          p.asked ? h('span.pill.warn', 'Asked') : null)))]
      : h('span.muted', `Nobody is off on ${fmtDay(d.day)}.`));
  };

  const grid = h('div.lv-off-grid', { role: 'list' },
    away.days.slice(0, 7).map((d) => h('div.lv-off-head', { 'aria-hidden': 'true' }, weekday(d.day))),
    away.days.map((d, i) => {
      const approved = d.people.filter((p) => !p.asked).length;
      const asked = d.people.length - approved;
      const total = d.people.length;
      const tone = !limited ? '' : total > cap ? 'is-over' : total === cap || approved >= cap ? 'is-at' : '';
      const shown = d.people.slice(0, d.people.length > 4 ? 3 : 4);
      const more = d.people.length - shown.length;
      const dateNo = Number(d.day.slice(8));
      return h('button.lv-day', {
        type: 'button',
        role: 'listitem',
        'data-day': d.day,
        class: ['lv-day', tone, d.day === today ? 'is-today' : '', d.day < today ? 'is-past' : ''].filter(Boolean).join(' '),
        title: d.people.map((p) => `${p.name}${p.asked ? ' (asked)' : ''}`).join(', ') || 'Nobody off',
        'aria-label': `${fmtDay(d.day)}: ${approved} off${asked ? `, ${asked} more asked for` : ''}`,
        onclick: () => show(d),
      },
      h('span.lv-day-top',
        h('b', String(dateNo), i === 0 || dateNo === 1
          ? h('small.lv-day-month', ` ${new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`)
          : null),
        total ? h('small.lv-day-count', `${approved}${asked ? ` +${asked}` : ''} off`) : null),
      h('span.lv-faces', shown.map((p) => h(`span.lv-face${p.asked ? '.is-asked' : ''}`, {
        title: `${p.name} · ${p.why === 'leave' ? (p.label || 'leave').toLowerCase() : 'cannot work'}${p.asked ? ' · asked, not decided' : ''}`,
      }, leaveFace(p, { photos }))),
      more > 0 ? h('span.lv-face-more', `+${more}`) : null),
      limited
        ? h('span.lv-fill', h('i', { style: { width: `${Math.min(100, (total / cap) * 100)}%` } }))
        : null);
    }));

  const step = (n) => reload({ from: shiftDay(first, n) });
  const sayRange = `${new Date(`${first}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: first.slice(5, 7) === last.slice(5, 7) ? undefined : 'long', timeZone: 'UTC' })}`
    + ` – ${new Date(`${last}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
  return card('Who is off', {
    cls: 'lv-off',
    note: `${sayRange} · ${limited ? `${cap} a day at most` : 'nobody may ask'}`,
    actions: h('div.btn-row',
      h('button.btn-sm', { type: 'button', 'aria-label': 'The fortnight before', onclick: () => step(-14) }, '‹'),
      first <= today && today <= last
        ? null
        : h('button.btn-sm', { type: 'button', onclick: () => reload({ from: null }) }, 'Today'),
      h('button.btn-sm', { type: 'button', 'aria-label': 'The fortnight after', onclick: () => step(14) }, '›')),
  },
  grid,
  h('div.lv-legend',
    h('span', h('i.lv-key.is-booked'), 'Booked'),
    away.showsAsked ? h('span', h('i.lv-key.is-asked'), 'Asked, not decided') : null,
    limited ? h('span', h('i.lv-key.is-at'), 'At the limit') : null,
    limited ? h('span', h('i.lv-key.is-over'), 'Over it') : null,
    h('span.lv-legend-tip', 'Press a day for who, and why.')),
  names,
  h('p.muted.lv-note',
    'Leave and days somebody cannot work, counted together. The limit is set in Settings › Leave & holidays.'));
}

/**
 * What everybody has left: a bar each, taken, booked, asked for and left.
 *
 * The figure on the right is what the balance says now, before anything only
 * asked for. Late in the year anybody with a good part of their leave still to
 * take is marked, while there is still time to plan it.
 */
function balancesCard(data, { focus, today }) {
  if (!data.rows.length) {
    return emptyState('No balances yet', 'Once staff are set up, what each person has left shows here.');
  }
  const end = data.rows[0].balance.to;
  const toGo = end ? spanOf(data.asOf || today, end) - 1 : 365;
  const late = toGo <= 92;
  const monthsToGo = Math.max(1, Math.round(toGo / 30.4));
  const plenty = (b) => b.qualified && b.remaining - b.pending > Math.max(5, b.available / 2);
  const flagged = late ? data.rows.filter((r) => plenty(r.balance)) : [];

  const row = (r) => {
    const b = r.balance;
    const whole = Math.max(b.available, b.taken + b.booked + b.pending, 1);
    const pct = (n) => `${Math.max(0, (n / whole) * 100)}%`;
    const tone = b.remaining <= 0 ? 'is-out' : late && plenty(b) ? 'is-plenty' : 'is-ok';
    const parts = [
      b.taken ? `${sayNum(b.taken)} taken` : null,
      b.booked ? `${sayNum(b.booked)} booked` : null,
      b.pending ? `${sayNum(b.pending)} asked` : null,
    ].filter(Boolean);
    const about = [
      `${plural(b.available, 'day')} this year`,
      b.proRated ? 'pro-rata' : null,
      b.carryOver ? `${sayNum(b.carryOver)} carried over` : null,
      b.qualified ? null : 'not yet qualified',
    ].filter(Boolean).join(' · ');
    return h('div.lv-bal',
      h('div.lv-bal-who',
        leaveFace(r.staff, { size: '1.9rem' }),
        h('div',
          h('a', {
            href: `#/att-staff?id=${r.staff.id}`,
            onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: r.staff.id, period: 'month' }); },
          }, r.staff.name),
          h('small', { title: b.qualified ? null : `${b.serviceMonths} months' service` }, about))),
      h('div.lv-bal-bar',
        h('div.lv-stack', {
          role: 'img',
          'aria-label': `${parts.join(', ') || 'nothing taken yet'}, ${sayNum(b.remaining)} left`,
          title: `Taken ${sayNum(b.taken)} · booked ${sayNum(b.booked)} · asked ${sayNum(b.pending)} · left ${sayNum(b.remaining)}`,
        },
        h('i.is-taken', { style: { width: pct(b.taken) } }),
        h('i.is-booked', { style: { width: pct(b.booked) } }),
        h('i.is-asked', { style: { width: pct(b.pending) } })),
        h('small', parts.join(' · ') || 'Nothing taken yet')),
      h(`div.lv-bal-left.${tone}`, h('b', sayNum(b.remaining)), h('small', 'left')));
  };

  return h(`section.card.lv-bals${focus ? '.is-focus' : ''}`,
    h('div.card-head',
      h('h2', 'What everybody has left'),
      h('div.lv-legend.lv-legend-tight',
        h('span', h('i.lv-key.is-taken'), 'Taken'),
        h('span', h('i.lv-key.is-booked-bal'), 'Booked'),
        h('span', h('i.lv-key.is-asked-bal'), 'Asked'),
        h('span', h('i.lv-key.is-left'), 'Left'))),
    h('div.lv-bal-list', data.rows.map(row)),
    flagged.length
      ? h('div.lv-warn.lv-bal-flag',
        `${flagged.length === 1 ? '1 person has' : `${flagged.length} people have`} more than half their leave left `
        + `with ${monthsToGo === 1 ? 'a month' : `${monthsToGo} months`} to go: ${listOf(flagged.slice(0, 6).map((r) => firstName(r.staff.name)))}`
        + `${flagged.length > 6 ? ` and ${flagged.length - 6} more` : ''}.`)
      : null,
    h('p.muted.lv-note',
      'The default entitlement follows the Labour Act: fifteen working days after twelve months\' '
      + 'continuous service. Change it in Settings › Leave & holidays, or for one person on their record. '
      + 'Somebody part way through their first year is shown a pro-rata figure, so you can see what they '
      + 'are on course for.'));
}

/**
 * What is booked, eight weeks at a time: a line per person, a bar per leave.
 *
 * Coloured by the kind of leave, so a fortnight's holiday and a day off sick
 * are not the same grey. What is asked for and not decided is dashed. A bar
 * opens the record, to change it or cancel it.
 */
function bookedCard({ leave, from, today, open, reload, focus }) {
  const WEEKS = 8;
  const start = mondayOf(from || today);
  const end = shiftDay(start, WEEKS * 7 - 1);
  const width = WEEKS * 7;
  const live = leave.filter((l) => ['approved', 'pending'].includes(l.status));
  const inView = live.filter((l) => l.to_day >= start && l.from_day <= end);
  const later = live.filter((l) => l.from_day > end).length;

  const people = new Map();
  for (const l of [...inView].sort((a, b) => a.from_day.localeCompare(b.from_day))) {
    if (!people.has(l.staff_id)) people.set(l.staff_id, []);
    people.get(l.staff_id).push(l);
  }

  const at = (day) => Math.max(0, Math.min(width, spanOf(start, day) - 1));
  // A bar only says what fits in it. The whole of it is in its title.
  const label = (l, span) => {
    const word = String(l.reason_label || 'Leave').replace(/\s+leave$/i, '');
    if (span >= 9) return `${l.status === 'pending' ? 'Asked' : word} ${sayNum(l.days)}d`;
    return span >= 4 ? `${sayNum(l.days)}d` : '';
  };

  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const monday = shiftDay(start, i * 7);
    const showMonth = i === 0 || monday.slice(5, 7) !== shiftDay(monday, -7).slice(5, 7);
    return h('span', new Date(`${monday}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric', ...(showMonth ? { month: 'short' } : {}), timeZone: 'UTC',
    }));
  });
  const todayAt = today >= start && today <= end ? `${((at(today) + 0.5) / width) * 100}%` : null;
  const looks = [...new Set(inView.filter((l) => l.status === 'approved').map((l) => `${lookFor(l)}|${String(l.reason_label || 'Leave').replace(/\s+leave$/i, '')}`))];

  const step = (n) => reload({ from: shiftDay(start, n) });
  const rangeLabel = `${fmtDay(start)} to ${fmtDay(end)}`;

  return h(`section.card.lv-booked${focus ? '.is-focus' : ''}`,
    h('div.card-head',
      h('h2', 'Booked and coming up'),
      h('span.card-note', rangeLabel),
      h('div.btn-row',
        h('button.btn-sm', { type: 'button', 'aria-label': 'The eight weeks before', onclick: () => step(-WEEKS * 7) }, '‹'),
        from && mondayOf(from) !== mondayOf(today) ? h('button.btn-sm', { type: 'button', onclick: () => reload({ from: null }) }, 'Today') : null,
        h('button.btn-sm', { type: 'button', 'aria-label': 'The eight weeks after', onclick: () => step(WEEKS * 7) }, '›'))),
    people.size
      ? h('div.lv-tl',
        h('div.lv-tl-row.lv-tl-weeks', h('span.lv-tl-who'), h('div.lv-tl-scale', weeks)),
        [...people].map(([, list]) => h('div.lv-tl-row',
          h('div.lv-tl-who', leaveFace(list[0], { size: '1.6rem' }), h('span', list[0].staff_name)),
          h('div.lv-tl-track',
            todayAt ? h('i.lv-tl-today', { style: { left: todayAt } }) : null,
            list.map((l) => {
              const a = at(l.from_day < start ? start : l.from_day);
              const b = at(l.to_day > end ? end : l.to_day) + 1;
              const said = `${l.staff_name}: ${l.reason_label || 'leave'}, ${fmtDay(l.from_day)} to ${fmtDay(l.to_day)}, `
                + `${plural(l.days, 'day')}${l.status === 'pending' ? ', asked and not decided' : ''}`;
              return h(`button.lv-bar${l.status === 'pending' ? '.is-asked' : ''}`, {
                type: 'button',
                'data-leave': lookFor(l),
                style: { left: `${(a / width) * 100}%`, width: `${Math.max(((b - a) / width) * 100, 2.5)}%` },
                title: said,
                'aria-label': said,
                onclick: () => open(l),
              }, label(l, b - a));
            })))))
      : h('p.muted.lv-tl-empty', 'Nobody is booked off in these eight weeks.'),
    later
      ? h('p.lv-tl-later', h('button.btn-plain.lv-link', { type: 'button', onclick: () => step(WEEKS * 7) },
        `${later} more booked after ${fmtDay(end)} ›`))
      : null,
    h('div.lv-legend',
      looks.map((k) => {
        const [look, word] = k.split('|');
        return h('span', h('i.lv-key.is-type', { 'data-leave': look }), word);
      }),
      h('span', h('i.lv-key.is-asked'), 'Asked, waiting'),
      h('span.lv-legend-tip', 'Press a bar to change or cancel it.')));
}

function capitalise(value) {
  return String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1);
}


/**
 * The monthly reckoning: days owed against days worked, and what to do about
 * the gap.
 *
 * Both numbers are computed fresh every time this loads, so a shift corrected
 * this morning or a supervisor's ruling from yesterday shows here immediately —
 * right up until somebody signs the month off. After that the figures as signed
 * are kept beside the live ones, because a decision whose basis has quietly
 * changed underneath it is worse than no decision.
 *
 * Signing off is deliberately two numbers, not one. The difference is what the
 * rota and the terminal say; what actually comes off somebody's leave is a
 * judgement, and the form opens with the difference filled in rather than
 * applied — a default, not a verdict.
 */
export function monthCard(review, month, signs, reload) {
  if (!review) return null;

  // Changing what a month expected moves what the sign-off proposes against
  // somebody's leave, so it belongs with setting the property up rather than
  // with signing it off.
  const sets = can('att_setup');

  const step = async (n) => reload(shiftMonth(month, n));

  const sign = async (row) => {
    const done = await signOffDialog(row, { month });
    if (done) { toast('Recorded.', 'good'); await reload(); }
  };

  const undo = async (row) => {
    if (!window.confirm(`Reopen ${row.staff.name}'s ${monthLabel(month)}?`)) return;
    await api.attUndoReview({ staffId: row.staff.id, month });
    toast('Reopened.');
    await reload();
  };

  const waiting = review.rows.filter((r) => !r.decision).length;

  return card('The month, day for day', {
    note: waiting
      ? `${waiting} still to go through`
      : `all ${review.rows.length} signed off`,
    wide: true,
    actions: h('div.btn-row',
      h('button.btn-sm', { onclick: () => step(-1) }, '‹'),
      h('input', {
        type: 'month', value: month,
        onchange: (e) => e.target.value && reload(e.target.value),
      }),
      h('button.btn-sm', {
        onclick: () => step(1),
        disabled: month >= monthOf(todayISO()),
      }, '›'),
    ),
  },
    review.unsettled
      ? h('p.muted', { style: { color: 'var(--warn)', marginTop: 0 } },
        `${review.unsettled} day${review.unsettled === 1 ? '' : 's'} this month are still waiting `
        + 'on a supervisor. Their hours are not settled, so signing off now signs off a guess.')
      : null,

    table([
      { key: 'staff', label: 'Name', format: (v) => h('div', h('div', v.name), h('small.muted', v.department || v.employee_no)) },
      {
        key: 'calendarDays',
        label: 'Calendar',
        align: 'right',
        // What this month expected of this person. Five days out of every
        // seven unless somebody has said otherwise for this particular month —
        // a season covered on six days, a fortnight of closure, three months
        // part-time after an illness. Pressable either way: to read the days
        // behind it, or, if you may, to say what the month actually asked.
        format: (v, r) => h('div',
          openable(fmtNum(v, 0), () => (sets
            ? setCalendar(r, month, reload)
            : breakdown(r, month, 'calendar'))),
          r.calendarSet?.days != null
            ? h('small.muted', { style: { display: 'block' } }, 'set by hand')
            : null),
      },
      {
        key: 'scheduledDays',
        label: 'Rostered',
        align: 'right',
        format: (v, r) => openable(fmtNum(v, 1), () => breakdown(r, month, 'rostered')),
      },
      {
        key: 'workedDays',
        label: 'Worked',
        align: 'right',
        // Days clocked in *and* out of. A tap in with no tap out is not a day
        // worked; it is a day somebody still has to look at.
        format: (v, r) => openable(fmtNum(v, 0), () => breakdown(r, month, 'worked')),
      },
      {
        key: 'daysLeave',
        label: 'On leave',
        align: 'right',
        format: (v, r) => (v
          ? openable(fmtNum(v, 0), () => breakdown(r, month, 'leave'))
          : h('span.muted', '—')),
      },
      {
        key: 'difference',
        label: 'Over / under',
        align: 'right',
        // Worked plus leave, less the working days expected. One figure, and
        // the one the sign-off proposes against somebody's leave.
        format: (v, r) => h('div',
          v
            ? openable(
              h(`span.pill${v < 0 ? '.bad' : '.good'}`, `${v > 0 ? '+' : ''}${v}`),
              () => breakdown(r, month, v < 0 ? 'under' : 'over'),
            )
            : h('span.muted', 'square'),
          r.unsettledAbsences
            ? h('div', openable(
              h('small.pill.warn', `${r.unsettledAbsences} to settle`),
              () => breakdown(r, month, 'absent'),
            ))
            : null),
      },
      {
        key: 'daysAbsent',
        label: 'Absent',
        align: 'right',
        format: (v, r) => (v
          ? openable(fmtNum(v, 0), () => breakdown(r, month, 'absent'))
          : h('span.muted', '—')),
      },
      {
        key: 'decision',
        label: 'Decision',
        format: (v) => {
          if (!v) return h('span.pill.warn', 'waiting');
          if (v.decision === 'waived') return h('div', h('span.pill', 'let stand'), h('small.muted', ` ${v.by}`));
          return h('div',
            h('span.pill.good', `${v.daysApplied > 0 ? '+' : ''}${fmtNum(v.daysApplied, 1)} days`),
            h('small.muted', ` ${v.by}`));
        },
      },
      {
        key: 'actions',
        label: '',
        format: (v, r) => (signs
          ? h('div.btn-row', r.decision
            ? h('button.btn-sm', { onclick: () => undo(r) }, 'Reopen')
            : h('button.btn-sm', { onclick: () => sign(r) }, 'Sign off'))
          : null),
      },
    ], review.rows, { empty: 'Nobody was rostered or worked in this month.' }),

    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Every figure on a row can be pressed to see the days behind it. '
      + 'Over / under is Worked plus On leave, less Calendar — so a row that comes to nothing is '
      + 'somebody who gave the month exactly what it asked for. '
      + 'Calendar is the working days the month held: Monday to Friday, less any public holiday '
      + 'falling on one. It is the same for everybody, because whoever is rostered at the weekend '
      + 'takes their rest days midweek and the quota comes to the same thing over a month. '
      + 'Worked counts days clocked in and out of, whole days only — a tap in with no tap out is '
      + 'not a day worked, it is a day somebody still has to look at, and the count beside the '
      + 'figure says how many are waiting. Rostered is what the rota asked for and is there for '
      + 'comparison; it does not enter the arithmetic. '
      + 'Signing off moves days on and off the leave balance, and the balances under Leave '
      + 'include every month already signed.'),
  );
}

/**
 * Say what a month actually expected of somebody.
 *
 * Offered from the figure itself. A settings page somewhere else is a settings
 * page nobody finds on the morning they need it, and what prompts anybody to
 * change this is looking at a row and knowing the number is wrong.
 */
async function setCalendar(row, month, reload) {
  const worked = await formDialog({
    title: `${row.staff.name} — ${monthLabel(month)}`,
    submitLabel: 'Save',
    body: h('div',
      h('p.muted', `The rule makes it ${fmtNum(row.calendarDays, 0)} days — five out of every `
        + `seven, less public holidays. They were rostered ${fmtNum(row.scheduledDays, 0)} and `
        + `worked ${fmtNum(row.workedDays, 0)}.`),

      field('Working days this month', h('input', {
        type: 'number', name: 'days', min: 0, max: 31, step: 0.5,
        value: row.calendarSet?.days ?? '',
        placeholder: String(row.calendarDays),
      }), 'Leave blank to go back to the ordinary rule'),

      field('Why', h('input', {
        type: 'text', name: 'note', maxlength: 300,
        placeholder: 'Covered the season on six days',
      }), 'For whoever reads this month back in March'),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'This month only, and this person only. It changes what the over / under comes to and '
        + 'what a sign-off would propose against their leave — it does not change anything '
        + 'already signed.'),
    ),
    onSubmit: async (form) => api.attSetCalendar({
      staffId: row.staff.id,
      month,
      days: form.get('days') || null,
      note: form.get('note') || null,
    }),
  });

  if (worked) { toast('Saved.', 'good'); await reload(); }
}

/** A figure you can press, which is the difference between a number and a claim. */
function openable(content, onclick) {
  return h('button.btn-plain', {
    onclick,
    title: 'See the days behind this',
    style: {
      background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit',
      color: 'inherit', textDecoration: 'underline', textDecorationStyle: 'dotted',
      textUnderlineOffset: '3px',
    },
  }, content);
}


/**
 * The days behind a figure.
 *
 * Every number on that row is a count of days, and a count nobody can open is
 * an assertion. Rostered, worked, over and under each list the days they were
 * made of — which is what turns "you were two days short" from a claim into
 * something a person can be shown.
 */
/** Whether a day already sits inside a signed span for this person. */
function signedOn(row, dayStr) {
  if (row.decision) return true;
  return (row.overlapping ?? []).some((sp) => sp.from <= dayStr && sp.to >= dayStr);
}

function breakdown(row, month, which) {
  const titles = {
    rostered: 'Days the rota asked for',
    worked: 'Days worked',
    over: 'Extra days that counted',
    under: 'Whole shifts missed and confirmed',
    absent: 'Days missed',
    leave: 'Days on leave',
    calendar: 'Working days in the month',
  };

  const pick = {
    rostered: (d) => d.scheduled,
    worked: (d) => d.worked,
    over: (d) => d.counts === 'over',
    under: (d) => d.counts === 'under',
    // Every missed day, whether or not anybody has ruled on it — which is the
    // whole reason somebody presses this figure rather than the under one.
    absent: (d) => d.credit === 0 && ['absent', 'missing_in', 'missing_out'].includes(d.status),
    leave: (d) => d.onLeave,
    calendar: (d) => d.quota > 0,
  }[which];

  const days = (row.days ?? []).filter(pick);

  return formDialog({
    title: `${row.staff.name} — ${titles[which]}`,
    submitLabel: 'Close',
    body: h('div',
      h('p.muted', `${monthLabel(month)} — ${days.length} day${days.length === 1 ? '' : 's'}`),
      which === 'over'
        ? h('p.muted', { style: { fontSize: '.85rem' } },
          'A day given that nothing was expected of — worked at a weekend, or on a public '
          + 'holiday, or spent on leave on a day that was not a working day anyway.')
        : null,
      which === 'under'
        ? h('p.muted', { style: { fontSize: '.85rem' } },
          'A working day the month expected and did not get: nothing recorded at all, or a tap '
          + 'in with no tap out. Settling one does not remove it — it explains it.')
        : null,
      which === 'absent'
        ? h('p.muted', { style: { fontSize: '.85rem' } },
          'Every day missed, settled or not. A day with nobody against it has not been ruled on '
          + 'yet — it still counts in the over / under, because a working day nobody delivered '
          + 'is a working day nobody delivered, but somebody should say what happened.')
        : null,
      which === 'calendar'
        ? h('p.muted', { style: { fontSize: '.85rem' } },
          'Monday to Friday, less any public holiday falling on one. The same for everybody: '
          + 'whoever is rostered at the weekend takes their rest days midweek, so over a month '
          + 'the quota comes to the same thing.')
        : null,
      days.length
        ? table([
          { key: 'day', label: 'Date', format: (v) => fmtDay(v) },
          { key: 'shift', label: 'Shift', format: (v) => (v ? h('small', v) : h('span.muted', 'not rostered')) },
          { key: 'in', label: 'In', align: 'right', format: (v) => (v || h('span.muted', '—')) },
          { key: 'out', label: 'Out', align: 'right', format: (v) => (v || h('span.muted', '—')) },
          { key: 'minutes', label: 'Hours', align: 'right', format: (v) => (v ? fmtNum(v / 60, 1) : h('span.muted', '—')) },
          { key: 'label', label: 'Status', format: (v) => h('small', v) },
          { key: 'resolvedBy', label: 'Ruled by', format: (v) => (v ? h('small.muted', v) : h('span.muted', '—')) },
          {
            key: 'signed',
            label: '',
            format: (v, d) => (signedOn(row, d.day) ? h('span.pill.good', '✓ signed') : null),
          },
        ], days, { empty: 'None.' })
        : h('div.empty', h('p', which === 'under'
          ? 'Nothing counted. Absences that nobody has confirmed do not count here — settle them '
            + 'on the person\u2019s report and they will appear.'
          : 'Nothing counted.')),
    ),
    onSubmit: async () => true,
  });
}
