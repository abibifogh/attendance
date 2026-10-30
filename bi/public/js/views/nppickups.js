import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';
import { shrink, thumbOf } from './newpo.js';
import { canInstall, onInstallChange } from '../install.js';
import { installNow } from '../app.js';

/**
 * Front desk › Nice Place › Pickups.
 *
 * For the supervisor who takes the envelopes: the shifts in the safe, ticked;
 * what was paid out of them, each with its receipt (a draft PO in Odoo, like
 * a float's); and the money: sales less spent is the net cash, against what
 * was counted. For an admin: every pickup to review, Approve or Ask.
 */
const SHIFT = { day: 'Day', night: 'Night' };
const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const STATUS = { review: ['warn', '! To review'], approved: ['good', '✓ Approved'], asked: ['info', '? Asked'] };

export async function renderPickups(root) {
  const view = h('div.pu');
  mount(root, view);
  let data = null;
  let flash = null;
  let picked = null;
  let openRow = null;
  onInstallChange(() => { if (view.isConnected && data) paint(); });
  await load();

  async function load(message = null) {
    flash = message;
    try { data = await api('/np/pickups'); } catch (err) { mount(view, banner('problem', err.message)); return; }
    // Every shift in the safe is ticked to begin with.
    if (!picked || !data.open) picked = new Set(data.inSafe.map((s) => s.key));
    else picked = new Set([...picked].filter((k) => data.inSafe.some((s) => s.key === k)));
    paint();
  }

  const act = async (path, body, message) => {
    try { await api(path, { method: 'POST', body }); await load(message); } catch (err) { alert(err.message); }
  };

  function paint() {
    const t = data.tiles;
    mount(view,
      flash ? banner('good', flash) : null,
      // Pickups are made on a phone: Insight on its home screen opens with one tap.
      canInstall() ? h('div.pu-install', h('span', h('b', '📲 Put Insight on this phone'), ' and it opens with one tap, like any other app.'),
        h('button.btn.primary', { type: 'button', onclick: installNow }, 'Install')) : null,
      h('div.pu-tiles',
        tile('Sales this month', money(t.sales, { places: 0 }), 'picked up'),
        tile('Spent from it', money(t.spent, { places: 0 }), 'with receipts'),
        tile('Cash counted', money(t.counted, { places: 0 }), 'into the safe'),
        tile('Still in the safe', money(t.inSafe, { places: 0 }), `${t.inSafeShifts} shift${t.inSafeShifts === 1 ? '' : 's'}`)),
      data.open ? pickupForm(data.open) : h('section.card.pu-start',
        h('div', h('h2', 'Take the envelopes'), h('p.sub', data.inSafe.length ? `${data.inSafe.length} shift${data.inSafe.length === 1 ? '' : 's'} sent since the last pickup, ${money(t.inSafe)} in all.` : 'Nothing sent since the last pickup.')),
        h('button.btn.primary', { type: 'button', disabled: !data.inSafe.length, onclick: () => act('/np/pickups/start', {}, null) }, 'Start a pickup')),
      data.missing.length ? h('section.card.pu-missing', h('h2', `Shifts with no sales sent · ${data.missing.length}`),
        h('p.sub', 'Since the last pickup. Ask whoever was on to send them from the Nice Place link.'),
        h('div.pu-chips', data.missing.slice(-20).map((m) => h('span.pu-chip.bad', `${day(m.day)} · ${SHIFT[m.shift]}`)))) : null,
      h('section.card',
        h('h2', 'Pickups'),
        data.pickups.length ? h('div.table-wrap', h('table.pu-table',
          h('thead', h('tr', ['Pickup', 'By', 'Shifts', 'Sales', 'Spent', 'Net cash', 'Counted', ''].map((x, i) => h(i >= 3 && i <= 6 ? 'th.num' : 'th', x)))),
          h('tbody', data.pickups.flatMap((p) => [
            h('tr.pu-row', { class: openRow === p.id ? 'on' : '', onclick: () => { openRow = openRow === p.id ? null : p.id; paint(); } },
              h('td', h('b', day(p.day))), h('td', p.by), h('td', spanOf(p.shifts)),
              h('td.num', money(p.sales)), h('td.num', money(p.spent)), h('td.num', h('b', money(p.net))),
              h('td.num', money(p.counted), p.difference ? h('span.pu-diff', ` ${p.difference > 0 ? '+' : '−'}${money(Math.abs(p.difference))}`) : h('span.pu-ok', ' ✓')),
              h('td', h(`span.pu-st.${STATUS[p.status]?.[0] || 'info'}`, STATUS[p.status]?.[1] || p.status))),
            openRow === p.id ? h('tr.pu-detail', h('td', { colspan: 8 }, detail(p))) : null,
          ])))) : h('p.muted', 'No pickups yet.')));
  }

  function detail(p) {
    const ask = h('input', { type: 'text', placeholder: 'What to ask', 'aria-label': 'What to ask' });
    return h('div.pu-det',
      h('div', h('h3', 'Shifts'), p.shifts.map((s) => h('div.pu-li', h('span', `${day(s.day)} · ${SHIFT[s.shift]}`), h('span.num', money(s.amount))))),
      h('div', h('h3', 'Spent'), p.expenses.length ? p.expenses.map((e) => h('div.pu-li', h('span', e.what, h('small', ` ${e.ref}${e.po ? ` · ${e.po}` : e.problem ? ' · no PO yet' : ''}`)), h('span.num', money(e.amount)))) : h('p.small.muted', 'Nothing.'),
        p.note ? [h('h3', 'Why the count differs'), h('p.small', p.note)] : null),
      h('div',
        p.reviewedBy ? h('p.small.muted', `${STATUS[p.status]?.[1] || p.status} by ${p.reviewedBy}${p.reviewNote ? `: “${p.reviewNote}”` : ''}`) : null,
        data.admin ? h('div.pu-acts',
          p.status !== 'approved' ? h('button.btn.primary', { type: 'button', onclick: () => act('/np/pickups/review', { id: p.id, decision: 'approve' }, 'Pickup approved.') }, 'Approve') : null,
          ask, h('button.btn', { type: 'button', onclick: () => act('/np/pickups/review', { id: p.id, decision: 'ask', note: ask.value }, `Asked ${p.by}.`) }, `Ask ${p.by}`)) : null));
  }

  /** The pickup being made: envelopes, what was spent, the money. */
  function pickupForm(p) {
    const sales = data.inSafe.filter((s) => picked.has(s.key)).reduce((t, s) => t + s.amount, 0);
    const net = sales - p.spent;
    const counted = h('input', { inputmode: 'decimal', placeholder: (net / 100).toFixed(2), 'aria-label': 'Cash counted' });
    const note = h('input', { type: 'text', placeholder: 'e.g. one envelope GH₵ 10 short', 'aria-label': 'Why it is different' });
    const diff = h('p.small');
    const showDiff = () => {
      const c = Math.round(Number(counted.value.replace(/[\s,]/g, '')) * 100);
      if (!counted.value.trim() || !Number.isFinite(c)) { diff.textContent = ''; return; }
      const d = c - net;
      diff.textContent = d === 0 ? '✓ The same as the net cash.' : `${money(Math.abs(d))} ${d < 0 ? 'short of' : 'over'} the net cash. Say why:`;
      diff.className = d === 0 ? 'small pu-ok' : 'small pu-diff';
    };
    counted.addEventListener('input', showDiff);
    return h('section.card.pu-form',
      h('div.pu-formhead', h('h2', 'Pickup'), h('span.small.muted', `started by ${p.by} on ${day(p.day)}`)),
      h('div.pu-grid',
        h('div',
          h('h3', '1 · Envelopes in the safe'),
          h('p.small.muted', 'Untick any not in the safe.'),
          h('div.pu-envs', data.inSafe.map((s) => h('label.pu-env',
            h('input', { type: 'checkbox', checked: picked.has(s.key), onchange: (e) => { if (e.target.checked) picked.add(s.key); else picked.delete(s.key); paint(); } }),
            h('span', h('b', `${day(s.day)} · ${SHIFT[s.shift]}`), h('small', s.staff || '')),
            h('span.num', money(s.amount)))))),
        h('div',
          h('h3', '2 · Paid from this money'),
          h('p.small.muted', 'Each becomes a draft PO in Odoo, with its receipt.'),
          p.expenses.map((e) => h('div.pu-exp',
            h('span', h('b', e.what), h('small', [e.supplier, e.ref, e.po ? `PO ${e.po} draft` : e.problem ? 'no PO yet: see Receipts' : null].filter(Boolean).join(' · '))),
            h('span.num', money(e.amount)),
            h('button.btn.ghost', { type: 'button', 'aria-label': `Take off ${e.what}`, onclick: () => { if (window.confirm(`Take “${e.what}” off? Its draft PO stays in Odoo: cancel it there.`)) act('/np/pickups/expense/remove', { id: e.id }, null); } }, '×'))),
          expenseForm(p)),
        h('div',
          h('h3', '3 · The money'),
          h('div.pu-net',
            h('div', h('span', `Sales, ${picked.size} shift${picked.size === 1 ? '' : 's'}`), h('b.num', money(sales))),
            h('div', h('span', `Spent, ${p.expenses.length} receipt${p.expenses.length === 1 ? '' : 's'}`), h('b.num', `− ${money(p.spent)}`)),
            h('div.net', h('span', 'Net cash'), h('b.num', money(net)))),
          h('label.pu-f', 'Counted', counted), diff, h('label.pu-f', 'If different, why', note),
          h('p.small.muted', 'It goes into the main safe’s book, and to an admin to review.'),
          h('button.btn.primary.pu-record', {
            type: 'button',
            onclick: () => act('/np/pickups/record', { pickupId: p.id, shifts: [...picked], counted: counted.value, note: note.value }, 'Pickup recorded: it is in the safe’s book and waits for an admin.'),
          }, 'Record the pickup'))));
  }

  function expenseForm(p) {
    const what = h('input', { type: 'text', placeholder: 'What, e.g. bleach', 'aria-label': 'What it was' });
    const amount = h('input', { inputmode: 'decimal', placeholder: 'GH₵', 'aria-label': 'Amount' });
    const supplier = h('input', { type: 'text', placeholder: 'From whom', 'aria-label': 'From whom' });
    const file = h('input', { type: 'file', accept: 'image/*,application/pdf', capture: 'environment', hidden: true });
    const pic = h('button.btn.pu-cam', { type: 'button', onclick: () => file.click() }, '📷 Picture of the receipt');
    let chosen = null;
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      chosen = f.type === 'application/pdf' ? await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); }) : await shrink(f);
      pic.textContent = '✓ Receipt chosen';
    });
    const add = h('button.btn', {
      type: 'button',
      onclick: async () => {
        if (!chosen) { alert('Take a picture of the receipt first.'); return; }
        add.disabled = true; add.textContent = 'Reading the receipt…';
        const thumb = chosen.startsWith('data:image') ? await thumbOf(chosen).catch(() => null) : null;
        await act('/np/pickups/expense', { pickupId: p.id, what: what.value, amount: amount.value, supplier: supplier.value, file: chosen, thumb }, null);
      },
    }, '＋ Add');
    return h('div.pu-add', what, h('div.pu-two', amount, supplier), file, pic, add);
  }
}

function tile(label, big, small) {
  return h('div.pu-tile', h('small', label), h('b.num', big), h('span', small));
}

function spanOf(shifts) {
  if (!shifts.length) return '';
  const first = shifts[0].day;
  const last = shifts[shifts.length - 1].day;
  const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${first === last ? fmt(first) : `${fmt(first)}–${fmt(last)}`} · ${shifts.length}`;
}
