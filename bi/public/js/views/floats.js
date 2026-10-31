import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { state } from '../app.js';
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
const COLOURS = ['#4f46e5', '#0e9f8a', '#b45309', '#be185d', '#2a78d6', '#7c3aed'];
const avatar = (name, i, big = false) => h(`span.fl-av${big ? '.big' : ''}`, { style: `background:${COLOURS[Math.max(0, i) % COLOURS.length]}` }, String(name || '?').trim().charAt(0).toUpperCase());

let shown = null; // the person open, or null for everybody

export async function renderFloats(root) {
  shown = null;
  const view = h('div.fl');
  mount(root, view);
  const said = { el: null };
  await paint();

  async function paint(message = null) {
    said.el = message;
    let data;
    try { data = await api('/floats'); } catch (err) { mount(view, banner('problem', err.message)); return; }
    const t = data.tiles;
    // On a wide screen somebody is always open beside the list: whoever needs looking at first.
    const wide = window.matchMedia?.('(min-width: 900px)').matches;
    if (shown && !data.people.some((p) => p.id === shown)) shown = null;
    if (!shown && wide && data.people.length) shown = (data.people.find((p) => p.toLookAt || p.quiet) || data.people[0]).id;
    const detail = h('div.fl-detail');
    mount(view,
      h('div.fl-head', h('h1', 'Floats'), h('span.sp'), h('button.btn.primary', { type: 'button', onclick: () => giveDialog(null, data) }, '＋ Give money')),
      h('p.small.muted.fl-intro', 'Money given to people to spend. Each receipt they send from their own link becomes a draft PO in Odoo, marked with their reference, and comes off what they hold.'),
      said.el,
      h('div.fl-tiles',
        tile('With people now', money(t.held)), tile('Spent this month', money(t.spentThisMonth)),
        tile('Receipts to look at', String(t.toLookAt), t.toLookAt ? 'bad' : ''), tile('Over 14 days, nothing sent', String(t.quiet), t.quiet ? 'bad' : '')),
      data.people.length
        ? h(`div.fl-split${shown ? '.picked' : ''}`, h('div.fl-people', data.people.map((p, i) => personCard(p, i))), detail)
        : h('section.card', h('p', 'Nobody holds a float yet. ', h('button.sh-link', { type: 'button', onclick: () => giveDialog(null, data) }, 'Give money'), ' to start.')));
    if (shown) await person(shown, detail, data.people.findIndex((p) => p.id === shown));
  }

  function personCard(p, i) {
    const flag = p.toLookAt ? chip('over', `${p.toLookAt} to look at`) : p.quiet ? chip('short', `${p.quiet} days, nothing sent`)
      : p.held === 0 && p.given ? chip('ok', '✓ Settled') : !p.active ? chip('none', 'Link switched off') : null;
    return h(`button.fl-pcard${shown === p.id ? '.on' : ''}`, { type: 'button', onclick: () => { shown = p.id; paint(); } },
      h('div.fl-prow', avatar(p.name, i), h('div.fl-pname', h('b', p.name), p.note ? h('small', p.note) : null), h('span.sp'),
        h('div.fl-pheld', h('b', money(p.held)), h('small', 'with them'))),
      bar(p), flag ? h('div', flag) : null);
  }

  function bar(p) {
    return h('div.fl-bar',
      h('i', { style: `width:${p.given ? Math.min(100, (p.spent / p.given) * 100) : 0}%;background:var(--accent, #4f46e5)` }),
      h('i', { style: `width:${p.given ? Math.min(100, (p.back / p.given) * 100) : 0}%;background:var(--series-3)` }));
  }

  function tile(label, value, tone = '') {
    return h('div.fl-tile', h('small', label), h(`b${tone ? `.${tone}` : ''}`, value));
  }

  /** One person, beside the list: totals, what to do, their link, everything newest first. */
  async function person(id, box, index) {
    let d;
    try { d = await api(`/floats/${id}`); } catch (err) { mount(box, banner('problem', err.message)); return; }
    const p = d.person;
    const link = p.slug ? shortOf(p.slug) : (p.token ? linkOf(p.token) : '');
    const copied = h('small.muted');
    const lines = [
      ...d.receipts.map((r) => ({ sort: `${r.day} 1 ${r.at}`, r })),
      ...d.moves.map((m) => ({ sort: `${m.day} 0 ${String(m.id).padStart(9, '0')}`, m })),
    ].sort((a, b) => (a.sort < b.sort ? 1 : -1));
    mount(box,
      h('button.sh-link.fl-back', { type: 'button', onclick: () => { shown = null; paint(); } }, '‹ Everybody'),
      h('div.fl-dhead', avatar(p.name, index, true),
        h('div', h('h2', p.name, ' ', h('span.fl-ref', `FLT/${p.code}`)),
          h('p.small.muted', [p.note, p.active ? 'sends receipts from their own link' : 'link switched off'].filter(Boolean).join(' · ')))),
      h('div.fl-d4',
        h('div', h('small', 'Given'), h('b', money(d.given))),
        h('div', h('small', `Spent · ${d.receipts.filter((r) => r.status !== 'refused').length} receipts`), h('b', money(d.spent))),
        h('div', h('small', 'Given back'), h('b', money(d.back))),
        h('div.end', h('small', 'With them'), h('b', money(d.held)))),
      h('div.fl-acts',
        h('button.btn.primary', { type: 'button', onclick: () => giveDialog(p, d) }, '＋ Give more'),
        h('button.btn', { type: 'button', onclick: () => backDialog(p, d) }, 'Given back…'),
        h('button.btn', { type: 'button', onclick: () => addFor(p) }, '📷 Add a receipt'),
        h('button.btn', { type: 'button', onclick: () => statementDialog(p) }, '⬇ Statement')),
      h('div.fl-linkbox', '🔗 ', h('code', link.replace(/^https?:\/\//, '')),
        h('button.btn', { type: 'button', onclick: () => navigator.clipboard?.writeText(link).then(() => { copied.textContent = 'Copied: send it by SMS or WhatsApp.'; }).catch(() => {}) }, 'Copy'),
        h('button.btn', { type: 'button', onclick: () => linkDialog(p) }, 'Change…'), copied),
      lines.length ? h('div.fl-list', lines.map(({ r, m }) => (r ? receiptItem(r) : moveItem(m)))) : h('p.muted', 'Nothing yet.'));

    function receiptItem(r) {
      const [cls, words] = STATUS[r.status] || ['none', r.status];
      const refused = r.status === 'refused';
      const act = h('div.fl-iacts');
      if (r.po?.url) act.append(h('a.btn', { href: r.po.url, target: '_blank', rel: 'noopener' }, `Open ${r.po.name} in Odoo`));
      else if (r.po) act.append(h('span.fl-note', r.po.name));
      if (!r.po) act.append(h('button.btn', { type: 'button', onclick: () => fillIn(r) }, 'Fill it in'));
      if (refused) act.append(h('button.btn', { type: 'button', onclick: () => decide(r, false) }, 'Not refused after all'));
      else if (r.status === 'checking') act.append(h('button.btn', { type: 'button', onclick: () => decide(r, true) }, 'Refuse…'));
      act.append(h('button.btn', { type: 'button', onclick: () => seeReceipt(r) }, 'See the receipt'));
      return h('div.fl-item',
        r.thumb ? h('img.fl-ico', { src: r.thumb, alt: '' }) : h(`div.fl-ico${refused ? '.no' : ''}`, '🧾'),
        h('div', h('b', r.vendor || 'Not read yet'), h('small', [dayText(r.day), r.description, r.ref].filter(Boolean).join(' · ')),
          h('div', chip(cls, words), r.toLookAt ? [' ', chip('over', 'Look at it')] : null)),
        h(`div.fl-amt${refused ? '.off' : ''}`, r.amount != null ? `−${money(r.amount)}` : '—'),
        r.hint ? h('div.fl-memo', `“${r.hint}”`) : null,
        r.problem ? h('div.fl-memo', r.problem) : null,
        refused && r.reason ? h('div.fl-memo.why', `Why: ${r.reason}${r.decidedBy && r.decidedBy !== 'Odoo' ? ` (${r.decidedBy})` : ''}`) : null,
        r.change ? changeBox(r) : null,
        act);
    }

    /** Its PO changed in Odoo to another total: what the person said, and the admin's answer, which stands. */
    function changeBox(r) {
      const c = r.change;
      const theirs = !c.asksHolder ? `changed more than 30 days after ${p.name} sent it: yours to decide`
        : { accept: `${p.name} accepted it${c.holderNote ? `: “${c.holderNote}”` : ''}`, dispute: `${p.name} says it is not right` }[c.holder] || `${p.name} has not answered yet`;
      const answer = (value) => async () => {
        try { await api('/floats/amount', { method: 'POST', body: { id: r.id, answer: value } }); paint(banner('good', value === 'accept' ? `${r.ref}: ${money(c.now)} counts.` : value === 'keep' ? `${r.ref}: the receipt’s ${money(c.was)} counts.` : `${r.ref}: your answer is taken off.`)); } catch (err) { paint(banner('problem', err.message)); }
      };
      return h('div.fl-memo.ask',
        h('b', `PO changed in Odoo: ${money(c.was)} → ${money(c.now)}`), ` · ${theirs}. `,
        c.admin ? [h('span', c.admin === 'accept' ? `${money(c.now)} counts` : `The receipt’s ${money(c.was)} counts`, c.adminBy ? ` (${c.adminBy})` : '', '. '), h('button.sh-link', { type: 'button', onclick: answer('') }, 'Change')]
          : h('span.fl-askbtns', h('button.btn.primary', { type: 'button', onclick: answer('accept') }, `Accept ${money(c.now)}`), h('button.btn', { type: 'button', onclick: answer('keep') }, `Keep ${money(c.was)}`)));
    }

    /** The note on money given or given back: shown, and added or changed in place. It goes on their page and statement. */
    function noteBox(m) {
      const box = h('div.fl-memo.fl-mnote');
      const show = () => {
        box.classList.toggle('blank', !m.note);
        mount(box,
          m.note ? [m.note, m.noteBy ? h('span.fl-noteby', ` · ${m.noteBy}`) : null, ' '] : null,
          h('button.sh-link', { type: 'button', onclick: edit }, m.note ? 'change' : '＋ Add a note'));
      };
      const edit = () => {
        const input = h('input', { value: m.note || '', maxlength: 300, placeholder: 'What this money was for, who asked, anything to remember' });
        const save = h('button.btn', { type: 'button', onclick: async () => {
          save.disabled = true;
          try {
            const out = await api('/floats/note', { method: 'POST', body: { id: m.id, note: input.value } });
            m.note = out.note; m.noteBy = out.note ? (state.me?.account?.name || 'you') : null; show();
          } catch (e) { alert(e.message); save.disabled = false; }
        } }, 'Save');
        mount(box, h('div.fl-noteedit', input, save, h('button.sh-link', { type: 'button', onclick: show }, 'Cancel')));
        input.focus();
      };
      show();
      return box;
    }

    function moveItem(m) {
      const given = m.kind === 'given';
      return h('div.fl-item',
        h(`div.fl-ico.${given ? 'in' : 'out'}`, given ? '↓' : '↑'),
        h('div', h('b', given ? 'Given' : 'Given back'),
          h('small', [dayText(m.day), m.sourceText ? `${given ? 'from' : 'into'} ${m.sourceText.charAt(0).toLowerCase()}${m.sourceText.slice(1)}` : null, given && m.by ? `by ${m.by}` : null].filter(Boolean).join(' · '))),
        h(`div.fl-amt${given ? '.in' : ''}`, `${given ? '+' : '−'}${money(m.amount)}`),
        noteBox(m),
        h('div.fl-iacts', h('button.sh-link', { type: 'button', onclick: async () => {
          if (!confirm(`Take this out: ${given ? 'given' : 'given back'} ${money(m.amount)} on ${dayText(m.day)}?`)) return;
          await api('/floats/undo', { method: 'POST', body: { id: m.id } }); paint(banner('good', 'Taken out.'));
        } }, 'Take out')));
    }

    async function seeReceipt(r) {
      const w = window.open('', '_blank');
      try {
        const f = await api(`/receipts/${r.receiptId}/file`);
        if (!w) return;
        w.document.title = r.ref;
        w.document.body.style.margin = '0';
        const el = w.document.createElement(String(f.file).startsWith('data:application/pdf') ? 'iframe' : 'img');
        el.src = f.file;
        el.style.cssText = 'width:100%;max-width:900px;display:block;margin:0 auto;border:0;' + (el.tagName === 'IFRAME' ? 'height:100vh' : '');
        w.document.body.append(el);
      } catch (err) { w?.close(); paint(banner('problem', err.message)); }
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
    // A note on this money in particular: on their page and their statement.
    const moveNote = h('input', { maxlength: 300, placeholder: 'e.g. For the generator repair, Tuesday' });
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
        const out = await api('/floats/give', { method: 'POST', body: { personId, name: name.value, code: code.value, note: note.value, moveNote: moveNote.value, amount: amount.value, day: day.value, source: from.value } });
        close();
        shown = out.personId;
        paint(banner('good', `Given. ${personId ? '' : 'Send them their link (🔗 Their link) to send receipts from. '}Each receipt becomes a draft PO with their reference.`));
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    } }, 'Give');
    const close = dialog(p ? `＋ Give ${p.name} more` : '＋ Give money',
      h('p.small.muted', 'Who, how much, and from where. Their reference goes on every PO their receipts make.'),
      p ? null : field('Person', who), p ? null : fresh,
      h('div.fl-two', field('Amount (GH₵)', amount), field('Given on', day)),
      field('From', from), field('Note on this money (shows on their statement)', moveNote), err, h('div.fl-dlg-acts', go));
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
        paint();
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
