import { api } from '../api.js';
import { fmtDay, h, toast, todayISO } from '../util.js';
import { face } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * Off sick, absent, or here?
 *
 * The question HIVE asks whoever runs the floor half an hour into a shift
 * nobody clocked in for, and the three answers. Shown as a card on Home and as
 * rows on Today; both answer through the same three sheets.
 */

const HOW = [
  ['called', 'Called'],
  ['message', 'Sent a message'],
  ['colleague', 'Told a colleague'],
  ['none', 'No word'],
];

const WHY = [
  'Forgot to clock in',
  'The terminal was not working',
  'Came in another way',
  'Something else',
];

const firstOf = (name) => String(name ?? '').split(/\s+/)[0] || 'They';
const nextDay = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function chips(name, options, selected) {
  return h('div.ask-chips', { role: 'radiogroup' },
    options.map(([value, label]) => h('label.ask-chip',
      h('input', { type: 'radio', name, value, checked: value === selected }),
      h('span', label))));
}

/** What the question says about the person, under their name. */
function sayWhat(q) {
  const shift = q.shift ? `${q.shift.name} ${q.shift.starts_at}` : 'Shift';
  return q.followUp
    ? `Off sick yesterday. No clock-in today, ${q.late} after the start.`
    : `${shift}. No clock-in, ${q.late} after the start.`;
}

/** Yes, off sick. */
async function sickSheet(q) {
  const first = firstOf(q.staff.name);
  const out = await formDialog({
    title: q.followUp ? `${q.staff.name} is still off sick` : `${q.staff.name} is off sick`,
    submitLabel: 'Log sick leave',
    body: h('div.ask-sheet',
      h('p.muted', [q.staff.department, q.shift ? `${q.shift.name} on ${fmtDay(q.day)}` : fmtDay(q.day)].filter(Boolean).join(' · ')),
      h('fieldset.ask-set',
        h('legend', q.followUp ? 'Until when?' : 'For how long?'),
        chips('span', q.day === todayISO()
          ? [['1', 'Today'], ['2', 'Today and tomorrow'], ['pick', 'Choose days']]
          : [['1', fmtDay(q.day)], ['2', `${fmtDay(q.day)} and the next day`], ['pick', 'Choose days']], '1'),
        field('Last sick day', h('input', { type: 'date', name: 'until', value: q.day, min: q.day, max: nextDay(q.day, 13) }),
          'Only for Choose days')),
      h('fieldset.ask-set',
        h('legend', `How did ${first} let you know? `, h('small.muted', '(if you know)')),
        chips('how', HOW, null)),
      field('Note', h('input', { type: 'text', name: 'note', maxlength: 300, placeholder: 'e.g. Fever since last night' }),
        'Optional, only managers see it'),
      h('div.ask-what',
        h('strong', 'What happens'),
        h('span', `Sick leave for ${first}, so the shift is not counted as absent. ${first} is told by phone and email.`),
        h('span', 'Two days or more needs a medical certificate. HIVE asks for a photo of it.'))),
    onSubmit: (form) => {
      const span = form.get('span');
      const until = span === '2' ? nextDay(q.day, 1) : span === 'pick' ? form.get('until') : q.day;
      return api.answerAbsence(q.id, {
        answer: 'sick', until, how: form.get('how') || null, note: form.get('note') || null,
      });
    },
  });
  if (out) toast(`${q.staff.name}: off sick, logged.${out.note ? ' A certificate is asked for.' : ''}`, 'good');
  return out;
}

/** No, absent. */
async function absentSheet(q) {
  const first = firstOf(q.staff.name);
  const out = await formDialog({
    title: `Mark ${q.staff.name} absent`,
    submitLabel: 'Mark absent',
    body: h('div.ask-sheet',
      h('p.muted', q.shift ? `${q.shift.name} on ${fmtDay(q.day)}` : fmtDay(q.day)),
      h('fieldset.ask-set',
        h('legend', `Did ${first} let anybody know?`),
        chips('how', HOW, 'none')),
      field('Note', h('input', { type: 'text', name: 'note', maxlength: 300 }), 'Optional'),
      h('div.ask-what',
        h('strong', 'What happens'),
        h('span', `The day is settled as absent and ${first} is told. It can be changed later on Today, like any day.`))),
    onSubmit: (form) => api.answerAbsence(q.id, {
      answer: 'absent', how: form.get('how') || null, note: form.get('note') || null,
    }),
  });
  if (out) toast(`${q.staff.name}: marked absent.`, 'good');
  return out;
}

/** Here after all: put the start time right. */
async function hereSheet(q) {
  const first = firstOf(q.staff.name);
  const now = new Date().toTimeString().slice(0, 5);
  const start = q.shift?.starts_at || '';
  const input = h('input.ask-time', { type: 'time', name: 'in', value: start, required: true });
  const quick = (label, value) => h('button.ask-chip-btn', { type: 'button', onclick: () => { input.value = value; } }, label);
  const out = await formDialog({
    title: `${first} is here: when did ${first} start?`,
    submitLabel: 'Save the time',
    body: h('div.ask-sheet',
      h('p.muted', q.shift ? `${q.shift.name} · started at ${start}` : fmtDay(q.day)),
      field('Start time', input),
      h('div.ask-chips',
        start ? quick(`${start} on time`, start) : null,
        quick(`Now, ${now}`, now)),
      field('Why is there no clock-in?', h('select', { name: 'why', required: true },
        WHY.map((w) => h('option', { value: w }, w)))),
      h('div.ask-what',
        h('strong', 'What happens'),
        h('span', `${first} is on the record from that time. The clock-out still comes from the terminal.`),
        h('span', 'The change carries your name and the administrators are told, as with any time you put right.'))),
    onSubmit: (form) => api.answerAbsence(q.id, { answer: 'here', in: form.get('in'), why: form.get('why') }),
  });
  if (out) {
    toast(out.pending
      ? `${q.staff.name}: time sent to an administrator to approve.`
      : `${q.staff.name}: here, time put right.`, 'good');
  }
  return out;
}

/** The three answers, as buttons. */
function answers(q, onDone, { compact = false } = {}) {
  const run = (sheet) => async () => {
    try {
      if (await sheet(q)) await onDone?.();
    } catch (err) {
      toast(err.message, 'bad');
      await onDone?.();
    }
  };
  const first = firstOf(q.staff.name);
  return h(compact ? 'div.ask-buttons.is-row' : 'div.ask-buttons',
    h('button.btn.btn-primary.ask-yes', { type: 'button', onclick: run(sickSheet) },
      q.followUp ? 'Yes, still off sick' : compact ? 'Off sick' : 'Yes, off sick'),
    h('div.ask-pair',
      h('button.btn', { type: 'button', onclick: run(absentSheet) }, compact ? 'Absent' : 'No, absent'),
      h('button.btn', { type: 'button', onclick: run(hereSheet) }, compact ? 'Here: fix the time' : `${first} is here`)));
}

/** A question, as a card for Home. */
export function questionCard(q, onDone) {
  return h('section.card.ask-card', { 'aria-labelledby': `ask-${q.id}` },
    h('div.ask-who',
      face(q.staff.name, { size: '2.75rem' }),
      h('div',
        h('span.ask-eyebrow', q.followUp ? 'Off sick yesterday · not in today' : `Not in · ${q.late}`),
        h('span.muted', [q.staff.department, q.shift ? `${q.shift.name} ${q.shift.starts_at}–${q.shift.ends_at}` : null].filter(Boolean).join(' · ')))),
    h('h2.ask-title', { id: `ask-${q.id}` }, q.followUp ? `Is ${q.staff.name} still off sick?` : `Is ${q.staff.name} off sick?`),
    h('p.muted', sayWhat(q)),
    q.said ? h('div.ask-note', `${firstOf(q.staff.name)} said in HIVE: off sick${q.said.note ? `. ${q.said.note.replace(/^Said in HIVE:?\s*/, '')}` : ''}`) : null,
    q.followUp ? h('div.ask-note', `A second day needs a medical certificate. If you answer yes, HIVE asks ${firstOf(q.staff.name)} to send a photo of it.`) : null,
    answers(q, onDone),
    h('div.ask-foot',
      h('span', `Sick leave this year: ${q.sickThisYear} day${q.sickThisYear === 1 ? '' : 's'}`),
      h('a', { href: `#/att-staff?id=${q.staff.id}&day=${q.day}` }, 'See the record')));
}

/** "Off sick, logged by Kojo Badu", for the settled list. */
export function sayAnswer(q) {
  const by = String(q.answeredBy ?? '').replace(/\s*\([^)]*\)\s*$/, '');
  switch (q.answer) {
    case 'sick': return `off sick · logged by ${by}`;
    case 'absent': return `absent · marked by ${by}`;
    case 'here': return `here from ${q.detail?.in ?? '?'} · time put right by ${by}${q.detail?.pending ? ', waiting on approval' : ''}`;
    case 'came_in': return 'clocked in after all';
    default: return `settled by ${by || 'somebody'}`;
  }
}

/** The settled ones, briefly, under the cards. */
export function settledList(list) {
  if (!list.length) return null;
  return h('section.card.ask-settled',
    h('strong', 'Settled'),
    list.slice(0, 6).map((q) => h('span.muted', `${q.staff.name} · ${sayAnswer(q)}`)));
}

/** The questions as rows, for Today. */
export function questionRows(data, onDone) {
  const open = data?.open ?? [];
  const settled = (data?.settled ?? []).filter((q) => q.day === data.today);
  if (!open.length && !settled.length) return null;
  return h('section.card.ask-rows', { 'aria-labelledby': 'ask-rows' },
    h('div.card-head',
      h('h2', { id: 'ask-rows' }, 'Not in yet · off sick, absent, or here?'),
      h('small.muted', 'Asked 30 minutes after each start')),
    open.map((q) => h('div.ask-row',
      h('div.ask-row-who', face(q.staff.name, { size: '2.25rem' }),
        h('div', h('strong', q.staff.name), h('small.muted', q.staff.department || ''))),
      h('div.ask-row-shift',
        h('span', q.shift ? `${q.shift.name} ${q.shift.starts_at}` : fmtDay(q.day)),
        h('small.ask-late', `${q.late}, no clock-in`)),
      h('span.ask-row-note.muted', q.followUp
        ? 'Off sick yesterday. A second day needs a certificate.'
        : q.said ? `${firstOf(q.staff.name)} said in HIVE: off sick.` : `Nothing from ${firstOf(q.staff.name)} in HIVE.`),
      answers(q, onDone, { compact: true }))),
    settled.map((q) => h('div.ask-row.is-settled',
      h('div.ask-row-who', face(q.staff.name, { size: '2.25rem' }),
        h('div', h('strong', q.staff.name), h('small.muted', q.staff.department || ''))),
      h('div.ask-row-shift', h('span', q.shift ? `${q.shift.name} ${q.shift.starts_at}` : ''), h('small.muted', 'settled')),
      h('span.ask-row-note.muted', sayAnswer(q)))),
    h('p.muted.ask-rule', 'Nobody is marked absent until somebody answers. HIVE keeps asking planners, '
      + 'supervisors and administrators until then.'));
}

// ---------------------------------------------------------------------------
// The person's own side, on My day
// ---------------------------------------------------------------------------

/** You are off sick, the certificate to send, and "I'm off sick today". */
export function mySickCards(data, { reload, shrink }) {
  if (!data) return [];
  const cards = [];
  const first = (name) => String(name ?? '').split(/\s+/)[0];

  if (data.sick && data.sick.to >= data.today) {
    const s = data.sick;
    const range = s.from === s.to ? fmtDay(s.from) : `${fmtDay(s.from)} – ${fmtDay(s.to)}`;
    cards.push(h('section.card.sick-card',
      h('strong', s.status === 'pending' ? 'You said you are off sick' : 'You are off sick'),
      h('small.muted', `${range} · ${s.days} day${s.days === 1 ? '' : 's'}`
        + (s.status === 'pending' ? ' · waiting for your supervisor' : s.loggedBy ? ` · logged by ${s.loggedBy}` : '')),
      h('p', 'Your shifts on those days are covered as sick leave, not counted as absent.'),
      s.loggedBy && s.status !== 'pending' ? h('small.muted', `Not right? Speak to ${first(s.loggedBy)}.`) : null));
  }

  for (const note of data.notes ?? []) {
    const picker = (capture) => {
      const input = h('input', {
        type: 'file', accept: 'image/*,application/pdf', hidden: true,
        ...(capture ? { capture: 'environment' } : {}),
        onchange: async () => {
          const file = input.files?.[0];
          if (!file) return;
          try {
            const shrunk = await shrink(file);
            await api.sendSickNote(note.leaveId, { file: shrunk });
            toast('Certificate sent. Thank you.', 'good');
            await reload();
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      });
      return input;
    };
    const camera = picker(true);
    const chooser = picker(false);
    cards.push(h('section.card.note-card',
      h('span.note-eyebrow', note.late ? `Late · was due ${fmtDay(note.due)}` : `To do · by ${fmtDay(note.due)}`),
      h('h2', 'Send your medical certificate'),
      h('p', `${note.days} days off sick needs one from the clinic or hospital. Without it, these days are unpaid.`),
      h('button.btn.btn-primary.note-photo', { type: 'button', onclick: () => camera.click() }, 'Take a photo of it'),
      h('button.btn', { type: 'button', onclick: () => chooser.click() }, 'Choose a file'),
      camera, chooser));
  }

  if (data.canSay) {
    cards.push(h('section.card.say-sick',
      h('strong', 'Not well enough to come in?'),
      h('p.muted', 'One tap tells your supervisor and the planner straight away, so nobody has to chase you.'),
      h('button.btn', {
        type: 'button',
        onclick: async () => {
          const out = await formDialog({
            title: 'I\'m off sick',
            submitLabel: 'Tell them',
            body: h('div.ask-sheet',
              h('fieldset.ask-set', h('legend', 'For how long?'),
                chips('days', [['1', 'Today'], ['2', 'Today and tomorrow']], '1')),
              field('Anything to add?', h('input', { type: 'text', name: 'note', maxlength: 300, placeholder: 'e.g. Fever since last night' }),
                'Optional'),
              h('div.ask-what', h('span', 'Your supervisor and the planner are told now. Two days or more needs '
                + 'a medical certificate.'))),
            onSubmit: (form) => api.sayOffSick({ days: Number(form.get('days') || 1), note: form.get('note') || null }),
          });
          if (out) {
            toast('Told. Get well soon.', 'good');
            await reload();
          }
        },
      }, 'I\'m off sick today')));
  }
  return cards;
}
