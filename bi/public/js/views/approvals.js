import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * Approvals: everything waiting for an admin, in every system, in one list.
 *
 * Each item says what it is and offers the choices its own system gives, with
 * whatever those choices take (days charged, an amount, which changes to
 * accept). Pressing one does it in that system, as you: HIVE records
 * "Michael Test via Insight" and tells whoever asked, exactly as if you had
 * pressed it in HIVE. Done, it leaves the list.
 */

const SHORT = { insight: 'Insight', hive: 'HIVE', pos: 'POS', maintenance: 'Maint', tasks: 'Tasks' };
const state = { system: 'all', open: null, data: null, said: null };

/** The count on the menu bar's button: read in the background, and after each decision. */
export async function approvalsCount() {
  const data = await api('/approvals');
  state.data = data;
  return data.count;
}

const ageOf = (at) => {
  if (!at) return '';
  const d = new Date(`${String(at).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(at) ? '' : 'Z'}`);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days <= 0 ? 'today' : `${days} d`;
};
const whenOf = (at) => {
  if (!at) return '';
  const d = new Date(`${String(at).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(at) ? '' : 'Z'}`);
  return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
};
const sysTag = (id, label) => h(`span.ap-sys.${id}`, SHORT[id] || label || id);
/** Where to see it in its own system: a new tab for the others, Shifts › Inbox for Insight's. */
const openLink = (x, spec = 'a') => (!x.open ? null : x.system === 'insight'
  ? h(spec, { href: x.open, onclick: () => { try { sessionStorage.setItem('insight-shifts-section', 'inbox'); } catch { /* private mode */ } } }, 'Open in Shifts › Inbox')
  : h(spec, { href: x.open, target: '_blank', rel: 'noopener' }, `Open in ${x.systemLabel} ↗`));

export async function renderApprovals(root) {
  const view = h('div.ap');
  mount(root, h('section.card.ap-head',
    h('h1', '✓ Approvals'),
    h('p.small.muted', 'Everything waiting for your decision, in every system. A decision is made there, as you, and that system tells whoever asked.')),
  view);
  mount(view, h('p.muted', 'Asking each system what is waiting…'));
  await read();

  async function read() {
    try {
      state.data = await api('/approvals');
    } catch (err) {
      mount(view, banner('problem', err.message));
      return;
    }
    tellCount();
    paint();
  }

  function tellCount() {
    window.dispatchEvent(new CustomEvent('approvals:count', { detail: state.data?.count ?? 0 }));
  }

  function paint() {
    const { systems, items } = state.data;
    const shown = items.filter((x) => state.system === 'all' || x.system === state.system);
    let at = shown.findIndex((x) => `${x.system}:${x.kind}:${x.id}` === state.open);
    if (at < 0) at = 0;
    const current = shown[at] || null;
    state.open = current ? `${current.system}:${current.kind}:${current.id}` : null;
    const down = systems.filter((s) => !s.ok);
    const partly = systems.flatMap((s) => (s.partly || []).map((p) => `${s.label} could not read its ${p.label.toLowerCase()}s: ${p.error}`));
    const open = (i) => { state.open = `${shown[i].system}:${shown[i].kind}:${shown[i].id}`; state.said = null; paint(); if (window.matchMedia('(max-width: 760px)').matches) view.querySelector('.ib-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

    mount(view,
      h('div.ib-bar',
        h('div.td-pills', { role: 'group', 'aria-label': 'Systems' },
          h('button', { type: 'button', 'aria-pressed': String(state.system === 'all'), onclick: () => { state.system = 'all'; state.open = null; paint(); } }, `All · ${items.length}`),
          systems.map((s) => h('button', {
            type: 'button', 'aria-pressed': String(state.system === s.id), title: s.ok ? '' : s.error,
            onclick: () => { state.system = s.id; state.open = null; paint(); },
          }, s.ok ? `${s.label} · ${s.count}` : `${s.label} · ⚠`))),
        h('div.ib-refresh', h('button.btn', { type: 'button', onclick: async (e) => { e.target.disabled = true; state.said = null; await read(); } }, '↻ Refresh'))),
      down.map((s) => banner('warning', h('b', `${s.label} could not be reached`), ` — ${s.error} Its approvals are not in the list this time; nothing was changed there. `,
        h('button.sh-link', { type: 'button', onclick: () => read() }, 'Try again'))),
      partly.length ? banner('warning', partly.join(' ')) : null,
      state.said ? state.said : null,
      shown.length ? h('div.ib-split',
        h('div.card.ib-list', { role: 'listbox', 'aria-label': 'Waiting for a decision' },
          shown.map((x, i) => h(`div.ib-row.ap-row${i === at ? '.on' : ''}`, {
            role: 'option', tabindex: '0', 'aria-current': String(i === at), 'aria-selected': String(i === at),
            onclick: () => open(i),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i); } },
          },
          sysTag(x.system, x.systemLabel),
          h('span.ib-t', h('b', x.title), h('small', x.sub || x.kindLabel || '')),
          h('span.ib-r', x.amount ? h('b.num', money(x.amount)) : null, h('small.muted', ageOf(x.askedAt)))))),
        h('div.ib-detail',
          h('div.ib-step',
            h('span.small', `${at + 1} of ${shown.length}`),
            h('button.btn', { type: 'button', disabled: at <= 0, onclick: () => open(at - 1) }, '‹ Previous'),
            h('button.btn', { type: 'button', disabled: at >= shown.length - 1, onclick: () => open(at + 1) }, 'Next ›')),
          current ? detail(current) : null))
        : h('section.card', h('p', state.system === 'all' ? '✓ Nothing waiting for you anywhere.' : '✓ Nothing waiting here.')));
  }

  /** One item in full: what it is, the facts, and its own choices. */
  function detail(x) {
    const values = {};
    const said = h('p.small.ap-said', { role: 'status' });
    const needs = x.decisions.filter((d) => d.note === 'required').map((d) => d.label.toLowerCase());
    const anyNote = x.decisions.some((d) => d.note !== 'none');
    const note = anyNote ? h('input', {
      type: 'text', maxlength: '500',
      placeholder: needs.length ? `Note${x.who ? ` to ${x.who.split(' ')[0]}` : ''} (needed to ${needs.join(' or ')})` : 'Note (optional)',
    }) : null;
    // The first decision's fields are shown: they are what approving takes.
    const fielded = x.decisions.find((d) => d.fields?.length);
    const inputs = (fielded?.fields || []).map((f) => field(f, values));
    const buttons = x.decisions.map((d) => h(`button.btn${d.primary ? '.primary' : ''}`, {
      type: 'button', title: d.hint || '',
      onclick: async (e) => {
        if (d.note === 'required' && !note?.value.trim()) { said.textContent = `Say why, to ${d.label.toLowerCase()}.`; note?.focus(); return; }
        for (const b of buttons) b.disabled = true;
        said.className = 'small ap-said';
        said.textContent = `${d.label}…`;
        try {
          const body = {
            system: x.system, kind: x.kind, id: x.id, decision: d.key, note: note?.value.trim() || undefined,
            fields: d === fielded ? Object.fromEntries(Object.entries(values).map(([k, get]) => [k, get()])) : {},
          };
          const out = await api('/approvals/decide', { method: 'POST', body });
          state.data.items = state.data.items.filter((o) => o !== x);
          state.data.count = state.data.items.length;
          const sys = state.data.systems.find((s) => s.id === x.system);
          if (sys) sys.count = Math.max(0, sys.count - 1);
          state.open = null;
          state.said = h('div.banner.good.ap-done', `✓ Done in ${x.systemLabel}${out.as ? `, as ${out.as}` : ''}: “${d.label}” on ${x.title}. `, openLink(x));
          tellCount();
          paint();
          e.target.blur();
        } catch (err) {
          for (const b of buttons) b.disabled = false;
          said.className = 'small ap-said form-error';
          said.textContent = `${err.message} Nothing was changed.`;
        }
      },
    }, d.label));
    return h('article.card.ap-detail',
      h('div.ap-meta', sysTag(x.system, x.systemLabel), ` · ${x.kindLabel || ''}${x.askedAt ? ` · asked ${whenOf(x.askedAt)}` : ''}`),
      h('h2', x.title, x.amount ? h('span.num', ` · ${money(x.amount)}`) : null),
      x.sub ? h('p.ap-sub', x.sub) : null,
      x.details?.length ? h('dl.ap-facts', x.details.map(([k, v]) => [h('dt', k), h('dd', String(v))])) : null,
      x.warnings?.length ? banner('warning', h('ul.ap-warn', x.warnings.map((w) => h('li', w)))) : null,
      inputs.length ? h('div.ap-fields', inputs) : null,
      note,
      h('div.ap-actions', buttons,
        openLink(x, 'a.small')),
      said,
      x.decisions.find((d) => d.hint) ? h('p.small.muted', x.decisions.filter((d) => d.hint).map((d) => `${d.label}: ${d.hint}`).join(' ')) : null);
  }
}

/** A decision's field, drawn by its type; `values[name]` reads it back. */
function field(f, values) {
  const id = `ap-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
  if (f.type === 'select') {
    const el = h('select', { id }, (f.options || []).map(([v, label]) => h('option', { value: v, selected: String(v) === String(f.value) }, label)));
    values[f.name] = () => el.value;
    return h('label.ap-field', { for: id }, h('span', f.label), el);
  }
  if (f.type === 'check') {
    const el = h('input', { id, type: 'checkbox', checked: Boolean(f.value) });
    values[f.name] = () => el.checked;
    return h('label.ap-check', { for: id }, el, ` ${f.label}`);
  }
  if (f.type === 'checks') {
    const boxes = (f.options || []).map(([v, label]) => ({ v, el: h('input', { type: 'checkbox', checked: (f.value || []).includes(v) }), label }));
    values[f.name] = () => boxes.filter((b) => b.el.checked).map((b) => b.v);
    return h('fieldset.ap-checks', h('legend', f.label), boxes.map((b) => h('label.ap-check', b.el, ` ${b.label}`)));
  }
  const el = h('input', {
    id, type: f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text',
    value: f.value ?? '', ...(f.min != null ? { min: String(f.min) } : {}), ...(f.max != null ? { max: String(f.max) } : {}), ...(f.step != null ? { step: String(f.step) } : {}),
  });
  values[f.name] = () => (f.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value);
  return h('label.ap-field', { for: id }, h('span', f.label), el);
}
