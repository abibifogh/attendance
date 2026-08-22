import { api } from '../api.js';
import { navigate } from '../app.js';
import { fmtDay, fmtDayShort, fmtNum, h, mount, shiftDay, toast } from '../util.js';
import { card, emptyState } from './components.js';
import {
  asHours, field, formDialog, shiftColour, shiftHours, shiftMinutes, showSheet,
} from './att-shared.js';

/**
 * My shifts.
 *
 * The screen a member of staff opens on their phone, in a corridor, to answer
 * one of four questions: am I in tomorrow, was I marked late on Tuesday, can I
 * have Friday off, and I am stuck in traffic.
 *
 * Built as a list rather than a grid on purpose. A rota grid is the right
 * shape for the person building it, who is comparing twenty-four people; it is
 * the wrong shape for the person on it, who is reading one column and is
 * holding a phone.
 *
 * What is deliberately not here: anybody else's shifts, and any overtime
 * figure. The first is not their business and the second is not settled until
 * somebody signs the month off — a running total on a phone is a number to
 * argue about, and the app should not be the one starting the argument.
 */
export async function renderAttMe(params = {}) {
  const host = h('div');
  const from = params.from || null;
  const data = await api.myWeek(from).catch((err) => ({ error: err.message }));

  const reload = async (next = {}) => mount(host, await renderAttMe({ ...params, ...next }));

  if (data.error) {
    mount(host,
      h('div.page-head', h('h1', 'My shifts')),
      emptyState('Nothing to show yet', data.error));
    return host;
  }

  const upcoming = data.days.filter((d) => d.day >= data.today);
  const behind = data.days.filter((d) => d.day < data.today && d.was).reverse();
  const next = upcoming.find((d) => d.shift);

  // A week at a time. Four weeks of days on a phone is a page nobody reaches
  // the bottom of, and the question this screen answers is almost always about
  // this week. The rest is one press away and does not have to be scrolled
  // past to get anywhere.
  const thisWeek = upcoming.slice(0, 7);
  const laterOn = upcoming.slice(7);
  const lastWeek = behind.slice(0, 7);
  const earlier = behind.slice(7);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'My shifts'),
        // What is happening, in the order it matters: at work now, then the
        // next one. "Next: today's shift" while standing on it is the line
        // that made this screen feel like it was not paying attention.
        h('div.sub', data.onShift
          ? `On shift since ${data.onShift.since ?? 'earlier'}`
            + `${data.onShift.shift?.ends_at ? `, until ${data.onShift.shift.ends_at}` : ''}`
          : next
            ? `Next: ${fmtDay(next.day)}, ${next.shift.name} ${shiftHours(next.shift)}`
            : 'Nothing on the rota for you in the next four weeks'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => runningLate(reload) }, 'I am running late'),
        h('button.btn-sm', {
          onclick: () => editMyAvailability(data, reload),
        }, 'Days I cannot work'),
        h('button.btn.btn-primary', { onclick: () => askForLeave(data, reload) }, 'Ask for leave'),
      ),
    ),

    data.onShift ? onShiftCard(data) : countdownCard(data),

    // The dates the list below actually covers, and the arrows move by that
    // much. Showing a four-week span over a card holding seven days is the
    // screen disagreeing with itself.
    h('div.toolbar',
      h('button.btn-sm', {
        onclick: () => reload({ from: shiftDay(data.from, -7) }),
        'aria-label': 'The week before',
      }, '‹'),
      h('strong', thisWeek.length
        ? `${fmtDayShort(thisWeek[0].day)} – ${fmtDayShort(thisWeek[thisWeek.length - 1].day)}`
        : `${fmtDayShort(data.from)} – ${fmtDayShort(data.to)}`),
      h('button.btn-sm', {
        onclick: () => reload({ from: shiftDay(data.from, 7) }),
        'aria-label': 'The week after',
      }, '›'),
      h('button.btn-sm', { onclick: () => reload({ from: null }) }, 'Today'),
    ),

    balanceLine(data),

    card('Coming up', {
      note: `${thisWeek.filter((d) => d.shift).length} shift`
        + `${thisWeek.filter((d) => d.shift).length === 1 ? '' : 's'} this week`,
      wide: true,
    },
    thisWeek.length
      ? h('div.me-list', thisWeek.map((d) => dayRow(d, data)))
      : h('p.muted', 'Nothing yet.'),
    seeMore(laterOn, data, {
      label: `See the next ${laterOn.length} day${laterOn.length === 1 ? '' : 's'}`,
      title: 'The rest of the four weeks',
      empty: 'Nothing further ahead has been published yet.',
    })),

    data.leave.length
      ? card('My leave', { note: `${data.leave.length}`, wide: true },
        h('div.me-list', data.leave.map((row) => leaveRow(row, reload))))
      : null,

    lastWeek.length
      ? card('How the days behind me came out', {
        note: 'the last seven',
        wide: true,
        actions: h('button.btn-sm', {
          onclick: () => navigate('att-my-report'),
          title: 'Your month, in figures',
        }, 'My report'),
      },
      h('div.me-list', lastWeek.map((d) => dayRow(d, data))),
      seeMore(earlier, data, {
        label: `See ${earlier.length} more day${earlier.length === 1 ? '' : 's'}`,
        title: 'Earlier in this window',
        empty: 'Nothing earlier in this window.',
      }))
      : null,

    h('p.muted', { style: { fontSize: '.82rem' } },
      'Only shifts that have been published show here. If a day is blank and you expected '
      + 'something, the rota for it may still be being worked out.'),
  );

  return host;
}

/**
 * The rest of the list, behind one press.
 *
 * A dialog rather than an expanding section: on a phone, unfolding thirty
 * more rows in place pushes everything the reader was looking at off the
 * screen and leaves them somewhere in the middle of a page they did not ask
 * for. A sheet opens over the top and closes back to where they were.
 */
function seeMore(rows, data, { label, title, empty }) {
  if (!rows.length) return null;

  return h('div', { style: { marginTop: '.6rem' } },
    h('button.btn-sm.me-more', {
      onclick: () => showSheet({
        title,
        body: rows.length
          ? h('div.me-list', rows.map((d) => dayRow(d, data)))
          : h('p.muted', empty),
      }),
    }, label));
}

/**
 * The banner that says you are at work.
 *
 * It replaces the countdown rather than sitting beside it. Somebody who
 * clocked in at twenty to six for a six o'clock start does not need a clock
 * ticking down to a shift they are already standing on; they need to know the
 * terminal saw them, at what time, and when they finish.
 *
 * Nothing here ticks. The countdown ticks because seconds are what make a
 * countdown believable; this is a statement of fact and a statement of fact
 * that flickers looks like it is unsure.
 */
function onShiftCard(data) {
  const on = data.onShift;
  const shift = on.shift;

  const how = on.lateMinutes > 0
    ? h('span.pill.warn', `${on.lateMinutes} min late`)
    : on.earlyIn > 0
      ? h('span.pill.good', `${on.earlyIn} min early`)
      : h('span.pill.good', 'On time');

  return h('div.countdown.on-shift',
    h('div',
      h('div.countdown-label', 'You are on shift'),
      h('div.on-shift-since', on.since ? `Clocked in at ${on.since}` : 'Clocked in'),
      h('div.countdown-sub',
        shift?.ends_at ? `until ${shift.ends_at}` : 'the terminal has you at work',
        on.day !== data.today ? ` · started ${fmtDay(on.day)}` : ''),
      h('div.on-shift-how', how)),
    shift
      ? h('div.countdown-shift', { 'data-shift-colour': String(shiftColour(shift)) },
        h('strong', shift.name),
        h('small.muted', `${shiftHours(shift)} · ${asHours(shiftMinutes(shift))}`),
        shift.department ? h('small.muted', shift.department) : null)
      : null,
  );
}

/**
 * How long until the next shift starts.
 *
 * Only inside a day, because that is the window where the number changes what
 * somebody does: "in 3 days" is a calendar and "in 6 hours" is a reason to go
 * to bed. It ticks, because a countdown that does not tick is a timestamp with
 * extra steps, and the seconds are what make somebody believe it.
 */
function countdownCard(data) {
  const next = data.next;
  if (!next?.soon) return null;

  // Counted from the second the answer was made, using the browser's own clock
  // for the ticking only. The server said how far away it was; nothing here
  // needs to know what time it is, which is the whole reason it works on a
  // phone whose clock is wrong.
  const start = Date.now();
  const remaining = () => Math.max(0, next.seconds - Math.floor((Date.now() - start) / 1000));

  const big = h('div.countdown-clock');
  const line = h('div.countdown-sub');

  const draw = () => {
    const left = remaining();
    const hh = Math.floor(left / 3600);
    const mm = Math.floor((left % 3600) / 60);
    const ss = left % 60;

    big.textContent = left
      ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : 'Now';
    line.textContent = left
      ? `until ${next.shift.name} on ${fmtDay(next.day)}, ${next.shift.starts_at}`
      : `${next.shift.name} starts now`;
  };
  draw();

  // Stopped the moment the element leaves the page, so browsing to another
  // week does not leave a timer running against a card nobody is looking at.
  const tick = setInterval(() => {
    if (!big.isConnected) { clearInterval(tick); return; }
    draw();
  }, 1000);

  const hours = Math.floor(next.seconds / 3600);

  return h('div.countdown', {
    class: hours < 3 ? 'countdown-close' : '',
  },
    h('div',
      h('div.countdown-label', 'Your next shift'),
      big,
      line,
      next.title ? h('div.countdown-sub', next.title) : null,
    ),
    h('div.countdown-shift', { 'data-shift-colour': String(shiftColour(next.shift)) },
      h('strong', next.shift.name),
      h('small.muted', `${shiftHours(next.shift)} · ${asHours(shiftMinutes(next.shift))}`),
      next.shift.department ? h('small.muted', next.shift.department) : null),
  );
}

/** What is left, and what is already spoken for. */
function balanceLine(data) {
  // The property can turn this off. When it is off the figure is not in the
  // answer at all, so there is nothing here to hide badly.
  if (!data.showBalance || !data.balance) return null;
  const b = data.balance;
  const day = (n) => `${fmtNum(n ?? 0, (n ?? 0) % 1 ? 1 : 0)} day${(n ?? 0) === 1 ? '' : 's'}`;

  return h('p.signoff-counts',
    h('strong', `${day(b.remaining)} of leave left`),
    b.taken != null ? h('span.muted', ` · ${day(b.taken)} taken`) : null,
    b.booked ? h('span.pill', { style: { marginLeft: '.4rem' } }, `${day(b.booked)} booked`) : null,
    b.pending ? h('span.pill.warn', { style: { marginLeft: '.35rem' } }, `${day(b.pending)} asked for`) : null,
  );
}

/** One day, as somebody reads their own week. */
function dayRow(entry, data) {
  const when = new Date(`${entry.day}T12:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

  const what = entry.leave
    ? h('span.pill.good', entry.leave)
    : entry.shift
      ? h('div.me-shift', { 'data-shift-colour': String(shiftColour(entry.shift)) },
        entry.title ? h('span.me-title', entry.title) : null,
        h('strong', entry.shift.name),
        h('small.muted', `${shiftHours(entry.shift)} · ${asHours(shiftMinutes(entry.shift))}`))
      : entry.restDay
        ? h('span.muted', 'Day off')
        : entry.pending
          ? h('span.pill.warn', 'Being worked out')
          : h('span.muted', '—');

  return h('div.me-day', {
    class: [entry.day === data.today ? 'me-today' : '', entry.onShift ? 'me-on-shift' : '']
      .filter(Boolean).join(' '),
  },
    h('div.me-when',
      h('strong', when),
      h('small.muted', fmtDayShort(entry.day))),
    h('div.me-what',
      // Against the shift itself, so a week with a banner in it is read the
      // same way as a week without one: eyes down the middle column.
      entry.onShift
        ? h('div.me-banner',
          h('span.me-banner-dot'),
          h('strong', entry.onShift.since ? `On shift since ${entry.onShift.since}` : 'On shift'),
          entry.onShift.lateMinutes > 0
            ? h('small', ` · ${entry.onShift.lateMinutes} min late`)
            : entry.onShift.earlyIn > 0
              ? h('small', ` · ${entry.onShift.earlyIn} min early`)
              : null)
        : null,
      what,
      entry.holiday ? h('small.muted', entry.holiday) : null,
      entry.availability
        ? h('small.muted', entry.availability.status === 'preferred'
          ? `★ you asked for this day${entry.availability.from ? ` ${entry.availability.from}–${entry.availability.to}` : ''}`
          : `✕ you said you cannot work${entry.availability.from ? ` ${entry.availability.from}–${entry.availability.to}` : ' this day'}`)
        : null),
    h('div.me-was', entry.was
      ? h('div',
        h('span', { class: `pill${entry.was.colour === 'green' ? ' good' : entry.was.colour === 'red' ? ' bad' : entry.was.colour === 'amber' ? ' warn' : ''}` },
          entry.was.label),
        entry.was.lateMinutes
          ? h('small.muted', ` ${entry.was.lateMinutes} min late`)
          : null,
        h('div', h('small.muted', `${entry.was.in || '—'} → ${entry.was.out || '—'}`)))
      : null),
  );
}

/** One leave request, and the only thing they can do to it. */
function leaveRow(row, reload) {
  const pill = { pending: 'warn', approved: 'good', rejected: 'bad' }[row.status] ?? '';
  const label = {
    pending: 'Waiting', approved: 'Approved', rejected: 'Not approved', withdrawn: 'Taken back',
  }[row.status] ?? row.status;

  return h('div.me-day',
    h('div.me-when',
      h('strong', fmtDayShort(row.from)),
      h('small.muted', row.from === row.to ? '' : `to ${fmtDayShort(row.to)}`)),
    h('div.me-what',
      h('strong', row.label),
      h('small.muted', `${fmtNum(row.days, row.days % 1 ? 1 : 0)} day`
        + `${row.days === 1 ? '' : 's'}${row.reason ? ` · ${row.reason}` : ''}`),
      row.note ? h('small.muted', `“${row.note}”`) : null),
    h('div.me-was',
      h(`span.pill${pill ? `.${pill}` : ''}`, label),
      row.status === 'pending'
        ? h('button.btn-sm', {
          style: { marginLeft: '.4rem' },
          onclick: async () => {
            if (!window.confirm('Take this request back?')) return;
            try {
              await api.myWithdrawLeave(row.id);
              toast('Taken back.');
              await reload();
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        }, 'Take it back')
        : null),
  );
}

/**
 * Ask for leave.
 *
 * It says what it will cost before it is sent, because the number people
 * actually want is not the length of the holiday, it is how many days come off
 * the balance — and rest days inside the span cost nothing.
 */
async function askForLeave(data, reload) {
  const done = await formDialog({
    title: 'Ask for leave',
    submitLabel: 'Send it',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        (data.showBalance && data.balance
          ? `You have ${fmtNum(data.balance.remaining ?? 0, 1)} days left. `
          : '')
        + 'Only days you are rostered on are charged: rest days and public holidays inside '
        + 'the period cost nothing.'),
      field('Type', h('select', { name: 'reason', required: true },
        h('option', { value: '' }, 'Choose…'),
        data.reasons.map((r) => h('option', { value: r.code }, r.label)))),
      h('div.field-row',
        field('First day', h('input', { type: 'date', name: 'from', required: true, min: data.today })),
        field('Last day', h('input', { type: 'date', name: 'to', required: true, min: data.today })),
      ),
      field('Half day', h('select', { name: 'halfDay' },
        h('option', { value: '' }, 'No, full days throughout'),
        h('option', { value: 'start' }, 'Back for the afternoon of the first day'),
        h('option', { value: 'end' }, 'Off from the afternoon of the last day'),
        h('option', { value: 'both' }, 'Half day at each end'),
      )),
      field('Why', h('input', { type: 'text', name: 'note', maxlength: 500 }),
        'Your manager sees this'),
    ),
    onSubmit: async (form) => api.myAskForLeave({
      reason: form.get('reason'),
      from: form.get('from'),
      to: form.get('to'),
      halfDay: form.get('halfDay') || null,
      note: form.get('note') || null,
    }),
  });

  if (!done) return;
  toast(`Sent. ${fmtNum(done.days, done.days % 1 ? 1 : 0)} day`
    + `${done.days === 1 ? '' : 's'} if it is approved.`, 'good');
  await reload();
}

/**
 * Days I cannot work.
 *
 * Not leave, and it says so plainly: nothing is approved and nothing is spent.
 * It is the fact the planner needs before they pick a shift, put in by the one
 * person who actually knows it.
 */
async function editMyAvailability(data, reload) {
  const ahead = data.days.filter((d) => d.day >= data.today);

  const done = await formDialog({
    title: 'Days I cannot work',
    submitLabel: 'Save',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'This is not leave. Nothing is approved and no days are spent. It shows in the cell '
        + 'so whoever builds the rota sees it before they put you on something.'),
      h('div.avail-days', ahead.map((d) => h('label.tickline',
        h('input', {
          type: 'checkbox', name: 'day', value: d.day,
          checked: d.availability?.status === 'unavailable',
        }),
        h('span', fmtDayShort(d.day),
          d.shift ? h('small.muted', ` (on ${d.shift.name})`) : null)))),
      field('Kind', h('select', { name: 'status' },
        h('option', { value: 'unavailable' }, 'Cannot work'),
        h('option', { value: 'preferred' }, 'Would like to work'),
      )),
      h('div.field-row',
        field('From', h('input', { type: 'time', name: 'fromTime' }), 'Leave both blank for the whole day'),
        field('Until', h('input', { type: 'time', name: 'toTime' })),
      ),
      field('Note', h('input', { type: 'text', name: 'note', maxlength: 200 })),
    ),
    onSubmit: async (form) => {
      const days = form.getAll('day');
      if (!days.length) throw new Error('Tick at least one day.');
      return api.mySetAvailability({
        days,
        status: form.get('status'),
        note: form.get('note') || null,
        fromTime: form.get('fromTime') || null,
        toTime: form.get('toTime') || null,
      });
    },
  });

  if (!done) return;
  toast(`${done.marked} day${done.marked === 1 ? '' : 's'} marked.`, 'good');
  await reload();
}

/**
 * Stuck in traffic.
 *
 * One button, and the thing a hotel wants most out of a phone. It records
 * nothing against the day — the terminal decides what happened — it just means
 * whoever is on the floor knows before the shift starts rather than by looking
 * at an empty station.
 */
async function runningLate(reload) {
  const done = await formDialog({
    title: 'Tell them I am running late',
    submitLabel: 'Send it',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'This is a message, not an excuse note. It changes nothing on your record: the '
        + 'terminal still decides what time you arrived.'),
      field('About how late', h('select', { name: 'minutes' },
        [10, 15, 30, 45, 60, 90, 120].map((n) => h('option', {
          value: String(n), selected: n === 15,
        }, `${n} minutes`)))),
      field('Anything to add', h('input', {
        type: 'text', name: 'note', maxlength: 200, placeholder: 'The Spintex road is at a stop',
      })),
    ),
    onSubmit: async (form) => api.myRunningLate({
      minutes: Number(form.get('minutes')),
      note: form.get('note') || null,
    }),
  });

  if (!done) return;
  toast('Sent. They know.', 'good');
  await reload();
}
