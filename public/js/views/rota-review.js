import { api } from '../api.js';
import { state } from '../app.js';
import { h, mount, toast } from '../util.js';
import { field, formDialog } from './att-shared.js';

/**
 * The draft rota sent for review: a button for the planner and a strip under
 * the rota's title saying where the shown weeks stand. Both load on their
 * own after the grid, so a slow answer never holds the rota up.
 */

const when = (at) => {
  if (!at) return '';
  const d = new Date(`${String(at).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function rotaReviewParts({ from, to, label, publishButton = null }) {
  const button = h('span.rota-review-btn-wrap');
  const strip = h('div.rota-review');
  let data = null;
  // A planner's Publish stays out of sight until an administrator approves
  // what is shown; the server refuses it anyway. Hidden from the start so it
  // never flashes up while the answer loads.
  const showPublish = (yes) => { if (publishButton) publishButton.style.display = yes ? '' : 'none'; };
  if (state.role !== 'admin') showPublish(false);

  const send = async () => {
    const names = (data?.reviewers ?? []).filter((r) => r.name !== state.name).map((r) => r.name);
    const got = await formDialog({
      title: `Send the rota for ${label} for review`,
      submitLabel: 'Send for review',
      body: h('div',
        h('p', { style: { marginTop: 0 } }, names.length
          ? `It goes to ${names.join(', ')}. They can approve it or send it back with a note, and you are told either way.`
          : 'It goes to the administrators. They can approve it or send it back with a note.'),
        data?.review?.status === 'returned'
          ? h('p.muted', `Sent back by ${data.review.decidedBy}: “${data.review.decisionNote}”`)
          : null,
        field('Anything to say with it', h('textarea', { name: 'note', rows: 3, maxlength: 600, placeholder: 'Two short in the kitchen on Saturday, covering with Kojo' }))),
      onSubmit: async (form) => api.sendRotaForReview({ from, to, note: String(form.get('note') || '').trim() }),
    });
    if (got) {
      toast(`Sent for review to ${got.reviewers.join(', ')}.`, 'good');
      load();
    }
  };

  const decide = async (action) => {
    const r = data.review;
    const got = await formDialog({
      title: action === 'approve' ? `Approve the rota for ${label}` : `Send the rota for ${label} back`,
      submitLabel: action === 'approve' ? 'Approve' : 'Send it back',
      body: field(action === 'approve' ? 'Anything to add (optional)' : 'What needs changing',
        h('textarea', { name: 'note', rows: 3, maxlength: 600, required: action !== 'approve', placeholder: action === 'approve' ? '' : 'Saturday dinner needs a second cook' }),
        `${r.sentBy} is told.`),
      onSubmit: async (form) => api.decideRotaReview(r.id, { action, note: String(form.get('note') || '').trim() }),
    });
    if (got) { toast(action === 'approve' ? 'Approved. They have been told.' : 'Sent back. They have been told.', 'good'); load(); }
  };

  const draw = () => {
    const r = data?.review;
    const d = data?.deadline;
    const gate = data?.publish ?? { needed: false, ok: true, changed: [], waiting: [] };
    showPublish(!gate.needed || gate.ok);
    const changedSince = gate.needed && gate.changed.length > 0;
    const gateLine = !gate.needed || gate.ok ? null
      : changedSince ? h('small.rota-review-gate', 'Changed since it was approved. Send it for review again; Publish appears once it is approved.')
        : h('small.rota-review-gate', 'Publish appears once an administrator approves it.');
    mount(button, h('button.btn-sm.rota-review-btn', {
      type: 'button',
      class: r?.status === 'sent' ? 'is-sent' : r?.status === 'approved' ? 'is-approved' : '',
      title: 'Send these weeks to the administrators to look over before you publish',
      onclick: send,
    }, changedSince ? 'Send for review again' : r?.status === 'sent' ? 'Sent for review ✓' : r?.status === 'approved' ? 'Approved ✓' : 'Send for review'));

    if (r) {
      const tone = changedSince || r.status === 'returned' ? 'is-warn' : r.status === 'approved' ? 'is-good' : 'is-info';
      mount(strip, h('div', { class: `rota-review-strip ${tone}` },
        h('div.rota-review-text',
          r.status === 'sent'
            ? h('strong', `Sent for review by ${r.sentBy}, ${when(r.sentAt)}`)
            : r.status === 'approved'
              ? h('strong', `Approved by ${r.decidedBy}, ${when(r.decidedAt)}.${changedSince ? '' : ' Ready to publish.'}`)
              : h('strong', `Sent back by ${r.decidedBy}, ${when(r.decidedAt)}`),
          r.status === 'sent' && r.reviewers.length ? h('small', `Waiting on ${r.reviewers.join(' or ')}`) : null,
          r.note ? h('small', `${r.sentBy}: “${r.note}”`) : null,
          r.decisionNote ? h('small', `${r.decidedBy}: “${r.decisionNote}”`) : null,
          gateLine),
        r.status === 'sent' && data.canReview
          ? h('div.btn-row',
            h('button.btn-sm', { type: 'button', onclick: () => decide('return') }, 'Send back…'),
            h('button.btn.btn-primary', { type: 'button', onclick: () => decide('approve') }, 'Approve'))
          : null));
    } else if (d) {
      mount(strip, h('div', { class: `rota-review-strip ${d.past ? 'is-warn' : 'is-quiet'}` },
        h('div.rota-review-text',
          h('strong', d.past ? `The draft for this week was due ${d.said}` : `Draft due ${d.said}`),
          h('small', 'Not sent for review yet. Press Send for review when the draft is ready.'),
          gateLine)));
    } else if (gateLine) {
      mount(strip, h('div.rota-review-strip.is-quiet', h('div.rota-review-text', h('strong', 'Not sent for review yet'), gateLine)));
    } else {
      mount(strip);
    }
  };

  async function load() {
    data = await api.rotaReview(from, to).catch(() => null);
    if (!data) { mount(button); mount(strip); return; }
    draw();
  }
  load();
  return { button, strip };
}

/** Settings › Rota & clocking › Draft deadline. */
export async function renderRotaDraftSetup() {
  const host = h('div.late-setup.draft-setup');
  const data = await api.rotaDraftRule().catch((err) => ({ error: err.message }));
  if (data.error) { mount(host, h('p.muted', data.error)); return host; }
  const r = data.rule;
  const edit = Boolean(data.canEdit);
  const dis = !edit;
  const on = h('input', { type: 'checkbox', checked: r.on, disabled: dis });
  const cc = h('input', { type: 'checkbox', checked: r.ccAdmins, disabled: dis });
  const gateBox = h('input', { type: 'checkbox', checked: r.publishNeedsReview !== false, disabled: dis });
  const dueDow = h('select', { disabled: dis }, data.days.map((d, i) => h('option', { value: i, selected: i === r.dueDow }, d)));
  const dueTime = h('input', { type: 'time', value: r.dueTime, disabled: dis });
  const firstDays = h('select', { disabled: dis }, [0, 1, 2, 3, 4, 5, 6].map((n) => h('option', { value: n, selected: n === r.firstDays },
    n === 0 ? 'the same day' : `${n} day${n === 1 ? '' : 's'} before`)));
  const firstTime = h('input', { type: 'time', value: r.firstTime, disabled: dis });
  const lastHours = h('select', { disabled: dis }, [0, 1, 2, 3, 4, 6, 8, 12, 24].map((n) => h('option', { value: n, selected: n === r.lastHours },
    n === 0 ? 'No second reminder' : `${n} hour${n === 1 ? '' : 's'} before`)));
  const weeks = h('select', { disabled: dis }, [1, 2, 3].map((n) => h('option', { value: n, selected: n === r.weeksAhead },
    n === 1 ? 'The next week' : n === 2 ? 'The week after next' : 'Three weeks on')));
  const picks = new Set(r.reviewers.map(Number));
  const reviewers = h('div.draft-reviewers', data.admins.map((a) => h('label.draft-reviewer',
    h('input', { type: 'checkbox', checked: picks.has(Number(a.id)), disabled: dis, onchange: (e) => { if (e.target.checked) picks.add(Number(a.id)); else picks.delete(Number(a.id)); } }),
    h('span', a.name))));

  const save = async () => {
    try {
      await api.saveRotaDraftRule({
        on: on.checked, ccAdmins: cc.checked, publishNeedsReview: gateBox.checked, dueDow: Number(dueDow.value), dueTime: dueTime.value,
        firstDays: Number(firstDays.value), firstTime: firstTime.value, lastHours: Number(lastHours.value),
        weeksAhead: Number(weeks.value), reviewers: [...picks],
      });
      toast('Saved.', 'good');
      mount(host, ...(await renderRotaDraftSetup()).childNodes);
    } catch (err) { toast(err.message, 'bad'); }
  };

  mount(host,
    h('label.late-switch', on, h('span', h('strong', 'Remind the planners every week'),
      h('small.muted', data.planners.length
        ? `Whoever can build the rota: ${data.planners.map((p) => p.name).join(', ')}.`
        : 'Nobody but administrators can build the rota, so the administrators are reminded.'))),
    h('div.draft-grid',
      field('Draft due on', dueDow),
      field('By', dueTime),
      field('For', weeks, 'Counted from the deadline'),
      field('First reminder', firstDays),
      field('At', firstTime),
      field('Second reminder', lastHours, 'Before the deadline')),
    h('p.muted.draft-next', `Next: the rota for ${data.next.week}, due ${data.next.due}. `
      + data.next.steps.map((s) => (s.step === 'first' ? `Reminded ${s.said}` : s.step === 'last' ? `again ${s.said}` : null)).filter(Boolean).join(', ')
      + '. If it has not been sent for review by the deadline, the planners and the administrators are told then. Sending it for review stops the reminders for that week.'),
    h('label.late-switch', cc, h('span', h('strong', 'Copy the administrators'),
      h('small.muted', 'A copy of each reminder to every administrator.'))),
    h('h3.late-setup-h', 'Who reviews the draft'),
    h('p.muted', { style: { margin: '0 0 .4rem' } }, 'When a planner presses Send for review, it goes to the administrators ticked here. With nobody ticked, it goes to every administrator.'),
    reviewers,
    h('label.late-switch', gateBox, h('span', h('strong', 'Planners publish only after approval'),
      h('small.muted', 'A planner who is not an administrator sees Publish only once the shown weeks are approved, '
        + 'and again needs approval for anything changed after. Administrators can always publish.'))),
    edit ? h('div.btn-row', h('button.btn.btn-primary', { type: 'button', onclick: save }, 'Save')) : null,
  );
  return host;
}
