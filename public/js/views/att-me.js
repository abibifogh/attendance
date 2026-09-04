import { api } from '../api.js';
import { navigate } from '../app.js';
import { fmtDay, fmtDayShort, fmtNum, h, mount, shiftDay, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { installNudge } from './install-help.js';
import {
  asHours, field, formDialog, lateBy, shiftColour, shiftHours, shiftMinutes, showSheet,
} from './att-shared.js';

// How many days somebody can say they cannot work in one go. Kept in step with
// the same figure in src/routes/me.js, which is the one that actually holds:
// this one is here so the screen can say it before the server has to.
const MAX_UNAVAILABLE_DAYS = 2;

/**
 * My shifts.
 *
 * The screen a member of staff opens on their phone, in a corridor, to answer
 * three questions: am I in tomorrow, was I marked late on Tuesday, and can I
 * have Friday off.
 *
 * Built as a list rather than a grid on purpose. A rota grid is the right
 * shape for the person building it, who is comparing twenty-four people; it is
 * the wrong shape for the person on it, who is reading one column and is
 * holding a phone.
 *
 * What is deliberately not here: any overtime figure. What somebody is owed is
 * not settled until the month is signed off, and a running total on a phone is
 * a number to argue about; the app should not be the one starting the
 * argument.
 *
 * Anybody else's shifts are not here either, with one exception somebody has
 * to switch on: the department card, which shows the week for the people they
 * work beside and nothing that goes with it.
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
        h('button.btn-sm', {
          onclick: () => editMyAvailability(data, reload),
        }, 'Create unavailability'),
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

    // Once, on the screen staff actually open. It lived under My account,
    // which is where somebody goes to change a PIN and otherwise never.
    installNudge(),

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

    departmentCard(),

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
    ? h('span.pill.warn', `${lateBy(on.lateMinutes)} late`)
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
        // Said rather than left blank. A dash meant two different things and
        // this is the one somebody can plan around: a day with nothing on it
        // in a week that has gone out is a day off, and it was decided.
        ? h('span.pill', 'Rest day')
        : entry.pending
          ? h('span.pill.warn', 'Being worked out')
          // The other thing the dash meant: nobody has said yet.
          : h('small.muted', 'Not out yet');

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
            ? h('small', ` · ${lateBy(entry.onShift.lateMinutes)} late`)
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
          ? h('small.muted', ` ${lateBy(entry.was.lateMinutes)} late`)
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
        + 'Only working days are charged: rest days and public holidays inside the period '
        + 'cost nothing. Ask as far ahead as you like — the rota does not have to reach '
        + 'that far yet, and the days are settled when it is approved.'),
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
    + `${done.days === 1 ? '' : 's'} if it is approved`
    + (done.estimated ? ', give or take — the rota does not reach that far yet.' : '.'), 'good');
  await reload();
}

/**
 * Who else is on this week.
 *
 * The one question a member of staff has about anybody else's rota, and the
 * only reason they were asking a supervisor to read it out: somebody wanting
 * to swap a Saturday, or working out whether the bar is covered before
 * agreeing to something.
 *
 * Their own department and no other, and the shifts only. No clock times, no
 * lateness, no leave balances, nothing anybody has asked for. That somebody is
 * away shows, because that is the question; why they are away does not.
 *
 * Loaded on its own after the page, so somebody who is not allowed it pays
 * nothing for it and somebody who is does not wait on it to see their own
 * week.
 */
function departmentCard() {
  const host = h('div');

  const draw = async (from = null) => {
    const data = await api.myDepartment(from).catch(() => null);
    if (!data || !data.allowed) { mount(host); return; }

    mount(host, card(`Who else is on in ${data.department}`, {
      note: `${data.people.length} ${data.people.length === 1 ? 'person' : 'people'}`,
      wide: true,
    },
    h('div.toolbar',
      h('button.btn-sm', {
        onclick: () => draw(shiftDay(data.from, -7)), 'aria-label': 'The week before',
      }, '‹'),
      h('strong', `${fmtDayShort(data.from)} – ${fmtDayShort(data.to)}`),
      h('button.btn-sm', {
        onclick: () => draw(shiftDay(data.from, 7)), 'aria-label': 'The week after',
      }, '›'),
      h('button.btn-sm', { onclick: () => draw(null) }, 'This week'),
    ),
    h('div.dept-week', deptWeek(data)),
    h('div.dept-days', data.days.map((day) => deptDay(day, data))),
    ));
  };

  draw();
  return host;
}

/**
 * The week as a grid, for a screen wide enough to hold one.
 *
 * Names down the side, days across the top, which is the shape anybody who has
 * seen a rota already knows how to read.
 */
function deptWeek(data) {
  return h('table.table.dept-rota',
    h('thead', h('tr',
      h('th', 'Name'),
      ...data.days.map((day) => h('th',
        { class: day === data.today ? 'rota-today' : null },
        h('div', weekdayOf(day)),
        h('small.muted', String(Number(day.slice(8, 10)))))))),
    h('tbody', data.people.map((person) => h('tr',
      { class: person.isMe ? 'dept-me' : null },
      h('td', person.name, person.isMe ? h('small.muted', ' (you)') : null),
      ...person.days.map((entry) => h('td',
        { class: entry.day === data.today ? 'rota-today' : null },
        entry.away
          ? h('small.muted', 'Away')
          : entry.shift
            ? h('div.dept-shift',
              { 'data-shift-colour': String(entry.shift.colour ?? 0) },
              h('span.dept-shift-name', entry.shift.name),
              h('small.muted', `${entry.shift.starts_at}\u2013${entry.shift.ends_at}`))
            : entry.restDay
              ? h('small.muted', 'Rest day')
              : h('small.muted', '\u2014')))))));
}

/**
 * One day, and who is on it.
 *
 * The phone shape, and a different one on purpose. Seven columns of shift
 * names will not fit a phone at any size worth reading, and the question being
 * asked in a corridor is about a day, not about a week: who is on tomorrow.
 * So the day comes first and the names hang off it, and the people who are not
 * in gather on one line at the bottom rather than taking a row each.
 */
function deptDay(day, data) {
  const on = [];
  const off = [];
  const away = [];

  const unsaid = [];

  for (const person of data.people) {
    const entry = person.days.find((d) => d.day === day);
    const label = person.name + (person.isMe ? ' (you)' : '');
    if (entry?.away) away.push(label);
    else if (entry?.shift) on.push({ label, shift: entry.shift, isMe: person.isMe });
    // Off and not-yet-said kept apart. Somebody working out who to ask about a
    // Saturday is asking about the first list, and the second one is not an
    // answer at all.
    else if (entry?.restDay) off.push(label);
    else unsaid.push(label);
  }
  on.sort((a, b) => String(a.shift.starts_at).localeCompare(String(b.shift.starts_at)));

  return h('div.dept-day', { class: day === data.today ? 'dept-day-today' : null },
    h('div.dept-day-head',
      h('strong', weekdayOf(day)),
      h('small.muted', fmtDayShort(day)),
      day === data.today ? h('span.pill.good', 'Today') : null),
    on.length
      ? h('div.dept-day-on', on.map((row) => h('div.dept-on',
        { class: row.isMe ? 'dept-me' : null, 'data-shift-colour': String(row.shift.colour ?? 0) },
        h('span.dept-on-who', row.label),
        h('small.muted', `${row.shift.name} \u00b7 ${row.shift.starts_at}\u2013${row.shift.ends_at}`))))
      : h('p.muted', 'Nobody on this day.'),
    off.length ? h('p.dept-day-off', h('small.muted', `Off: ${off.join(', ')}`)) : null,
    away.length ? h('p.dept-day-off', h('small.muted', `Away: ${away.join(', ')}`)) : null,
    unsaid.length
      ? h('p.dept-day-off', h('small.muted', `Not out yet: ${unsaid.join(', ')}`))
      : null,
  );
}

/** Mon, Tue, Wed. Read off the day itself rather than the reader's clock. */
function weekdayOf(day) {
  return new Date(`${day}T12:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

/**
 * Create unavailability.
 *
 * Not leave, and it says so plainly: nothing is approved and nothing is spent.
 * It is the fact the planner needs before they pick a shift, put in by the one
 * person who actually knows it.
 *
 * Two days at a time, because that is the size of thing this is for: a
 * christening on Saturday, a clinic appointment on Tuesday. A week off is
 * leave, and asking for it here would be asking for a week away without any
 * of it being approved, counted or taken off a balance. So the third tick
 * says so and sends them next door.
 */
async function editMyAvailability(data, reload) {
  const ahead = data.days.filter((d) => d.day >= data.today);

  const status = h('select', { name: 'status' },
    h('option', { value: 'unavailable' }, 'Cannot work'),
    h('option', { value: 'preferred' }, 'Would like to work'),
  );

  // Said as it happens rather than on Save. Somebody who has ticked five days
  // should find out before they have filled in a note and a pair of times.
  const tally = h('p.muted', { style: { fontSize: '.85rem', minHeight: '1.2rem' } });
  const ticks = [];
  const cannotWork = () => status.value !== 'preferred';
  const count = () => ticks.filter((t) => t.checked).length;

  const paint = () => {
    const n = count();
    const over = cannotWork() && n > MAX_UNAVAILABLE_DAYS;
    tally.textContent = over
      ? `${n} days ticked. Unavailability is for a day or two. For anything longer, `
        + 'close this and use Ask for leave instead.'
      : n
        ? `${n} day${n === 1 ? '' : 's'} ticked.`
        : '';
    tally.classList.toggle('bad-text', over);
  };

  const dayList = h('div.avail-days', ahead.map((d) => {
    const tick = h('input', {
      type: 'checkbox', name: 'day', value: d.day,
      checked: d.availability?.status === 'unavailable',
      onchange: paint,
    });
    ticks.push(tick);
    return h('label.tickline', tick,
      h('span', fmtDayShort(d.day),
        d.shift ? h('small.muted', ` (on ${d.shift.name})`) : null));
  }));

  status.onchange = paint;
  paint();

  const done = await formDialog({
    title: 'Create unavailability',
    submitLabel: 'Save',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'This is not leave. Nothing is approved and no days are spent. It shows in the cell '
        + 'so whoever builds the rota sees it before they put you on something. Two days at a '
        + 'time. For longer than that, ask for leave.'),
      dayList,
      tally,
      field('Kind', status),
      h('div.field-row',
        field('From', h('input', { type: 'time', name: 'fromTime' }), 'Leave both blank for the whole day'),
        field('Until', h('input', { type: 'time', name: 'toTime' })),
      ),
      field('Note', h('input', { type: 'text', name: 'note', maxlength: 200 })),
    ),
    onSubmit: async (form) => {
      const days = form.getAll('day');
      if (!days.length) throw new Error('Tick at least one day.');
      if (form.get('status') !== 'preferred' && days.length > MAX_UNAVAILABLE_DAYS) {
        throw new Error(
          `${MAX_UNAVAILABLE_DAYS} days at most. For longer than that, ask for leave instead.`,
        );
      }
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
  toast(`${done.asked} day${done.asked === 1 ? '' : 's'} marked.`, 'good');
  await reload();
}
