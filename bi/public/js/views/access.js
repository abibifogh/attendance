import { h, mount } from '../util.js';
import { api } from '../api.js';

/**
 * Settings › People & access › Who sees what: one row per person, one column
 * per tab in Insight, each Hidden, See or Do; the places fold. A name opens
 * that person, tab by tab, with the finer things inside each tab as ticks.
 * The other systems sit at the end. Nothing is saved until Save.
 *
 * Admins only. Making or unmaking an admin, and the other systems, are an
 * owner's: for an admin who is not one, those squares do not change.
 * The rules behind it are routes/tabaccess.js.
 */

const WORD = ['–', 'See', 'Do'];
const LEVEL_WORDS = ['Hidden', 'See', 'Do'];
const OWNS = {
  shifts: ['day', 'week', 'month', 'money', 'odoo', 'check', 'proof'],
  inbox: ['answers', 'advances', 'bank', 'moves', 'money_out'],
  closing: ['reports', 'reopen'], cashiers: ['net'], safe: ['envelopes'], npcounters: ['niceplace'], pickups: ['pickups'], upload: ['files'],
};
const OPEN_KEY = 'insight-access-open';
const readOpen = () => { try { return new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY) || 'null') || ['Front desk', 'Buying & stock', 'Reports']); } catch { return new Set(['Front desk', 'Buying & stock', 'Reports']); } };
const keepOpen = (set) => { try { sessionStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* private mode */ } };
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const COLOURS = ['#5b3df5', '#0e9f6e', '#e8a10c', '#2f6bff', '#d6402f', '#3b4256', '#9b4dca', '#0f8fa8'];

export async function renderAccess(root) {
  let data;
  try { data = await api('/access'); } catch (err) { mount(root, h('div.card', h('h2', 'That did not work'), h('p', err.message))); return; }
  const open = readOpen();
  let draft = new Map();
  let chosen = null;
  let query = '';
  let said = null;
  const view = h('div.ax');
  mount(root, view);

  // ------------------------------------------------------------ the model --

  const places = () => {
    const out = [];
    for (const t of data.tabs) {
      let p = out.find((x) => x.name === t.place);
      if (!p) out.push(p = { name: t.place, tabs: [] });
      p.tabs.push(t);
    }
    if (data.systems.length) out.push({ name: 'Other systems', systems: true, tabs: data.systems.map((s) => ({ key: `sys:${s.id}`, label: s.label, max: 1, system: s.id })) });
    return out;
  };
  const original = (id) => data.people.find((p) => p.id === id);
  /** A person as they will be once saved. */
  function now(id) {
    const p = original(id);
    const d = draft.get(id);
    if (!d) return p;
    return { ...p, ...d, tabs: { ...p.tabs, ...d.tabs }, areas: { ...p.areas, ...d.areas }, systems: { ...p.systems, ...d.systems } };
  }
  const isAdmin = (p) => p.role === 'admin';
  const owner = data.me.isOwner;
  function level(p, t) {
    if (t.system) return p.systems?.[t.system] ? 1 : 0;
    return p.tabs[t.key] || 0;
  }
  function canEdit(p, t) {
    if (t.system) return owner && !p.isOwner;
    if (isAdmin(p) || t.max === 'always' || t.max === 'admin') return false;
    return true;
  }
  function startOf(p) {
    if (p.role === 'admin') return { key: 'admin', label: p.isOwner ? 'Owner' : 'Admin' };
    if (p.role === 'none') return { key: 'none', label: 'No Insight access' };
    const same = data.presets.find((s) => s.tabs && data.tabs.every((t) => typeof t.max !== 'number' || (s.tabs[t.key] || 0) === (p.tabs[t.key] || 0))
      && Object.keys(s.areas).every((k) => (s.areas[k] || 0) === (p.areas[k] || 0)));
    if (same && same.key !== 'reports') return { key: same.key, label: same.label };
    if (p.role === 'reports' || (same && same.key === 'reports')) return { key: 'reports', label: 'Reports only' };
    return { key: 'custom', label: 'Custom' };
  }

  function touch(id, fn) {
    const p = now(id);
    const d = { start: 'custom', tabs: { ...p.tabs }, areas: { ...p.areas }, systems: { ...p.systems }, role: p.role === 'none' ? 'supervisor' : p.role };
    fn(d);
    draft.set(id, d);
    said = null;
    paint();
  }
  /** One tab to a level, its areas following the way the server will settle them. */
  function setTab(d, key, to) {
    d.tabs[key] = to;
    if (d.role !== 'admin') d.role = 'supervisor';
    const a = d.areas;
    if (!to) for (const k of OWNS[key] || []) a[k] = 0;
    if (to === 1) for (const t of data.ticks[key] || []) if (t.level === 2 && !t.withSee) a[t.area] = Math.min(a[t.area] || 0, 1);
    if (key === 'safe' && to) a.envelopes = Math.max(a.envelopes || 0, to);
    if (key === 'shifts' && to && !['day', 'week', 'month'].some((k) => a[k])) { a.day = 1; a.week = 1; a.month = 1; }
    if (key === 'shifts' && to === 2 && !a.check && !a.proof) { a.check = 2; a.proof = 2; }
    if (key === 'inbox' && to === 2 && !(data.ticks.inbox || []).some((t) => (a[t.area] || 0) >= 2)) { a.answers = 2; a.advances = 2; }
    if (key === 'closing' && to) { a.reports = 1; if (to === 2) a.reopen = 2; }
    if (key === 'cashiers' && to) a.net = Math.max(a.net || 0, 1);
    if (key === 'npcounters' && to) a.niceplace = Math.max(a.niceplace || 0, to);
    if (key === 'pickups') a.pickups = to;
    if (key === 'upload') a.files = to;
  }
  function cycle(id, t) {
    const p = now(id);
    if (!canEdit(p, t)) return;
    const max = t.max;
    const next = (level(p, t) + 1) % (max + 1);
    if (t.system) { touchSystems(id, t.system, Boolean(next)); return; }
    touch(id, (d) => setTab(d, t.key, next));
  }
  function touchSystems(id, sys, on) {
    const p = now(id);
    const d = draft.get(id) || {};
    draft.set(id, { ...d, systems: { ...(d.systems || p.systems), [sys]: on } });
    said = null;
    paint();
  }
  function startFrom(id, key) {
    const s = data.presets.find((x) => x.key === key);
    const p = now(id);
    if (!s) return;
    if (s.admin) { draft.set(id, { ...(draft.get(id) || {}), start: 'admin', role: 'admin', tabs: Object.fromEntries(data.tabs.map((t) => [t.key, typeof t.max === 'number' ? t.max : 2])) }); }
    else if (s.none) { draft.set(id, { ...(draft.get(id) || {}), start: 'none', role: 'none', tabs: Object.fromEntries(data.tabs.map((t) => [t.key, 0])), areas: Object.fromEntries(Object.keys(p.areas).map((k) => [k, 0])) }); }
    else {
      const keepReports = key === 'reports' ? Object.fromEntries(data.tabs.filter((t) => t.max === 1 && ['Reports', 'Team', 'Buying & stock'].includes(t.place)).map((t) => [t.key, p.tabs[t.key] || 0])) : {};
      draft.set(id, { ...(draft.get(id) || {}), start: 'custom', role: 'supervisor', tabs: { ...s.tabs, ...keepReports }, areas: { ...s.areas } });
    }
    said = null;
    paint();
  }
  const changed = (id, t) => {
    const p = original(id);
    const n = now(id);
    if (t.system) return Boolean(p.systems?.[t.system]) !== Boolean(n.systems?.[t.system]);
    return (p.tabs[t.key] || 0) !== (n.tabs[t.key] || 0);
  };
  const changesOf = (id) => {
    const n = now(id);
    const p = original(id);
    const tabs = places().flatMap((pl) => pl.tabs).filter((t) => changed(id, t)).length;
    const areas = Object.keys(n.areas || {}).filter((k) => (n.areas[k] || 0) !== (p.areas[k] || 0)).length;
    const role = n.role !== p.role ? 1 : 0;
    return tabs + (tabs ? 0 : areas) + (tabs || areas ? 0 : role);
  };

  // ----------------------------------------------------------- painting --

  function cell(p, t) {
    const lv = level(p, t);
    const locked = !canEdit(p, t);
    const word = t.system ? (lv ? 'Yes' : '–') : (t.max === 'admin' && !isAdmin(p) ? '·' : WORD[lv]);
    const tone = t.max === 'admin' && !isAdmin(p) ? 'x' : ['h', 's', 'd'][t.system && lv ? 1 : lv];
    return h(`button.ax-c.${tone}${locked ? '.lock' : ''}${changed(p.id, t) ? '.chg' : ''}`, {
      type: 'button',
      title: `${p.name} · ${t.label}: ${t.system ? (lv ? 'opens it' : 'does not open it') : t.max === 'admin' && !isAdmin(p) ? 'admins only' : LEVEL_WORDS[lv]}${locked ? '' : ' (tap to change)'}`,
      disabled: locked,
      onclick: (e) => { e.stopPropagation(); cycle(p.id, t); },
    }, word);
  }
  function summary(p, pl) {
    const lv = pl.tabs.map((t) => level(p, t));
    const on = lv.filter(Boolean).length;
    const chg = pl.tabs.some((t) => changed(p.id, t));
    return h(`span.ax-sum${chg ? '.chg' : ''}`, h('span.ax-bars', lv.map((v) => h(`i.${['h', 's', 'd'][v]}`))), h('small', `${on} of ${lv.length}`));
  }
  const avatar = (p) => h('span.ax-av', { style: { background: COLOURS[p.id % COLOURS.length] } }, initials(p.name));

  function matrix(people) {
    const pls = places();
    const head1 = h('tr.ax-grp', h('th.ax-who'), pls.map((pl) => h('th.ax-place', {
      colspan: String(open.has(pl.name) ? pl.tabs.length : 1),
      onclick: () => { if (open.has(pl.name)) open.delete(pl.name); else open.add(pl.name); keepOpen(open); paint(); },
    }, pl.name, h('span', open.has(pl.name) ? '▾ fold' : `▸ ${pl.tabs.length} ${pl.systems ? 'systems' : pl.tabs.length === 1 ? 'tab' : 'tabs'}`))));
    const head2 = h('tr.ax-tabs', h('th.ax-who', 'Person · access'), pls.map((pl) => (open.has(pl.name)
      ? pl.tabs.map((t, j) => h(`th.ax-tab${j === 0 ? '.first' : ''}`, h('span', t.label)))
      : h('th.ax-sumh.first', 'all'))));
    const rows = people.map((p) => h(`tr${chosen === p.id ? '.open' : ''}`,
      h('td.ax-who', h('button.ax-nm', { type: 'button', onclick: () => { chosen = chosen === p.id ? null : p.id; paint(); setTimeout(() => view.querySelector('.ax-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30); } },
        avatar(p), h('span', h('b', p.name), h(`span.ax-role.r-${startOf(p).key === 'custom' ? 'custom' : isAdmin(p) ? 'admin' : p.role === 'none' ? 'none' : 'preset'}`, startOf(p).label)))),
      pls.map((pl) => (open.has(pl.name)
        ? pl.tabs.map((t, j) => h(`td${j === 0 ? '.first' : ''}`, cell(p, t)))
        : h('td.first', summary(p, pl))))));
    return h('div.ax-mx', h('table', h('thead', head1, head2), h('tbody', rows)));
  }

  function seg(p, t) {
    if (t.max === 'always') return h('span.ax-chip', 'Always on');
    if (t.max === 'admin') return h('span.ax-chip', isAdmin(p) ? 'Admin' : 'Admins only');
    const lv = level(p, t);
    const edit = canEdit(p, t);
    return h('span.ax-seg', [0, 1, 2].map((k) => h(`button.${['h', 's', 'd'][k]}${k === lv ? '.on' : ''}`, {
      type: 'button',
      disabled: !edit || k > t.max,
      onclick: () => touch(p.id, (d) => setTab(d, t.key, k)),
    }, LEVEL_WORDS[k])));
  }

  function panel(id) {
    const p = now(id);
    const st = startOf(p);
    const pick = h('select', {
      'aria-label': 'Start from',
      onchange: (e) => startFrom(id, e.target.value),
      disabled: p.isOwner,
    },
    st.key === 'custom' ? h('option', { value: 'custom', selected: true }, 'Custom') : null,
    data.presets.filter((s) => owner || (!s.admin) || isAdmin(original(id))).map((s) => h('option', { value: s.key, selected: s.key === st.key, title: s.text }, s.label)));
    const n = changesOf(id);
    const body = h('div.ax-body', places().map((pl) => {
      const on = pl.tabs.filter((t) => level(p, t)).length;
      return h('div.ax-pl',
        h('b', pl.name, h('em', ` ${on} of ${pl.tabs.length}`)),
        pl.tabs.map((t) => {
          const ticks = !t.system && level(p, t) && !isAdmin(p) ? data.ticks[t.key] || [] : [];
          return [
            h('div.ax-row', h('span', t.label, changed(id, t) ? h('span.ax-chip.warn', ' changed') : null),
              t.system ? h('label.ax-sys', h('input', { type: 'checkbox', checked: level(p, t) === 1, disabled: !canEdit(p, t), onchange: (e) => touchSystems(id, t.system, e.target.checked) }), level(p, t) ? 'Opens it' : 'No') : seg(p, t)),
            ticks.length ? h('div.ax-inside', ticks.map((k) => {
              const ok = (p.areas[k.area] || 0) >= k.level;
              const off = k.withSee ? level(p, t) === 2 : k.level === 2 && level(p, t) < 2;
              return h(`button.ax-tk${ok ? '.on' : ''}`, {
                type: 'button', disabled: off,
                title: off ? (k.withSee ? 'On Do they have the whole safe already' : 'Put the tab on Do to allow this') : '',
                onclick: () => touch(id, (d) => { d.areas[k.area] = ok ? 0 : k.level; }),
              }, k.label);
            })) : null,
          ];
        }));
    }));
    return h('section.card.ax-panel',
      h('div.ax-ph', avatar(p), h('div', h('h2', p.name), h('small.muted', p.email)), h('span.sp'),
        h('button.btn', { type: 'button', onclick: () => { chosen = null; paint(); } }, 'Close')),
      h('div.ax-start', h('span.muted', 'Start from'), pick,
        n ? h('span.ax-chip.warn', `${n} change${n === 1 ? '' : 's'}`) : null,
        p.isOwner ? h('span.small.muted', 'An owner sees everything.') : !owner ? h('span.small.muted', 'Only an owner makes or unmakes an admin, and changes the other systems.') : null),
      body);
  }

  function cards(people) {
    return h('div.ax-cards', people.map((p) => {
      const lv = places().flatMap((pl) => pl.tabs).filter((t) => !t.system).map((t) => level(p, t));
      return h('button.ax-card', { type: 'button', onclick: () => { chosen = p.id; paint(); window.scrollTo({ top: 0 }); } },
        avatar(p),
        h('span.t', h('b', p.name), h('small', h(`span.ax-role.r-${startOf(p).key === 'custom' ? 'custom' : isAdmin(p) ? 'admin' : p.role === 'none' ? 'none' : 'preset'}`, startOf(p).label), ` · ${lv.filter(Boolean).length} of ${lv.length} tabs`),
          h('span.ax-strip', lv.map((v) => h(`i.${['h', 's', 'd'][v]}`)))),
        h('span.muted', '›'));
    }));
  }

  function download() {
    const pls = places();
    const cols = pls.flatMap((pl) => pl.tabs);
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [['Person', 'Email', 'Access', ...cols.map((t) => `${t.place || 'Other systems'} › ${t.label}`)].map(esc).join(',')];
    for (const o of data.people) {
      const p = now(o.id);
      lines.push([p.name, p.email, startOf(p).label, ...cols.map((t) => (t.system ? (level(p, t) ? 'Yes' : '') : t.max === 'admin' && !isAdmin(p) ? '' : ['', 'See', 'Do'][level(p, t)]))].map(esc).join(','));
    }
    const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: 'who-sees-what.csv' });
    document.body.append(a); a.click(); a.remove();
  }

  async function save() {
    const people = [...draft.entries()].filter(([id]) => changesOf(id) || Object.keys(draft.get(id).systems || {}).length).map(([id, d]) => {
      const p = now(id);
      const o = original(id);
      const out = { accountId: id };
      if (d.tabs || d.areas || d.start) {
        out.start = p.role === 'admin' ? 'admin' : p.role === 'none' ? 'none' : 'custom';
        out.tabs = p.tabs;
        out.areas = p.areas;
      }
      const sys = Object.fromEntries(Object.keys(p.systems || {}).filter((k) => Boolean(p.systems[k]) !== Boolean(o.systems[k])).map((k) => [k, Boolean(p.systems[k])]));
      if (Object.keys(sys).length) out.systems = sys;
      return out;
    });
    if (!people.length) { draft = new Map(); paint(); return; }
    try {
      data = await api('/access', { method: 'POST', body: { people } });
      said = ['good', `Saved: ${people.length === 1 ? data.people.find((x) => x.id === people[0].accountId)?.name || 'one person' : `${people.length} people`}.`];
      draft = new Map();
    } catch (err) {
      said = ['problem', err.message];
    }
    paint();
  }

  function paint() {
    const people = data.people.filter((p) => !query || `${p.name} ${p.email}`.toLowerCase().includes(query.toLowerCase())).map((p) => now(p.id));
    const pending = [...draft.keys()].filter((id) => changesOf(id) || places().some((pl) => pl.systems && pl.tabs.some((t) => changed(id, t))));
    const total = pending.reduce((n, id) => n + Math.max(1, changesOf(id)), 0);
    const search = h('input.ax-search', { type: 'search', placeholder: 'Search a name…', value: query, oninput: (e) => { query = e.target.value; paint(); view.querySelector('.ax-search')?.focus(); } });
    const copy = chosen ? h('select.ax-copy', {
      'aria-label': 'Copy access from',
      onchange: (e) => {
        const from = now(Number(e.target.value));
        if (!from) return;
        if (isAdmin(from)) startFrom(chosen, 'admin');
        else if (from.role === 'none') startFrom(chosen, 'none');
        else touch(chosen, (d) => { d.tabs = { ...from.tabs }; d.areas = { ...from.areas }; });
      },
    }, h('option', { value: '' }, `Copy access to ${now(chosen).name} from…`), data.people.filter((p) => p.id !== chosen).map((p) => h('option', { value: String(p.id) }, p.name))) : null;
    mount(view,
      h('div.ax-head', h('h1', 'Who sees what'), h('span.sp'), search, copy,
        h('button.btn', { type: 'button', onclick: download }, '⬇ Download')),
      h('p.ax-lede', 'One row per person, one column per tab. Tap a square to change it: Hidden → See → Do. A hidden tab is gone from their menu and Insight refuses its data. Tap a place to open or fold it; tap a name for the finer things inside each tab. Settings are for admins.'),
      h('div.ax-legend',
        h('span', h('i.ax-c.h', '–'), 'Hidden'), h('span', h('i.ax-c.s', 'See'), 'Can look'), h('span', h('i.ax-c.d', 'Do'), 'Can act and change'),
        h('span', h('i.ax-c.x', '·'), 'Admins only'), h('span', h('i.ax-c.s.chg', 'See'), 'Changed, not saved yet')),
      said ? h(`div.banner.${said[0]}`, said[1]) : null,
      chosen ? h('div.ax-back', h('button.btn', { type: 'button', onclick: () => { chosen = null; paint(); } }, '‹ Everybody')) : null,
      matrix(people),
      chosen ? null : cards(people),
      chosen ? panel(chosen) : null,
      pending.length ? h('div.ax-save', h('span', `● ${total} change${total === 1 ? '' : 's'} for ${pending.map((id) => now(id).name).join(', ')}, not saved yet.`), h('span.sp'),
        h('button.btn', { type: 'button', onclick: () => { draft = new Map(); said = null; paint(); } }, 'Undo'),
        h('button.btn.primary', { type: 'button', onclick: save }, `Save ${total} change${total === 1 ? '' : 's'}`)) : null);
  }

  paint();
}
