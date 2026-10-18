import { api } from '../api.js';
import { confirmAction, fmtDay, h, mount, toast } from '../util.js';
import { emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { inWeek, sayRange, stripKey, yearStrip } from './year-strip.js';

/**
 * A person's own leave plan for the year.
 *
 * Asked for once, early in the year: the weeks they want off, picked around the
 * busy seasons and the weeks their department is already full. The manager
 * approves the whole year at once.
 */
export async function renderMyLeavePlan() {
  const host = h('div.lp');
  const data = await api.myLeavePlan();
  const reload = async () => mount(host, ...(await renderMyLeavePlan()).childNodes);

  if (!data.round) {
    mount(host, h('div.page-head', h('h1', 'Leave plan')),
      emptyState('No leave plan to send just now',
        'When planning opens for the year, it appears here and you are told by phone and email.'));
    return host;
  }
  if (!data.eligible) {
    mount(host, h('div.page-head', h('h1', `Your ${data.round.year} leave plan`)),
      emptyState('You are not asked for a plan this year',
        'Ask for leave under Requests as usual. Plans are for everybody who has earned a full year of annual leave.'));
    return host;
  }

  const { round, plan, blocks, balance } = data;
  const full = new Set(data.fullDays ?? []);
  const live = blocks.filter((b) => b.status !== 'declined');
  const waiting = blocks.filter((b) => b.status === 'planned');
  const toMove = blocks.filter((b) => b.status === 'move');
  const approvedDays = blocks.filter((b) => b.status === 'approved').reduce((n, b) => n + b.days, 0);
  const plannedTotal = live.reduce((n, b) => n + b.days, 0);
  const available = Math.round((data.left + plannedTotal) * 2) / 2;
  const canEdit = plan.status !== 'reviewed' || toMove.length > 0;

  const add = async () => {
    const reasons = data.reasons?.length ? data.reasons : [{ code: 'annual_leave', label: 'Annual leave' }];
    const from = h('input', { type: 'date', name: 'from', required: true, min: balance.from, max: balance.to });
    const to = h('input', { type: 'date', name: 'to', required: true, min: balance.from, max: balance.to });
    const hint = h('p.lp-hint.muted', 'Monday to Friday uses 5 days and gives you 9 days off with the weekends.');
    const check = () => {
      if (!from.value) return;
      if (!to.value || to.value < from.value) to.value = from.value;
      to.min = from.value;
      const clash = [];
      for (let d = from.value; d <= to.value; d = next(d)) if (full.has(d)) clash.push(d);
      const busy = round.busy.find((b) => b.from <= to.value && b.to >= from.value);
      hint.className = busy || clash.length ? 'lp-hint is-warn' : 'lp-hint muted';
      hint.textContent = busy
        ? `${busy.label || 'Busy season'}: no leave from ${sayRange(busy.from, busy.to)}. Your manager may ask you to move it.`
        : clash.length
          ? `${round.department} is full on ${clash.length === 1 ? fmtDay(clash[0]) : `${clash.length} of those days`}: somebody is already off and ${round.limit} away at once is the limit.`
          : `About ${workdays(from.value, to.value)} days. Weekends and public holidays are not counted.`;
    };
    from.addEventListener('change', check);
    to.addEventListener('change', check);

    const out = await formDialog({
      title: 'Add time off',
      submitLabel: 'Add to my plan',
      body: h('div.ask-sheet',
        h('div.grid.grid-2', field('First day', from), field('Last day', to)),
        hint,
        field('Type of leave', h('select', { name: 'reason' }, reasons.map((r) => h('option', { value: r.code }, r.label)))),
        upcomingFull(data)),
      onSubmit: (form) => api.addPlanBlock({ from: form.get('from'), to: form.get('to'), reason: form.get('reason') }),
    });
    if (out) {
      toast(out.warning || `Added: ${out.days} days.`, out.warning ? 'warn' : 'good');
      await reload();
    }
  };

  const send = async () => {
    try {
      await api.sendLeavePlan();
      toast('Plan sent. Your manager approves the whole year at once.', 'good');
      await reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  const reviewed = plan.status === 'reviewed';
  const sentBefore = plan.status !== 'draft';
  mount(host,
    h('div.page-head',
      h('div',
        h('h1', reviewed ? `Your ${round.year} leave plan, reviewed` : `Your ${round.year} leave plan`),
        h('div.sub', reviewed
          ? `Reviewed by ${plan.reviewedBy || 'your manager'}${plan.reviewedAt ? ` on ${fmtDay(plan.reviewedAt.slice(0, 10))}` : ''}`
          : sentBefore
            ? `Sent${plan.sentAt ? ` on ${fmtDay(plan.sentAt.slice(0, 10))}` : ''}. Waiting for your manager.`
            : `Send it by ${fmtDay(round.dueOn)}. Your manager approves the whole year at once.`))),

    h('section.card.lp-count',
      reviewed
        ? h('div.lp-big', h('strong', String(approvedDays)), h('span', 'days approved'),
          toMove.length ? h('span.lp-big-warn', `${toMove.reduce((n, b) => n + b.days, 0)} days to move`) : null)
        : h('div.lp-big', h('strong', String(plannedTotal)), h('span', `of ${available} days planned`),
          h('span.lp-big-left', `${Math.max(0, data.left)} left`)),
      h('p.muted', balance.carryOver
        ? `${balance.entitlement} for ${round.year}, plus ${balance.carryOver} carried over. Weekends and public holidays are not counted.`
        : `${balance.entitlement} for ${round.year}. Weekends and public holidays are not counted.`)),

    h('section.card',
      h('div.card-head', h('h2', 'The year at a glance'), h('small.muted', 'a week a bar')),
      yearStrip(round.year, (monday) => {
        const mine = live.find((b) => inWeek(monday, b.from, b.to));
        if (mine) return { cls: mine.status === 'approved' ? 'is-ok' : mine.status === 'move' ? 'is-move' : 'is-mine', title: sayRange(mine.from, mine.to) };
        if (round.busy.some((b) => inWeek(monday, b.from, b.to))) return { cls: 'is-busy', title: 'Busy season, no leave' };
        for (let i = 0, d = monday; i < 7; i += 1, d = next(d)) if (full.has(d)) return { cls: 'is-full', title: `${round.department} full` };
        return null;
      }, { label: `Your ${round.year}` }),
      stripKey([['is-mine', 'Your plan'], ['is-ok', 'Approved'], ['is-busy', 'Busy season, no leave'], ['is-full', `${round.department} full`]])),

    h('section.lp-blocks', { 'aria-labelledby': 'lp-off' },
      h('h2', { id: 'lp-off' }, 'Your time off'),
      live.length ? null : h('p.muted', 'Nothing yet. Add the weeks you want off this year.'),
      live.map((b) => blockCard(b, { canEdit, reload }))),

    canEdit ? h('button.btn.lp-add', { type: 'button', onclick: add }, '+ Add time off') : null,

    canEdit && (waiting.length || !sentBefore)
      ? h('button.btn.btn-primary.lp-send', { type: 'button', onclick: send, disabled: !live.length },
        sentBefore ? `Send the changes · ${waiting.reduce((n, b) => n + b.days, 0)} days` : `Send my plan · ${plannedTotal} days`)
      : null,

    reviewed
      ? h('p.muted.lp-after', data.left > 0
        ? `You still have ${data.left} days to plan. You can ask for them, or change approved days, under Requests at any time; your manager decides as usual.`
        : 'Change approved days under Requests at any time; your manager decides as usual.')
      : h('p.muted.lp-after', `Plan at least ${Math.min(round.minDays, available)} days now. The rest can be asked for later in the year as usual.`),
  );
  return host;
}

function blockCard(b, { canEdit, reload }) {
  const type = b.reason === 'unpaid_leave' ? 'Unpaid leave' : 'Annual leave';
  const pill = {
    planned: ['', 'Planned'], approved: ['good', 'Approved'], move: ['warn', 'Asked to move'], declined: ['bad', 'Not approved'],
  }[b.status] ?? ['', b.status];
  const remove = async () => {
    if (!await confirmAction(`Take ${sayRange(b.from, b.to)} out of your plan?`)) return;
    try { await api.removePlanBlock(b.id); await reload(); } catch (err) { toast(err.message, 'bad'); }
  };
  const take = async () => {
    try { await api.takePlanSuggestion(b.id); toast('Dates changed. Sent back to your manager.', 'good'); await reload(); } catch (err) { toast(err.message, 'bad'); }
  };
  return h(`section.card.lp-block.is-${b.status}`,
    h('div.lp-block-head',
      h('div', h('strong', sayRange(b.from, b.to)), h('small.muted', `${b.days} days · ${type}`)),
      h(`span.pill${pill[0] ? `.${pill[0]}` : ''}`, pill[1])),
    b.status === 'approved' ? h('small.muted', 'On the rota now, and taken off your balance.') : null,
    b.status === 'planned' && b.busy ? h('p.lp-warn', `${b.busy} is a busy season. Your manager may ask you to move it.`) : null,
    b.status === 'planned' && !b.busy && b.full ? h('p.lp-warn', 'Your department is full that week. Your manager may ask you to move it.') : null,
    b.note ? h('div.lp-quote', h('small', `${b.decidedBy || 'Your manager'} says`), h('p', b.note)) : null,
    b.status === 'move' || (b.status === 'planned' && canEdit)
      ? h('div.btn-row',
        b.status === 'move' && b.suggestFrom ? h('button.btn.btn-primary', { type: 'button', onclick: take }, `Take ${sayRange(b.suggestFrom, b.suggestTo || b.suggestFrom)}`) : null,
        h('button.btn-sm', { type: 'button', onclick: remove }, b.status === 'move' ? 'Take it out, choose other dates' : 'Remove'))
      : null);
}

/** The weeks ahead the department is already full, so they can pick around them. */
function upcomingFull(data) {
  const days = [...(data.fullDays ?? [])].filter((d) => d >= data.today).sort();
  if (!days.length) return null;
  const ranges = [];
  for (const d of days) {
    const last = ranges[ranges.length - 1];
    if (last && next(last[1]) === d) last[1] = d;
    else ranges.push([d, d]);
  }
  return h('div.lp-full',
    h('strong', `${data.round.department} is already full on`),
    h('span.muted', ranges.slice(0, 6).map(([a, b]) => sayRange(a, b)).join(' · ')
      + (ranges.length > 6 ? ` and ${ranges.length - 6} more` : '')));
}

const next = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Weekdays in a span, for the hint. The server counts against the rota. */
function workdays(from, to) {
  let n = 0;
  for (let d = from; d <= to; d = next(d)) {
    const w = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}
