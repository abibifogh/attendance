import { api } from '../api.js';
import { fmtSince, h, mount, toast } from '../util.js';
import { emptyState, face } from './components.js';
import { field, formDialog } from './att-shared.js';
import { inboxChanged } from '../app.js';

/**
 * Every decision waiting on whoever is signed in, in one list.
 *
 * Leave, clock times, availability, swaps, advances, medical claims, lunch
 * changes, documents and details used to wait on eight different screens.
 * They are the same act each time, read what was asked and say yes or no, so
 * they are one list, oldest first, with the answer on the row.
 *
 * Each decision goes through the route its own screen uses, as the person
 * deciding, so the checks, balances and messages are exactly those.
 */

const TONE = {
  leave: 'info', leaveDays: 'info', availability: '', times: 'warn', swap: '',
  advance: 'money', medical: 'money', lunch: 'good', document: '', details: '', query: 'warn',
};

/** How many are waiting, for the menu. */
export async function inboxCount() {
  const data = await api.inbox();
  return (data.items ?? []).length;
}

export async function renderInbox(params = {}) {
  const host = h('div');
  let only = params.kind || null;
  let picked = null;
  let data = { items: [], failed: [] };
  // Ticked for approving together. Kept across the filter chips, and cleared
  // of anything that is no longer waiting each time the list comes back.
  const selected = new Set();
  let busy = false;

  const load = async () => {
    data = await api.inbox();
    if (picked && !data.items.some((i) => key(i) === picked)) picked = null;
    const still = new Set(data.items.map(key));
    for (const k of [...selected]) if (!still.has(k)) selected.delete(k);
    paint();
  };

  /** Approve every ticked one, one after another, through its own route. */
  const approveSelected = async () => {
    const items = (data.items ?? []).filter((i) => selected.has(key(i)) && approveOf(i));
    if (!items.length || busy) return;
    busy = true;
    paint();
    let done = 0;
    const failed = [];
    for (const item of items) {
      try {
        // One at a time: each goes through the checks its own screen makes,
        // and a balance or a clash seen by the first is seen by the next.
        await api.inboxDecide({ kind: item.kind, id: item.id, decision: approveOf(item).key, note: '', fields: {} }); // eslint-disable-line no-await-in-loop
        selected.delete(key(item));
        done += 1;
      } catch (err) {
        failed.push(`${item.who || item.title}: ${err.message}`);
      }
    }
    busy = false;
    toast(failed.length
      ? `Approved ${done}. ${failed.length} could not be: ${failed[0]}`
      : `Approved ${done}.`, failed.length ? 'warn' : 'good');
    inboxChanged();
    await load();
  };

  const decide = async (item, decision) => {
    const fields = decision.fields ?? [];
    const noteRequired = decision.note === 'required';
    let answer = { fields: {}, note: '' };

    // Straight from the row when there is nothing more to say. A question
    // first only when the decision has something to fill in.
    if (fields.length || noteRequired) {
      const controls = fields.map(control);
      const note = h('textarea', { name: 'note', rows: 2, maxlength: 500, required: noteRequired });
      const done = await formDialog({
        title: `${decision.label}: ${item.who || item.title}`,
        submitLabel: decision.label,
        body: h('div',
          h('p.muted', { style: { marginTop: 0 } }, item.sub || ''),
          ...controls.map((c) => c.el),
          field(noteRequired ? 'Note (needed)' : 'Note back (optional)', note)),
        onSubmit: async (form) => {
          answer = {
            fields: Object.fromEntries(controls.map((c) => [c.name, c.read(form)])),
            note: String(form.get('note') || ''),
          };
          return true;
        },
      });
      if (!done) return;
    }

    try {
      await api.inboxDecide({
        kind: item.kind, id: item.id, decision: decision.key, note: answer.note, fields: answer.fields,
      });
      toast(saidDone(decision.label), 'good');
      inboxChanged();
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const paint = () => {
    const items = data.items ?? [];
    const kinds = [...new Map(items.map((i) => [i.kind, i.kindLabel])).entries()];
    const shown = only ? items.filter((i) => i.kind === only) : items;
    const chosen = shown.find((i) => key(i) === picked) ?? shown[0] ?? null;
    picked = chosen ? key(chosen) : null;
    const pickable = shown.filter(approveOf);
    const ticked = items.filter((i) => selected.has(key(i)) && approveOf(i));
    const allOn = pickable.length > 0 && pickable.every((i) => selected.has(key(i)));
    const toggle = (item, on) => {
      if (on) selected.add(key(item)); else selected.delete(key(item));
      paint();
    };

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Inbox'),
          h('div.sub', items.length
            ? `${items.length} waiting on you, oldest first`
            : 'Nothing waiting on you'))),

      kinds.length > 1
        ? h('div.chips', { role: 'group', 'aria-label': 'Show' },
          chip('All', items.length, !only, () => { only = null; paint(); }),
          kinds.map(([k, label]) => chip(label, items.filter((i) => i.kind === k).length, only === k,
            () => { only = k; paint(); })))
        : null,

      (data.failed ?? []).length
        ? h('div.alert.warn', h('div',
          h('strong', 'Some requests could not be loaded'),
          h('div', data.failed.map((f) => f.label).join(', '), '. Open their own screen to see them.')))
        : null,

      pickable.length
        ? h('div.decide-bulk',
          h('label.check',
            h('input', {
              type: 'checkbox',
              checked: allOn,
              onchange: (e) => {
                for (const i of pickable) if (e.target.checked) selected.add(key(i)); else selected.delete(key(i));
                paint();
              },
            }),
            ` Select all ${pickable.length}${only ? '' : ' that can be approved here'}`),
          ticked.length
            ? h('span.decide-bulk-actions',
              h('button.btn-sm', { type: 'button', onclick: () => { selected.clear(); paint(); }, disabled: busy }, 'Clear'),
              h('button.btn.btn-primary', { type: 'button', onclick: approveSelected, disabled: busy },
                busy ? 'Approving…' : `Approve ${ticked.length} selected`))
            : h('small.muted', 'Tick the ones to approve together'))
        : null,

      shown.length
        ? h('div.decide',
          h('div.decide-list', shown.map((item) => row(item, {
            open: key(item) === picked,
            onPick: () => { picked = key(item); paint(); },
            decide,
            ticked: selected.has(key(item)),
            onTick: approveOf(item) ? (on) => toggle(item, on) : null,
          }))),
          chosen ? h('aside.decide-detail.card', detail(chosen, decide)) : null)
        : emptyState('All done', 'Nothing is waiting on you. New requests appear here as they come in.'),
    );
  };

  await load();
  return host;
}

const key = (item) => `${item.kind}:${item.id}`;

/**
 * The approve a request can take straight from a tick: its main answer, with
 * nothing to fill in. Anything that needs a figure or a note is answered on
 * its own.
 */
const approveOf = (item) => (item.decisions ?? [])
  .find((d) => d.primary && !(d.fields ?? []).length && d.note !== 'required') ?? null;

/** "Approve" said back as "Approved.", and so on. */
function saidDone(label) {
  const done = {
    approve: 'Approved', refuse: 'Refused', decline: 'Declined', agree: 'Agreed', accept: 'Accepted',
    'send back': 'Sent back', 'refuse all': 'Refused',
  }[String(label).toLowerCase()];
  return `${done ?? 'Done'}.`;
}

function chip(label, count, on, onclick) {
  return h('button.chip', { type: 'button', class: on ? 'chip on' : 'chip', 'aria-pressed': String(on), onclick },
    label, h('small', String(count)));
}

/** One request, with its answer on the row where there is nothing to fill in. */
function row(item, { open, onPick, decide, ticked = false, onTick = null }) {
  const quick = (item.decisions ?? []).filter((d) => !(d.fields ?? []).length && d.note !== 'required');
  return h('div.decide-item', { class: `decide-item${open ? ' open' : ''}${ticked ? ' ticked' : ''}` },
    onTick
      ? h('label.decide-tick', { title: 'Select to approve together' },
        h('input', {
          type: 'checkbox', checked: ticked, 'aria-label': `Select ${item.who || item.title}`,
          onchange: (e) => onTick(e.target.checked),
        }))
      : h('span.decide-tick'),
    h('button.decide-pick', { type: 'button', onclick: onPick, 'aria-expanded': String(open) },
      face(item.who || item.title, { size: '2.3rem' }),
      h('span.decide-text',
        h('span.decide-who', h('strong', item.who || item.title),
          h(`span.pill${TONE[item.kind] ? `.${TONE[item.kind]}` : ''}`, item.kindLabel),
          item.tag ? h('span.pill.bad', item.tag) : null),
        h('span', item.sub || item.title),
        item.askedAt ? h('small.muted', fmtSince(item.askedAt)) : null)),
    h('div.decide-actions',
      !(item.decisions ?? []).length && item.link
        ? h('a.btn-sm.btn-primary', { href: item.link }, 'Open')
        : null,
      (item.decisions ?? []).map((d) => h('button.btn-sm', {
        type: 'button',
        class: d.primary ? 'btn-sm btn-primary' : 'btn-sm',
        onclick: () => decide(item, d),
      }, quick.includes(d) ? d.label : `${d.label}…`))),
    // On a phone the detail opens under the row it belongs to.
    open ? h('div.decide-inline', detail(item, decide, { inline: true })) : null,
  );
}

/** Everything about one request, and its answers. */
function detail(item, decide, { inline = false } = {}) {
  return h('div.decide-detail-body',
    inline ? null : h('div.decide-detail-head',
      face(item.who || item.title, { size: '2.8rem' }),
      h('div', h('strong', item.who || item.title), h('div.muted', item.kindLabel))),
    (item.warnings ?? []).map((w) => h('div.alert.warn', h('div', w))),
    (item.details ?? []).length
      ? h('dl.decide-facts', item.details.flatMap(([k, v]) => [h('dt', k), h('dd', String(v))]))
      : null,
    inline ? null : h('div.btn-row',
      (item.decisions ?? []).map((d) => h('button.btn', {
        type: 'button',
        class: d.primary ? 'btn btn-primary' : 'btn',
        onclick: () => decide(item, d),
      }, d.label))),
    item.link ? h('a.decide-open', { href: item.link }, 'Open on its own screen') : null,
  );
}

/** A field a decision asks for, and how to read it back. */
function control(f) {
  const name = f.name;
  if (f.type === 'select') {
    const el = h('select', { name },
      (f.options ?? []).map(([value, label]) => h('option', { value, selected: String(value) === String(f.value) }, label)));
    return { name, el: field(f.label, el), read: (form) => form.get(name) };
  }
  if (f.type === 'checks') {
    const picked = new Set((Array.isArray(f.value) ? f.value : []).map(String));
    const boxes = (f.options ?? []).map(([value, label]) => h('label.check',
      h('input', { type: 'checkbox', name, value: String(value), checked: picked.has(String(value)) }), ' ', label));
    return {
      name,
      el: h('fieldset.field', h('legend', f.label), ...boxes),
      read: (form) => form.getAll(name),
    };
  }
  const type = ['number', 'date', 'time'].includes(f.type) ? f.type : 'text';
  const el = h('input', {
    name, type, value: f.value ?? '',
    ...(f.min != null ? { min: f.min } : {}), ...(f.max != null ? { max: f.max } : {}),
    ...(f.step != null ? { step: f.step } : {}),
  });
  return {
    name,
    el: field(f.label, el),
    read: (form) => (type === 'number' ? Number(form.get(name)) : form.get(name)),
  };
}
