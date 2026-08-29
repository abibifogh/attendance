import { api } from '../api.js';
import { daysApart, fmtDay, fmtDayShort, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { can, navigate, replaceParams } from '../app.js';
import { correctTimesDialog, field, formDialog, overUnderOf } from './att-shared.js';

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

const TABS = [['open', 'To sign off'], ['queries', 'Questions'], ['times', 'Clock changes']];

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

/** Held for a few minutes only, so coming back to the screen later is clean. */
const PIN_MS = 10 * 60 * 1000;
const pinned = () => (justActed && Date.now() - justActed.at < PIN_MS ? justActed : null);

/** Remember who, and what to say on their card. Cleared by any other move. */
function keepInView(staffId, note) {
  justActed = { staffId, note, at: Date.now() };
}

export async function renderAttSignoff(params) {
  const host = h('div');
  const tab = TABS.some(([key]) => key === params.tab) ? params.tab : 'open';
  const range = rangeFor(params);

  const reload = async (next = {}) => {
    // Called with no arguments after an action — keep the pin. Called with
    // arguments because a control was pressed — the reader has moved on.
    if (Object.keys(next).length) justActed = null;
    const merged = { ...params, ...next };
    replaceParams('signoff', merged);
    mount(host, await renderAttSignoff(merged));
  };

  const tabs = h('div.seg.seg-wrap', TABS.map(([key, label]) =>
    h('button', { class: tab === key ? 'active' : '', onclick: () => reload({ tab: key }) }, label)));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Sign-off'),
      ),
    ),
    h('div.toolbar', tabs),
    tab === 'queries' ? await queriesTab(reload)
      : tab === 'times' ? await timesTab(range, reload)
        : await openTab(params, range, reload),
  );

  return host;
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
 * What is outstanding, in three lists and as little else as possible.
 *
 * The screen this replaced had four tiles, five controls and an alert box on
 * every card before you reached a single day, and the thing it exists for —
 * tick some days, sign them — was below the fold. So: one line of controls,
 * one line of counts, and then the days.
 *
 * The grouping is by day rather than by person. Asking about a Thursday nobody
 * can explain must not put that person's other four days beyond reach, and
 * parking somebody's whole week because one day of it has a question on it is
 * the surest way to stop anybody ever asking.
 */
async function openTab(params, range, reload) {
  const data = await api.attOutstanding({
    from: range.from,
    to: range.to,
    ...(params.department ? { department: params.department } : {}),
    ...(params.issues === '1' || params.issues === '0' ? { issues: params.issues } : {}),
  });

  /** One person, cut down to a given set of their days. */
  const slice = (row, days) => ({ ...row, days, unsignedCount: days.length });

  const groups = { answered: [], working: [], asked: [] };
  for (const row of data.rows) {
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

  const count = (list) => list.reduce((n, r) => n + r.days.length, 0);
  const toDo = count(groups.working);

  // Days nothing is wrong with and nothing is waiting on. The bulk clear works
  // on the working list alone: sweeping up a day somebody deliberately asked
  // about would answer their question for them.
  const clearable = groups.working
    .map((row) => ({ row, days: row.days.filter((d) => !d.issues.length && !d.pendingTimes) }))
    .filter((entry) => entry.days.length);
  const clearableDays = clearable.reduce((n, entry) => n + entry.days.length, 0);

  const custom = Boolean(params.from || params.to);

  const controls = h('div.signoff-bar',
    h('div.seg.seg-wrap', [...PRESETS, ['custom', 'Dates…']].map(([key, label]) =>
      h('button', {
        class: (custom ? 'custom' : range.preset) === key ? 'active' : '',
        onclick: () => (key === 'custom'
          ? reload({ preset: null, from: range.from, to: range.to })
          : reload({ preset: key, from: null, to: null })),
      }, label))),

    // Only in the way when somebody has actually asked for dates by hand.
    custom
      ? h('span.signoff-dates',
        h('input', {
          type: 'date', value: range.from, 'aria-label': 'From',
          onchange: (e) => e.target.value && reload({ from: e.target.value, to: range.to, preset: null }),
        }),
        h('input', {
          type: 'date', value: range.to, 'aria-label': 'To',
          onchange: (e) => e.target.value && reload({ from: range.from, to: e.target.value, preset: null }),
        }))
      : null,

    h('div.seg.seg-wrap',
      [['', 'All'], ['1', 'With issues'], ['0', 'Clean']].map(([value, label]) =>
        h('button', {
          class: (params.issues ?? '') === value ? 'active' : '',
          onclick: () => reload({ issues: value || null }),
        }, label))),

    h('div', { style: { flex: 1 } }),

    data.departments?.length
      ? h('select', {
        'aria-label': 'Department',
        onchange: (e) => reload({ department: e.target.value || null }),
      },
      h('option', { value: '' }, 'Every department'),
      data.departments.map((d) => h('option', {
        value: d, selected: params.department === d,
      }, d)))
      : null,
  );

  const view = h('div',
    controls,

    // One line where four tiles were. Everything on it is a number somebody
    // acts on; nothing on it is a number that only describes the page.
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
      h('span.muted', { style: { marginLeft: '.5rem' } }, `up to ${fmtDayShort(data.limit)}`),
    ),

    groups.answered.length
      ? h('div',
        h('h2.group-head', h('span.pill.good', 'Answered'), ' back with you'),
        groups.answered.map((row) => personCard(row, data, reload, 'answered')))
      : null,

    clearable.length
      ? h('div.bulk-clear',
        h('span', h('strong', `${clearableDays} clean`),
          h('span.muted', ' — nothing flagged, nothing waiting')),
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
          ` ${count(groups.asked)} day${count(groups.asked) === 1 ? '' : 's'} — nothing to do until somebody replies`),
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
  if (pin) {
    requestAnimationFrame(() => view.querySelector('.just-acted')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }

  return view;
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
      }), difference === (row.difference ?? 0)
        ? `The figures make it ${difference}. What actually moves is your call`
        : `The figures make it ${difference} for the ${days.length} day`
          + `${days.length === 1 ? '' : 's'} you ticked — ${row.difference ?? 0} over the whole `
          + 'period. What actually moves is your call'),

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
      + `${done.excluded ? `, ${done.excluded} left for later` : ''}.`, 'good');
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

  return h('div',
    waiting.length
      ? h('div',
        h('h2.group-head', h('span.pill.warn', 'Waiting'), ' on an answer'),
        waiting.map((q) => queryCard(q, data, reload)))
      : null,

    back.length
      ? h('div',
        h('h2.group-head', h('span.pill.good', 'Answered'),
          ' back with whoever asked — the days can be signed'),
        back.map((q) => queryCard(q, data, reload)))
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
    ? card('Waiting for you', {
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

function queryCard(q, data, reload) {
  const mine = q.raisedBy === data.mine;

  const forMe = q.addressedTo != null && Number(q.addressedTo) === Number(data.myId);

  return card(q.staff.name, {
    note: `${fmtDay(q.from, { withYear: true })} – ${fmtDay(q.to, { withYear: true })} · ${q.days.length} day(s)`,
    wide: true,
    actions: h('div.btn-row',
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
