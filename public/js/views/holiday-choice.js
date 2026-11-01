import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { emptyState, face } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * Christmas or New Year.
 *
 * The office asks everybody on the rota (casual staff aside) to choose which
 * holiday they have off, sees who chose what department by department, moves
 * people where it must, and confirms: every choice goes onto the rota as leave
 * and everybody is told. Staff choose on their phone from a card on Requests.
 */

/** "Fri 25 – Sat 26 Dec". */
function sayRange(from, to) {
  const opts = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
  const a = new Date(`${from}T12:00:00Z`).toLocaleDateString('en-GB', opts);
  if (from === to) return a;
  return `${a} – ${new Date(`${to}T12:00:00Z`).toLocaleDateString('en-GB', opts)}`;
}

// ---------------------------------------------------------------------------
// The office
// ---------------------------------------------------------------------------

export async function renderHolidayBoard(params = {}) {
  const host = h('div.hc');
  const [data, plans] = await Promise.all([
    api.holidays(params.id || null),
    // Next year's plans sit at the foot of this page as a card.
    api.leavePlans().catch(() => null),
  ]);
  const reload = async (id = data.round?.id) => {
    if (id) replaceParams('holidays', { id });
    mount(host, ...(await renderHolidayBoard({ id })).childNodes);
  };

  const head = (sub, ...buttons) => h('div.page-head',
    h('div', h('h1', 'Leave'), h('div.sub', sub)),
    h('div.btn-row',
      data.rounds.length > 1
        ? h('select', { 'aria-label': 'Which one', onchange: (e) => reload(Number(e.target.value)) },
          data.rounds.map((r) => h('option', { value: r.id, selected: r.id === data.round?.id }, r.title)))
        : null,
      ...buttons));

  const startNew = h('button.btn.btn-primary', { type: 'button', onclick: () => setUp(null, reload) }, 'Ask staff to choose a holiday');
  if (!data.round) {
    mount(host,
      head('Christmas or New Year'),
      emptyState('Nobody has been asked yet',
        'Offer Christmas and New Year, say how many of each department can have each, and everybody on the rota chooses on their phone.'),
      h('div', { style: { textAlign: 'center', marginBottom: '1rem' } }, startNew),
      plansCard(plans));
    return host;
  }

  const { round, departments, people, problems } = data;
  const underWay = data.rounds.some((r) => r.status !== 'confirmed');
  const optionBy = new Map(round.options.map((o) => [o.id, o]));
  const waiting = people.filter((p) => !p.optionId);
  const live = round.status === 'open';
  const confirmed = round.status === 'confirmed';

  const pick = async (person, optionId) => {
    try {
      await api.holidayPick(round.id, { staffId: person.id, optionId });
      toast(optionId ? `${person.name}: ${optionBy.get(optionId).label}.` : `${person.name} taken off.`, 'good');
      await reload();
    } catch (err) { toast(err.message, 'bad'); }
  };
  const mover = (person, label) => (confirmed ? null : h('select.hc-move', {
    'aria-label': `${label} for ${person.name}`,
    onchange: (e) => e.target.value && pick(person, Number(e.target.value)),
  },
  h('option', { value: '' }, label),
  round.options.filter((o) => o.id !== person.optionId).map((o) => h('option', { value: o.id }, o.label))));

  const remindAll = async () => {
    try {
      const out = await api.remindHolidays(round.id);
      toast(`Reminded ${out.reminded}.`, 'good');
    } catch (err) { toast(err.message, 'bad'); }
  };

  const confirmAll = async () => {
    const given = round.unanswered === 'room' && waiting.length
      ? `${waiting.length} ${waiting.length === 1 ? 'person has' : 'people have'} not answered and will be given whichever has room. `
      : '';
    const done = await formDialog({
      title: `Confirm ${round.title}?`,
      submitLabel: 'Confirm and put on the rota',
      body: h('div',
        h('p', `${given}Every choice goes onto the rota as a day off, and everybody is told by phone and email.`),
        h('p.muted', round.chargeLeave
          ? 'A day that is not a public holiday comes off their annual leave.'
          : 'Nothing comes off anybody\'s annual leave.'),
        h('p.muted', 'This cannot be undone here; a change afterwards is a change to that person\'s leave.')),
      onSubmit: () => api.confirmHolidays(round.id),
    });
    if (!done) return;
    toast(`Confirmed. ${done.written} on the rota${done.skipped?.length ? `; ${done.skipped.length} already had leave on those days` : ''}.`, 'good');
    await reload();
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${round.title}? Everything chosen so far goes with it.`)) return;
    try {
      await api.removeHolidays(round.id);
      toast('Removed.');
      mount(host, ...(await renderHolidayBoard({})).childNodes);
    } catch (err) { toast(err.message, 'bad'); }
  };

  const status = confirmed
    ? `${round.title} · confirmed${round.confirmedAt ? ` on ${fmtDay(round.confirmedAt.slice(0, 10))}` : ''}`
    : live
      ? `${round.title} · answers by ${fmtDay(round.dueOn)} · ${round.mode === 'first' ? 'first come, first served' : 'you decide where it is over'}`
      : `${round.title} · saved, nobody asked yet`;

  const answered = people.length - waiting.length;
  const done = people.length ? Math.round((answered / people.length) * 100) : 0;
  const hues = ['var(--c5)', 'var(--c1)', 'var(--c2)', 'var(--c4)', 'var(--c3)', 'var(--c6)'];

  // Every choice a department has filled, said once at the top rather than
  // found by reading every card.
  const full = [];
  for (const d of departments) {
    for (const o of round.options) {
      const c = d.options.find((x) => x.id === o.id);
      if (c && c.places != null && c.taken >= c.places && c.places > 0) full.push({ dept: d.name, option: o.label, ...c });
    }
  }
  const fullNote = full.length && !confirmed
    ? h('div.lv-warn', full.length === 1
      ? [h('strong', `${full[0].dept} ${full[0].option} is ${full[0].taken > full[0].places ? 'over' : 'full'}`),
        ` (${full[0].taken} of ${full[0].places}). ${round.mode === 'first'
          ? `Anybody else in ${full[0].dept} sees it as full and picks another.`
          : 'You decide who has it before it is confirmed.'}`]
      : [h('strong', `${full.length} choices are full`), `: ${full.map((f) => `${f.dept} ${f.option} (${f.taken} of ${f.places})`).join(', ')}.`])
    : null;

  const chip = (p) => h('div.lv-chip',
    face(p.name, { size: '1.35rem' }),
    h('span.lv-chip-name', { title: p.name }, shortName(p.name, people), p.byOffice ? h('small', ' · by the office') : null),
    mover(p, 'Move'));

  mount(host,
    head(status,
      !confirmed ? h('button.btn-sm', { type: 'button', onclick: () => setUp(round, reload) }, 'Settings') : null,
      !confirmed ? h('button.btn-sm', { type: 'button', onclick: remove }, 'Remove') : null,
      confirmed && !underWay ? startNew : null,
      live && waiting.length ? h('button.btn', { type: 'button', onclick: remindAll }, `Remind the ${waiting.length}`) : null,
      live ? h('button.btn.btn-primary', { type: 'button', onclick: confirmAll, disabled: problems.length > 0 }, 'Confirm and put on the rota') : null,
      round.status === 'draft' ? h('button.btn.btn-primary', { type: 'button', onclick: () => setUp(round, reload, { open: true }) }, 'Ask everybody now') : null),

    h(`div.lv-hc-top${problems.length || fullNote ? '' : '.is-single'}`,
      h('section.card.lv-hc-hero',
        h('div.lv-ring', { style: { '--done': `${done}%` }, role: 'img', 'aria-label': `${answered} of ${people.length} ${confirmed ? 'on the rota' : 'answered'}` },
          h('b', `${answered}/${people.length}`)),
        h('div.lv-hc-title',
          h('strong', round.title),
          h('span', confirmed
            ? `Confirmed and on the rota.${round.chargeLeave ? ' Days that are not public holidays came off annual leave.' : ''}`
            : `${live ? `Answers by ${fmtDay(round.dueOn)}` : 'Nobody asked yet'} · ${round.mode === 'first' ? 'first come, first served' : 'you decide where it is over'}`
              + `${round.chargeLeave ? ' · days that are not public holidays come off annual leave' : ''}`)),
        h('div.lv-hc-counts',
          round.options.map((o, i) => h('div',
            h('b', { style: { color: hues[i % hues.length] } }, String(people.filter((p) => p.optionId === o.id).length)),
            h('small', o.label))),
          confirmed ? null : h(`div${waiting.length ? '.is-waiting' : ''}`, h('b', String(waiting.length)), h('small', 'not answered')))),
      problems.length || fullNote
        ? h('div.lv-hc-notes',
          problems.length
            ? h('div.alert.warn', h('span.alert-icon', '⚠️'),
              h('div', h('div.alert-title', 'Before it can be confirmed'), h('div.alert-detail', problems.join(' '))))
            : null,
          fullNote)
        : null),

    h('div.lv-hc-depts', departments.map((d) => {
      const inDept = people.filter((p) => p.department === d.name);
      const notYet = inDept.filter((p) => !p.optionId);
      return h('section.card.lv-hc-dept',
        h('div.card-head', h('h2', d.name), h('span.card-note', `${d.people} on the rota`)),
        h('div.lv-hc-cols', { style: { '--cols': String(Math.min(round.options.length, 3)) } }, round.options.map((o) => {
          const counts = d.options.find((x) => x.id === o.id) ?? { taken: 0, places: null };
          const chose = inDept.filter((p) => p.optionId === o.id);
          const isFull = counts.places != null && counts.taken >= counts.places;
          const over = counts.places != null && counts.taken > counts.places;
          const fill = counts.places ? Math.min(100, (counts.taken / counts.places) * 100) : counts.places === 0 ? 100 : 0;
          return h(`div.lv-hc-col${over ? '.is-over' : isFull ? '.is-full' : ''}`,
            h('div.lv-hc-col-head',
              h('span', `${o.label} off`),
              h('span', counts.places == null
                ? `${counts.taken}, no limit`
                : counts.places === 0 && !counts.taken
                  ? 'none allowed'
                  : `${counts.taken} of ${counts.places}${over ? ' · over' : isFull ? ' · full' : ''}`)),
            counts.places == null || (counts.places === 0 && !counts.taken) ? null : h('div.lv-hc-cap', h('i', { style: { width: `${fill}%` } })),
            chose.length
              ? h('div.lv-hc-chips', chose.map(chip))
              : h('p.lv-hc-empty', 'Nobody yet.'));
        })),
        notYet.length
          ? h('div.lv-hc-waiting',
            h('span.lv-hc-waiting-label', `Not answered · ${notYet.length}`),
            notYet.map((p) => h('span.lv-wait-chip', h('span', { title: p.name }, shortName(p.name, people)), mover(p, 'Choose'))))
          : null);
    })),

    h('p.muted.hc-note', confirmed
      ? 'Each choice is on the rota as "Holiday chosen". A change now is a change to that person\'s leave, under Leave › Booked.'
      : `Confirming tells everybody, marks the days they have off on the rota, and leaves the days they work for you to put shifts on. ${round.unanswered === 'room' ? 'Anybody not answered by then is given whichever has room.' : 'Anybody not answered has to be chosen for first.'}`),
    plansCard(plans),
  );
  return host;
}

/**
 * A first name, or a first name and an initial where two people share it.
 * A chip has room for a word, and "Ama" is only enough when there is one Ama.
 */
function shortName(name, everybody) {
  const [first, ...rest] = String(name || '').split(/\s+/);
  const twin = everybody.some((p) => p.name !== name && String(p.name).split(/\s+/)[0] === first);
  return twin && rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
}

/**
 * Next year's leave plans, as a card on Holidays: what state it is in and the
 * way into it. The board itself is under Leave › Plans.
 */
function plansCard(plans) {
  if (!plans) return null;
  const sets = can('att_setup');
  const year = plans.round?.year ?? plans.year;
  if (!plans.round || plans.round.status !== 'open') {
    return h('section.card.lv-plan-card',
      h('strong', `Plans for ${year}`),
      h('span', plans.round
        ? 'Saved, not opened yet. Nobody has been asked.'
        : 'Ask everybody for their leave plan at once, remind them until it is in, and approve the year in one place. Not open yet.'),
      plans.round
        ? h('button.btn', { type: 'button', onclick: () => navigate('leave-plans', { year }) }, 'Open plans')
        : sets ? h('button.btn', { type: 'button', onclick: () => navigate('settings', { section: 'leave', panel: 'planning' }) }, 'Set up planning') : null);
  }
  const c = plans.counts ?? {};
  return h('section.card.lv-plan-card',
    h('strong', `Plans for ${year}`),
    h('span', `${c.sent ?? 0} of ${c.eligible ?? 0} sent · ${c.clashes ?? 0} clash${c.clashes === 1 ? '' : 'es'} to settle · due ${fmtDay(plans.round.dueOn)}`),
    h('button.btn', { type: 'button', onclick: () => navigate('leave-plans', { year }) }, 'Open plans'));
}


/** Set a round up, or change one. */
async function setUp(round, reload, { open = false } = {}) {
  const start = round
    ? { ...round, departments: null }
    : await api.holidaySuggestion();
  const departments = start.departments
    ?? (await api.holidaySuggestion().catch(() => ({ departments: [] }))).departments;
  const options = start.options.map((o) => ({ ...o, limits: { ...o.limits } }));
  const isNew = !round;
  const isOpen = round?.status === 'open';

  const title = h('input', { type: 'text', name: 'title', value: start.title, maxlength: 120, required: true });
  const due = h('input', { type: 'date', name: 'dueOn', value: start.dueOn, required: true });
  const firstCome = h('input', { type: 'radio', name: 'mode', value: 'first', checked: start.mode !== 'decide' });
  const decide = h('input', { type: 'radio', name: 'mode', value: 'decide', checked: start.mode === 'decide' });
  const unanswered = h('select', { name: 'unanswered' },
    h('option', { value: 'room', selected: start.unanswered !== 'office' }, 'Gets whichever has room'),
    h('option', { value: 'office', selected: start.unanswered === 'office' }, 'I choose for them'));
  const remind = h('input', { type: 'checkbox', checked: start.remind !== false });
  const charge = h('input', { type: 'checkbox', checked: start.chargeLeave !== false });
  const askNow = h('input', { type: 'checkbox', checked: isNew || open });

  const choicesHost = h('div.hc-choices');
  const limitsHost = h('div.hc-limits');
  const drawLimits = () => mount(limitsHost,
    h('div.table-wrap', h('table.hc-limit-table',
      h('thead', h('tr', h('th', 'Department'), h('th', 'On the rota'), options.map((o) => h('th', o.label || 'Choice')))),
      h('tbody', departments.map((d) => h('tr',
        h('td', d.name),
        h('td', String(d.people)),
        options.map((o) => h('td', h('input', {
          type: 'number', min: 0, max: 500, value: o.limits[d.name] ?? '',
          'aria-label': `${o.label || 'Choice'}, ${d.name}`,
          oninput: (e) => { o.limits[d.name] = e.target.value === '' ? '' : Number(e.target.value); },
        })))))))));
  const drawChoices = () => {
    mount(choicesHost, options.map((o, i) => h('div.hc-choice',
      field('Name', h('input', { type: 'text', value: o.label, maxlength: 60, oninput: (e) => { o.label = e.target.value; }, onchange: drawLimits })),
      field('First day off', h('input', { type: 'date', value: o.from, onchange: (e) => { o.from = e.target.value; } })),
      field('Last day off', h('input', { type: 'date', value: o.to, onchange: (e) => { o.to = e.target.value; } })),
      options.length > 2
        ? h('button.btn-sm', { type: 'button', 'aria-label': `Remove ${o.label}`, onclick: () => { options.splice(i, 1); drawChoices(); drawLimits(); } }, '✕')
        : h('span'))));
  };
  drawChoices();
  drawLimits();

  const done = await formDialog({
    title: isNew ? 'Ask staff to choose a holiday' : `Settings: ${round.title}`,
    wide: 'xl',
    submitLabel: isNew || round.status === 'draft' ? 'Save' : 'Save changes',
    body: h('div.hc-setup',
      field('What staff see it called', title),
      h('h3', 'The choices'),
      choicesHost,
      h('div.btn-row',
        options.length < 6 ? h('button.btn-sm', {
          type: 'button',
          onclick: () => { options.push({ label: '', from: '', to: '', limits: {} }); drawChoices(); drawLimits(); },
        }, '+ Add a choice') : null,
        h('span.muted', 'Each person gets one choice off and works the others.')),
      h('h3', 'How many can have each'),
      limitsHost,
      h('p.muted', 'Filled in as half of each department; change any, or leave one empty for no limit. Casual staff are left out. Staff see how many places are left in their department, never who else chose what.'),
      h('h3', 'When a choice fills up'),
      h('label.check', firstCome, ' First come, first served. Once it is full, staff see it as full and pick the other.'),
      h('label.check', decide, ' Let everybody say what they want, and I decide where it is over.'),
      h('div.grid.grid-2',
        field('Answers by', due),
        field('Anybody who has not answered by then', unanswered)),
      h('label.check', remind, ' Remind anybody who has not answered every Monday, and each of the last three days'),
      h('label.check', charge, ' Days that are not public holidays come off annual leave'),
      isOpen ? null : h('label.check.hc-ask', askNow, ' Ask everybody now, by phone and email')),
    onSubmit: (form) => api.saveHolidays({
      id: round?.id ?? null,
      title: title.value,
      dueOn: due.value,
      mode: form.get('mode'),
      unanswered: unanswered.value,
      remind: remind.checked,
      chargeLeave: charge.checked,
      options: options.map((o) => ({ id: o.id ?? null, label: o.label, from: o.from, to: o.to, limits: o.limits })),
      open: !isOpen && askNow.checked,
    }),
  });
  if (!done) return;
  toast(done.asked ? `Asked. ${done.asked} people told.` : 'Saved.', 'good');
  await reload(done.id);
}

// ---------------------------------------------------------------------------
// A member of staff
// ---------------------------------------------------------------------------

/** The card on Requests, while there is something to choose or to know. */
export function holidayCard(data) {
  if (!data?.round) return null;
  const { round, options } = data;
  const chosen = options.find((o) => o.id === data.choice);
  const others = options.filter((o) => o.id !== data.choice);
  const said = round.status === 'confirmed' ? ['good', 'Confirmed'] : chosen ? ['warn', 'With the office'] : ['', 'Not answered'];
  return h('section.card.hc-card',
    h('div.card-head', h('h2', round.title), h(`span.pill${said[0] ? `.${said[0]}` : ''}`, said[1])),
    round.status === 'confirmed' && chosen
      ? h('dl.hc-facts',
        h('dt', 'Off'), h('dd', h('strong', `${chosen.label}, ${sayRange(chosen.from, chosen.to)}`)),
        others.length ? h('dt', 'Working') : null,
        others.length ? h('dd', others.map((o) => `${o.label}, ${sayRange(o.from, o.to)}`).join('; ')) : null)
      : h('p.muted', chosen
        ? `You chose ${chosen.label}.${round.open ? ` You can change it until ${fmtDay(round.dueOn)}.` : ''}`
        : `Which would you like off? Answer by ${fmtDay(round.dueOn)}.`),
    round.status === 'confirmed' ? null : h('button.btn.btn-primary', { type: 'button', onclick: () => navigate('my-holiday') },
      chosen ? (round.open ? 'Change my choice' : 'Open') : 'Choose my holiday'));
}

export async function renderMyHoliday() {
  const host = h('div.hc-mine');
  const data = await api.myHoliday();
  const reload = async () => mount(host, ...(await renderMyHoliday()).childNodes);

  if (!data.round) {
    mount(host, h('div.page-head', h('h1', 'Holidays')),
      emptyState(data.asked ? 'Nothing to choose just now' : 'You are not asked this time',
        data.asked
          ? 'When the office asks which holiday you would like off, it appears here and you are told by phone and email.'
          : 'Casual staff are not asked to choose. Speak to the office about the holidays.'));
    return host;
  }

  const { round, options } = data;
  let picked = data.choice;
  const chosen = () => options.find((o) => o.id === picked);
  const send = h('button.btn.btn-primary.hc-send', { type: 'button' }, data.choice ? 'Change my choice' : 'Send my choice');

  const list = h('div.hc-options', options.map((o) => {
    const others = options.filter((x) => x.id !== o.id);
    const input = h('input', {
      type: 'radio', name: 'holiday', value: o.id, checked: o.id === picked,
      disabled: !round.open || (o.full && round.mode === 'first'),
      onchange: () => {
        picked = o.id;
        for (const el of list.querySelectorAll('.hc-option')) el.classList.toggle('on', Number(el.dataset.id) === picked);
        send.disabled = picked === data.choice;
      },
    });
    return h('label.hc-option', { 'data-id': o.id, class: `hc-option${o.id === picked ? ' on' : ''}${o.full ? ' is-full' : ''}` },
      input,
      h('span.hc-option-text',
        h('strong', o.label),
        h('span', `${sayRange(o.from, o.to)} off`),
        others.length ? h('small.muted', `You work ${others.map((x) => sayRange(x.from, x.to)).join(' and ')}`) : null,
        o.left == null ? null
          : o.full ? h('span.pill.bad', `Full in ${data.department}`)
            : h(`span.pill${o.left === 1 ? '.warn' : '.good'}`, `${o.left} ${o.left === 1 ? 'place' : 'places'} left in ${data.department}`)));
  }));

  send.disabled = !picked || picked === data.choice;
  send.addEventListener('click', async () => {
    if (!picked) return;
    send.disabled = true;
    try {
      await api.chooseHoliday(picked);
      toast(`${chosen().label} it is. The office confirms it later.`, 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
      await reload();
    }
  });

  const confirmed = round.status === 'confirmed';
  mount(host,
    h('div.page-head', h('div', h('h1', round.title),
      h('div.sub', confirmed
        ? 'Confirmed, and on your shifts.'
        : round.open
          ? `Which would you like off? You get one and work the other. Answer by ${fmtDay(round.dueOn)}; you can change it until then.`
          : 'The date to answer has passed. Speak to the office if something needs to change.'))),
    confirmed
      ? holidayCard(data)
      : h('div', list,
        h('p.muted.hc-note', round.chargeLeave
          ? 'A day that is not a public holiday comes off your annual leave. Once the office confirms, it is on your shifts.'
          : 'These days do not come off your annual leave. Once the office confirms, they are on your shifts.'),
        round.open ? send : null,
        data.byOffice && data.choice ? h('p.muted', 'The office chose this for you.') : null),
  );
  return host;
}
