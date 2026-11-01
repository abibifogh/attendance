import { api } from '../api.js';
import { daysApart, fmtDay, fmtDayShort, h, monthOf, mount, shiftDay, toast, todayISO } from '../util.js';
import { monthCard } from './att-leave.js';
import { card, emptyState, table } from './components.js';
import { can, navigate, replaceParams } from '../app.js';
import {
  correctTimesDialog, field, formDialog, overUnderOf, reasonSelect, shiftColour,
} from './att-shared.js';

/**
 * What is still waiting to be signed off.
 *
 * The screen whoever builds the rota opens on a Monday. Two ideas behind it.
 *
 * Signing is per day, not per month. A fortnight with three days nobody can
 * explain used to be all-or-nothing — sign the lot or leave eleven settled days
 * waiting on three — so the three held up everything and nothing got signed.
 * Now the clear days go and the awkward ones stay on the list.
 *
 * And there is a second answer beside "sign it". A run of lateness or an
 * absence nobody has explained is a question for somebody senior before it
 * becomes a charge against a colleague's leave. Raising it is one press, and
 * it lands in a queue rather than in a conversation nobody can find again.
 */
const PRESETS = [
  ['yesterday', 'Yesterday'],
  ['week', 'Last 7 days'],
  ['fortnight', 'Last 14 days'],
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
];

// Every way a period is closed, in one place. Months used to be signed off
// from the Leave screen as well.
const TABS = [['open', 'To sign off'], ['months', 'Months'], ['queries', 'Questions'], ['times', 'Clock changes'],
  ['leave', 'Leave days']];

/**
 * The person just acted on, so the list does not move out from under them.
 *
 * The list is ordered worst first, which is right when you open it and wrong
 * the moment you do anything: signing somebody's two worst days drops their
 * count, so on the refresh they re-sort into the middle of twenty-three cards
 * and the person you were halfway through working on is simply gone from the
 * screen. It reads as "the whole card disappeared when I signed two days" —
 * and from where the reader is sitting, it did.
 *
 * So whoever you last acted on is held at the top until you do something else.
 * It is not a second sort order; it is one card kept under the eye that was
 * already on it, with a line saying what just happened to it.
 */
let justActed = null;

/**
 * The day last signed with one press on the list, so it can be taken back.
 * Held on the page rather than in a toast, which is gone before most people
 * have read it; cleared by any other control, like the pin above.
 */
let justSigned = null;

/** Held for a few minutes only, so coming back to the screen later is clean. */
const PIN_MS = 10 * 60 * 1000;
const pinned = () => (justActed && Date.now() - justActed.at < PIN_MS ? justActed : null);

/** Remember who, and what to say on their card. Cleared by any other move. */
function keepInView(staffId, note) {
  justActed = { staffId, note, at: Date.now() };
}

export async function renderAttSignoff(params) {
  const host = h('div.so-page');
  const tab = TABS.some(([key]) => key === params.tab) ? params.tab : 'open';
  const range = rangeFor(params);

  const reload = async (next = {}) => {
    // Called with no arguments after an action — keep the pin. Called with
    // arguments because a control was pressed — the reader has moved on.
    if (Object.keys(next).length) { justActed = null; justSigned = null; }
    const merged = { ...params, ...next };
    replaceParams('signoff', merged);
    mount(host, await renderAttSignoff(merged));
  };

  const [content, counts] = await Promise.all([
    tab === 'months' ? monthsTab(params, reload)
      : tab === 'queries' ? queriesTab(reload)
        : tab === 'times' ? timesTab(range, reload)
          : tab === 'leave' ? leaveTab(reload)
            : openTab(params, range, reload),
    tabCounts(),
  ]);

  // The tabs carry how many are waiting behind each, so a question nobody has
  // answered is visible from whichever tab somebody happens to be on.
  const tabs = h('div.so-tabs', { role: 'tablist' }, TABS.map(([key, label]) =>
    h('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': tab === key ? 'true' : 'false',
      class: tab === key ? 'on' : '',
      onclick: () => reload({ tab: key }),
    }, label, counts[key] ? h('span.so-tab-n', String(counts[key])) : null)));

  mount(host,
    h('div.so-head', h('h1', 'Sign-off'), tabs),
    content,
  );

  return host;
}

/**
 * How many are waiting behind each of the other tabs. Each is asked on its
 * own and a refusal (a tab this login cannot open) is simply no number.
 */
async function tabCounts() {
  const [queries, times, leave] = await Promise.all([
    api.attQueries().catch(() => null),
    api.attTimeEdits({ limit: 1 }).catch(() => null),
    api.attLeaveChanges().catch(() => null),
  ]);
  return {
    queries: (queries?.rows ?? []).filter((q) => q.status === 'open' || q.status === 'answered').length,
    times: (times?.pending ?? []).length,
    leave: (leave?.rows ?? []).filter((r) => r.status === 'pending').length,
  };
}

/**
 * A month at a time: days owed against days worked, signed off person by
 * person, and what it does to their leave.
 */
async function monthsTab(params, reload) {
  const month = params.month || monthOf(todayISO());
  const review = await api.attReview({ month }).catch(() => null);
  return monthCard(review, month, true, (next) => reload(next ? { month: next } : {}))
    ?? emptyState('Nothing to sign off', 'Nobody was rostered or worked in this month.');
}

/** The window, from a preset or a pair of dates picked by hand. */
function rangeFor(params) {
  if (params.from && params.to) return { from: params.from, to: params.to, preset: null };

  const today = todayISO();
  const preset = params.preset || 'fortnight';

  if (preset === 'yesterday') return { from: shiftDay(today, -1), to: shiftDay(today, -1), preset };
  if (preset === 'week') return { from: shiftDay(today, -7), to: shiftDay(today, -1), preset };
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: shiftDay(today, -1), preset };
  if (preset === 'lastmonth') {
    const first = `${today.slice(0, 7)}-01`;
    const end = shiftDay(first, -1);
    return { from: `${end.slice(0, 7)}-01`, to: end, preset };
  }
  return { from: shiftDay(today, -14), to: shiftDay(today, -1), preset: 'fortnight' };
}

// ---------------------------------------------------------------------------
// What is outstanding
// ---------------------------------------------------------------------------

/**
 * What is outstanding, as a list of the things to settle.
 *
 * One line per day that needs somebody: what kind of problem it is, whose day
 * and which shift, what happened in a sentence, and the likely fix as the main
 * button with the other answers beside it. Every button is one of the answers
 * this screen already gave (correct the times, sign the day as it stands, ask
 * somebody, open their record), moved onto the line it is about.
 *
 * The days nothing is wrong with are not listed. They are counted, and signed
 * together from the footer once the reader is happy with them.
 *
 * The person-by-person cards are still here under "Each person", for ticking a
 * run of somebody's days, reopening what was signed, or asking about a week.
 */
async function openTab(params, range, reload) {
  const view = params.view === 'people' ? 'people' : 'problems';
  const data = await api.attOutstanding({
    from: range.from,
    to: range.to,
    ...(params.department ? { department: params.department } : {}),
    ...(view === 'people' && (params.issues === '1' || params.issues === '0') ? { issues: params.issues } : {}),
  });

  const groups = groupRows(data.rows);

  // Days nothing is wrong with and nothing is waiting on. The bulk clear works
  // on the working list alone: sweeping up a day somebody deliberately asked
  // about would answer their question for them.
  const clearable = groups.working
    .map((row) => ({ row, days: row.days.filter((d) => !d.issues.length && !d.pendingTimes) }))
    .filter((entry) => entry.days.length);
  const clearableDays = clearable.reduce((n, entry) => n + entry.days.length, 0);

  const problems = problemsOf(data.rows);
  const totalDays = data.rows.reduce((n, r) => n + r.days.length, 0);

  const side = sidePanel({
    params, range, data, reload, view, clean: clearableDays, total: totalDays, problems,
  });

  const main = view === 'people'
    ? peopleView({ params, data, reload, groups, clearable, clearableDays })
    : problemsView({ params, data, reload, problems, clearable, clearableDays });

  return h('div.so-layout', main, side);
}

/** Each person's days split by where any question about them has got to. */
function groupRows(rows) {
  /** One person, cut down to a given set of their days. */
  const slice = (row, days) => ({ ...row, days, unsignedCount: days.length });

  const groups = { answered: [], working: [], asked: [] };
  for (const row of rows) {
    const bucket = {
      answered: row.days.filter((d) => d.query?.status === 'answered'),
      working: row.days.filter((d) => !d.query),
      asked: row.days.filter((d) => d.query?.status === 'open'),
    };
    for (const key of Object.keys(groups)) {
      if (bucket[key].length) groups[key].push(slice(row, bucket[key]));
    }
  }

  // Whoever was just acted on stays at the top of whichever group they are in
  // now, rather than re-sorting away under the reader.
  const pin = pinned();
  if (pin) {
    for (const list of Object.values(groups)) {
      const at = list.findIndex((r) => r.staff.id === pin.staffId);
      if (at > 0) list.unshift(...list.splice(at, 1));
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The things to settle
// ---------------------------------------------------------------------------

/**
 * The kinds of problem, in the order they are listed. `wait` marks the ones
 * that are with somebody else: shown, but not counted as things to settle.
 */
const KINDS = [
  { key: 'noout', label: 'No clock-out', icon: '?', tone: 'info' },
  { key: 'noin', label: 'No clock-in', icon: '?', tone: 'info' },
  { key: 'absent', label: 'Absent', icon: '✕', tone: 'bad' },
  { key: 'late', label: 'Late', icon: '!', tone: 'warn' },
  { key: 'early', label: 'Left early', icon: '!', tone: 'warn' },
  { key: 'noshift', label: 'No shift', icon: '+', tone: 'accent' },
  { key: 'answered', label: 'Answered', icon: '✓', tone: 'good' },
  { key: 'other', label: 'Other', icon: '•', tone: 'plain' },
  { key: 'waiting', label: 'Clock change waiting', icon: '⏳', tone: 'plain', wait: true },
  { key: 'asked', label: 'Asked', icon: '?', tone: 'plain', wait: true },
];
const KIND = new Map(KINDS.map((k) => [k.key, k]));

/** Which kind of problem a day is. A day carrying two shows as the worse. */
function kindOf(day) {
  if (day.query?.status === 'open') return 'asked';
  if (day.pendingTimes) return 'waiting';
  if (day.query?.status === 'answered') return 'answered';
  const has = (key) => day.issues.includes(key);
  if (has('open')) return day.in ? 'noout' : 'noin';
  if (has('absent') || has('under')) return 'absent';
  if (has('late')) return 'late';
  if (has('early')) return 'early';
  if (has('noshift') || has('over')) return 'noshift';
  return day.issues.length ? 'other' : null;
}

/** Every day that needs somebody, worst kind first, then by date. */
function problemsOf(rows) {
  const order = new Map(KINDS.map((k, i) => [k.key, i]));
  const list = [];
  for (const row of rows) {
    for (const day of row.days) {
      const kind = kindOf(day);
      if (kind) list.push({ row, day, kind });
    }
  }
  return list.sort((a, b) => (order.get(a.kind) - order.get(b.kind))
    || (a.day.day < b.day.day ? -1 : a.day.day > b.day.day ? 1 : 0)
    || a.row.staff.name.localeCompare(b.row.staff.name));
}

/** "1h 07m" or "34 min": how far out, the way somebody would say it. */
function sayMinutes(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "Night 22:00–06:00", or what the day was if nobody rostered a shift. */
function shiftLabel(day) {
  if (!day.shift) return day.scheduled ? 'no shift named' : 'no shift';
  if (!day.starts || !day.ends || day.shift.includes(day.starts)) return day.shift;
  return `${day.shift} ${day.starts}–${day.ends}`;
}

/** What happened, in one sentence, with the part that matters in bold. */
function sentenceFor(item) {
  const { day, kind } = item;
  const extra = kind !== 'early' && day.issues.includes('early') && day.earlyMinutes
    ? ` · left ${sayMinutes(day.earlyMinutes)} early`
    : '';

  switch (kind) {
    case 'noout':
      return [`Clocked in ${day.in}, `, h('b', 'no clock-out'), extra];
    case 'noin':
      return day.out
        ? [`Clocked out ${day.out}, `, h('b', 'no clock-in')]
        : [h('b', 'Nothing clocked'), ', and nobody has said why'];
    case 'absent':
      return [h('b', 'Absent'), day.issues.includes('under')
        ? ', a whole shift missed'
        : ', nothing clocked'];
    case 'late':
      return [h('b', day.lateMinutes ? `${sayMinutes(day.lateMinutes)} late` : 'Late'),
        day.in ? ` · in ${day.in}` : '', extra];
    case 'early':
      return [h('b', day.earlyMinutes ? `Left ${sayMinutes(day.earlyMinutes)} early` : 'Left early'),
        day.out ? ` · out ${day.out}` : ''];
    case 'noshift':
      return [`Worked ${day.in || '—'}–${day.out || '—'} with `, h('b', 'nothing on the rota')];
    case 'answered':
      return [h('b', 'Answered'), day.query?.reason ? `: ${day.query.reason}` : '', ` · ${day.label}`];
    case 'waiting':
      return [h('b', 'Clock change waiting'), `: ${day.pendingTimes.actor} asked for `
        + `${day.pendingTimes.now_in || '—'} → ${day.pendingTimes.now_out || '—'}`];
    case 'asked':
      return [h('b', `Asked${day.query?.addressedName ? ` of ${day.query.addressedName}` : ''}`),
        day.query?.reason ? `: ${day.query.reason}` : ''];
    default:
      return [h('b', day.label || 'Flagged'),
        day.in || day.out ? ` · ${day.in || '—'} → ${day.out || '—'}` : ''];
  }
}

/**
 * The answers to one problem: the likely one first, the others beside it.
 * Each is an action this screen already had.
 */
function fixesFor(item, data, reload) {
  const { row, day, kind } = item;
  const staff = row.staff;
  const one = () => new Set([day.day]);
  const ask = { label: 'Ask', title: 'Ask somebody senior about this day', run: () => raise(row, one(), reload) };
  const times = (label = 'Another time…') => (data.canFixTimes
    ? { label, title: 'Change the clock-in or clock-out', run: () => fixTimes(staff, day, reload) }
    : null);
  const reason = (label, preset) => (data.canDecide
    ? { label, title: 'Record what the day was', run: () => giveReason(row, day, preset, reload) }
    : null);
  const record = {
    label: 'Open their day',
    run: () => navigate('att-staff', { id: staff.id, day: day.day, period: 'day' }),
  };

  switch (kind) {
    case 'noout':
      return [
        data.canFixTimes && day.ends
          ? {
            label: `Out at ${day.ends}`,
            title: 'Set the clock-out to the end of the shift',
            run: () => setTime(row, day, { in: day.corrected_in || day.in, out: day.ends },
              `No clock-out. Out at ${day.ends}, the end of the shift.`, reload),
          }
          : times('Set the clock-out…'),
        data.canFixTimes && day.ends ? times() : null,
        ask,
      ];
    case 'noin':
      return [
        data.canFixTimes && day.starts && day.out
          ? {
            label: `In at ${day.starts}`,
            title: 'Set the clock-in to the start of the shift',
            run: () => setTime(row, day, { in: day.starts, out: day.corrected_out || day.out },
              `No clock-in. In at ${day.starts}, the start of the shift.`, reload),
          }
          : times('Set the times…'),
        data.canFixTimes && day.starts && day.out ? times() : null,
        reason('Give a reason…', ''),
        ask,
      ];
    case 'absent':
      return [
        { label: 'Sign off as absent', title: 'Sign this day as it stands', run: () => sign(row, one(), reload) },
        reason('Give a reason…', ''),
        ask,
        times('They were in…'),
      ];
    case 'late':
    case 'early':
      return [
        {
          label: kind === 'late' ? 'Keep as late' : 'Keep as left early',
          title: 'Sign this day as it stands',
          run: () => quickSign(row, day,
            kind === 'late' ? 'Late, kept as it stands' : 'Left early, kept as it stands', reload),
        },
        reason('Excuse it…', 'present') ?? times('Change the times…'),
        ask,
      ];
    case 'noshift':
      return [
        {
          label: 'Count it as worked',
          title: 'Sign this day as worked',
          run: () => quickSign(row, day, 'Worked with no shift, counted', reload),
        },
        times('Change the times…'),
        ask,
      ];
    case 'answered':
      return [
        { label: 'Sign it off', run: () => sign(row, one(), reload) },
        { label: 'See the answer', run: () => reload({ tab: 'queries' }) },
      ];
    case 'waiting':
      return can('att_setup')
        ? [{ label: 'Approve or send back', run: () => reload({ tab: 'times' }) }, record]
        : [record];
    case 'asked':
      return [{ label: 'See the question', run: () => reload({ tab: 'queries' }) }, record];
    default:
      return [
        { label: 'Sign it as it stands', run: () => sign(row, one(), reload) },
        times('Change the times…'),
        ask,
      ];
  }
}

/** One problem, one line. */
function problemLine(item, data, reload) {
  const { row, day, kind } = item;
  const meta = KIND.get(kind) ?? KIND.get('other');
  // Three at most: the likely answer and two others. Anything further is on
  // their record, and a row of five buttons is a row nobody reads.
  const fixes = fixesFor(item, data, reload).filter(Boolean).slice(0, 3);
  const colour = day.shiftId ? shiftColour({ id: day.shiftId, colour: day.shiftColour }) : 0;

  const press = (fix) => async (event) => {
    const line = event.currentTarget.closest('.so-issue');
    const buttons = [...(line?.querySelectorAll('button') ?? [])];
    line?.classList.add('is-busy');
    for (const b of buttons) b.disabled = true;
    try {
      await fix.run();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      // The list is redrawn after anything that worked, so this only matters
      // when the answer was cancelled or refused.
      line?.classList.remove('is-busy');
      for (const b of buttons) b.disabled = false;
    }
  };

  return h(`div.so-issue.is-${meta.tone}`, { dataset: { kind } },
    h('span.so-ic', { 'aria-hidden': 'true' }, meta.icon),
    h('div.so-who',
      h('b', row.staff.name),
      h('div.so-when',
        h('span', fmtDay(day.day)),
        h('span.so-shift', { 'data-shift-colour': String(colour) }, shiftLabel(day)))),
    h('div.so-what', h('span.so-kind-word', `${meta.label}: `), sentenceFor(item)),
    h('div.so-fixes', fixes.map((fix, i) => h(`button.so-btn${i === 0 ? '.so-fix' : ''}`, {
      type: 'button', title: fix.title ?? null, onclick: press(fix),
    }, fix.label))),
  );
}

function problemsView({ params, data, reload, problems, clearable, clearableDays }) {
  const toSettle = problems.filter((p) => !KIND.get(p.kind)?.wait);
  const waiting = problems.filter((p) => KIND.get(p.kind)?.wait);

  // Kind chips: everything, then each kind that is actually on the list.
  const counts = new Map();
  for (const p of problems) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  let chosen = counts.has(params.kind) ? params.kind : 'all';

  const listHost = h('div.so-list');
  const chipHost = h('div.so-chips.so-kinds', { role: 'group', 'aria-label': 'Show only' });

  const draw = () => {
    mount(chipHost,
      [['all', 'Everything', problems.length], ...KINDS.filter((k) => counts.has(k.key))
        .map((k) => [k.key, k.label, counts.get(k.key)])]
        .map(([key, label, n]) => h('button.so-chip', {
          type: 'button',
          class: chosen === key ? 'on' : '',
          'aria-pressed': chosen === key ? 'true' : 'false',
          onclick: () => {
            chosen = key;
            params.kind = key === 'all' ? null : key;
            replaceParams('signoff', params);
            draw();
          },
        }, label, h('span.so-chip-n', String(n)))));

    const shown = (list) => (chosen === 'all' ? list : list.filter((p) => p.kind === chosen));
    const mine = shown(toSettle);
    const theirs = shown(waiting);
    mount(listHost,
      mine.map((p) => problemLine(p, data, reload)),
      theirs.length
        ? h('div.so-sub', `Waiting on somebody else · ${theirs.length}`)
        : null,
      theirs.map((p) => problemLine(p, data, reload)),
      !mine.length && !theirs.length
        ? h('div.so-none',
          h('span.so-none-tick', { 'aria-hidden': 'true' }, '✓'),
          h('b', data.rows.length ? 'Nothing to settle' : 'Nothing outstanding'),
          h('span', data.rows.length
            ? 'Every day left in this period is clean. Sign them off below.'
            : `Every day between ${fmtDay(data.from)} and ${fmtDay(data.limit)} has been signed off, `
              + 'or there was nothing on it to sign.'))
        : null,
    );
  };
  draw();

  const period = data.limit && data.limit > data.from
    ? `${fmtDayShort(data.from)} – ${fmtDayShort(data.limit)}`
    : fmtDayShort(data.from);

  return h('section.so-main',
    h('div.so-main-head',
      h('div.so-title',
        h('b', toSettle.length
          ? `${toSettle.length} thing${toSettle.length === 1 ? '' : 's'} to settle`
          : 'Nothing to settle'),
        h('span', ` · ${period}`,
          clearableDays
            ? ` · ${clearableDays} clean day${clearableDays === 1 ? '' : 's'} sign${clearableDays === 1 ? 's' : ''} off together`
            : '')),
      problems.length ? chipHost : null),
    undoStrip(reload),
    listHost,
    h('div.so-foot',
      h('span', toSettle.length
        ? 'Each answer is saved as you press it, with who and when. The clean days can go now; '
          + 'the rest stay on the list.'
        : 'Each answer is saved as you press it, with who and when.'),
      h('button.so-btn.so-sign-all', {
        type: 'button',
        disabled: !clearableDays,
        title: clearableDays
          ? 'Shows every day first, and any of them can be taken out'
          : 'No clean day is waiting',
        onclick: (event) => signAllClean(clearable, clearableDays, reload, event.currentTarget),
      }, clearableDays
        ? `Sign off ${clearableDays === 1 ? 'the clean day' : `all ${clearableDays} clean days`}`
        : 'No clean days to sign')),
  );
}

/**
 * The cards as they were: one per person with their days in a table, for
 * ticking a run of them, asking about a week, or reopening what was signed.
 */
function peopleView({ params, data, reload, groups, clearable, clearableDays }) {
  const count = (list) => list.reduce((n, r) => n + r.days.length, 0);
  const toDo = count(groups.working);

  const view = h('div.so-people',
    h('div.so-people-bar',
      h('div.so-chips', [['', 'All'], ['1', 'With issues'], ['0', 'Clean']].map(([value, label]) =>
        h('button.so-chip', {
          type: 'button',
          class: (params.issues ?? '') === value ? 'on' : '',
          'aria-pressed': (params.issues ?? '') === value ? 'true' : 'false',
          onclick: () => reload({ issues: value || null }),
        }, label))),
      h('p.signoff-counts',
        h('strong', `${toDo} day${toDo === 1 ? '' : 's'} to deal with`),
        groups.working.length
          ? h('span.muted', ` · ${groups.working.length} ${groups.working.length === 1 ? 'person' : 'people'}`)
          : null,
        count(groups.answered)
          ? h('span.pill.good', { style: { marginLeft: '.5rem' } }, `${count(groups.answered)} answered`)
          : null,
        count(groups.asked)
          ? h('span.pill.warn', { style: { marginLeft: '.35rem' } }, `${count(groups.asked)} waiting`)
          : null,
        h('span.muted', { style: { marginLeft: '.5rem' } }, `up to ${fmtDayShort(data.limit)}`))),

    groups.answered.length
      ? h('div',
        h('h2.group-head', h('span.pill.good', 'Answered'), ' back with you'),
        groups.answered.map((row) => personCard(row, data, reload, 'answered')))
      : null,

    clearable.length
      ? h('div.bulk-clear',
        h('span', h('strong', `${clearableDays} clean`),
          h('span.muted', ', nothing flagged and nothing waiting')),
        h('button.btn-sm.btn-primary', {
          onclick: (event) => signAllClean(clearable, clearableDays, reload, event.target),
        }, 'Review and sign'))
      : null,

    groups.working.length
      ? h('div', groups.working.map((row) => personCard(row, data, reload, 'working')))
      : null,

    groups.asked.length
      ? h('details.asked-group',
        h('summary',
          h('span.pill.warn', 'Waiting on an answer'),
          ` ${count(groups.asked)} day${count(groups.asked) === 1 ? '' : 's'}, nothing to do until somebody replies`),
        h('div', groups.asked.map((row) => personCard(row, data, reload, 'asked'))))
      : null,

    !data.rows.length
      ? emptyState('Nothing outstanding',
        `Every day between ${fmtDay(data.from)} and ${fmtDay(data.limit)} has been signed off, `
        + 'or there was nothing on it to sign.')
      : null,

    data.rows.length && !groups.working.length && !groups.answered.length
      ? emptyState('Nothing left to do',
        'Everything still outstanding is waiting on an answer from somebody else.')
      : null,
  );

  // And brought back under the eye. The card is at the top of its group, but
  // its group may not be the one that was on screen a moment ago.
  if (pinned()) {
    requestAnimationFrame(() => view.querySelector('.just-acted')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
  return view;
}

/** The right-hand column: how clean the period is, the controls, the last sign-off. */
function sidePanel({ params, range, data, reload, view, clean, total, problems }) {
  const custom = Boolean(params.from || params.to);
  const pct = total ? Math.round((clean / total) * 100) : 100;
  const others = problems.filter((p) => !KIND.get(p.kind)?.wait).length;

  const ring = h('section.so-card.so-ring-card',
    h('div.so-ring', { style: { '--pct': String(pct) }, role: 'img', 'aria-label': `${pct}% clean` },
      h('div.so-ring-hole', h('b', `${pct}%`), h('small', 'clean'))),
    h('div.so-ring-text',
      h('b', total
        ? `${clean} of ${total} day${total === 1 ? '' : 's'} ${clean === 1 ? 'is' : 'are'} clean`
        : 'Nothing waiting'),
      h('span', !total
        ? 'Every day in this period is signed off.'
        : others
          ? `Settle the ${others} problem${others === 1 ? '' : 's'} and the period signs off in one press.`
          : 'All of it can be signed off in one press.')));

  const chip = (label, on, onclick) => h('button.so-chip', {
    type: 'button', class: on ? 'on' : '', 'aria-pressed': on ? 'true' : 'false', onclick,
  }, label);

  const departments = data.departments ?? [];
  const controls = h('section.so-card.so-controls',
    h('span.so-label', 'Period'),
    h('div.so-chips',
      PRESETS.map(([key, label]) => chip(label, !custom && range.preset === key,
        () => reload({ preset: key, from: null, to: null }))),
      chip('Dates…', custom, () => reload({ preset: null, from: range.from, to: range.to }))),
    custom
      ? h('div.so-dates',
        h('input', {
          type: 'date', value: range.from, 'aria-label': 'From',
          onchange: (e) => e.target.value && reload({ from: e.target.value, to: range.to, preset: null }),
        }),
        h('input', {
          type: 'date', value: range.to, 'aria-label': 'To',
          onchange: (e) => e.target.value && reload({ from: range.from, to: e.target.value, preset: null }),
        }))
      : null,
    departments.length
      ? [
        h('span.so-label', 'Department'),
        h('div.so-chips.so-depts',
          chip('Everybody', !params.department, () => reload({ department: null })),
          departments.map((d) => chip(d, params.department === d, () => reload({ department: d })))),
        h('select.so-dept-select', {
          'aria-label': 'Department',
          onchange: (e) => reload({ department: e.target.value || null }),
        },
        h('option', { value: '' }, 'Everybody'),
        departments.map((d) => h('option', { value: d, selected: params.department === d }, d))),
      ]
      : null,
    h('span.so-label', 'Show'),
    h('div.so-chips',
      chip('Problems', view === 'problems', () => reload({ view: null })),
      chip('Each person', view === 'people', () => reload({ view: 'people' }))),
  );

  const last = data.lastSigned;
  const lastCard = h('section.so-card.so-last',
    h('span.so-label', 'Last signed off'),
    last
      ? h('p',
        `${last.from === last.to ? fmtDayShort(last.from) : `${fmtDayShort(last.from)} – ${fmtDayShort(last.to)}`}`
        + `${last.people > 1 ? `, ${last.people} people` : ''}`
        + `${last.by ? `, by ${last.by}` : ''}, on ${fmtDayShort(last.on)}. `,
        h('button.so-link', {
          type: 'button',
          onclick: () => reload({ tab: 'months', month: last.to.slice(0, 7) }),
        }, 'Open it'))
      : h('p', 'Nothing has been signed off yet.'));

  return h('aside.so-side', ring, controls, lastCard);
}

/** One press: put a clock time on from the shift, as the times dialog would. */
async function setTime(row, day, times, reason, reload) {
  const done = await api.attCorrectTimes(day.day, {
    staffId: row.staff.id,
    in: times.in || null,
    out: times.out || null,
    reason,
  });
  const said = `${times.in || '—'} → ${times.out || '—'}`;
  toast(done?.pending
    ? `Sent to an administrator: ${row.staff.name}, ${said}. Nothing has changed yet.`
    : `${row.staff.name}, ${fmtDayShort(day.day)}: ${said}. The day is settled.`,
  'good');
  keepInView(row.staff.id, done?.pending
    ? 'Clock times sent for approval just now'
    : 'Clock times corrected just now');
  await reload();
}

/**
 * One press: sign one day as it stands.
 *
 * Only when signing it moves nothing on their leave. A day that would charge
 * or give back a day opens the ordinary sign-off, where the figure is shown
 * and can be changed, because that is a decision and not a tidy-up.
 */
async function quickSign(row, day, note, reload) {
  if (overUnderOf([day]) !== 0) {
    await sign(row, new Set([day.day]), reload);
    return;
  }
  await api.attSignDays({ staffId: row.staff.id, days: [day.day], daysApplied: 0, note });
  justSigned = { staffId: row.staff.id, name: row.staff.name, day: day.day, at: Date.now() };
  toast(`${row.staff.name}, ${fmtDayShort(day.day)} signed off.`, 'good');
  keepInView(row.staff.id, '1 day signed just now');
  await reload();
}

/** "Signed: Ama, 19 Oct. Undo", for the day just signed with one press. */
function undoStrip(reload) {
  const last = justSigned && Date.now() - justSigned.at < PIN_MS ? justSigned : null;
  if (!last) return null;
  const undo = h('button.so-link', {
    type: 'button',
    onclick: async () => {
      undo.disabled = true;
      try {
        await api.attReopenDays({ staffId: last.staffId, from: last.day, to: last.day });
        justSigned = null;
        toast('Taken back. The day is on the list again.');
        await reload();
      } catch (err) {
        undo.disabled = false;
        toast(err.message, 'bad');
      }
    },
  }, 'Undo');
  return h('div.so-undone', { role: 'status' },
    h('span.so-undone-tick', { 'aria-hidden': 'true' }, '✓'),
    h('span', `Signed off: ${last.name}, ${fmtDay(last.day)}. `), undo);
}

/**
 * Say what a day was: sick, leave, excused, present after all.
 *
 * The same ruling the person's record and the Today screen make, offered here
 * to whoever may make it, so an absence with a reason is settled on its line
 * rather than by going to find it somewhere else.
 */
async function giveReason(row, day, preset, reload) {
  const { reasons } = await api.attReasons();
  const done = await formDialog({
    title: `${row.staff.name}, ${fmtDay(day.day, { withYear: true })}`,
    submitLabel: 'Record it',
    body: h('div',
      h('p.muted', day.shift ? shiftLabel(day) : 'No shift rostered for this day'),
      h('div.grid.grid-2',
        field('Clocked in', h('input', { type: 'time', name: 'in', value: day.corrected_in || day.in || '' }),
          day.in ? 'What the terminal saw' : 'The terminal saw nothing'),
        field('Clocked out', h('input', { type: 'time', name: 'out', value: day.corrected_out || day.out || '' }),
          day.out ? 'What the terminal saw' : 'The terminal saw nothing')),
      field('Record this day as', reasonSelect(reasons, preset, { name: 'reason', required: true })),
      field('Note', h('input', {
        type: 'text', name: 'note', maxlength: 500,
        placeholder: 'What they told you, or who confirmed it',
      })),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Recorded against your name. The punches are never altered, and it can be undone from their '
        + 'record. The day still needs signing off afterwards.'),
    ),
    onSubmit: async (form) => api.attResolve(day.day, {
      staffId: row.staff.id,
      reason: form.get('reason'),
      in: form.get('in') || null,
      out: form.get('out') || null,
      note: form.get('note') || null,
    }),
  });
  if (!done) return;
  toast('Recorded.', 'good');
  keepInView(row.staff.id, 'Day recorded just now');
  await reload();
}

const ISSUE_PILL = { open: 'bad', absent: 'bad', under: 'bad', over: 'warn', late: 'warn', early: 'warn', noshift: 'warn' };

/**
 * How each column of a person's days sorts, and what a day is worth when the
 * column is empty.
 *
 * Sorting is per person, because the table is per person. Whoever is going
 * down a card wants the two lates together, or the flagged days at the top,
 * and neither of those is a question about anybody else's week.
 *
 * The keys are deliberately dull — a date string, minutes, a count. Nothing
 * here reads a label off the screen and sorts by it, because "Absent" sorting
 * before "Late" is alphabetical order pretending to be meaning.
 */
const SORTERS = {
  day: (d) => d.day,
  // Clocked-in time, with days nobody clocked at all pushed to the end rather
  // than the beginning. An absence is not "earliest".
  clocked: (d) => d.in || d.corrected_in || '~',
  happened: (d) => `${d.status ?? ''}|${d.label ?? ''}`,
  // Worst first when descending: how many flags, then whether any of them is
  // one of the serious ones.
  flags: (d) => `${String(d.issues.length).padStart(2, '0')}|`
    + `${d.issues.some((k) => ISSUE_PILL[k] === 'bad') ? '1' : '0'}`,
};

/**
 * One person and the days of theirs that belong in this group.
 *
 * Stripped back to a heading and a table. The alert box that used to sit above
 * every card repeated what the flags on the rows already said, one line lower
 * and in more words, and pushed the days themselves off the screen.
 */
/**
 * How much of this person's window is already settled.
 *
 * Counted in days and clipped to the window, so it is the same unit as the
 * table above it. A span that started in May and a window that starts in June
 * only contributes its June days.
 */
function signedDays(row, data) {
  let n = 0;
  for (const span of row.signedSpans) {
    const from = span.from > data.from ? span.from : data.from;
    const to = span.to < data.limit ? span.to : data.limit;
    if (from > to) continue;
    n += Math.max(0, daysApart(from, to) + 1 - (span.excluded ?? 0));
  }
  return n;
}

function personCard(row, data, reload, group) {
  const chosen = new Set();
  const parked = group === 'asked';

  // A day the app will refuse to sign, shown as unpickable rather than
  // offered and then rejected. A clock-time change waiting on an
  // administrator moves the very figures a sign-off would be recorded
  // against, so the tick comes back once the change has been ruled on.
  const lockedBecause = (day) => (day.pendingTimes
    ? `A clock-time change is waiting on an administrator: ${day.pendingTimes.actor} asked `
      + `for ${day.pendingTimes.now_in || '—'} → ${day.pendingTimes.now_out || '—'}. `
      + 'This day can be signed once that has been approved or turned down.'
    : day.query?.status === 'open'
      ? `Waiting on an answer to ${day.query.raisedBy}'s question.`
      : null);

  const signButton = h('button.btn-sm.btn-primary', {
    onclick: () => sign(row, chosen, reload),
    disabled: true,
  }, 'Sign off');

  const refreshCount = () => {
    signButton.disabled = chosen.size === 0;
    signButton.textContent = chosen.size
      ? `Sign off ${chosen.size} day${chosen.size === 1 ? '' : 's'}`
      : 'Sign off';
  };

  const body = h('tbody');
  let sortBy = 'day';
  let descending = false;

  const dayRow = (day) => {
    const locked = lockedBecause(day);
    return h('tr', { class: locked ? 'day-locked' : '' },
      h('td',
        h('label.tickline', { style: { padding: 0 }, title: locked ?? '' },
          h('input', {
            type: 'checkbox',
            disabled: parked || Boolean(locked),
            checked: chosen.has(day.day),
            onchange: (e) => {
              if (e.target.checked) chosen.add(day.day); else chosen.delete(day.day);
              refreshCount();
            },
          }),
          h('span', fmtDay(day.day)))),
      h('td', h('small.mono', `${day.in || '—'} → ${day.out || '—'}`),
        day.shift ? h('small.muted', { style: { display: 'block' } }, day.shift) : null),
      h('td', h('small', day.label),
        // The question, on the day it is about rather than over the person.
        day.query
          ? h('small.muted', { style: { display: 'block' } },
            `${day.query.status === 'answered' ? 'Answered' : 'Asked'}`
            + `${day.query.addressedName ? ` of ${day.query.addressedName}` : ''}: ${day.query.reason}`)
          : null),
      h('td', day.issues.length
        ? h('div.chip-row', day.issues.map((key) => {
          const issue = data.issues.find((i) => i.key === key);
          return h(`span.pill.${ISSUE_PILL[key] ?? ''}`, { title: issue?.detail ?? '' },
            issue?.label ?? key);
        }))
        : h('span.muted', '—')),
      h('td', data.canFixTimes && (day.issues.length || day.pendingTimes)
        ? (day.pendingTimes
          ? h('span.pill.warn', { title: locked }, '⏳')
          : h('button.btn-sm', {
            title: 'Change the clock-in or clock-out',
            onclick: () => fixTimes(row.staff, day, reload),
          }, 'Times'))
        : null),
    );
  };

  /** A header that sorts. Second press on the same one turns it round. */
  const sortHead = (key, label, extra = null) => {
    const on = sortBy === key;
    const arrow = on ? (descending ? ' ▾' : ' ▴') : '';
    return h('th', { class: on ? 'sorted' : '' },
      h('div.th-head',
        extra,
        h(`button.th-sort${on ? '' : '.sort-off'}`, {
          type: 'button',
          title: `Sort by ${label.toLowerCase()}`,
          'aria-label': `Sort by ${label.toLowerCase()}`,
          onclick: () => {
            if (sortBy === key) descending = !descending;
            else { sortBy = key; descending = false; }
            draw();
          },
        }, `${label}${arrow}`)));
  };

  const head = h('thead');

  function draw() {
    const key = SORTERS[sortBy] ?? SORTERS.day;
    // Copied before sorting: the array belongs to the response, and the group
    // above it counts the same days.
    const days = [...row.days].sort((a, b) => {
      const left = key(a);
      const right = key(b);
      if (left === right) return a.day < b.day ? -1 : 1;
      return (left < right ? -1 : 1) * (descending ? -1 : 1);
    });
    mount(body, days.map(dayRow));
    mount(head, h('tr',
      sortHead('day', 'Day', parked
        ? null
        : h('input.th-tick', {
          type: 'checkbox',
          title: 'Tick every day that can be signed',
          onchange: (e) => {
            const on = e.target.checked;
            for (const box of body.querySelectorAll('input[type=checkbox]:not(:disabled)')) {
              box.checked = on;
              box.dispatchEvent(new Event('change'));
            }
          },
        })),
      sortHead('clocked', 'Clocked'),
      sortHead('happened', 'What happened'),
      sortHead('flags', 'Flags'),
      h('th', ''),
    ));
  }

  draw();
  refreshCount();

  const pin = pinned();
  const mine = pin?.staffId === row.staff.id;

  const built = card(row.staff.name, {
    note: [row.staff.department, `${row.days.length} day${row.days.length === 1 ? '' : 's'}`]
      .filter(Boolean).join(' · '),
    wide: true,
    actions: h('div.btn-row',
      h('button.btn-sm.btn-ghost', {
        onclick: () => navigate('att-staff', {
          id: row.staff.id, from: row.days[0].day, to: row.days[row.days.length - 1].day,
        }),
      }, 'Record'),
      parked
        ? h('button.btn-sm', { onclick: () => navigate('signoff', { tab: 'queries' }) }, 'See the question')
        : h('button.btn-sm', { onclick: () => raise(row, chosen, reload) }, 'Ask'),
      parked ? null : signButton,
    ),
  },
    // What just happened to this person, said on their card. Without it the
    // count on the table silently drops by two and the reader is left working
    // out whether they signed what they meant to.
    mine
      ? h('p.just-said', h('span.pill.good', '✓'), ` ${pin.note} — `,
        h('strong', `${row.days.length} day${row.days.length === 1 ? '' : 's'}`),
        ' still outstanding for them')
      : null,

    h('div.table-wrap', h('table', head, body)),

    row.signedSpans.length
      ? h('details', { style: { marginTop: '.5rem' } },
        h('summary', { style: { cursor: 'pointer', fontSize: '.82rem' } },
          // In days rather than in records, because days are what the table
          // above is counting. "2 already signed" beside four listed days
          // reads as though two of those four are done; the number people
          // actually want is how much of this person's window is settled.
          `${signedDays(row, data)} day${signedDays(row, data) === 1 ? '' : 's'} in this `
          + `window already signed off, in ${row.signedSpans.length} `
          + `record${row.signedSpans.length === 1 ? '' : 's'}`),
        h('ul.signed-list', row.signedSpans.map((s) => h('li',
          h('small', `${fmtDayShort(s.from)} – ${fmtDayShort(s.to)} · `,
            s.decision === 'waived'
              ? 'let stand'
              : `${s.daysApplied > 0 ? '+' : ''}${s.daysApplied ?? 0} against leave`,
            ` · ${s.by}`,
            s.excluded ? ` · ${s.excluded} left out` : ''),
          h('button.btn-sm', { onclick: () => reopen(row, s, reload) }, 'Reopen')))))
      : null,
  );

  if (mine) built.classList.add('just-acted');
  return built;
}

async function fixTimes(staff, day, reload) {
  const done = await correctTimesDialog(day, staff, {
    approves: can('att_setup'),
    pending: day.pendingTimes,
  });
  if (!done) return;
  toast(done.pending
    ? 'Sent to an administrator. Nothing has changed on the day yet.'
    : 'Times corrected and the day settled.', 'good');
  keepInView(staff.id, done.pending
    ? 'Clock times sent for approval just now'
    : 'Clock times corrected just now');
  await reload();
}

async function sign(row, chosen, reload) {
  if (!chosen.size) {
    toast('Nothing ticked, so nothing to sign.', 'bad');
    return;
  }

  const days = [...chosen].sort();

  /**
   * The over-or-under of the days actually ticked.
   *
   * The server works this out again from the record before it writes anything,
   * so this is only what the box is filled in with — but a box filled in with
   * the wrong number is what gets signed, because almost nobody changes a
   * figure the screen appears confident about.
   *
   * Each day already arrives marked as an extra day, a missed one, or neither,
   * so the sum is a count rather than a second copy of the rule.
   */
  const ticked = row.days.filter((d) => chosen.has(d.day));
  // Worked plus leave, less what those days expected of them — the same
  // arithmetic the month is read on, over the days actually ticked.
  const difference = overUnderOf(ticked);

  const done = await formDialog({
    title: `Sign off ${row.staff.name}`,
    submitLabel: `Sign off ${days.length} day${days.length === 1 ? '' : 's'}`,
    body: h('div',
      h('p.muted',
        `${fmtDay(days[0], { withYear: true })} to ${fmtDay(days[days.length - 1], { withYear: true })}`
        + (days.length < row.days.length
          ? ` — ${row.days.length - days.length} day(s) left out and still outstanding.`
          : '.')),

      // What is wrong with the days actually ticked, rather than with the
      // person's whole period. Since the list groups by day, a card may hold
      // three clean days out of a fortnight and warning about the fortnight's
      // absence would be warning about a day that is not being signed.
      ticked.some((d) => d.issues.length)
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'You are signing over something'),
            h('div.alert-detail', [...new Set(ticked.flatMap((d) => d.issues))].join(', ')
              + '. That you knew is recorded with the sign-off.'),
          ))
        : null,

      // Offered to anybody who may sign off, including the rota planner. This
      // is the over-or-under for the period, not a leave balance — how many
      // days somebody has left is a different question and one the planner is
      // deliberately never shown.
      //
      // Counted over the ticked days and not the whole window. Ticking three
      // days of a fortnight and being handed the fortnight's figure is how
      // somebody loses eleven days of leave to a default nobody read.
      field('Days against their leave', h('input', {
        type: 'number', name: 'daysApplied', step: 1, min: -60, max: 60,
        value: String(difference),
      }), (() => {
        const figures = difference === (row.difference ?? 0)
          ? `The figures make it ${difference}.`
          : `The figures make it ${difference} for the ${days.length} day`
            + `${days.length === 1 ? '' : 's'} you ticked — ${row.difference ?? 0} over the whole `
            + 'period.';
        // Said before they type it rather than after they press it. A number
        // that quietly turns into a request is a number somebody thinks moved.
        return can('att_setup')
          ? `${figures} What actually moves is your call`
          : `${figures} Anything other than 0 goes to an administrator to approve — the days `
            + 'are signed either way, and the balance does not move until they say so';
      })()),

      field('Note', h('input', {
        type: 'text', name: 'note', maxlength: 300,
        placeholder: 'Spoke to him — was at the clinic',
      })),
    ),
    onSubmit: async (form) => api.attSignDays({
      staffId: row.staff.id,
      days,
      daysApplied: Number(form.get('daysApplied')),
      note: form.get('note'),
    }),
  });

  if (done) {
    toast(`${done.signed} day${done.signed === 1 ? '' : 's'} signed off`
      + `${done.excluded ? `, ${done.excluded} left for later` : ''}.`
      + `${done.leaveAsked ? ` ${sayDays(done.leaveAsked.days)} sent to an administrator.` : ''}`,
    'good');
    keepInView(row.staff.id,
      `${done.signed} day${done.signed === 1 ? '' : 's'} signed just now`);
    await reload();
  }
}

/**
 * Sign every day that nothing is wrong with, in one press.
 *
 * One request per person rather than a bulk endpoint, deliberately. Each
 * person gets their own record with their own dates, their own audit line and
 * their own overlap check — which is what a sign-off is — and a bulk endpoint
 * would either duplicate all of that or quietly skip some of it.
 *
 * It asks once, and the asking says the number. What it must never be is a
 * button that turns out to have done something slightly different from what
 * the line above it said, so if any one person fails the rest still go
 * through and the failures are named.
 */
async function signAllClean(clearable, total, reload, button) {
  // Shown before it happens, and every line of it can be taken back out. A
  // button that signs ninety-six days on one press has to be able to say which
  // ninety-six first — "trust me" is not a confirmation dialog, it is a dialog
  // people learn to press through.
  const picked = new Map(clearable.map(({ row, days }) => [row.staff.id, new Set(days.map((d) => d.day))]));

  const countLine = h('strong');
  const refresh = () => {
    const days = [...picked.values()].reduce((n, set) => n + set.size, 0);
    const people = [...picked.values()].filter((set) => set.size).length;
    countLine.textContent = `${days} day${days === 1 ? '' : 's'} across `
      + `${people} ${people === 1 ? 'person' : 'people'}`;
  };
  refresh();

  const rows = clearable.map(({ row, days }) => h('div.clean-person',
    h('label.tickline',
      h('input', {
        type: 'checkbox',
        checked: true,
        onchange: (event) => {
          const set = picked.get(row.staff.id);
          set.clear();
          if (event.target.checked) for (const d of days) set.add(d.day);
          for (const box of event.target.closest('.clean-person').querySelectorAll('.clean-days input')) {
            box.checked = event.target.checked;
          }
          refresh();
        },
      }),
      h('span', h('strong', row.staff.name),
        h('small.muted', ` · ${row.staff.department || ''}`))),

    h('div.clean-days', days.map((d) => h('label.tickline',
      h('input', {
        type: 'checkbox',
        checked: true,
        onchange: (event) => {
          const set = picked.get(row.staff.id);
          if (event.target.checked) set.add(d.day); else set.delete(d.day);
          refresh();
        },
      }),
      h('small', fmtDayShort(d.day)),
      h('small.muted', ` ${d.in || '—'}→${d.out || '—'}`)))),
  ));

  const done = await formDialog({
    title: 'Sign off everything clean',
    submitLabel: 'Sign them off',
    body: h('div',
      h('p.muted', 'Every day here has nothing flagged against it, nothing waiting on an '
        + 'administrator, and nothing to charge against anybody’s leave. Take out anything '
        + 'you would rather look at yourself.'),
      h('p', 'Signing ', countLine, '.'),
      h('div.clean-list', rows),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Each person gets their own record, and each can be reopened on its own afterwards.'),
    ),
    onSubmit: async () => {
      const work = clearable
        .map(({ row }) => ({ row, days: [...(picked.get(row.staff.id) ?? [])].sort() }))
        .filter((entry) => entry.days.length);
      if (!work.length) throw new Error('Nothing is ticked, so there is nothing to sign.');

      // One request per person rather than a bulk endpoint: each gets their own
      // record, their own audit line and their own overlap check, which is what
      // a sign-off is. If one fails the rest still go through.
      let signed = 0;
      const failed = [];
      for (const { row, days } of work) {
        try {
          const out = await api.attSignDays({
            staffId: row.staff.id,
            days,
            daysApplied: 0,
            note: 'Nothing outstanding on these days',
          });
          signed += Number(out.signed ?? days.length);
        } catch (err) {
          failed.push(`${row.staff.name}: ${err.message}`);
        }
      }
      if (failed.length && !signed) throw new Error(failed[0]);
      return { signed, failed };
    },
  });

  if (!done) return;
  if (done.failed?.length) {
    toast(`${done.signed} signed. ${done.failed.length} could not be: ${done.failed[0]}`, 'bad');
  } else {
    toast(`${done.signed} day${done.signed === 1 ? '' : 's'} signed off.`, 'good');
  }
  await reload();
  if (button) button.disabled = false;
}

/**
 * Take a sign-off back off.
 *
 * The days return to the list and the days it charged stop counting. What it
 * does not do is undo anything that was decided about the days themselves — a
 * ruling on a Tuesday stays a ruling on a Tuesday; only the closing of the
 * period is removed.
 */
async function reopen(row, span, reload) {
  const moved = span.decision === 'waived' ? 0 : (span.daysApplied ?? 0);
  if (!window.confirm(
    `Reopen ${row.staff.name}, ${fmtDay(span.from)} to ${fmtDay(span.to)}?\n\n`
    + `${moved ? `The ${moved > 0 ? '+' : ''}${moved} day(s) charged against their leave stop counting.` : 'Nothing was charged against their leave.'}\n`
    + 'The days go back on the list to be signed again. Nothing decided about the '
    + 'days themselves is undone.',
  )) return;

  await api.attUndoReview({ staffId: row.staff.id, from: span.from, to: span.to });
  toast('Reopened. Those days are back on the list.');
  keepInView(row.staff.id, 'Reopened just now');
  await reload();
}

async function raise(row, chosen, reload) {
  const days = chosen.size ? [...chosen].sort() : row.days.map((d) => d.day);

  // Who could actually answer. Fetched when the dialog opens rather than with
  // the page, because most visits to this screen never raise anything.
  const { people } = await api.attDeciders().catch(() => ({ people: [] }));

  const done = await formDialog({
    title: `Ask about ${row.staff.name}`,
    submitLabel: 'Send it',
    body: h('div',
      h('p.muted', 'It goes with the dates and what the figures say. Nothing is signed off '
        + 'until somebody answers, and the days stay on your list.'),

      // Naming somebody is the difference between a question that is answered
      // and one that three people can see and none of them owns. Still
      // optional: on a small property "whoever gets to it" is a real answer.
      people.length
        ? field('Who are you asking?', h('select', { name: 'addressedTo' },
          h('option', { value: '' }, 'Anybody who can answer'),
          people.map((p) => h('option', { value: String(p.id) }, p.name))),
        'Their bell rings for it. Everybody who can answer still sees it on the list')
        : null,

      h('p', h('strong', `${days.length} day${days.length === 1 ? '' : 's'}: `),
        days.map((d) => fmtDayShort(d)).join(', ')),

      row.issues.list.length
        ? h('div.chip-row', { style: { marginBottom: '.6rem' } },
          row.issues.list.map((i) => h(`span.pill.${ISSUE_PILL[i.key] ?? ''}`,
            { title: i.detail ?? '' },
            `${i.count} ${i.label.toLowerCase()}`)))
        : null,

      field('What is the question?', h('textarea', {
        name: 'reason', rows: 4, required: true, maxlength: 600,
        placeholder: 'Absent all day Thursday and nobody knows why. I would rather not charge '
          + 'his leave without somebody checking.',
      })),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'What you write here is read by whoever can answer a question, and by nobody else — '
        + 'not by other supervisors and not by whoever builds the rota. It is a sentence about '
        + 'a colleague, so write it as one.'),
    ),
    onSubmit: async (form) => api.attRaiseQuery({
      staffId: row.staff.id,
      days,
      reason: form.get('reason'),
      addressedTo: form.get('addressedTo') || null,
      issues: row.issues.counts,
    }),
  });

  if (done) {
    toast('Sent. It is in the questions tab until somebody answers.', 'good');
    keepInView(row.staff.id, `Question sent just now about ${days.length} day${days.length === 1 ? '' : 's'}`);
    await reload();
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

const STATUS_PILL = { open: 'warn', answered: 'good', resolved: '', withdrawn: '' };
const STATUS_LABEL = {
  open: 'Waiting on an administrator',
  answered: 'Answered — back to you',
  resolved: 'Dealt with',
  withdrawn: 'Taken back',
};

/**
 * Everything anybody has asked about, in one place.
 *
 * The point of the tab. A question asked in a corridor is a question nobody can
 * find again; a question with the dates, the figures and the answer on it is a
 * record of a decision.
 */
async function queriesTab(reload) {
  const data = await api.attQueries('all');
  // Three lists, because a question has three lives. Waiting on somebody,
  // answered and back with whoever asked, and finished. Answered used to sit
  // in the same list as waiting, so answering one changed a chip and moved
  // nothing, and the queue read as though nothing had been done.
  const waiting = data.rows.filter((q) => q.status === 'open');
  const back = data.rows.filter((q) => q.status === 'answered');
  const done = data.rows.filter((q) => !['open', 'answered'].includes(q.status));

  if (!data.rows.length) {
    return emptyState(
      data.canDecide ? 'Nothing to answer' : 'You have not asked anything',
      data.canDecide
        ? 'When somebody signing off is unsure about a period, they can send it here rather '
          + 'than sign it. It arrives with the dates and what the figures said.'
        : 'Questions you raise appear here with the answers to them. You see your own and '
          + 'nobody else’s — what somebody writes about a colleague is read by whoever can '
          + 'answer it, and by them alone.');
  }

  // Ticked, for answering several together. Only the ones that can still be
  // answered, and only for whoever can answer them.
  const answerable = data.canDecide ? [...waiting, ...back] : [];
  const chosen = new Set();
  const bar = h('div.bulk-clear', { hidden: true });

  const refreshBar = () => {
    bar.hidden = chosen.size === 0;
    mount(bar,
      h('span', h('strong', `${chosen.size} question${chosen.size === 1 ? '' : 's'} ticked`)),
      h('div.btn-row',
        h('button.btn-sm', {
          onclick: () => {
            chosen.clear();
            for (const box of document.querySelectorAll('.query-tick input')) box.checked = false;
            refreshBar();
          },
        }, 'Clear'),
        h('button.btn.btn-primary', {
          onclick: () => answerMany([...chosen], answerable, reload),
        }, 'Answer them together')));
  };

  const pick = data.canDecide
    ? {
      has: (id) => chosen.has(id),
      set: (id, on) => { if (on) chosen.add(id); else chosen.delete(id); refreshBar(); },
    }
    : null;

  const tickAll = (on) => {
    for (const q of answerable) { if (on) chosen.add(q.id); else chosen.delete(q.id); }
    for (const box of document.querySelectorAll('.query-tick input')) box.checked = on;
    refreshBar();
  };

  return h('div',
    answerable.length > 1
      ? h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
        'Tick more than one to answer them together. ',
        h('button.link-button', { onclick: () => tickAll(true) }, `Tick all ${answerable.length}`))
      : null,

    bar,

    waiting.length
      ? h('div',
        h('h2.group-head', h('span.pill.warn', 'Waiting'), ' on an answer'),
        waiting.map((q) => queryCard(q, data, reload, pick)))
      : null,

    back.length
      ? h('div',
        h('h2.group-head', h('span.pill.good', 'Answered'),
          ' back with whoever asked — the days can be signed'),
        back.map((q) => queryCard(q, data, reload, pick)))
      : null,

    !waiting.length && !back.length
      ? emptyState('Nothing waiting', 'Everything asked has been dealt with.')
      : null,

    done.length
      ? card('Already dealt with', { note: `${done.length}`, wide: true },
        table([
          { key: 'staff', label: 'Who', format: (v) => v.name },
          {
            key: 'from',
            label: 'Period',
            format: (v, r) => h('small', `${fmtDayShort(v)} – ${fmtDayShort(r.to)}`),
          },
          { key: 'reason', label: 'Asked', format: (v) => h('small.muted', v) },
          {
            key: 'outcome',
            label: 'Outcome',
            format: (v) => h('span.pill', { }, { signed: 'Signed off', returned: 'Sent back', withdrawn: 'Taken back', no_action: 'Closed' }[v] ?? v),
          },
          {
            key: 'closedBy',
            label: 'By',
            format: (v, r) => h('small.muted', `${v || '—'}${r.closedAt ? ` · ${String(r.closedAt).slice(0, 10)}` : ''}`),
          },
        ], done, { empty: 'None.' }))
      : null,
  );
}

/**
 * The register of clock-time changes.
 *
 * Whoever builds the rota can put a wrong clock time right on their own, which
 * is the only way corrections actually get made — the person who knows what
 * time the kitchen closed is not usually the person who can approve leave. The
 * price of that is this page: every change, with what stood before it, who made
 * it and why, in one list somebody can read down.
 *
 * Sat beside the sign-off screen rather than buried in setup, because the
 * question it answers — "has anything on this period been touched?" — is asked
 * at exactly the moment somebody is about to sign it.
 */
// ---------------------------------------------------------------------------
// Days on and off a leave balance
// ---------------------------------------------------------------------------

/** A figure as somebody would say it out loud. Mirrors src/lib/leave-days.js. */
function sayDays(days) {
  const n = Math.round(Number(days) || 0);
  if (!n) return 'no change';
  const word = Math.abs(n) === 1 ? 'day' : 'days';
  return n > 0 ? `${n} ${word} back` : `${Math.abs(n)} ${word} off`;
}

/**
 * What somebody has asked to take off, or give back to, a leave balance.
 *
 * Signing a month records one figure that is not a fact about the month but a
 * decision about somebody's entitlement, and at this property the person who
 * signs is the person who built the rota the shortfall is about. So the figure
 * waits here. The days themselves were signed at the time — holding those up
 * would stop the property working — and only the balance is held.
 *
 * Beside the clock changes rather than anywhere else, because it is the same
 * shape of thing: somebody who can see what happened asking somebody who
 * carries the consequence.
 */
async function leaveTab(reload) {
  const { rows, canDecide } = await api.attLeaveChanges();
  const waiting = rows.filter((r) => r.status === 'pending');
  const done = rows.filter((r) => r.status !== 'pending');

  if (!rows.length) {
    return emptyState('Nothing waiting',
      'Nobody has asked to move anybody\u2019s leave. When a period is signed off with days '
      + 'on or off somebody\u2019s balance by anybody who is not an administrator, it waits '
      + 'here and the balance stays where it is until you decide.');
  }

  const decide = async (row, approve) => {
    const note = approve
      ? window.prompt(`Approve ${sayDays(row.days)} against ${row.staff.name}\u2019s leave?\n\n`
        + 'Anything to add (optional):', '')
      : window.prompt(`Send this back to ${row.actor}?\n\n`
        + 'Say why, so they know what to do instead:', '');
    if (note === null) return;
    if (!approve && !note.trim()) {
      toast('Say why, so whoever asked knows what to do instead.', 'bad');
      return;
    }
    try {
      await api.attDecideLeaveChange(row.id, { approve, note: note.trim() || null });
      toast(approve ? 'Approved. The balance has moved.' : 'Sent back. Nothing has moved.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const row = (r) => h('tr',
    h('td',
      h('div', h('strong', r.staff.name)),
      h('small.muted', `${fmtDayShort(r.from)} \u2013 ${fmtDayShort(r.to)}`)),
    h('td',
      h(`strong${r.days > 0 ? '.good-text' : '.bad-text'}`, sayDays(r.days)),
      h('small.muted', { style: { display: 'block' } }, `it stands at ${sayDays(r.was)}`)),
    h('td', h('small', r.reason || h('span.muted', 'no reason given'))),
    h('td',
      h('small', r.actor),
      h('br'),
      h('small.muted', String(r.at || '').slice(0, 16).replace('T', ' '))),
    h('td', r.status === 'pending'
      ? (canDecide
        ? h('div.btn-row',
          h('button.btn-sm', {
            title: 'The days this is about, in full',
            onclick: () => navigate('att-staff', { id: r.staff.id, from: r.from, to: r.to }),
          }, 'Open their record'),
          h('button.btn-sm.btn-primary', { onclick: () => decide(r, true) }, 'Approve'),
          h('button.btn-sm', { onclick: () => decide(r, false) }, 'Send back'))
        : h('span.pill.warn', 'Waiting on an administrator'))
      : h('div',
        h(`span.pill.${r.status === 'approved' ? 'good' : ''}`,
          r.status === 'approved' ? 'Approved' : 'Sent back'),
        h('small.muted', { style: { display: 'block' } },
          `${r.decidedBy ?? ''}${r.decisionNote ? ` \u2014 ${r.decisionNote}` : ''}`))),
  );

  return h('div',
    card('Waiting on an administrator', {
      note: waiting.length
        ? `${waiting.length} to decide`
        : 'Nothing waiting',
      wide: true,
    },
      waiting.length
        ? h('div.table-wrap', h('table',
          h('thead', h('tr',
            h('th', 'Who, and which period'),
            h('th', 'What is being asked'),
            h('th', 'Why'),
            h('th', 'Asked by'),
            h('th', ''),
          )),
          h('tbody', waiting.map(row))))
        : h('p.muted', { style: { margin: 0 } },
          'Nothing is waiting. The days below have already been decided.'),
      canDecide
        ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Approving writes the figure onto the sign-off, which is the only moment a balance '
          + 'moves. Sending it back writes nothing at all: the balance is already where it was.')
        : null),

    done.length
      ? card('Already decided', { note: `last ${done.length}`, wide: true },
        h('div.table-wrap', h('table',
          h('thead', h('tr',
            h('th', 'Who, and which period'),
            h('th', 'What was asked'),
            h('th', 'Why'),
            h('th', 'Asked by'),
            h('th', ''),
          )),
          h('tbody', done.map(row)))))
      : null,
  );
}

async function timesTab(range, reload) {
  const { edits, pending, canApprove } = await api.attTimeEdits({
    from: range.from, to: range.to, limit: 400,
  });

  if (!edits.length && !pending.length) {
    return emptyState('Nothing changed',
      `No clock time was altered between ${fmtDay(range.from)} and ${fmtDay(range.to)}. `
      + 'When somebody asks for one, it waits here until you approve it.');
  }

  const moved = (observed, was, now) => {
    const from = was ?? observed;
    if (from === now) return h('span.muted', 'unchanged');
    if (!now) return h('span', h('s', from), ' ', h('span.muted', 'removed'));
    if (!from) return h('span', h('span.muted', '— → '), h('strong', now));
    return h('span', h('s', from), ' → ', h('strong', now));
  };

  // Louder where the correction contradicts something the terminal actually
  // recorded. Filling in a punch the device never saw is the ordinary case;
  // overwriting one it did see is the row worth stopping on.
  const contradicts = (e) => (e.now_in && e.observed_in && e.now_in !== e.observed_in)
    || (e.now_out && e.observed_out && e.now_out !== e.observed_out);

  // Ticked rows, for ruling on a stack of them at once. A morning's worth of
  // missed clock-outs is fifteen rows that all say the same thing, and fifteen
  // dialogs is how a queue stops being read.
  const chosen = new Set();
  const bar = h('div.bulk-clear', { style: { display: 'none' } });

  const refreshBar = () => {
    bar.style.display = chosen.size ? '' : 'none';
    mount(bar,
      h('span', h('strong', `${chosen.size} ticked`),
        h('span.muted', ' — the same answer to all of them')),
      h('div.btn-row',
        h('button.btn-sm.btn-primary', {
          onclick: () => decideMany([...chosen], 'approve', pending, reload),
        }, `Approve ${chosen.size}`),
        h('button.btn-sm', {
          onclick: () => decideMany([...chosen], 'reject', pending, reload),
        }, 'Send them back'),
      ));
  };

  const tickAll = h('input.th-tick', {
    type: 'checkbox',
    title: 'Tick every change waiting',
    onchange: (event) => {
      const on = event.target.checked;
      for (const box of queueBody.querySelectorAll('input[type=checkbox]')) {
        box.checked = on;
        box.dispatchEvent(new Event('change'));
      }
    },
  });

  const queueBody = h('tbody', pending.map((e) => h('tr',
    canApprove
      ? h('td', h('input', {
        type: 'checkbox',
        'aria-label': `${e.staff_name}, ${e.day}`,
        onchange: (event) => {
          if (event.target.checked) chosen.add(e.id); else chosen.delete(e.id);
          refreshBar();
        },
      }))
      : null,
          h('td', h('div',
            h('div', fmtDayShort(e.day)),
            h('small.muted', e.staff_name))),
          h('td', moved(e.observed_in, e.was_in, e.now_in)),
          h('td', moved(e.observed_out, e.was_out, e.now_out)),
          h('td', h('small', e.reason || '—')),
          h('td', h('div',
            h('small', e.actor),
            h('br'),
            h('small.muted', String(e.at_utc || '').slice(0, 16).replace('T', ' ')))),
          canApprove
            ? h('td', h('div.btn-row',
              // Before, not after. Approving puts the times on and settles the
              // day, and the row above says only what somebody typed and what
              // the terminal read — not what the rest of that week looked
              // like, whether the shift was even theirs, or whether the same
              // thing happened on the Tuesday. Opening on the day itself,
              // because that is the day being ruled on.
              h('button.btn-sm', {
                onclick: () => navigate('att-staff', { id: e.staff_id, day: e.day, period: 'day' }),
                title: 'The day this change is about, in full',
              }, 'Record'),
              h('button.btn-sm.btn-primary', { onclick: () => decide(e, 'approve', reload) }, 'Approve'),
              h('button.btn-sm', { onclick: () => decide(e, 'reject', reload) }, 'Send back'),
            ))
            : null,
  )));

  const queue = pending.length
    ? card('Waiting on you', {
      note: `${pending.length}`,
      wide: true,
    }, h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        canApprove
          ? 'Nothing on these days has changed. Approving puts the times on and settles the day '
            + 'on whatever the rules make of them — you are not being asked to choose a status. '
            + 'Tick several to answer them together.'
          : 'These are waiting on an administrator. Until one answers, the days read exactly as '
            + 'the terminal left them.'),
      bar,
      h('div.table-wrap', h('table',
        h('thead', h('tr',
          canApprove ? h('th', tickAll) : null,
          h('th', 'Day'), h('th', 'In'), h('th', 'Out'), h('th', 'Why'), h('th', 'Asked by'),
          canApprove ? h('th', '') : null,
        )),
        queueBody,
      )),
    ))
    : null;

  if (!edits.length) return h('div', queue);

  return h('div', queue, card('Already applied', {
    note: `${edits.length} in this period`,
    wide: true,
  }, table([
    {
      key: 'day',
      label: 'Day',
      format: (v, r) => h('div',
        h('div', fmtDayShort(v)),
        h('small.muted', r.staff_name)),
    },
    { key: 'now_in', label: 'In', align: 'right', format: (v, r) => moved(r.observed_in, r.was_in, r.now_in) },
    { key: 'now_out', label: 'Out', align: 'right', format: (v, r) => moved(r.observed_out, r.was_out, r.now_out) },
    {
      key: 'reason',
      label: 'Why',
      format: (v, r) => h('div',
        h('div', v || h('span.muted', '—')),
        contradicts(r)
          ? h('small.pill.warn', 'overwrote what the terminal read')
          : null),
    },
    {
      key: 'actor',
      label: 'By',
      format: (v, r) => h('div',
        h('div', h('small', v)),
        h('small.muted', String(r.at_utc || '').slice(0, 16).replace('T', ' '))),
    },
    {
      key: 'status',
      label: '',
      format: (v, r) => (v === 'approved'
        ? h('small.muted', r.decided_by && r.decided_by !== r.actor ? `approved by ${r.decided_by}` : 'applied')
        : h('span.pill.warn', { title: r.decision_note ?? '' },
          v === 'rejected' ? 'sent back' : v === 'superseded' ? 'replaced' : v)),
    },
  ], edits, { empty: 'None.' })));
}

/**
 * Approve a correction, or send it back.
 *
 * Sending it back asks for a reason and will not take no answer, because "no"
 * on its own tells whoever asked nothing about what to do instead — and they
 * will simply ask again.
 */
/**
 * The same ruling, given to a stack of changes at once.
 *
 * It names what it is about to do before it does it, and each request is still
 * applied on its own terms behind the scenes. A refusal still has to say why:
 * "no" on its own tells whoever asked nothing about what to do instead.
 */
async function decideMany(ids, decision, pending, reload) {
  const rows = pending.filter((e) => ids.includes(e.id));
  const people = [...new Set(rows.map((r) => r.staff_name))];

  const done = await formDialog({
    title: decision === 'approve'
      ? `Approve ${ids.length} change${ids.length === 1 ? '' : 's'}`
      : `Send back ${ids.length} change${ids.length === 1 ? '' : 's'}`,
    submitLabel: decision === 'approve' ? 'Approve them' : 'Send them back',
    body: h('div',
      h('p.muted', `${people.length} ${people.length === 1 ? 'person' : 'people'}: `
        + `${people.slice(0, 4).join(', ')}${people.length > 4 ? ` and ${people.length - 4} more` : ''}.`),

      h('ul.signed-list', rows.slice(0, 12).map((e) => h('li', h('small',
        `${fmtDayShort(e.day)} · ${e.staff_name} · ${e.now_in || '—'} → ${e.now_out || '—'}`
        + `${e.reason ? ` · ${e.reason}` : ''}`)))),
      rows.length > 12
        ? h('p.muted', { style: { fontSize: '.82rem' } }, `and ${rows.length - 12} more`)
        : null,

      field(decision === 'approve' ? 'Anything to add' : 'Why not', h('input', {
        type: 'text', name: 'note', maxlength: 500, required: decision !== 'approve',
        placeholder: decision === 'approve'
          ? 'Optional — kept against every one of them'
          : 'The terminal was down that morning — raise it against the right shift',
      }), decision === 'approve'
        ? 'Kept with each record'
        : 'Required, and sent with each one'),

      decision === 'approve'
        ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Each day is worked out again from its own times and settled on that verdict under '
          + 'your name. The punches themselves are untouched.')
        : h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Nothing changes on any of these days. They stay exactly as the terminal left them.'),
    ),
    onSubmit: async (form) => api.attDecideTimeEdits({
      ids, decision, note: form.get('note') || null,
    }),
  });

  if (!done) return;
  if (done.failed?.length) {
    toast(`${done.decided.length} done. ${done.failed.length} could not be: ${done.failed[0].why}`, 'bad');
  } else {
    toast(decision === 'approve'
      ? `${done.decided.length} approved and settled.`
      : `${done.decided.length} sent back.`, 'good');
  }
  await reload();
}

async function decide(edit, decision, reload) {
  const done = await formDialog({
    title: decision === 'approve'
      ? `Approve: ${edit.staff_name}, ${fmtDay(edit.day, { withYear: true })}`
      : `Send back: ${edit.staff_name}, ${fmtDay(edit.day, { withYear: true })}`,
    submitLabel: decision === 'approve' ? 'Approve and settle the day' : 'Send it back',
    body: h('div',
      h('p.muted',
        `${edit.actor} asked for ${edit.now_in || '—'} → ${edit.now_out || '—'}`
        + `${edit.reason ? `: ${edit.reason}` : ''}`),
      h('p.muted', { style: { fontSize: '.85rem' } },
        `The terminal read ${edit.observed_in || 'nothing'} → ${edit.observed_out || 'nothing'}.`),

      // Offered here as well as on the row. This is the moment the day is
      // about to be settled on somebody else's account of it, and looking
      // first should not cost whoever is deciding the note they have already
      // typed — so it opens in its own tab.
      h('p', h('a', {
        href: `#/att-staff?id=${edit.staff_id}&day=${edit.day}&period=day`,
        target: '_blank',
        rel: 'noopener',
      }, `Open ${edit.staff_name}'s record for ${fmtDay(edit.day)} ↗`)),

      field(decision === 'approve' ? 'Anything to add' : 'Why not', h('input', {
        type: 'text', name: 'note', maxlength: 500,
        required: decision !== 'approve',
        placeholder: decision === 'approve'
          ? 'Optional'
          : 'That was Kofi on the late shift — check the roster and ask again',
      }), decision === 'approve'
        ? 'Kept with the record'
        : 'Required. Whoever asked needs to know what to do instead'),

      decision === 'approve'
        ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'The times go on, the day is worked out again from them, and it is settled on that '
          + 'verdict under your name. The punches themselves are untouched.')
        : h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Nothing changes on the day. It stays exactly as the terminal left it, and whoever '
          + 'asked is told why.'),
    ),
    onSubmit: async (form) => api.attDecideTimeEdit(edit.id, {
      decision,
      note: form.get('note') || null,
    }),
  });

  if (done) { toast(decision === 'approve' ? 'Approved and settled.' : 'Sent back.', 'good'); await reload(); }
}

/**
 * What the question is actually about: the days, as the terminal left them.
 *
 * The card used to say "1 absent, 1 late" and nothing else, so answering one
 * meant opening the person's record in another screen and holding the two side
 * by side in your head. The counts and what they are counting now sit on the
 * same card: the day, the shift, what was clocked, what the app made of it, and
 * the flags on it.
 *
 * Read only. Anything to be *done* about a day is done where it is done
 * already, on their record or on the sign-off tab, and putting a second way to
 * change a clock time here would be two screens that disagree about which one
 * settled it.
 */
function daysBehind(q, data) {
  if (!q.records?.length) return null;

  const clocked = (d) => (d.in || d.out
    ? `${d.in || '\u2014'} \u2192 ${d.out || '\u2014'}`
    : 'nothing clocked');

  // Only where the app has a figure and it says something the label does not.
  // "Late" already says late; "34 min" says how much.
  const byHow = (d) => [
    d.lateMinutes > 0 ? `${d.lateMinutes} min late` : null,
    d.earlyMinutes > 0 ? `${d.earlyMinutes} min early` : null,
  ].filter(Boolean).join(', ');

  return h('div.table-wrap.query-days',
    h('table',
      h('thead', h('tr',
        h('th', 'Day'),
        h('th', 'Clocked'),
        h('th', 'What it came out as'),
        h('th', ''),
      )),
      h('tbody', q.records.map((d) => h('tr',
        h('td',
          h('small', fmtDayShort(d.day)),
          d.shift
            ? h('small.muted', { style: { display: 'block' } }, d.shift)
            : h('small.muted', { style: { display: 'block' } },
              d.scheduled ? 'no shift named' : 'not scheduled')),
        h('td', h('small.mono', clocked(d))),
        h('td',
          h('small', d.label),
          byHow(d) ? h('small.muted', { style: { display: 'block' } }, byHow(d)) : null),
        h('td', d.issues.length
          ? h('div.chip-row', d.issues.map((key) => {
            const issue = (data.issues ?? []).find((i) => i.key === key);
            return h(`span.pill.${ISSUE_PILL[key] ?? ''}`, { title: issue?.detail ?? '' },
              issue?.label ?? key);
          }))
          : h('span.muted', '\u2014')),
      ))),
    ));
}

function queryCard(q, data, reload, pick = null) {
  const mine = q.raisedBy === data.mine;

  const forMe = q.addressedTo != null && Number(q.addressedTo) === Number(data.myId);

  return card(q.staff.name, {
    note: `${fmtDay(q.from, { withYear: true })} – ${fmtDay(q.to, { withYear: true })} · ${q.days.length} day(s)`,
    wide: true,
    actions: h('div.btn-row',
      // Ticking is for answering several with one sentence, which is what a
      // queue of nine "please review" questions actually needs.
      pick
        ? h('label.tickline.query-tick', { title: 'Answer this one with the others' },
          h('input', {
            type: 'checkbox',
            checked: pick.has(q.id),
            'aria-label': `Tick ${q.staff.name}\u2019s question`,
            onchange: (e) => pick.set(q.id, e.target.checked),
          }))
        : null,
      // Who was asked, so a queue of six is a queue of six with names on it.
      // Everybody who can answer still sees all of them — somebody on leave
      // must not take their questions with them — but whose it is shows.
      q.addressedName
        ? h(`span.pill${forMe ? '.warn' : ''}`, forMe ? 'Asked of you' : `For ${q.addressedName}`)
        : null,
      h(`span.pill.${STATUS_PILL[q.status] ?? ''}`, STATUS_LABEL[q.status] ?? q.status),

      // The way into what the question is actually about. Somebody asked to
      // look at a period cannot answer it from a sentence and a chip saying
      // "1 absent" — they need the days, the clock times, the shifts and
      // whatever else that week did. Opening on the days the question covers,
      // not on the current month, because the question is about those.
      h('button.btn-sm', {
        onclick: () => navigate('att-staff', { id: q.staff.id, from: q.from, to: q.to }),
        title: 'The days this question is about, in full',
      }, 'Open their record'),

      mine && q.status !== 'resolved'
        ? h('button.btn-sm', {
          onclick: async () => {
            if (!window.confirm('Take this question back? You worked it out yourself.')) return;
            await api.attWithdrawQuery(q.id);
            toast('Taken back.');
            await reload();
          },
        }, 'Take it back')
        : null,
      // Answered means the days are unblocked and somebody has to go and sign
      // them. Sending the reader to exactly those dates, rather than to
      // whatever window the sign-off tab happened to be left on.
      q.status === 'answered'
        ? h('button.btn.btn-primary', {
          onclick: () => reload({ tab: 'open', from: q.from, to: q.to, preset: null }),
        }, 'Go and sign it')
        : null,

      data.canDecide
        ? h(`button.btn${q.status === 'answered' ? '-sm' : '.btn-primary'}`, {
          onclick: () => answer(q, reload),
        }, q.status === 'answered' ? 'Say more' : 'Answer it')
        : null,
    ),
  },
    q.issues && Object.keys(q.issues).length
      ? h('div.chip-row', { style: { marginBottom: '.6rem' } },
        Object.entries(q.issues).map(([key, n]) => {
          // "3 under" is short enough to fit four of them on one line and
          // says nothing on its own, so what it means is on hovering it.
          const issue = (data.issues ?? []).find((i) => i.key === key);
          return h(`span.pill.${ISSUE_PILL[key] ?? ''}`,
            { title: issue ? `${issue.label} — ${issue.detail}` : '' },
            `${n} ${key}`);
        }))
      : null,

    daysBehind(q, data),

    h('div.thread', q.notes.map((note) => h('div.thread-note',
      h('div.thread-head',
        h('strong', note.author),
        h('small.muted', String(note.at_utc).slice(0, 16)),
        note.kind === 'direction' ? h('span.pill.good', 'direction') : null,
        note.kind === 'decision' ? h('span.pill', 'decision') : null,
      ),
      h('div', note.body),
    ))),

    h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
      `Raised by ${q.raisedBy} on ${fmtDay(String(q.raisedAt).slice(0, 10), { withYear: true })}. `
      + 'The days stay outstanding until this is settled.'),
  );
}

/**
 * Answer several with one sentence.
 *
 * A queue of nine questions all saying "please review" is nine dialogs, nine
 * notes typed out and nine bells carrying the same sentence. This is the same
 * three answers, given once.
 *
 * SIGNING IN BULK PUTS NOTHING AGAINST ANYBODY'S LEAVE, and the dialog says so
 * where somebody will read it. How many days come off an entitlement is a
 * decision about one person, and one figure spread across nine of them is not
 * that decision. Charging days is done on the card, where their name is.
 */
async function answerMany(ids, questions, reload) {
  const chosen = questions.filter((q) => ids.includes(q.id));
  if (!chosen.length) return;

  const pick = (value, label, detail, checked = false) => h('label.answer-choice',
    h('input', { type: 'radio', name: 'action', value, checked, required: true }),
    h('span', h('strong', label), h('small.muted', detail)));

  const done = await formDialog({
    title: `${chosen.length} question${chosen.length === 1 ? '' : 's'}`,
    submitLabel: 'Send',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
        chosen.map((q) => q.staff.name).join(', ')),

      h('div.answer-choices',
        pick('direction', 'Answer them and hand them back',
          ' \u2014 each person who asked gets the answer and can sign their days', true),
        pick('close', 'Nothing needed \u2014 close them',
          ' \u2014 the days go back to whoever asked, unblocked'),
        pick('sign', 'Sign the days off myself, now',
          ' \u2014 closes them under your name, with nothing against anybody\u2019s leave'),
        pick('comment', 'Add a note and leave them open',
          ' \u2014 the days stay blocked until somebody answers properly'),
      ),

      field('What to say', h('textarea', {
        name: 'body', rows: 4, maxlength: 800,
        placeholder: 'Charge these to sick leave and sign them.',
      }), 'The same words go on every one of them, and to everybody who asked'),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Signing here puts nothing on or off anybody\u2019s leave. A figure spread across '
        + `${chosen.length} people is not a decision about any of them \u2014 do that on the `
        + 'card, one at a time.'),
    ),
    onSubmit: async (form) => {
      const action = form.get('action');
      const out = await api.attAnswerQueries({
        ids, action, body: form.get('body'),
      });
      return { ...out, action };
    },
  });

  if (!done) return;

  const said = {
    direction: 'answered and handed back',
    sign: 'signed off',
    close: 'closed',
    comment: 'commented on, and still open',
  }[done.action] ?? 'done';

  toast(`${done.done.length} ${said}.`
    + (done.skipped.length ? ` ${done.skipped.length} could not be: ${done.skipped[0].why}` : ''),
  done.skipped.length ? 'warn' : 'good');
  await reload();
}

/**
 * Answer one, three ways.
 *
 * They are genuinely different things and the dialog does not pretend
 * otherwise: saying something is not the same as handing it back, and neither
 * is the same as dealing with it yourself.
 */
async function answer(q, reload) {
  const pick = (value, label, detail, checked = false) => h('label.answer-choice',
    h('input', {
      type: 'radio', name: 'action', value, checked, required: true,
      onchange: (e) => {
        const box = e.target.closest('form').querySelector('[data-days]');
        if (box) box.style.display = value === 'sign' ? '' : 'none';
      },
    }),
    h('span', h('strong', label), h('small.muted', detail)));

  const done = await formDialog({
    title: `${q.staff.name}, ${fmtDayShort(q.from)}–${fmtDayShort(q.to)}`,
    submitLabel: 'Send',
    body: h('div',
      // Handing it back is what answering a question means, so it is what the
      // dialog opens on. It used to open on "leave it open", which read as the
      // gentlest choice and was the only one that changed nothing: the question
      // stayed in the queue and the days stayed unsignable, however carefully
      // somebody had written the answer.
      h('div.answer-choices',
        pick('direction', 'Answer it and hand it back',
          ' — they get the answer and can sign the days', true),
        pick('sign', 'Sign the days off myself, now',
          ' — closes the question under your name'),
        pick('close', 'Nothing needed — close it',
          ' — the days go back to them, unblocked'),
        pick('comment', 'Add a note and leave it open',
          ' — the days stay blocked until somebody answers properly'),
      ),

      // Offered here as well as on the card. This is the moment somebody is
      // about to charge days against a colleague's leave, and "open the
      // record" is exactly the thing they should be able to do without
      // losing what they have typed — so it opens in its own tab.
      h('p', h('a', {
        href: `#/att-staff?id=${q.staff.id}&from=${q.from}&to=${q.to}`,
        target: '_blank',
        rel: 'noopener',
      }, `Open ${q.staff.name}'s record for these days ↗`)),

      field('What to say', h('textarea', {
        name: 'body', rows: 4, maxlength: 800,
        placeholder: 'He was at the clinic — mark it sick leave, then sign it.',
      })),

      h('div', { 'data-days': '', style: { display: 'none' } },
        field('Days against their leave', h('input', {
          type: 'number', name: 'daysApplied', step: 1, min: -60, max: 60, value: '0',
        }))),
    ),
    onSubmit: async (form) => {
      const action = form.get('action');
      const out = await api.attAnswerQuery(q.id, {
        action,
        body: form.get('body'),
        daysApplied: Number(form.get('daysApplied') || 0),
      });
      return { ...out, action };
    },
  });

  if (!done) return;
  toast({
    direction: 'Answered. The days are theirs to sign.',
    sign: 'Signed off, and the question is closed.',
    close: 'Closed. The days are theirs to sign.',
    comment: 'Note added. The question is still open, so those days stay blocked.',
  }[done.action] ?? 'Done.', done.action === 'comment' ? 'warn' : 'good');
  await reload();
}
