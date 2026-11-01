import { h, mount, money } from '../util.js';
import { api } from '../api.js';

/**
 * Buying › Fixed assets (admins): what Insight found in Odoo that may be a
 * fixed asset, to decide; what is on the fixed asset accounts; the register,
 * as Maintenance keeps it; what is not an asset; and the rules.
 *
 * "It's an asset" opens the panel beside the list: each unit with its NCA
 * tag, a name and a room, and how often it is serviced. They go to
 * Maintenance's equipment register, where the rooms and the servicing are
 * managed. Insight never changes Odoo.
 */
const TABS = [['review', 'To review'], ['account', 'In the asset account'], ['register', 'On the register'], ['not', 'Not assets'], ['rules', 'Rules']];
const EVERY = [[0, 'None'], [1, 'Month'], [3, '3 months'], [6, '6 months'], [12, 'Year']];

const shortDay = (day) => (day ? new Date(`${String(day).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const plusMonths = (months) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };
const cedis = (ghs) => money(Math.round(Number(ghs || 0) * 100), { places: 0 });

export async function renderFixedAssets(root) {
  let tab = 'review';
  try { tab = sessionStorage.getItem('insight-fa-tab') || 'review'; } catch { /* private mode */ }
  let data;
  let open = null; // the item whose panel is open
  let form = null;
  const said = h('p.small.fa-said');

  async function load() {
    data = await api('/assets');
    paint();
  }

  function paint() {
    const t = data.totals;
    const reg = data.register || [];
    mount(root, h('div.fa',
      h('div.fa-head',
        h('div',
          h('h1', 'Fixed assets'),
          h('p.fa-lede', h('b', String(t.register)), ' on the register · ', h('b', money(t.atCost, { places: 0 })), ' at cost · ',
            h('b', String(t.review)), ` to review${t.late ? ' · ' : ''}`, t.late ? h('b.bad', `${t.late} overdue for service`) : null)),
        h('div.fa-scan',
          h('button.btn', { type: 'button', onclick: scan }, 'Read Odoo now'),
          h('small.muted', data.scanned ? `Read ${new Date(`${data.scanned.at.replace(' ', 'T')}Z`).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${data.scanned.assetsApp ? '' : ' · no Assets app in Odoo'}` : 'Not read from Odoo yet'))),
      said,
      h('div.fa-tiles',
        tile('am', 'To review', t.review, 'purchases and asset-account entries to decide'),
        tile('vi', 'In the asset account', t.account, t.accountOff ? `${t.accountOff} not on the register yet` : 'all on the register or decided'),
        tile('gr', 'On the register', t.register, `in ${t.rooms} room${t.rooms === 1 ? '' : 's'}, in Maintenance`),
        tile('em', 'Service', t.late ? `${t.late} late` : '✓', t.dueSoon ? `${t.dueSoon} more due within 30 days` : 'nothing due within 30 days')),
      h('div.fa-chips', { role: 'tablist' }, TABS.map(([k, label]) => h('button.fa-chip', {
        type: 'button', role: 'tab', 'aria-selected': String(tab === k),
        onclick: () => { tab = k; open = null; try { sessionStorage.setItem('insight-fa-tab', k); } catch { /* private mode */ } paint(); },
      }, label, k === 'rules' ? null : h('span', String(k === 'review' ? t.review : k === 'account' ? t.account : k === 'register' ? reg.length : data.notAssets.length))))),
      tab === 'review' ? h('div.fa-cols', listOf(data.review, 'Nothing to review. New purchases that look like assets come here as Odoo is read.'), panel())
        : tab === 'account' ? listOf(data.account, 'Nothing on the fixed asset accounts in Odoo yet.')
          : tab === 'register' ? registerList(reg)
            : tab === 'not' ? listOf(data.notAssets, 'Nothing marked not an asset.')
              : rules()));
  }

  function tile(tone, label, big, small) {
    return h(`div.fa-tile.${tone}`, h('small', label), h('b', String(big)), h('span', small));
  }

  function listOf(items, empty) {
    if (!items.length) return h('div.fa-empty', empty);
    return h('div.fa-list', items.map(row));
  }

  function row(x) {
    const each = x.qty > 1 ? ` × ${x.qty} · ${money(x.unitCost, { places: 0 })} each` : ` · ${money(x.amount, { places: 0 })}`;
    const source = x.kind === 'purchase' ? ['tag.fa-new', 'New purchase'] : x.kind === 'odoo_asset' ? ['tag.fa-acc', 'Odoo asset'] : ['tag.fa-acc', 'In the asset account'];
    const acts = [];
    if (x.state === 'review') {
      acts.push(h('button.btn.primary', { type: 'button', onclick: () => openPanel(x) }, x.kind === 'purchase' ? 'It’s an asset' : 'Put on the register'));
      acts.push(h('button.btn.quiet', { type: 'button', onclick: () => decide(x, false) }, 'Not an asset'));
    } else if (x.state === 'not_asset') {
      acts.push(h('button.btn.quiet', { type: 'button', onclick: () => decide(x, true) }, 'Put back'));
    }
    return h('div.fa-row', { class: open?.key === x.key ? 'sel' : '', dataset: { kind: x.kind, state: x.state } },
      h('span.fa-bar'),
      h('div',
        h('div.fa-t', x.name, h('span.fa-q', each)),
        h('div.fa-m', h(`span.${source[0]}`, source[1]), [x.supplier, x.doc, shortDay(x.day)].filter(Boolean).join(' · ')),
        x.why ? h('div.fa-why', 'Why: ', x.why.map((w) => h('i', w))) : null,
        x.kind === 'purchase' && !x.onAssetAccount && x.account ? h('div.fa-warn', `⚠ Booked to ${x.account}, an expense. If it is an asset, ask the accountant to move it to a fixed asset account.`) : null,
        x.onAssetAccount && x.account ? h('div.fa-ok', `✓ On ${x.account}`) : null,
        x.state === 'registered' ? h('div.fa-ok', `✓ On the register: ${x.units.map((u) => `${u.tag} ${u.name}, ${u.room}`).join(' · ')}`) : null,
        x.state === 'not_asset' ? h('div.fa-m', `Not an asset${x.decidedBy ? ` · ${x.decidedBy}` : ''}`) : null),
      h('div.fa-acts', acts));
  }

  function openPanel(x) {
    open = x;
    const count = Math.max(1, Math.min(20, Math.round(x.qty) || 1));
    form = { count, units: unitsFor(x, count), every: 0, first: '', by: 'in_house', error: '' };
    paint();
    // Below the list on a narrow screen: brought into view, or the tap looks like it did nothing.
    if (window.innerWidth < 1100) root.querySelector('.fa-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function unitsFor(x, count, had = []) {
    const base = x.name.replace(/\s*\d+\s*$/, '');
    return Array.from({ length: count }, (_, i) => had[i] || { name: count > 1 ? `${base} ${i + 1}` : x.name, room: '' });
  }

  function panel() {
    if (!open || tab !== 'review') {
      return h('div.fa-panel.quiet', h('h2', 'Decide each'), h('p.small.muted',
        '“It’s an asset” gives each unit its NCA tag, a name, a room and its servicing, and puts it on the equipment register in Maintenance. “Not an asset” is remembered for that product. Odoo is never changed.'));
    }
    const x = open;
    const first = Number(data.nextTag.replace('NCA-', ''));
    const tagOf = (i) => `NCA-${String(first + i).padStart(4, '0')}`;
    const err = h('p.small.form-error', form.error || '');
    return h('div.fa-panel',
      h('h2', `${x.name}${x.qty > 1 ? ` × ${x.qty}` : ''}`),
      h('p.small.muted', 'Goes to Maintenance › Equipment, one entry each, with its tag, its room and its service.'),
      h('label.fa-l', 'How many'),
      h('div.fa-count',
        h('button.btn.quiet', { type: 'button', onclick: () => { form.count = Math.max(1, form.count - 1); form.units = form.units.slice(0, form.count); paint(); } }, '−'),
        h('b', String(form.count)),
        h('button.btn.quiet', { type: 'button', onclick: () => { form.count = Math.min(100, form.count + 1); form.units = unitsFor(x, form.count, form.units); paint(); } }, '+')),
      h('label.fa-l', 'Each one'),
      form.units.map((u, i) => h('div.fa-unit',
        h('span.fa-tagp', tagOf(i)),
        h('input', { type: 'text', value: u.name, 'aria-label': `Name of ${tagOf(i)}`, oninput: (e) => { u.name = e.target.value; } }),
        h('select', { 'aria-label': `Room of ${tagOf(i)}`, onchange: (e) => { u.room = e.target.value; } },
          h('option', { value: '' }, 'Room or area…'),
          data.rooms.map((r) => h('option', { value: r, selected: u.room === r }, r))))),
      data.rooms.length ? null : h('p.small.form-error', data.registerError || 'Maintenance has no rooms to choose from.'),
      h('label.fa-l', 'Service every'),
      h('div.fa-seg', EVERY.map(([m, label]) => h('button', {
        type: 'button', class: form.every === m ? 'on' : '',
        onclick: () => { form.every = m; form.first = m ? plusMonths(m) : ''; paint(); },
      }, label))),
      form.every ? [h('label.fa-l', 'First service'), h('input.fa-date', { type: 'date', value: form.first, oninput: (e) => { form.first = e.target.value; } }),
        h('label.fa-l', 'Serviced by'),
        h('div.fa-seg', [['in_house', 'Our artisans'], ['supplier', 'The supplier']].map(([k, label]) => h('button', { type: 'button', class: form.by === k ? 'on' : '', onclick: () => { form.by = k; paint(); } }, label)))] : null,
      h('div.fa-note', `${money(Math.round(x.amount / form.count), { places: 0 })} each${x.supplier ? `, ${x.supplier}` : ''}${x.doc ? `, ${x.doc}` : ''}, kept on each.`),
      err,
      h('button.btn.primary.fa-wide', { type: 'button', onclick: (e) => add(e.currentTarget, err) }, `Add ${form.count} to the register`),
      h('button.btn.quiet.fa-wide', { type: 'button', onclick: () => { open = null; paint(); } }, 'Cancel'));
  }

  async function add(button, err) {
    const missing = form.units.findIndex((u) => !u.name.trim() || !u.room);
    if (missing >= 0) { err.textContent = `Give number ${missing + 1} a name and a room.`; return; }
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      const out = await api('/assets/register', { method: 'POST', body: { key: open.key, units: form.units, serviceMonths: form.every, firstService: form.first || null, servicedBy: form.by } });
      said.textContent = `✓ ${out.tags.join(', ')} added to the register in Maintenance.`;
      open = null;
      await load();
    } catch (e) {
      err.textContent = e.message;
      button.disabled = false;
      button.textContent = `Add ${form.count} to the register`;
    }
  }

  async function decide(x, undo) {
    try {
      await api('/assets/decide', { method: 'POST', body: { key: x.key, undo } });
      said.textContent = undo ? `${x.name} is back to review.` : `${x.name}: not an asset. ${x.kind === 'purchase' ? 'Not asked about again for this product.' : ''}`;
      if (open?.key === x.key) open = null;
      await load();
    } catch (e) { said.textContent = e.message; }
  }

  async function scan(e) {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = 'Reading Odoo…';
    try {
      const out = await api('/assets/scan', { method: 'POST', body: {} });
      said.textContent = `Read Odoo: ${out.found} in all, ${out.fresh} new.${out.assetsApp ? '' : ' Odoo has no Assets app, so the asset accounts were read.'}`;
      await load();
    } catch (err) { said.textContent = err.message; b.disabled = false; b.textContent = 'Read Odoo now'; }
  }

  function registerList(reg) {
    if (!data.register) return h('div.fa-empty', data.registerError || 'The register could not be read.');
    if (!reg.length) return h('div.fa-empty', 'Nothing on the register yet.');
    const today = new Date().toISOString().slice(0, 10);
    const byRoom = new Map();
    for (const a of reg) { const k = a.room || 'No room yet'; if (!byRoom.has(k)) byRoom.set(k, []); byRoom.get(k).push(a); }
    return h('div',
      h('p.small.muted', 'Rooms and servicing are managed in Maintenance › Rooms › Equipment.'),
      [...byRoom.keys()].sort((a, b) => (a === 'No room yet') - (b === 'No room yet') || a.localeCompare(b, undefined, { numeric: true })).map((room) => h('section.fa-room',
        h('div.fa-gh', `${room} · ${byRoom.get(room).length}`),
        h('div.fa-list', byRoom.get(room).map((a) => {
          const late = a.overdue_since ? Math.round((Date.parse(today) - Date.parse(a.overdue_since)) / 864e5) : 0;
          return h('div.fa-row', { dataset: { kind: 'register' } },
            h('span.fa-bar', { class: late ? 'late' : '' }),
            h('div',
              h('div.fa-t', a.name, a.tag ? h('span.fa-tagp', a.tag) : null),
              h('div.fa-m', [a.cost != null ? cedis(a.cost) : null, a.supplier, a.bought ? `bought ${shortDay(a.bought)}` : null,
                a.service_months ? `serviced every ${a.service_months === 1 ? 'month' : `${a.service_months} months`}` : 'no servicing set'].filter(Boolean).join(' · '))),
            h('div.fa-acts', late ? h('span.fa-pill.late', `Service ${late} day${late === 1 ? '' : 's'} late`)
              : a.next_service ? h('span.fa-pill', `Next service ${shortDay(a.next_service)}`) : null));
        })))));
  }

  function rules() {
    const r = data.rules;
    const f = {
      minEach: h('input', { type: 'number', min: '1', value: String(r.minEach / 100) }),
      minLine: h('input', { type: 'number', min: '1', value: String(r.minLine / 100) }),
      words: h('textarea', { rows: 4 }, r.words.join(', ')),
      never: h('textarea', { rows: 3 }, r.never.join(', ')),
      since: h('input', { type: 'date', value: r.since || '' }),
    };
    const note = h('span.small');
    return h('div.fa-rules',
      h('section.card',
        h('h2', 'Cost'),
        h('label.fa-l', 'Each, at least (GH₵)'), f.minEach,
        h('label.fa-l', 'Or one line, at least (GH₵)'), f.minLine,
        h('p.small.muted', 'The second catches several cheaper ones bought together, such as ten mattresses.'),
        h('label.fa-l', 'Read purchases from'), f.since,
        h('p.small.muted', 'Empty: the last two years. Everything on the fixed asset accounts is always read.')),
      h('section.card',
        h('h2', 'Words in the name'),
        h('label.fa-l', 'Point to an asset (commas between)'), f.words,
        h('label.fa-l', 'Never an asset'), f.never,
        h('p.small.muted', 'Whole words only: “AC” is not found in “vacuum”. Plurals count.')),
      h('section.card',
        h('h2', 'Fixed asset accounts in Odoo'),
        h('p.small.muted', 'Every account of type “Fixed Assets” in Odoo’s chart is read, with Odoo’s Assets app when it is installed.'),
        data.scanned ? h('p.small', `Last read: ${data.scanned.found} found${data.scanned.assetsApp ? ', with the Assets app' : ', no Assets app'}.`) : null,
        h('button.btn.primary', {
          type: 'button',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api('/assets/rules', { method: 'POST', body: { minEach: f.minEach.value, minLine: f.minLine.value, words: f.words.value, never: f.never.value, since: f.since.value || null } });
              note.textContent = ' Saved. Read Odoo again to apply them.';
              data = await api('/assets');
            } catch (err) { note.textContent = ` ${err.message}`; }
            e.currentTarget.disabled = false;
          },
        }, 'Save the rules'), note));
  }

  await load();
}
