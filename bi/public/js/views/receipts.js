import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';
import { openNewPo } from './newpo.js';

/**
 * Money › Receipts: every receipt that came in, by upload or by email, and
 * what became of it. Complete drafts; drafts with a vendor or an item for the
 * accountant to change; one already seen; one that could not be read, kept
 * with its file and filled in by hand with "Fill it in". And the settings:
 * the address, who may send, the placeholders and who checks.
 */

const STATUS = {
  complete: ['ok', '✓ Complete'],
  check: ['over', '⚠ To check'],
  filled: ['ok', '✓ Filled in'],
  duplicate: ['none', '= Seen before'],
  unread: ['short', '✕ No PO made'],
  failed: ['short', '✕ Odoo refused'],
  dismissed: ['none', 'Set aside'],
};
const when = (at) => {
  const d = new Date(`${String(at).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(at || '') : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
};
const dayText = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

export async function renderReceipts(root) {
  let data = null;
  let filter = 'all';
  const view = h('div.rc');
  mount(root, view);
  await read();

  async function read() {
    try { data = await api('/receipts'); } catch (err) { mount(view, banner('problem', err.message)); return; }
    paint();
  }

  function paint(message = null) {
    const items = data.items;
    const open = items.filter((x) => ['unread', 'failed'].includes(x.status));
    const shown = items.filter((x) => filter === 'all' || (filter === 'todo' ? ['unread', 'failed', 'check'].includes(x.status) : x.status === filter));
    const s = data.settings;
    const pill = (key, label, n) => h('button', { type: 'button', 'aria-pressed': String(filter === key), onclick: () => { filter = key; paint(); } }, `${label} · ${n}`);
    mount(view,
      h('section.card.rc-head',
        h('div.rc-top',
          h('div', h('h1', 'Receipts'), h('p.small.muted', 'Every receipt sent in, and the draft PO it became. Approving stays in Odoo.')),
          h('button.btn.primary', { type: 'button', onclick: () => openNewPo({ bulk: true, after: () => read() }) }, '＋ Add receipts')),
        s.address ? h('p.rc-addr', '✉ Or email them to ', h('b', s.address), s.senders.length ? ` from ${s.senders.join(', ')}` : ': nobody may send yet (Settings, below)') : h('p.small.muted', 'Emailing receipts in is not set up yet: see Settings, below.'),
        !s.vendor || !s.product ? banner('warning', 'Choose the placeholder vendor and item (Settings, below): until then a receipt whose vendor or item is not in Odoo is kept here, with no PO.') : null),
      message ? banner('good', message) : null,
      h('div.td-pills', { role: 'group', 'aria-label': 'Which' },
        pill('all', 'All', items.length),
        pill('todo', 'To look at', items.filter((x) => ['unread', 'failed', 'check'].includes(x.status)).length),
        pill('complete', 'Complete', items.filter((x) => x.status === 'complete').length)),
      open.length ? h('p.small', `${open.length} with no PO yet: “Fill it in” opens the usual ＋ PO form with the receipt already there.`) : null,
      shown.length ? h('div.card.rc-list', shown.map(row)) : h('section.card', h('p', items.length ? 'Nothing here.' : 'No receipts yet. Press ＋ Add receipts, or email them in.')),
      settingsCard(),
      data.mails.length ? h('details.card.rc-mails', h('summary', `Emails to the receipts address · ${data.mails.length}`),
        h('ul', data.mails.map((m) => h('li', h('b', m.outcome === 'read' ? '✓ ' : '✕ '), `${when(m.at)} · ${m.from_email || '?'} · “${m.subject || ''}” · ${m.said || ''}`)))) : null);
  }

  function row(x) {
    const [tone, label] = STATUS[x.status] || ['none', x.status];
    const said = h('span.small');
    const fill = async (e) => {
      e.target.disabled = true; said.textContent = 'Opening…';
      try {
        const f = await api(`/receipts/${x.id}/file`);
        said.textContent = '';
        openNewPo({ receipt: { id: x.id, file: f.file, name: f.name }, after: () => read() });
      } catch (err) { said.textContent = err.message; }
      e.target.disabled = false;
    };
    const setAside = async () => {
      try { await api('/receipts/dismiss', { method: 'POST', body: { id: x.id } }); await read(); } catch (err) { said.textContent = err.message; }
    };
    const readAs = x.amount != null || x.vendorText
      ? [h('b', x.vendorOk === false ? `“${x.vendorText || 'no vendor'}”` : (x.vendorName || x.vendorText || '')), x.vendorOk === false ? ' (not in Odoo)' : '',
        x.amount != null ? ` · ${money(x.amount)}` : '', x.day ? ` · ${dayText(x.day)}` : '']
      : [h('span.muted', 'Not read')];
    return h(`div.rc-row.${x.status}`,
      x.thumb ? h('img.rc-thumb', { src: x.thumb, alt: '' }) : h('span.rc-thumb', x.mime === 'application/pdf' ? '📄' : '🖼'),
      h('div.rc-came', h('b', `${x.came === 'email' ? 'Email' : 'Upload'} · ${x.by || x.from || ''}`), h('small', when(x.at)), x.name ? h('small.muted', x.name) : null),
      h('div.rc-read', h('div', readAs), h('small', [x.description, x.productName && x.itemOk !== false ? `item: ${x.productName}` : x.itemOk === false ? 'item not matched' : null, x.hint ? `“${x.hint}”` : null].filter(Boolean).join(' · ')),
        x.problem && x.status !== 'complete' ? h('small.rc-problem', x.problem) : null),
      h('div.rc-po', x.po ? h('b', x.po.name) : null, x.po && ['complete', 'check'].includes(x.status) ? ' draft ' : ' ', h(`span.sh-chip.${tone}`, label),
        x.todo ? h('small', ' · To-Do in Odoo') : null),
      h('div.rc-act',
        x.po?.url ? h('a', { href: x.po.url, target: '_blank', rel: 'noopener' }, 'Open in Odoo ↗') : null,
        ['unread', 'failed'].includes(x.status) && x.hasFile ? [h('button.btn', { type: 'button', onclick: fill }, 'Fill it in'), h('button.sh-link', { type: 'button', onclick: setAside }, 'Set aside')] : null,
        said));
  }

  /** The address, who may send, the placeholders and who checks. */
  function settingsCard() {
    const s = data.settings;
    const box = h('div');
    const card = h('details.card.rc-set', { open: !s.vendor || !s.product || !s.senders.length }, h('summary', 'Settings'), box);
    card.addEventListener('toggle', () => { if (card.open && !box.childElementCount) fill(); });
    if (card.open) fill();
    async function fill() {
      mount(box, h('p.small.muted', 'Reading Odoo’s vendors, items and people…'));
      let c;
      try { c = await api('/receipts/choices'); } catch (err) { mount(box, banner('problem', err.message)); return; }
      const pick = (list, chosen, none) => h('select', h('option', { value: '' }, none), list.map((x) => h('option', { value: String(x.id), selected: chosen?.id === x.id }, x.name)));
      const vendor = pick(c.vendors, s.vendor, 'Choose: e.g. “Vendor to confirm”');
      const product = pick(c.products, s.product, 'Choose: e.g. “Item to classify”');
      const todo = pick(c.users, s.todoUser, 'Nobody: no To-Do');
      const address = h('input', { value: s.address, placeholder: 'receipts@po.niceoperation.com', maxlength: '200' });
      const senders = h('textarea', { rows: '3', placeholder: 'One email address per line' });
      senders.value = s.senders.join('\n');
      const said = h('span.small');
      const ref = (sel, list) => (sel.value ? { id: Number(sel.value), name: list.find((x) => x.id === Number(sel.value))?.name } : null);
      mount(box,
        h('label.rc-f', h('span', 'Vendor used when the receipt’s seller is not in Odoo'), vendor,
          h('small.muted', 'Make it once in Odoo (a contact called “Vendor to confirm”); the accountant changes it to the real one.')),
        h('label.rc-f', h('span', 'Item used when what was bought is not matched'), product,
          h('small.muted', 'A product in Odoo such as “Item to classify”, which may be purchased.')),
        h('label.rc-f', h('span', 'Who gets a To-Do in Odoo on a draft to check'), todo),
        h('label.rc-f', h('span', 'The receipts email address'), address,
          h('small.muted', 'As set up in Cloudflare Email Routing (see docs/receipts.md). Shown here so people know where to send.')),
        h('label.rc-f', h('span', 'Who may email receipts in'), senders,
          h('small.muted', 'Only these addresses. Anything from anybody else is ignored, and listed under “Emails to the receipts address”.')),
        h('div.rc-save', h('button.btn.primary', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true; said.textContent = 'Saving…';
            try {
              data.settings = await api('/receipts/settings', {
                method: 'POST',
                body: { vendor: ref(vendor, c.vendors), product: ref(product, c.products), todoUser: ref(todo, c.users), address: address.value, senders: senders.value },
              });
              paint('Settings saved.');
            } catch (err) { said.textContent = err.message; e.target.disabled = false; }
          },
        }, 'Save'), said));
    }
    return card;
  }
}
