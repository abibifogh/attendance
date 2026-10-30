import { h, mount, money, num } from '../util.js';
import { api } from '../api.js';

/**
 * Buying › Suppliers. Odoo's vendors, opening on the key suppliers in their
 * groups; everybody else in Odoo, where a name is marked key or hidden (not a
 * supplier: staff, a one-off); and the names typed in other systems that no
 * Odoo supplier has yet, to be linked to the one they are. A supplier opens
 * with Odoo's details, what Insight adds and, for admins and supervisors, how
 * they are paid. See src/routes/supplierbook.js.
 */

const VIEW_KEY = 'insight-suppliers-view';
const day = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const at = (t) => (t ? new Date(`${String(t).replace(' ', 'T')}Z`).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : 'never');
const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });

export async function renderSupplierBook(root, { range }) {
  let view = 'key';
  try { view = sessionStorage.getItem(VIEW_KEY) || 'key'; } catch { /* private mode */ }
  let q = '';
  let showHidden = false;
  let flash = null;
  let data = await load();
  const box = h('div.sb');
  mount(root, box);
  paint();
  // A supplier picked in search opens here.
  try {
    const asked = sessionStorage.getItem('insight-supplier-open');
    if (asked) { sessionStorage.removeItem('insight-supplier-open'); openOne(Number(asked)); }
  } catch { /* private mode */ }

  async function load() { return api(`/suppliers/book?from=${range.from}&to=${range.to}`); }
  async function reload(message) { data = await load(); flash = message ? h('div.sb-flash', message) : null; paint(); }
  function setView(v) { view = v; try { sessionStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } paint(); }
  function match(r) { return !q || [r.name, r.phone, r.email, r.group, ...(r.aliases || [])].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()); }

  function paint() {
    const t = data.tiles;
    const search = h('input.sb-search', { type: 'search', placeholder: 'Find a supplier, a phone number, a spelling', value: q, 'aria-label': 'Find a supplier' });
    search.addEventListener('input', () => { q = search.value; paintBody(); });
    const body = h('div.sb-body');
    mount(box,
      flash,
      h('div.sb-tiles',
        tile('Key suppliers', num(t.key), t.key ? `in ${new Set(data.suppliers.filter((r) => r.key && !r.hidden).map((r) => r.group || '—')).size} group${new Set(data.suppliers.filter((r) => r.key && !r.hidden).map((r) => r.group || '—')).size === 1 ? '' : 's'}` : 'none marked yet'),
        tile('Spent with them', money(t.keySpend, { places: 0 }), t.allSpend ? `${Math.round((t.keySpend / t.allSpend) * 100)}% of ${money(t.allSpend, { places: 0 })} in this window` : 'nothing bought in this window'),
        tile('Owed to suppliers', money(t.owed, { places: 0 }), 'Odoo bills not yet paid'),
        tile('Names not linked', num(t.unlinked), t.unlinked ? `${money(t.unlinkedSpend, { places: 0 })} spent under names no Odoo supplier has` : 'every name is an Odoo supplier')),
      h('div.sb-bar',
        h('div.sb-seg', { role: 'group', 'aria-label': 'Which suppliers' },
          seg('key', `★ Key suppliers (${t.key})`), seg('all', `All in Odoo (${data.suppliers.filter((r) => !r.hidden).length})`), seg('unlinked', `Not linked (${t.unlinked})`)),
        search,
        view === 'all' ? h('label.sb-tick', h('input', { type: 'checkbox', checked: showHidden, onchange: (e) => { showHidden = e.target.checked; paintBody(); } }), `Show hidden (${data.suppliers.filter((r) => r.hidden).length})`) : null,
        h('span.sb-sp'),
        h('span.small.muted', `Read from Odoo ${at(data.refreshedAt)}`),
        data.canEdit ? refreshButton() : null),
      body);
    paintBody();

    function paintBody() {
      if (!data.suppliers.length) {
        mount(body, h('div.card', h('p', 'No suppliers read from Odoo yet.'), data.canEdit ? h('p.muted', 'Press Refresh from Odoo: every vendor Odoo has comes in, and the ones that matter can be marked key.') : h('p.muted', 'An admin or supervisor reads them in from Odoo.')));
        return;
      }
      if (view === 'unlinked') mount(body, unlinkedView());
      else if (view === 'all') mount(body, allView());
      else mount(body, keyView());
    }
  }

  function tile(label, value, sub) { return h('div.sb-tile', h('small', label), h('b', value), h('span', sub)); }
  function seg(v, label) { return h('button', { type: 'button', class: view === v ? 'on' : '', 'aria-pressed': String(view === v), onclick: () => setView(v) }, label); }

  function refreshButton() {
    const b = h('button.btn', { type: 'button', onclick: async () => {
      b.disabled = true; b.textContent = 'Reading Odoo…';
      try { const out = await api('/suppliers/refresh', { method: 'POST' }); await reload(`Read ${out.count} suppliers from Odoo. The list for the breakfast app: ${out.sent?.breakfast || '—'}; for the maintenance store: ${out.sent?.maintenance || '—'}.`); } catch (err) { flash = h('div.sb-flash.bad', err.message); paint(); }
    } }, '↻ Refresh from Odoo');
    return b;
  }

  // ----------------------------------------------------------- key, grouped --
  function keyView() {
    const key = data.suppliers.filter((r) => r.key && !r.hidden && match(r));
    if (!data.suppliers.some((r) => r.key && !r.hidden)) {
      return h('div.card.sb-empty', h('p', h('b', 'No key suppliers marked yet.')),
        h('p.muted', 'Odoo lists everybody a PO or bill ever went to, staff included. Open All in Odoo and press ☆ on the ones you buy from again and again, then choose their group.'),
        h('button.btn.primary', { type: 'button', onclick: () => setView('all') }, 'Open All in Odoo'));
    }
    const groups = [...new Set([...data.groups, ...key.map((r) => r.group).filter(Boolean)])].filter((g) => key.some((r) => r.group === g));
    if (key.some((r) => !r.group)) groups.push(null);
    if (!groups.length) return h('p.muted', 'No key supplier matches that.');
    return h('div.sb-groups', groups.map((g) => {
      const rows = key.filter((r) => (r.group || null) === g);
      return h('section.card.sb-group',
        h('div.sb-ghead', h('h3', g || 'No group yet'), h('span.muted', `${rows.length} supplier${rows.length === 1 ? '' : 's'} · ${money(rows.reduce((t, r) => t + r.spend, 0), { places: 0 })} in this window`)),
        h('div.sb-table', h('table',
          h('thead', h('tr', h('th', 'Supplier'), h('th', 'Phone'), h('th.n', 'Spent'), h('th.n', 'Last bought'), h('th.n', 'Owed'), h('th', 'Bought through'))),
          h('tbody', rows.map((r) => h('tr.sb-row', { onclick: () => openOne(r.id) },
            h('td', h('b', r.name), r.aliases.length ? h('small.muted', ` · also ${r.aliases.slice(0, 2).join(', ')}${r.aliases.length > 2 ? '…' : ''}`) : null),
            h('td', r.phone || h('span.muted', '—')),
            h('td.n.num', money(r.spend, { places: 0 })),
            h('td.n', day(r.last)),
            h('td.n.num', r.owed ? h('span.sb-owed', money(r.owed, { places: 0 })) : h('span.muted', '—')),
            h('td.small', r.systems.join(', ') || h('span.muted', 'nothing in this window'))))))));
    }));
  }

  // ------------------------------------------------------------ all in Odoo --
  function allView() {
    const rows = data.suppliers.filter((r) => (showHidden || !r.hidden) && match(r));
    return h('div.card.sb-all',
      h('p.sub', data.canEdit ? 'Press ☆ to mark a key supplier, then choose its group. Hide anybody who is not a supplier (staff, a one-off): they leave this list, and nothing changes in Odoo.' : 'Every vendor in Odoo. Admins and supervisors mark the key ones.'),
      rows.length ? h('div.sb-table', h('table',
        h('thead', h('tr', h('th', ''), h('th', 'Supplier'), h('th', 'Group'), h('th.n', 'Spent'), h('th.n', 'Last bought'), h('th.n', 'Owed'), data.canEdit ? h('th', '') : null)),
        h('tbody', rows.slice(0, 400).map((r) => h(`tr${r.hidden ? '.sb-hidden' : ''}`,
          h('td', starButton(r)),
          h('td', h('button.sb-name', { type: 'button', onclick: () => openOne(r.id) }, r.name),
            r.staff ? h('span.sb-chip.warn', { title: 'A login in Odoo: usually a member of staff, not a supplier' }, 'Staff?') : null,
            r.inOdoo ? null : h('span.sb-chip', 'No longer in Odoo'),
            r.hidden ? h('span.sb-chip', 'Hidden') : null),
          h('td', r.key ? groupSelect(r) : h('span.muted', '—')),
          h('td.n.num', r.spend ? money(r.spend, { places: 0 }) : h('span.muted', '—')),
          h('td.n', day(r.last)),
          h('td.n.num', r.owed ? h('span.sb-owed', money(r.owed, { places: 0 })) : h('span.muted', '—')),
          data.canEdit ? h('td', h('button.linklike', { type: 'button', onclick: () => change(r, { hidden: !r.hidden }, r.hidden ? `${r.name} is back on the list.` : `${r.name} is hidden: not a supplier.`) }, r.hidden ? 'Show' : 'Hide')) : null))))) : h('p.muted', 'Nobody matches that.'),
      rows.length > 400 ? h('p.small.muted', `The first 400 of ${rows.length}: type in Find to narrow it.`) : null);
  }

  function starButton(r) {
    if (!data.canEdit) return r.key ? h('span.sb-star.on', { title: 'Key supplier' }, '★') : h('span.sb-star', '☆');
    return h(`button.sb-star${r.key ? '.on' : ''}`, {
      type: 'button', 'aria-pressed': String(r.key), title: r.key ? 'Key supplier: press to unmark' : 'Mark as a key supplier',
      onclick: () => change(r, { key: !r.key }, r.key ? `${r.name} is no longer a key supplier.` : `${r.name} is a key supplier. Choose its group.`),
    }, r.key ? '★' : '☆');
  }

  function groupSelect(r) {
    if (!data.canEdit) return r.group || h('span.muted', 'No group');
    const sel = h('select.sb-group-pick', { 'aria-label': `${r.name}’s group`, onchange: async () => {
      let g = sel.value;
      if (g === '__new') { g = (prompt('The new group’s name') || '').trim(); if (!g) { sel.value = r.group || ''; return; } }
      change(r, { group: g }, `${r.name}: ${g || 'no group'}.`);
    } },
    h('option', { value: '', selected: !r.group }, 'No group'),
    data.groups.map((g) => h('option', { value: g, selected: r.group === g }, g)),
    h('option', { value: '__new' }, 'A new group…'));
    return sel;
  }

  async function change(r, body, message) {
    try { await api('/suppliers/save', { method: 'POST', body: { id: r.id, ...body } }); await reload(message); } catch (err) { flash = h('div.sb-flash.bad', err.message); paint(); }
  }

  // --------------------------------------------------------- names not linked --
  function unlinkedView() {
    const rows = data.unlinked.filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()));
    const list = h('datalist', { id: 'sb-odoo-names' }, data.suppliers.filter((r) => !r.hidden).map((r) => h('option', { value: r.name })));
    return h('div.card',
      list,
      h('p.sub', 'Names typed in the breakfast app, the maintenance store, a receipt or a drawer that no Odoo supplier has. Say which Odoo supplier each one is, and its spend counts as theirs. Nothing changes in the other systems.'),
      rows.length ? h('div.sb-table', h('table',
        h('thead', h('tr', h('th', 'Name as typed'), h('th', 'Bought through'), h('th.n', 'Spent'), h('th.n', 'Last'), data.canEdit ? h('th', 'Which Odoo supplier is it?') : null)),
        h('tbody', rows.map((u) => {
          const pick = h('input', { placeholder: 'Start typing a supplier', 'aria-label': `Which Odoo supplier is ${u.name}` });
          pick.setAttribute('list', 'sb-odoo-names');
          const go = h('button.btn', { type: 'button', onclick: async () => {
            const target = data.suppliers.find((r) => r.name.toLowerCase() === pick.value.trim().toLowerCase());
            if (!target) { pick.setCustomValidity('Choose one from the list'); pick.reportValidity(); return; }
            go.disabled = true;
            try { await api('/suppliers/link', { method: 'POST', body: { id: target.id, name: u.name } }); await reload(`“${u.name}” now counts as ${target.name}.`); } catch (err) { flash = h('div.sb-flash.bad', err.message); paint(); }
          } }, 'Link');
          pick.addEventListener('input', () => pick.setCustomValidity(''));
          return h('tr',
            h('td', h('b', u.name)),
            h('td.small', u.systems.join(', ')),
            h('td.n.num', money(u.spend, { places: 0 })),
            h('td.n', day(u.last)),
            data.canEdit ? h('td', h('div.sb-link', pick, go)) : null);
        })))) : h('p.muted', 'Every name with spend in this window is an Odoo supplier.'));
  }

  // ------------------------------------------------------------- one of them --
  async function openOne(id) {
    const shade = h('div.sb-shade', { onclick: (e) => { if (e.target === shade) close(); } });
    const card = h('div.sb-card', { role: 'dialog', 'aria-modal': 'true' }, h('p.muted', 'Loading…'));
    shade.append(card);
    document.body.append(shade);
    const close = () => { shade.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    let d;
    const draw = async () => {
      try { d = await api(`/suppliers/one?id=${id}`); } catch (err) { mount(card, h('p.form-error', err.message)); return; }
      const s = d.supplier;
      const top = Math.max(1, ...d.byMonth.map((m) => m.spend));
      const said = h('p.small');
      mount(card,
        h('div.sb-dhead',
          h('div', h('h2', s.key ? '★ ' : '', s.name),
            h('p.small.muted', [s.key ? `Key supplier${s.group ? ` · ${s.group}` : ''}` : 'Not a key supplier', s.staff ? 'a login in Odoo: staff?' : null, s.hidden ? 'hidden' : null, s.inOdoo ? null : 'no longer in Odoo'].filter(Boolean).join(' · '))),
          h('button.btn', { type: 'button', 'aria-label': 'Close', onclick: close }, '✕')),
        d.canEdit ? h('div.sb-acts',
          h('button.btn', { type: 'button', onclick: () => edit({ key: !s.key }) }, s.key ? '☆ Not a key supplier' : '★ Mark as key supplier'),
          s.key ? groupPick(s) : null,
          h('button.btn', { type: 'button', onclick: () => edit({ hidden: !s.hidden }) }, s.hidden ? 'Show on the list' : 'Hide: not a supplier')) : null,
        h('div.sb-dgrid',
          h('section',
            h('h3', 'From Odoo'),
            h('dl.sb-dl',
              dt('Phone', s.phone), dt('Email', s.email), dt('TIN', s.vat), dt('Address', s.address), dt('Terms', s.terms)),
            data.odooUrl ? h('a.small', { href: `${data.odooUrl}/web#id=${s.id}&model=res.partner&view_type=form`, target: '_blank', rel: 'noopener' }, 'Change these in Odoo ↗') : null,
            h('p.small.muted', `Read from Odoo ${at(s.refreshedAt)}.`)),
          d.canEdit ? payBox(s, said) : null),
        h('section.sb-spend',
          h('h3', 'Spend, month by month'),
          h('div.sb-months', d.byMonth.map((m) => h('div.sb-month', { title: `${monthName(m.month)}: ${money(m.spend)}` },
            h('i', { style: `height:${(m.spend / top) * 100}%` }), h('span', monthName(m.month)))))),
        h('section',
          h('h3', 'Latest'),
          d.recent.length ? h('div.sb-table', h('table', h('tbody', d.recent.map((x) => h('tr',
            h('td', day(x.day)), h('td', x.what), h('td.small.muted', x.system), h('td.n.num', money(x.amount)), h('td.n', x.owed ? h('span.sb-owed', `${money(x.owed)} owed`) : '')))))) : h('p.muted', 'Nothing bought in the last six months.')),
        h('section',
          h('h3', 'Other spellings'),
          h('p.small.muted', 'The same supplier as typed in other systems: their spend counts here.'),
          s.aliases.length ? h('ul.sb-aliases', s.aliases.map((a) => h('li', a.name, d.canEdit ? h('button.linklike', { type: 'button', onclick: () => unlink(a) }, 'Not them') : null))) : h('p.small.muted', 'None.'),
          d.canEdit ? aliasAdd() : null),
        d.canEdit ? noteBox(s) : (s.note ? h('section', h('h3', 'Note'), h('p', s.note)) : null),
        d.canEdit && d.history.length ? h('section', h('h3', 'History'), h('ul.sb-history', d.history.map((x) => h('li', h('span', x.what), h('small.muted', ` ${x.by_name} · ${at(x.at)}`))))) : null,
        said);
    };
    const dt = (label, value) => [h('dt', label), h('dd', value || h('span.muted', '—'))];
    const edit = async (body) => {
      try { await api('/suppliers/save', { method: 'POST', body: { id, ...body } }); await draw(); data = await load(); paint(); } catch (err) { alert(err.message); }
    };
    const unlink = async (a) => {
      if (!confirm(`“${a.name}” is not ${d.supplier.name}? Its spend stops counting here.`)) return;
      await api('/suppliers/link', { method: 'POST', body: { unlink: a.key } }); await draw(); data = await load(); paint();
    };
    const groupPick = (s) => {
      const sel = h('select', { 'aria-label': 'Group', onchange: () => {
        let g = sel.value;
        if (g === '__new') { g = (prompt('The new group’s name') || '').trim(); if (!g) { sel.value = s.group || ''; return; } }
        edit({ group: g });
      } }, h('option', { value: '', selected: !s.group }, 'No group'),
      [...new Set([...d.groups, ...data.groups, ...(s.group ? [s.group] : [])])].map((g) => h('option', { value: g, selected: s.group === g }, g)),
      h('option', { value: '__new' }, 'A new group…'));
      return sel;
    };
    const aliasAdd = () => {
      const input = h('input', { placeholder: 'Another spelling, e.g. as typed in the breakfast app', maxlength: 120 });
      return h('div.sb-link', input, h('button.btn', { type: 'button', onclick: async () => {
        if (!input.value.trim()) return;
        try { await api('/suppliers/link', { method: 'POST', body: { id, name: input.value } }); await draw(); data = await load(); paint(); } catch (err) { alert(err.message); }
      } }, 'Add'));
    };
    const noteBox = (s) => {
      const t = h('textarea', { rows: 2, maxlength: 600, placeholder: 'Anything worth knowing: who to call, delivery days, what they are good for.' }, s.note || '');
      return h('section', h('h3', 'Note'), t, h('button.btn', { type: 'button', onclick: () => edit({ note: t.value }) }, 'Save the note'));
    };
    const payBox = (s, said) => {
      const p = s.pay || {};
      const f = (key, label, attrs = {}) => {
        const { list, ...rest } = attrs;
        const input = h('input', { value: p[key] || '', maxlength: 80, ...rest });
        // `list` is read-only as a property: it can only be set as an attribute.
        if (list) input.setAttribute('list', list);
        input.dataset.key = key;
        return h('label.sb-f', h('span', label), input);
      };
      const fields = [
        f('momoNumber', 'MoMo number', { inputmode: 'tel', placeholder: '024 123 4567' }), f('momoName', 'Name on the MoMo account'),
        f('momoNetwork', 'Network', { placeholder: 'MTN, Telecel, AT', list: 'sb-networks' }),
        f('bankName', 'Bank'), f('bankAccountName', 'Account name'), f('bankAccount', 'Account number', { inputmode: 'numeric' }),
      ];
      return h('section.sb-pay',
        h('h3', 'How they are paid'),
        h('p.small.muted', 'Admins and supervisors only. Every change is kept in the history.'),
        p.odooBanks?.length ? h('div.small', h('b', 'In Odoo: '), p.odooBanks.map((b) => `${b.bank || 'Bank'} ${b.number}${b.holder ? ` (${b.holder})` : ''}`).join(' · ')) : null,
        h('datalist', { id: 'sb-networks' }, ['MTN', 'Telecel', 'AT'].map((n) => h('option', { value: n }))),
        h('div.sb-fgrid', fields),
        h('button.btn.primary', { type: 'button', onclick: async () => {
          const pay = Object.fromEntries(fields.map((l) => { const i = l.querySelector('input'); return [i.dataset.key, i.value]; }));
          try { await api('/suppliers/save', { method: 'POST', body: { id, pay } }); said.textContent = 'Payment details saved.'; await draw(); } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
        } }, 'Save payment details'));
    };
    await draw();
  }
}
