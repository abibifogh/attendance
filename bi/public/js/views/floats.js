import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';
import { openNewPo, shrink, thumbOf } from './newpo.js';

/**
 * Money › Floats: money given to people to spend.
 *
 * Everybody holding money, and how much. One person: what they were given
 * and gave back, every receipt they sent with its PO in Odoo and its
 * reference (FLT/KOFI/005, on the PO as Vendor Reference and Source
 * Document), their link to send receipts from, and a statement to download.
 */

const dayText = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
const today = () => new Date().toISOString().slice(0, 10);
const chip = (cls, text) => h(`span.sh-chip.${cls}`, text);
const STATUS = { checking: ['none', 'Being checked'], accepted: ['ok', '✓ Accepted'], refused: ['short', '✕ Refused'] };
const linkOf = (token) => `${location.origin}/float.html?t=${encodeURIComponent(token)}`;
const shortOf = (slug) => `${location.origin}/float/${slug}`;

let shown = null; // the person open, or null for everybody

export async function renderFloats(root) {
  shown = null;
  const view = h('div.fl');
  mount(root, view);
  const said = { el: null };
  await paint();

  async function paint(message = null) {
    said.el = message;
    if (shown) return person(shown);
    let data;
    try { data = await api('/floats'); } catch (err) { mount(view, banner('problem', err.message)); return; }
    const t = data.tiles;
    const bar = (p) => (p.given ? h('div.fl-bar',
      h('i', { style: `width:${Math.min(100, (p.spent / p.given) * 100)}%;background:var(--series-1)` }),
      h('i', { style: `width:${Math.min(100, (p.back / p.given) * 100)}%;background:var(--series-3)` })) : null);
    mount(view,
      h('section.card',
        h('div.fl-head', h('h1', 'Floats'), h('span.sp'), h('button.btn.primary', { type: 'button', onclick: () => giveDialog(null, data) }, '＋ Give money')),
        h('p.small.muted', 'Money given to people to spend. Each receipt they send from their own link becomes a draft PO in Odoo, marked with their reference, and comes off what they hold.')),
      said.el,
      h('div.fl-tiles',
        tile('With people now', money(t.held)), tile('Spent this month (receipts)', money(t.spentThisMonth)),
        tile('Receipts to look at', String(t.toLookAt)), tile('Held over 14 days, nothing sent', String(t.quiet), t.quiet ? 'bad' : '')),
      h('section.card', data.people.length ? [
        h('div.table-wrap', h('table',
          h('thead', h('tr', ['Person', 'Reference', 'Given', 'Receipts', 'Given back', 'Still with them', 'Last receipt', ''].map((c, i) => h(i >= 2 && i <= 5 ? 'th.num' : 'th', c)))),
          h('tbody', data.people.map((p) => h('tr.fl-row', { onclick: () => { shown = p.id; paint(); } },
            h('td', h('b', p.name), p.note ? h('div.fl-note', p.note) : null, bar(p), p.active ? null : h('div.fl-note', 'Link switched off')),
            h('td', h('span.fl-ref', `FLT/${p.code}`)),
            h('td.num', money(p.given)), h('td.num', p.receipts ? `${money(p.spent)} · ${p.receipts}` : '—'), h('td.num', p.back ? money(p.back) : '—'),
            h('td.num', h('b', money(p.held))), h('td', dayText(p.lastReceipt)),
            h('td', p.toLookAt ? chip('over', `${p.toLookAt} to look at`) : p.quiet ? chip('short', `${p.quiet} days, nothing sent`) : p.held === 0 && p.given ? chip('ok', '✓ Settled') : null)))))),
        h('p.fl-note', h('span', { style: 'color:var(--series-1)' }, '■'), ' spent with receipts   ', h('span', { style: 'color:var(--series-3)' }, '■'), ' given back   ░ still with them'),
      ] : h('p', 'Nobody holds a float yet. ', h('button.sh-link', { type: 'button', onclick: () => giveDialog(null, data) }, 'Give money'), ' to start.')));
  }

  function tile(label, value, tone = '') {
    return h('div.fl-tile', h('small', label), h(`b${tone ? `.${tone}` : ''}`, value));
  }

  /** One person: totals, what to do, everything newest first. */
  async function person(id) {
    let d;
    try { d = await api(`/floats/${id}`); } catch (err) { shown = null; mount(view, banner('problem', err.message)); return; }
    const p = d.person;
    const back = () => { shown = null; paint(); };
    const lines = [
      ...d.receipts.map((r) => ({ sort: `${r.at}`, r })),
      ...d.moves.map((m) => ({ sort: `${m.day} 99`, m })),
    ].sort((a, b) => (a.sort < b.sort ? 1 : -1));
    mount(view,
      h('section.card',
        h('div.fl-head',
          h('div', h('button.sh-link', { type: 'button', onclick: back }, '‹ All floats'),
            h('h1', p.name, ' ', h('span.fl-ref', `FLT/${p.code}`)),
            h('p.small.muted', [p.note, p.active ? 'sends receipts from their own link' : 'link switched off'].filter(Boolean).join(' · '))),
          h('span.sp'),
          h('div.fl-acts',
            h('button.btn.primary', { type: 'button', onclick: () => giveDialog(p, d) }, '＋ Give more'),
            h('button.btn', { type: 'button', onclick: () => backDialog(p, d) }, 'Given back…'),
            h('button.btn', { type: 'button', onclick: () => addFor(p) }, '📷 Add a receipt for them'),
            h('button.btn', { type: 'button', onclick: () => linkDialog(p) }, '🔗 Their link'),
            h('button.btn', { type: 'button', onclick: () => statementDialog(p) }, '⬇ Statement')))),
      said.el,
      h('div.fl-tiles',
        tile('Given', money(d.given)), tile(`Receipts (${d.receipts.filter((r) => r.status !== 'refused').length})`, money(d.spent)),
        tile('Given back', money(d.back)), tile('Still with them', money(d.held))),
      h('section.card',
        h('h2', 'Everything, newest first'),
        lines.length ? h('div.table-wrap', h('table',
          h('thead', h('tr', h('th', 'Day'), h('th', 'What'), h('th.num', 'In / out'), h('th', 'PO in Odoo'), h('th', 'Reference on the PO'), h('th', ''))),
          h('tbody', lines.map(({ r, m }) => (r ? receiptRow(r) : moveRow(m))))))
          : h('p.muted', 'Nothing yet.')));

    function receiptRow(r) {
      const [cls, words] = STATUS[r.status] || ['none', r.status];
      const label = r.vendor ? [h('b', r.vendor), r.description ? ` · ${r.description}` : ''] : h('b', 'Not read yet');
      const notes = [r.hint ? `“${r.hint}”` : null, r.problem, r.status === 'refused' && r.reason ? `Refused: ${r.reason}${r.decidedBy && r.decidedBy !== 'Odoo' ? ` (${r.decidedBy})` : ''}` : null].filter(Boolean);
      const act = h('span.fl-row-acts');
      if (!r.po) {
        act.append(h('button.btn', { type: 'button', onclick: () => fillIn(r) }, 'Fill it in'));
      }
      if (r.status === 'refused') act.append(h('button.btn', { type: 'button', onclick: () => decide(r, false) }, 'Not refused after all'));
      else if (r.status === 'checking') act.append(h('button.btn', { type: 'button', onclick: () => decide(r, true) }, 'Refuse…'));
      return h('tr',
        h('td', dayText(r.day)),
        h('td', r.thumb ? h('img.fl-thumb', { src: r.thumb, alt: '' }) : null, '📄 Receipt · ', label, notes.length ? h('div.fl-note', notes.join(' · ')) : null),
        h('td.num', r.amount != null ? `−${money(r.amount)}` : '—'),
        h('td', r.po ? [r.po.url ? h('a', { href: r.po.url, target: '_blank', rel: 'noopener' }, r.po.name) : r.po.name, ' '] : h('span.fl-note', 'No PO yet'), ' ', chip(cls, words), r.toLookAt ? [' ', chip('over', 'Look at it')] : null),
        h('td', h('span.fl-ref', r.ref)),
        h('td', act));
    }

    function moveRow(m) {
      return h('tr',
        h('td', dayText(m.day)),
        h('td', m.kind === 'given' ? `💵 Given${m.by ? ` by ${m.by}` : ''}${m.sourceText ? ` · ${m.sourceText.toLowerCase()}` : ''}` : '↩ Given back', m.note ? h('div.fl-note', m.note) : null),
        h('td.num', `${m.kind === 'given' ? '+' : '−'}${money(m.amount)}`),
        h('td.fl-note', { colspan: 2 }, 'Not a PO: money handed over'),
        h('td', h('button.sh-link', { type: 'button', onclick: async () => {
          if (!confirm(`Take this out: ${m.kind === 'given' ? 'given' : 'given back'} ${money(m.amount)} on ${dayText(m.day)}?`)) return;
          await api('/floats/undo', { method: 'POST', body: { id: m.id } }); paint(banner('good', 'Taken out.'));
        } }, 'Take out')));
    }

    async function decide(r, refuse) {
      const reason = refuse ? prompt(`Why is ${r.ref} refused? ${p.name} sees this, and it goes back on what they hold.`) : null;
      if (refuse && !reason?.trim()) return;
      try {
        await api('/floats/decide', { method: 'POST', body: { id: r.id, refuse, reason } });
        paint(banner('good', refuse ? `${r.ref} refused: it no longer counts against ${p.name}. Cancel its PO in Odoo if there is one.` : `${r.ref} counts again, being checked.`));
      } catch (err) { paint(banner('problem', err.message)); }
    }

    async function fillIn(r) {
      try {
        const f = await api(`/receipts/${r.receiptId}/file`);
        openNewPo({ receipt: { id: r.receiptId, file: f.file, name: f.name }, after: () => paint(banner('good', `${r.ref} filled in: its PO carries the reference.`)) });
      } catch (err) { paint(banner('problem', err.message)); }
    }
  }

  // ------------------------------------------------------------ dialogs --

  function dialog(title, ...body) {
    const close = () => shade.remove();
    const card = h('div.fl-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.fl-dlg-head', h('h2', title), h('button.btn', { type: 'button', 'aria-label': 'Close', onclick: close }, '✕')), ...body);
    const shade = h('div.fl-dlg', { onclick: (e) => { if (e.target === shade) close(); } }, card);
    document.body.append(shade);
    card.querySelector('input, select')?.focus();
    return close;
  }
  const field = (label, el) => h('label.fl-field', h('span', label), el);
  const sourceSelect = (sources, value = 'safe') => h('select', Object.entries(sources).map(([k, v]) => h('option', { value: k, selected: k === value }, v)));

  /** Give money: to somebody here, or somebody new (their reference and link are made). */
  function giveDialog(p, data) {
    const people = (data.people || []).filter(() => !p);
    const who = p ? null : h('select', h('option', { value: '' }, 'Somebody new…'), people.map((x) => h('option', { value: String(x.id) }, x.name)));
    const name = h('input', { placeholder: 'Their name' });
    const code = h('input', { placeholder: 'KOFI', maxlength: '10', autocapitalize: 'characters' });
    const note = h('input', { placeholder: 'e.g. Market runs this week' });
    const amount = h('input', { inputmode: 'decimal', placeholder: '1000.00' });
    const day = h('input', { type: 'date', value: today() });
    const from = sourceSelect(data.sources);
    const err = h('p.small.form-error');
    const fresh = h('div', h('div.fl-two', field('Name', name), field('Their reference', code)), field('What it is for (optional)', note));
    name.addEventListener('input', () => { if (!code.dataset.typed) code.value = name.value.trim().split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });
    code.addEventListener('input', () => { code.dataset.typed = '1'; });
    who?.addEventListener('change', () => { fresh.hidden = Boolean(who.value); });
    const go = h('button.btn.primary', { type: 'button', onclick: async () => {
      go.disabled = true; err.textContent = '';
      try {
        const personId = p?.id || (who?.value ? Number(who.value) : null);
        const out = await api('/floats/give', { method: 'POST', body: { personId, name: name.value, code: code.value, note: note.value, amount: amount.value, day: day.value, source: from.value } });
        close();
        shown = out.personId;
        paint(banner('good', `Given. ${personId ? '' : 'Send them their link (🔗 Their link) to send receipts from. '}Each receipt becomes a draft PO with their reference.`));
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    } }, 'Give');
    const close = dialog(p ? `＋ Give ${p.name} more` : '＋ Give money',
      h('p.small.muted', 'Who, how much, and from where. Their reference goes on every PO their receipts make.'),
      p ? null : field('Person', who), p ? null : fresh,
      h('div.fl-two', field('Amount (GH₵)', amount), field('Given on', day)),
      field('From', from), err, h('div.fl-dlg-acts', go));
  }

  function backDialog(p, d) {
    const amount = h('input', { inputmode: 'decimal', value: d.held > 0 ? (d.held / 100).toFixed(2) : '' });
    const day = h('input', { type: 'date', value: today() });
    const to = sourceSelect(d.sources);
    const note = h('input', { placeholder: 'Optional' });
    const err = h('p.small.form-error');
    const go = h('button.btn.primary', { type: 'button', onclick: async () => {
      go.disabled = true;
      try {
        await api('/floats/back', { method: 'POST', body: { personId: p.id, amount: amount.value, day: day.value, source: to.value, note: note.value } });
        close(); paint(banner('good', 'Given back: off what they hold.'));
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    } }, 'Record it');
    const close = dialog(`↩ ${p.name} gave money back`,
      h('p.small.muted', `They hold ${money(d.held)}.`),
      h('div.fl-two', field('Amount (GH₵)', amount), field('On', day)), field('Back into', to), field('Note', note), err, h('div.fl-dlg-acts', go));
  }

  function linkDialog(p) {
    const box = h('input', { readonly: true, value: p.slug ? shortOf(p.slug) : (p.token ? linkOf(p.token) : '') });
    const said = h('p.small');
    const copy = h('button.btn.primary', { type: 'button', onclick: () => { box.select(); navigator.clipboard?.writeText(box.value).then(() => { said.textContent = 'Copied: send it by SMS or WhatsApp.'; }).catch(() => {}); } }, 'Copy');
    // The ending is theirs to change: the first four letters of their name unless an admin chose another.
    const ending = h('input', { value: p.slug || '', maxlength: 30, 'aria-label': 'The link’s ending', placeholder: 'igna' });
    const change = h('button.btn', { type: 'button', onclick: async () => {
      if (!confirm(`Change ${p.name}’s link to /float/${ending.value.trim().toLowerCase() || '…'}? Their old link stops working at once.`)) return;
      change.disabled = true;
      try {
        const out = await api('/floats/link', { method: 'POST', body: { personId: p.id, slug: ending.value } });
        p.token = out.token; p.slug = out.slug; ending.value = out.slug; box.value = shortOf(out.slug);
        said.textContent = 'Changed: send them the new link. The old one no longer works.';
      } catch (e) { said.textContent = e.message; }
      change.disabled = false;
    } }, 'Change the link');
    const off = h('button.btn', { type: 'button', onclick: async () => {
      await api('/floats/link', { method: 'POST', body: { personId: p.id, active: !p.active } });
      close(); paint(banner('good', p.active ? 'Their link is switched off: no more receipts from it.' : 'Their link works again.'));
    } }, p.active ? 'Switch it off' : 'Switch it on');
    const close = dialog(`🔗 ${p.name}’s link`,
      h('p.small.muted', 'They open it on their phone to see what they hold and send a picture of each receipt. No login: whoever has or guesses the link can see what they hold and send receipts as them. If that worries you, choose a less obvious ending.'),
      box, said,
      h('div.fl-slug', h('span.small', `${location.host}/float/`), ending, change),
      h('div.fl-dlg-acts', copy, off));
  }

  function statementDialog(p) {
    const now = today();
    const from = h('input', { type: 'date', value: `${now.slice(0, 7)}-01` });
    const to = h('input', { type: 'date', value: now });
    const url = (format) => `/api/floats/${p.id}/statement?from=${from.value}&to=${to.value}${format ? `&format=${format}` : ''}`;
    dialog(`⬇ ${p.name}’s statement`,
      h('p.small.muted', 'What they held at the start, everything given, spent and given back, and what they hold at the end.'),
      h('div.fl-two', field('From', from), field('To', to)),
      h('div.fl-dlg-acts',
        h('button.btn.primary', { type: 'button', onclick: () => window.open(url(''), '_blank', 'noopener') }, 'Open to print or save as PDF'),
        h('button.btn', { type: 'button', onclick: () => { location.href = url('csv'); } }, 'Spreadsheet (CSV)')));
  }

  /** A receipt they handed over on paper: photographed here, for them. */
  function addFor(p) {
    const pick = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true });
    const hint = h('input', { placeholder: 'What it was for (optional)' });
    const out = h('div.fl-note');
    pick.addEventListener('change', async () => {
      for (const f of pick.files) {
        out.append(h('div', `Reading ${f.name}…`));
        try {
          const file = f.type === 'application/pdf' ? await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); }) : await shrink(f);
          const thumb = file.startsWith('data:image') ? await thumbOf(file).catch(() => null) : null;
          // eslint-disable-next-line no-await-in-loop
          const res = await api('/floats/add', { method: 'POST', body: { personId: p.id, file, thumb, name: f.name, hint: hint.value } });
          out.lastChild.textContent = res.duplicate ? `${f.name}: sent before, counted once.` : `${f.name}: ${res.ref}${res.receipt?.po ? ` · ${res.receipt.po.name}` : ' · could not be read: Fill it in'}`;
        } catch (e) { out.lastChild.textContent = `${f.name}: ${e.message}`; }
      }
      pick.value = '';
    });
    dialog(`📷 A receipt for ${p.name}`,
      h('p.small.muted', 'Each becomes a draft PO with their next reference, as if they had sent it.'),
      field('What it was for', hint), pick,
      h('div.fl-dlg-acts', h('button.btn.primary', { type: 'button', onclick: () => pick.click() }, 'Choose pictures or PDFs'), h('button.btn', { type: 'button', onclick: () => { document.querySelector('.fl-dlg')?.remove(); paint(); } }, 'Done')),
      out);
  }
}
