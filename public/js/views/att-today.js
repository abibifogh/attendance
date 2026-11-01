import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import { fmtDay, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { alertList, dropdownMenu, emptyState, exportButton, face, moreActions } from './components.js';
import { printButton } from '../print.js';
import { birthdayStrip } from './birthday.js';
import { byDepartment, sayHowItStands, toDealWith } from '../today-groups.js';
import {
  correctTimesDialog, field, formDialog, lateBy, needsAttention, periodBar, reasonSelect, shiftColour, totalsLine,
} from './att-shared.js';
import { questionRows } from './absence.js';

/**
 * The morning screen.
 *
 * One job: show a supervisor who is in, who is not, and what needs dealing
 * with, before they get on with their day.
 *
 * Read top to bottom it answers three questions in the order they are asked.
 * The four counts say how the day stands at a glance. The timeline says it per
 * person: the rota as a dashed bar in the shift's own colour, the time on the
 * clock as a solid stretch over it, and a red line where now is. And "Needs
 * you" at the side lists only what somebody has to do something about, each
 * with the press that does it, using the same corrections and rulings the app
 * has always had. Nothing on it is new server logic.
 *
 * Still one group per department inside the timeline, everybody in it once, in
 * the order a supervisor deals with them: waiting on a decision, then absent,
 * then late, then everybody who simply turned up.
 *
 * On a phone the timeline goes: the counts, what needs you, then a plain list
 * of names with a pill saying how each one stands.
 */
export async function renderAttToday(params) {
  const host = h('div.tday');
  const day = params.day || todayISO();
  const [data, asks] = await Promise.all([
    api.attDay(day),
    can('att_rota') && day === todayISO() ? api.absenceQuestions().catch(() => null) : Promise.resolve(null),
  ]);
  const isToday = day === data.today;

  // The day before, only so a clock-out forgotten last night can be put right
  // from this morning's screen. Never allowed to stop Today loading.
  const yesterday = isToday && data.rows.length
    ? await api.attDay(shiftDay(day, -1)).catch(() => null)
    : null;

  const KINDS = {
    all: () => true,
    on: (r) => isOn(r),
    late: (r) => isLate(r),
    missing: (r) => notIn(r),
    off: (r) => isOff(r),
  };
  let filter = KINDS[params.show] ? params.show : 'all';

  const reload = async (nextDay = day) => {
    const show = filter === 'all' ? null : filter;
    replaceParams('att-today', { day: nextDay, show });
    mount(host, await renderAttToday({ day: nextDay, show }));
  };

  const manages = can('att_manage');
  // Correcting a clock time is smaller than settling a day, and whoever builds
  // the rota holds it on its own.
  const fixesTimes = can('att_times');
  const clocks = clockBanner(data.clockWarnings);
  const quiet = terminalBanner(data.terminals);
  // Only ever on the day itself, and never allowed to stop the morning list
  // loading. It is a nicety; the rest of this screen is the job.
  const birthdays = isToday ? await birthdayStrip().catch(() => null) : null;
  // Everything with something against it, which is exactly what the download
  // is: whoever is about to walk round the building wants the eight names with
  // something wrong, not the ninety who turned up.
  const issues = data.rows.filter(toDealWith);
  const nowClock = isToday ? String(data.now || '').slice(11, 16) : '';
  const nowMin = isToday ? toMin(nowClock) : null;

  const nav = h('div.toolbar.tday-nav',
    // Arrows on a phone, words on a desk.
    periodBar({
      label: fmtDay(day, { withYear: true }),
      onPrev: () => reload(shiftDay(day, -1)),
      onNext: () => reload(shiftDay(day, 1)),
      nextDisabled: day >= data.today,
      prevLabel: 'The day before',
      nextLabel: 'The day after',
      picker: { type: 'date', value: day, max: data.today, label: 'Day', onPick: (v) => reload(v) },
      now: isToday ? null : { label: 'Today', onClick: () => reload(data.today) },
    }),
    h('div', { style: { flex: 1 } }),

    // Everything that makes a file. Along the toolbar on a desk, one More
    // button on a phone.
    moreActions(
      printButton({
        title: `Attendance, ${fmtDay(day, { withYear: true })}`,
        subtitle: totalsLine(data.totals),
        footer: PRINT_FOOTER,
      }),
      issues.length
        ? exportButton(api.attIssuesUrl({ day }), `Download the ${issues.length} to deal with`)
        : null,
      issues.length
        ? h('a.btn.btn-sm', {
          href: api.attIssuesUrl({ from: shiftDay(day, -6), to: day }),
          download: '',
          title: 'Everything with something wrong with it, over the last seven days',
        }, 'Last 7 days')
        : null,
      can('att_reports') ? exportButton(api.attExportUrl(day, day), 'Export this day') : null,
    ),
  );

  const head = h('div.page-head.tday-head',
    h('div',
      h('h1', 'Today'),
      h('div.sub', fmtDay(day, { withYear: true }),
        nowClock
          ? h('span.tday-live', h('i', { 'aria-hidden': 'true' }), `Live, updated ${nowClock}`)
          : null),
    ),
  );

  if (!data.rows.length) {
    mount(host,
      head,
      nav,
      quiet,
      clocks,
      birthdays,
      // Two different empty screens wearing one sentence. A Sunday nobody is
      // working needs nothing done about it; a property with nobody on the
      // books needs somebody to go and set it up.
      data.anybody
        ? emptyState(
          'Nobody on for this day',
          'Nobody is rostered and nobody clocked in. If that is wrong, the rota for this day is '
          + 'where to put it right.',
        )
        : emptyState(
          'Nobody on the rota for this day',
          can('att_setup')
            ? 'Add your staff and their shifts in Settings, then the terminal\'s punches will start '
              + 'landing against them. Punches for people who are not set up yet are kept, not thrown away.'
            : 'Nobody has been set up for attendance yet. An administrator can do it in Settings.',
        ),
    );
    return host;
  }

  // -------------------------------------------------------------------------
  // The actions. Every one of them is something the app already did: settle a
  // day, undo a ruling, correct a clock time.
  // -------------------------------------------------------------------------

  /** Ask what happened, then record it against the day. */
  const resolve = async (row, forDay = day) => {
    const shiftHint = row.shift ? `${row.shift.name}, ${row.shift.starts_at}–${row.shift.ends_at}` : 'No shift rostered';
    const { reasons } = await api.attReasons();

    const done = await formDialog({
      title: `${row.staff.name}, ${fmtDay(forDay)}`,
      submitLabel: 'Record it',
      body: h('div',
        h('p.muted', shiftHint),
        row.note ? h('p', row.note) : null,
        h('div.grid.grid-2',
          field('Clocked in', h('input', {
            type: 'time', name: 'in', value: row.first_in || '',
          }), row.first_in ? 'What the terminal saw' : 'The terminal saw nothing'),
          field('Clocked out', h('input', {
            type: 'time', name: 'out', value: row.last_out || '',
          }), row.last_out ? 'What the terminal saw' : 'The terminal saw nothing'),
        ),
        field('Record this day as', reasonSelect(reasons, suggestedReason(row), { name: 'reason', required: true })),
        field('Note', h('input', {
          type: 'text', name: 'note', maxlength: 500,
          placeholder: 'What they told you, or who confirmed it',
        })),
      ),
      onSubmit: async (form) => api.attResolve(forDay, {
        staffId: row.staff.id,
        reason: form.get('reason'),
        in: form.get('in') || null,
        out: form.get('out') || null,
        note: form.get('note') || null,
      }),
    });

    if (done) {
      toast(`${row.staff.name}: recorded.`, 'good');
      await reload();
    }
  };

  const undo = async (row) => {
    await api.attUnresolve(day, { staffId: row.staff.id });
    toast('Put back to what the terminal recorded.');
    await reload();
  };

  /** Move a clock time without ruling on the day. */
  const correctTimes = async (row, forDay = day) => {
    const done = await correctTimesDialog({ ...row, day: forDay }, row.staff, { approves: can('att_setup') });
    if (!done) return;
    toast(done.pending
      ? `${row.staff.name}: sent to an administrator. Nothing has changed on the day yet.`
      : `${row.staff.name}: times corrected and the day settled.`, 'good');
    await reload();
  };

  /**
   * One press, no form: the button says exactly what it will do.
   *
   * Disabled while it runs so a second tap does not send it twice, and put
   * back with the reason if the server says no.
   */
  const press = (label, run, { primary = false } = {}) => h('button.tday-mini', {
    type: 'button',
    class: primary ? 'is-primary' : null,
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await run();
      } catch (err) {
        toast(err?.message || 'That did not work. Try again.', 'bad');
      } finally {
        if (btn.isConnected) btn.disabled = false;
      }
    },
  }, label);

  const linkTo = (label, path, linkParams, { quiet = false } = {}) => h('a.tday-mini', {
    class: quiet ? 'is-link' : null,
    href: `#/${path}?${new URLSearchParams(linkParams)}`,
    onclick: (e) => { e.preventDefault(); navigate(path, linkParams); },
  }, label);

  /** The clock-out set to the end of the shift, through the ordinary correction. */
  const outAtShiftEnd = (row, forDay) => async () => {
    const done = await api.attCorrectTimes(forDay, {
      staffId: row.staff.id,
      in: row.corrected_in ?? null,
      out: row.shift.ends_at,
      reason: `Clock-out set to the end of the shift (${row.shift.ends_at}) from Today`,
    });
    toast(done?.pending
      ? `${row.staff.name}: sent to an administrator. Nothing has changed on the day yet.`
      : `${row.staff.name}: out at ${row.shift.ends_at}.`, 'good');
    await reload();
  };

  const settleAs = (row, reason, said) => async () => {
    await api.attResolve(day, { staffId: row.staff.id, reason });
    toast(`${row.staff.name}: ${said}.`, 'good');
    await reload();
  };

  // A shift's name often carries its hours already ("Breakfast 06:00–14:00"),
  // and saying them twice is a label that no longer fits its bar.
  const shiftLine = (r) => {
    if (!r.shift) return 'No shift';
    const hours = `${r.shift.starts_at}–${r.shift.ends_at}`;
    return r.shift.name.includes(r.shift.starts_at) ? r.shift.name : `${r.shift.name} ${hours}`;
  };

  // -------------------------------------------------------------------------
  // How each person stands, in the words on their pill.
  // -------------------------------------------------------------------------

  function shiftEndMin(r) {
    if (!r.shift) return null;
    const a = toMin(r.shift.starts_at);
    let b = toMin(r.shift.ends_at);
    if (a == null || b == null) return null;
    if (b <= a) b += 1440;
    return b;
  }
  const shiftRunning = (r) => nowMin != null && shiftEndMin(r) != null && nowMin < shiftEndMin(r);

  function isLate(r) {
    if (!r.first_in || !r.shift) return false;
    if (r.resolution === 'resolved') return r.status === 'late' || r.status === 'late_early';
    return (r.late_minutes || 0) > (r.shift.grace_in_minutes ?? 5);
  }
  function isOff(r) { return ['leave', 'holiday', 'rest'].includes(r.status); }
  function notIn(r) {
    return Boolean(r.scheduled) && !r.first_in && (r.status === 'absent' || r.status === 'missing_in');
  }
  function onNow(r) {
    if (!isToday || !r.first_in || r.last_out) return false;
    if (r.status === 'working' || r.status === 'unscheduled') return true;
    return r.resolution === 'resolved' && shiftRunning(r);
  }
  function isOn(r) { return isToday ? onNow(r) : Boolean(r.first_in); }

  const statusOf = (r) => {
    const clean = (text) => String(text || '').replace(/\s*—\s*/g, ', ');
    if (r.resolution === 'resolved') {
      const tone = r.status === 'leave' ? 'leave'
        : { green: 'good', amber: 'warn', red: 'bad' }[r.colour] ?? 'idle';
      const title = r.resolved_by ? `Recorded by ${r.resolved_by}` : null;
      // Settled as worked: the times say more than the word "Present".
      if (tone === 'good' && onNow(r)) return { text: `On since ${r.first_in}`, tone, title };
      if (r.status === 'present' && r.first_in && r.last_out) {
        return { text: `In ${r.first_in} · out ${r.last_out}`, tone, title };
      }
      return { text: clean(r.label), tone, title };
    }
    switch (r.status) {
      case 'working':
        return isLate(r)
          ? { text: `Late · in ${r.first_in}`, tone: 'warn' }
          : { text: `On since ${r.first_in}`, tone: 'good' };
      case 'present': return { text: `In ${r.first_in} · out ${r.last_out}`, tone: 'good' };
      case 'late': return { text: `Late · in ${r.first_in}`, tone: 'warn' };
      case 'early_leave': return { text: `Left early · ${r.last_out}`, tone: 'warn' };
      case 'late_early': return { text: 'Late and left early', tone: 'warn' };
      case 'missing_out':
        return r.resolution === 'auto'
          ? { text: 'No clock-out, shift credited', tone: 'warn' }
          : { text: `In ${r.first_in}, no clock-out`, tone: 'bad' };
      case 'missing_in':
        return r.held === 'terminal'
          ? { text: 'Terminal was quiet', tone: 'warn' }
          : { text: 'No clock-in', tone: 'bad' };
      case 'absent':
        if (isToday) return { text: shiftRunning(r) ? 'Not in yet' : 'Did not come in', tone: 'bad' };
        return { text: clean(r.label) || 'Absent', tone: 'bad' };
      case 'upcoming':
        return { text: 'Starts later', tone: 'idle', title: r.shift ? `Starts at ${r.shift.starts_at}` : null };
      case 'unscheduled':
        return r.last_out
          ? { text: 'Worked, no shift', tone: 'info' }
          : { text: `In at ${r.first_in}, no shift`, tone: 'info' };
      case 'leave': return { text: clean(r.label), tone: 'leave' };
      default: return { text: clean(r.label), tone: 'idle' };
    }
  };

  const pill = (r) => {
    const s = statusOf(r);
    return h('span.tday-pill', { class: `is-${s.tone}`, title: s.title }, s.text);
  };

  // -------------------------------------------------------------------------
  // The counts, and the filter they share with the chips.
  // -------------------------------------------------------------------------

  const count = (k) => data.rows.filter(KINDS[k]).length;
  const offCount = count('off') + Number(data.resting || 0);
  const onRostered = data.rows.filter((r) => r.scheduled && isOn(r)).length;

  const tile = (k, tone, value, long, short, extra = null) => h('button.tday-tile', {
    type: 'button',
    class: `is-${tone}`,
    'data-show': k,
    'aria-pressed': String(filter === k),
    onclick: () => setFilter(filter === k ? 'all' : k),
  },
  h('b', value, extra),
  h('span.tday-long', long),
  h('span.tday-short', short));

  const tiles = h('div.tday-tiles',
    tile('on', 'good', String(onRostered), isToday ? 'On now' : 'Came in', isToday ? 'On' : 'In',
      h('small', ` of ${data.totals.scheduled}`)),
    tile('late', 'warn', String(count('late')), 'Came in late', 'Late'),
    tile('missing', 'bad', String(count('missing')), isToday ? 'Not in yet' : 'Did not come in', 'Not in'),
    tile('off', 'idle', String(offCount), 'Off or on leave', 'Off'),
  );

  const CHIPS = [
    ['all', 'Everybody', 'all'],
    ['on', isToday ? 'On now' : 'Came in', 'good'],
    ['late', 'Late', 'warn'],
    ['missing', isToday ? 'Not in yet' : 'Did not come in', 'bad'],
    ['off', 'Off or on leave', 'idle'],
  ];
  const chips = h('div.tday-chips', { role: 'group', 'aria-label': 'Show' },
    CHIPS.map(([k, label, tone]) => h('button.tday-chip', {
      type: 'button',
      'data-show': k,
      'aria-pressed': String(filter === k),
      onclick: () => setFilter(k),
    }, h('i', { class: `is-${tone}`, 'aria-hidden': 'true' }), label, ' ',
    h('span.tday-chip-n', String(count(k))))));

  // -------------------------------------------------------------------------
  // The timeline.
  // -------------------------------------------------------------------------

  const axis = axisFor(data.rows, nowMin);
  const pos = (m) => `${(((m - axis.from) / (axis.to - axis.from)) * 100).toFixed(3)}%`;
  const span = (a, b) => `${(((b - a) / (axis.to - axis.from)) * 100).toFixed(3)}%`;
  const clamp = (m) => Math.max(axis.from, Math.min(axis.to, m));
  const nowShows = nowMin != null && nowMin >= axis.from && nowMin <= axis.to;

  const track = (r) => {
    const bits = [nowShows ? h('i.tday-now', { style: { left: pos(nowMin) }, 'aria-hidden': 'true' }) : null];
    const start = r.shift ? toMin(r.shift.starts_at) : null;
    const end = shiftEndMin(r);
    const inAt = toMin(r.first_in);
    let outAt = toMin(r.last_out);
    if (inAt != null && outAt != null && outAt < inAt) outAt += 1440;

    if (start != null && end != null) {
      const a = clamp(start);
      const b = clamp(end);
      bits.push(h('div.tday-shift', {
        class: end > axis.to ? 'runs-on' : null,
        style: { left: pos(a), width: span(a, b) },
        title: `${r.shift.name}, ${r.shift.starts_at}–${r.shift.ends_at}`,
      }, h('span', shiftLine(r))));
    }

    if (inAt != null) {
      const until = outAt ?? (onNow(r) && nowMin != null ? Math.max(nowMin, inAt) : null);
      const tone = !r.shift ? 'info' : isLate(r) ? 'warn' : 'good';
      if (until != null && until > inAt) {
        const a = clamp(inAt);
        const b = clamp(until);
        bits.push(h('div.tday-worked', {
          class: `is-${tone}${outAt == null ? ' is-open' : ''}`,
          style: { left: pos(a), width: span(a, b) },
          title: outAt == null ? `On the clock since ${r.first_in}` : `On the clock ${r.first_in} to ${r.last_out}`,
        }));
      }
      bits.push(h('span.tday-in', {
        class: `is-${tone}`,
        style: { left: pos(clamp(inAt)) },
        title: `Clocked in ${r.first_in}`,
      }));
      if (outAt != null) {
        bits.push(h('span.tday-out', { style: { left: pos(clamp(outAt)) }, title: `Clocked out ${r.last_out}` }));
      }
    }

    // Somebody off with no shift says so where the bar would be. Somebody in
    // with no shift is said by their pill and the violet stretch of clock.
    if (!r.shift && inAt == null) {
      bits.push(h('span.tday-note', { style: { left: '.6rem' } }, statusOf(r).text));
    }
    return h('div.tday-track', bits);
  };

  const rowActions = (r) => {
    if (!needsAttention(r) || !(manages || fixesTimes)) return null;
    const items = [];
    if (manages) {
      if (r.resolution === 'resolved') {
        items.push({ label: 'Put back to the terminal', onClick: () => undo(r) });
        items.push({ label: 'Change what was recorded', onClick: () => resolve(r) });
      } else {
        items.push({ label: r.open ? 'Confirm what happened' : 'Record this day as…', onClick: () => resolve(r) });
      }
    }
    if (fixesTimes) items.push({ label: 'Correct the clock times', onClick: () => correctTimes(r) });
    return dropdownMenu({ label: r.open ? 'Confirm' : 'Change', title: 'Settle this day or correct its times', items });
  };


  const personRow = (r) => {
    const kinds = Object.keys(KINDS).filter((k) => k !== 'all' && KINDS[k](r));
    return h('div.tday-row', {
      'data-kinds': kinds.join(' '),
      'data-staff': String(r.staff.id),
      'data-shift-colour': String(shiftColour(r.shift)),
    },
    h('div.tday-who',
      face(r.staff.name, { size: '2.1rem' }),
      h('a.tday-name', {
        href: `#/att-staff?id=${r.staff.id}&day=${day}`,
        onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: r.staff.id, day }); },
      }, r.staff.name),
      h('small.tday-sub', shiftLine(r)),
      pill(r)),
    track(r),
    h('div.tday-act', rowActions(r)));
  };

  const ticks = [];
  for (let m = axis.from; m <= axis.to; m += axis.step) {
    ticks.push(h('span.tday-tick', { style: { left: pos(m) } }, `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:00`));
  }

  const departments = byDepartment(data.rows);
  const nobody = h('p.tday-nobody', { hidden: true }, 'Nobody to show here.');
  const board = h('section.tday-board', { 'aria-label': 'Everybody on this day' },
    h('div.tday-row.tday-axis', { 'aria-hidden': 'true' },
      h('span.tday-axis-label', 'Person · shift'),
      h('div.tday-track',
        ticks,
        nowShows ? h('span.tday-now-label', { style: { left: pos(nowMin) } }, `Now ${nowClock}`) : null),
      h('div.tday-act')),
    departments.map((group) => h('div.tday-dept', { 'data-dept': group.department },
      h('div.tday-dept-head', h('b', group.department), h('small', sayHowItStands(group))),
      group.rows.map(personRow))),
    nobody,
  );

  function setFilter(k) {
    filter = k;
    for (const b of host.querySelectorAll('[data-show]')) {
      b.setAttribute('aria-pressed', String(b.dataset.show === k));
    }
    let shown = 0;
    for (const dept of board.querySelectorAll('.tday-dept')) {
      let here = 0;
      for (const row of dept.querySelectorAll('.tday-row')) {
        const on = k === 'all' || row.dataset.kinds.split(' ').includes(k);
        row.hidden = !on;
        if (on) here += 1;
      }
      dept.hidden = here === 0;
      shown += here;
    }
    nobody.hidden = shown > 0;
    replaceParams('att-today', { day, show: k === 'all' ? null : k });
  }

  // -------------------------------------------------------------------------
  // Needs you.
  // -------------------------------------------------------------------------

  const needs = [];
  const needed = new Set();
  const need = (tone, title, detail, actions, row = null) => {
    const real = actions.filter(Boolean);
    if (row && real.length) needed.add(String(row.staff.id));
    needs.push(h('div.tday-need', { class: `is-${tone}${needs.length >= FOLD_AFTER ? ' is-extra' : ''}` },
      h('div', h('b', title), detail ? h('small', detail) : null),
      real.length ? h('div.tday-need-act', real) : null));
  };
  const theirDay = (r, forDay = day) => linkTo('Open their day', 'att-staff', { id: r.staff.id, day: forDay },
    { quiet: manages || fixesTimes });

  const ago = (fromMin) => {
    if (nowMin == null || fromMin == null || nowMin <= fromMin) return null;
    const mins = nowMin - fromMin;
    return mins < 60 ? `${mins} min ago` : `${lateBy(Math.floor(mins / 60) * 60)} ago`;
  };

  const forgotten = (r, forDay, when) => {
    need('bad',
      `${r.staff.name} did not clock out${when}`,
      `${shiftLine(r)}. In at ${r.first_in}.`,
      [
        fixesTimes && r.shift ? press(`Out at ${r.shift.ends_at}`, outAtShiftEnd(r, forDay), { primary: true }) : null,
        fixesTimes ? press('Another time', () => correctTimes(r, forDay)) : null,
        manages && !fixesTimes ? press('Confirm what happened', () => resolve(r, forDay), { primary: true }) : null,
        !fixesTimes && !manages ? theirDay(r, forDay) : null,
      ], forDay === day ? r : null);
  };

  const rank = { absent: 0, missing_in: 1, missing_out: 2 };
  const open = (r) => r.resolution !== 'resolved' && r.resolution !== 'auto';

  for (const r of [...data.rows].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))) {
    if (r.status === 'absent' && open(r)) {
      const when = ago(toMin(r.shift?.starts_at));
      need('bad',
        isToday && shiftRunning(r) ? `${r.staff.name} is not in` : `${r.staff.name} did not come in`,
        [
          r.shift ? `${r.shift.name} started ${r.shift.starts_at}${when ? `, ${when}` : ''}.` : null,
          'No punch and no leave.',
          r.streak > 1 ? `Absent ${r.streak} days running.` : null,
        ].filter(Boolean).join(' '),
        [
          manages ? press('Mark absent', settleAs(r, 'absent', 'marked absent'), { primary: true }) : null,
          fixesTimes ? press('They’re in: fix the time', () => correctTimes(r)) : null,
          theirDay(r),
        ], r);
    } else if (r.status === 'missing_in' && open(r)) {
      need('bad',
        r.held === 'terminal' ? `${r.staff.name}: the terminal was quiet` : `${r.staff.name} has no clock-in`,
        r.held === 'terminal'
          ? `${shiftLine(r)}. Nothing was heard from the terminal when it began.`
          : `${shiftLine(r)}.${r.last_out ? ` Out at ${r.last_out}.` : ''}`,
        [
          fixesTimes ? press('Set the clock-in', () => correctTimes(r), { primary: true }) : null,
          manages ? press('Mark absent', settleAs(r, 'absent', 'marked absent')) : null,
          !fixesTimes && !manages ? theirDay(r) : null,
        ], r);
    } else if (r.status === 'missing_out' && open(r)) {
      forgotten(r, day, '');
    }
  }

  // Last night's forgotten clock-outs, said on this morning's screen.
  for (const r of yesterday?.rows ?? []) {
    if (r.status === 'missing_out' && open(r)) forgotten(r, yesterday.day, ' yesterday');
  }

  for (const r of data.rows) {
    // A missing punch is dealt with first; its lateness follows from the fix.
    if (!open(r) || r.status === 'missing_out' || r.status === 'missing_in') continue;
    if (isLate(r)) {
      need('warn',
        `${r.staff.name} came in ${lateBy(r.late_minutes)} late`,
        [
          `${r.shift.name} from ${r.shift.starts_at}; clocked in ${r.first_in}.`,
          r.weekCount > 1 ? `Late ${r.weekCount} times this week.` : null,
        ].filter(Boolean).join(' '),
        [
          manages ? press('Excuse it', settleAs(r, 'present', 'recorded as present')) : null,
          fixesTimes ? press('Wrong time? Fix it', () => correctTimes(r)) : null,
          !fixesTimes && !manages ? theirDay(r) : null,
        ], r);
    } else if (r.status === 'early_leave' && (r.early_minutes || 0) > 1) {
      need('warn',
        `${r.staff.name} left ${lateBy(r.early_minutes)} early`,
        `${shiftLine(r)}; clocked out ${r.last_out}.`,
        [
          manages ? press('Excuse it', settleAs(r, 'present', 'recorded as present')) : null,
          fixesTimes ? press('Wrong time? Fix it', () => correctTimes(r)) : null,
          !fixesTimes && !manages ? theirDay(r) : null,
        ], r);
    }
  }

  for (const r of data.rows) {
    if (r.status !== 'unscheduled' || r.resolution === 'resolved') continue;
    need('info',
      `${r.staff.name} clocked in with no shift`,
      `In at ${r.first_in}${r.last_out ? `, out at ${r.last_out}` : ''}. Nobody had them on the rota for this day.`,
      [
        can('att_rota') ? linkTo('Put them on the rota', 'att-rota', { from: day }) : null,
        !r.last_out && fixesTimes ? press('Set the clock-out', () => correctTimes(r)) : null,
        manages ? press('Record this day as…', () => resolve(r)) : null,
        !can('att_rota') && !fixesTimes && !manages ? theirDay(r) : null,
      ], r);
  }

  // On a phone, or anywhere the panel sits above the list, the first few and a
  // button for the rest: eleven cards would push everybody off the screen.
  const unfold = needs.length > FOLD_AFTER
    ? h('button.tday-mini.tday-unfold', {
      type: 'button',
      onclick: () => { panel.classList.remove('is-folded'); unfold.remove(); },
    }, `Show all ${needs.length}`)
    : null;
  const panel = h('aside.tday-panel', {
    'aria-label': 'Needs you',
    class: unfold ? 'is-folded' : null,
  },
  h('div.tday-panel-label', `Needs you · ${needs.length}`),
  needs.length
    ? needs
    : h('div.tday-clear', isToday ? 'Nothing needs you right now.' : 'Nothing was left to deal with on this day.'),
  unfold,
  h('p.tday-legend',
    nowShows
      ? 'Dashed bars are the rota; solid is time on the clock. The red line is now.'
      : 'Dashed bars are the rota; solid is time on the clock.'),
  );

  // Whatever is already in Needs you does not need its own button on a phone's
  // list as well.
  for (const row of board.querySelectorAll('.tday-row[data-staff]')) {
    if (needed.has(row.dataset.staff)) row.classList.add('has-need');
  }

  mount(host,
    head,
    nav,
    clocks,
    quiet,
    birthdays,
    questionRows(asks, () => reload()),
    tiles,
    h('div.tday-layout',
      h('div.tday-main', chips, board),
      panel),
  );
  if (filter !== 'all') setFilter(filter);

  return host;
}

/** How many of "Needs you" show before the rest fold away, where it is folded. */
const FOLD_AFTER = 3;

/** 'HH:MM' to minutes past midnight, or null. */
function toMin(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The stretch of the day the timeline covers.
 *
 * Wide enough for every shift start and clock-in on it, and the now line, in
 * whole even hours; never less than eight hours, never past midnight. A shift
 * that runs on into the night stops at the edge and says so with its shape.
 */
function axisFor(rows, nowMin) {
  let lo = 6 * 60;
  let hi = 22 * 60;
  for (const r of rows) {
    const marks = [];
    if (r.shift) {
      const a = toMin(r.shift.starts_at);
      let b = toMin(r.shift.ends_at);
      if (a != null) marks.push(a);
      if (a != null && b != null) {
        if (b <= a) b += 1440;
        marks.push(b);
      }
    }
    const inAt = toMin(r.first_in);
    let outAt = toMin(r.last_out);
    if (inAt != null) marks.push(inAt);
    if (inAt != null && outAt != null && outAt < inAt) outAt += 1440;
    if (outAt != null) marks.push(outAt);
    for (const m of marks) {
      lo = Math.min(lo, m);
      hi = Math.max(hi, m);
    }
  }
  if (nowMin != null) hi = Math.max(hi, nowMin + 30);
  let from = Math.max(0, Math.floor(lo / 120) * 120);
  let to = Math.min(1440, Math.ceil(hi / 120) * 120);
  if (to - from < 480) to = Math.min(1440, from + 480);
  if (to - from < 480) from = Math.max(0, to - 480);
  return { from, to, step: to - from > 12 * 60 ? 120 : 60 };
}

/**
 * A terminal nothing has been heard from, said before anything else on the
 * screen. Every number underneath it was worked out from what it sent.
 */
function terminalBanner(spells) {
  if (!spells?.length) return null;
  return alertList(spells.map((s) => ({
    level: 'high',
    title: `${s.device} has gone quiet`,
    detail: `Nothing has been heard from it since ${s.since.slice(11)} on ${fmtDay(s.since.slice(0, 10))}. `
      + (s.due === 1
        ? 'One person was due to start since then and has no punch. '
        : `${s.due} people were due to start since then and none of them has a punch. `)
      + 'Until it is back, the shifts that began in the silence are held on the to-confirm list '
      + 'rather than marked absent. Check the terminal is on and the machine that polls it is running.',
  })));
}

function clockBanner(warnings) {
  if (!warnings?.length) return null;

  return alertList(warnings.map((w) => ({
    level: Math.abs(w.offsetSeconds) >= 900 ? 'high' : 'warn',
    title: 'The terminal’s clock is wrong',
    detail: `${w.note} Fix it on the terminal: set the time zone to GMT+00:00, leave daylight `
      + 'saving off, and switch time sync to NTP so it corrects itself from now on.',
  })));
}

/**
 * What to pre-select in the dialog.
 *
 * A guess, and a conservative one: a day with an arrival and no departure is
 * almost always somebody who worked and forgot, so "present" is offered. A day
 * with nothing at all is offered nothing; that one needs a person to choose.
 */
function suggestedReason(row) {
  if (row.status === 'missing_out' || row.status === 'missing_in') {
    return row.late_minutes > 5 ? 'late' : 'present';
  }
  return '';
}

const PRINT_FOOTER = 'Clock times come from the attendance terminal. Where a punch was '
  + 'missing, the time shown was supplied by a supervisor and is recorded as such.';
