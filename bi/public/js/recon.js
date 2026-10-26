/**
 * A shift's reconciliation report, as a page of its own to print, save as a
 * PDF or download: what the drawer, card and MoMo, expenses, the desk's
 * stock and the laundry came to, against what was found, and every
 * difference with where it stands.
 *
 * Three layouts of the same figures:
 * - statement: an accountant's reconciliation, top to bottom, with sign-off lines;
 * - bridge: bars from where each figure started to what was found;
 * - checklist: one row per check, ASSD against what was found, ticked or not.
 *
 * Pure: it takes the report's figures (made on the Shifts screen, see
 * reconOf there) and returns the page as text, so it is tested on its own.
 * Amounts are in pesewas.
 */

export const LAYOUTS = [
  { id: 'statement', name: 'The statement', about: 'Reads top to bottom like an accountant’s reconciliation. One A4 page, with lines to sign.' },
  { id: 'bridge', name: 'The bridge', about: 'Bars from where each figure started to what was found. Best on a screen.' },
  { id: 'checklist', name: 'The checklist', about: 'One row per check, ASSD against what was found, ticked or not. Quickest to scan.' },
];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** 120300 → "1,203.00"; minus with a true minus sign. */
export const amount = (minor) => (minor == null ? '—' : `${minor < 0 ? '−' : ''}${(Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (minor) => (minor == null ? '—' : minor === 0 ? '0.00' : `${minor > 0 ? '+' : '−'}${amount(Math.abs(minor))}`);
const bracket = (minor) => (minor < 0 ? `(${amount(-minor)})` : amount(minor));
const tone = (minor) => (minor == null ? '' : minor === 0 ? 'good' : minor < 0 ? 'bad' : 'warn');

const STATE = {
  answer: ['bad', 'Answer needed'],
  approve: ['warn', 'Admin to approve'],
  done: ['good', 'Answered'],
  info: ['none', 'Explains the drawer'],
};
const chip = (state, words = null) => `<span class="chip ${STATE[state]?.[0] || 'none'}">${esc(words || STATE[state]?.[1] || '')}</span>`;

/** How many differences wait on an answer, and on an admin. */
export function counts(m) {
  const d = m.diffs || [];
  return { answer: d.filter((x) => x.state === 'answer').length, approve: d.filter((x) => x.state === 'approve').length, all: d.filter((x) => x.state !== 'info').length };
}

/** The drawer's difference in words: short, over, or agrees. */
function drawerWord(dr) {
  if (!dr || dr.variance == null) return 'No closing count';
  return dr.variance === 0 ? 'Agrees' : dr.variance < 0 ? 'Short' : 'Over';
}

/** Every check, ASSD against what was found, for the checklist and the summary. */
export function checks(m) {
  const out = [];
  const dr = m.drawer;
  if (dr) {
    const settled = dr.settled && dr.variance;
    out.push({
      group: 'Cash', state: dr.variance == null ? 'none' : dr.variance === 0 || settled ? 'good' : 'bad',
      mark: dr.variance == null ? '–' : dr.variance === 0 || settled ? '✓' : '!',
      title: 'Drawer at the close',
      sub: `${dr.steps.map((x, i) => `${x.kind === 'start' ? '' : x.kind === 'out' ? '− ' : '+ '}${i ? x.label.charAt(0).toLowerCase() + x.label.slice(1) : x.label} ${amount(x.amount)}`).join(' ')}.${dr.countedRef ? ` Count ${dr.countedRef}.` : ''}${settled ? ` ${dr.settled}.` : dr.variance ? ' Answer needed.' : ''}`,
      assd: dr.expected, found: dr.counted, diff: dr.variance,
    });
    if (dr.handover) {
      out.push({
        group: 'Cash', state: dr.handover.gap ? 'bad' : 'good', mark: dr.handover.gap ? '!' : '✓',
        title: 'Hand-over from the shift before', sub: `${dr.handover.from}’s closing count against this shift’s first.`,
        assd: dr.handover.before, found: dr.handover.first, diff: dr.handover.gap,
      });
    }
  }
  for (const x of (m.diffs || []).filter((d) => d.kind === 'keyed-no-cash')) {
    out.push({ group: 'Cash', state: 'warn', mark: '≡', title: 'Cash keyed while the counts stood still', sub: x.text, assd: x.amount, found: 0, diff: null, note: 'with the drawer' });
  }
  if (m.card) {
    for (const x of m.card.items) {
      out.push({
        group: 'Card & MoMo', state: x.state === 'done' ? 'good' : x.state === 'approve' ? 'warn' : 'bad', mark: x.state === 'done' ? '✓' : x.state === 'approve' ? '?' : '!',
        title: `${x.label}${x.ref ? ` · ${x.ref}` : ''}`, sub: `${x.text || ''}${x.said ? ` ${x.said}` : ''}`.trim(), assd: x.assd, found: x.found, diff: x.amount,
      });
    }
    out.push({
      group: 'Card & MoMo', state: 'good', mark: '✓', title: `The other ${m.card.matched} line${m.card.matched === 1 ? '' : 's'}`,
      sub: 'Each matched to a payment on the card machine or MoMo.', assd: m.card.matchedAmount, found: m.card.matchedAmount, diff: 0,
    });
  }
  if (m.expenses) {
    const e = m.expenses;
    const ok = e.difference === 0;
    out.push({
      group: 'Expenses, stock, laundry', state: e.poTotal == null ? 'none' : ok ? 'good' : 'bad', mark: e.poTotal == null ? '–' : ok ? '✓' : '!',
      title: 'Expenses against POs', sub: e.orders.length ? e.orders.map((o) => `${o.name} · ${o.vendor || ''}${o.ok ? '' : ' (not approved in Odoo)'}`).join('; ') : 'No PO numbers yet.',
      assd: e.amount, found: e.poTotal, diff: e.difference,
    });
  }
  for (const g of m.goods || []) {
    out.push({
      group: 'Expenses, stock, laundry', state: g.diff == null ? 'none' : g.diff === 0 ? 'good' : 'bad', mark: g.diff == null ? '–' : g.diff === 0 ? '✓' : '!',
      title: g.name, sub: `${g.start ?? '—'} at the start, ${g.out} out, ${g.back} back${g.end != null ? `, ${g.end} counted at the end` : ''}.`,
      assd: g.should, found: g.end, diff: g.diff, count: true,
    });
  }
  if (m.laundry) {
    const l = m.laundry;
    out.push({
      group: 'Expenses, stock, laundry', state: l.system == null ? 'none' : l.difference === 0 ? 'good' : 'bad', mark: l.system == null ? '–' : l.difference === 0 ? '✓' : '!',
      title: 'Laundry', sub: l.system == null ? 'The laundry system has not been read for this shift.' : 'ASSD against the laundry system, same hours.',
      assd: l.assd, found: l.system, diff: l.difference,
    });
  }
  return out;
}

// ------------------------------------------------------------ the page --

const CSS = `
:root { --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781; --grid:#e1e0d9; --border:rgba(11,11,11,.12); --surface:#fff; --surface-2:#f2f1ed;
  --good:#12a150; --good-ink:#0b6b35; --warn:#e8a10c; --warn-ink:#8a5a00; --bad:#d33a3a; --bad-ink:#a32121; --blue:#2a78d6; }
* { box-sizing:border-box; }
html { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { margin:0; background:#f9f9f7; color:var(--ink); font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif; }
.page { max-width:860px; margin:0 auto; padding:24px 16px 48px; }
.num { font-variant-numeric:tabular-nums; }
.muted { color:var(--muted); } .good { color:var(--good-ink); } .warn { color:var(--warn-ink); } .bad { color:var(--bad-ink); }
.chip { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; font-weight:600; white-space:nowrap; }
.chip.good { background:#e3f4ea; color:var(--good-ink); } .chip.warn { background:#fdf1d6; color:var(--warn-ink); } .chip.bad { background:#fbe3e3; color:var(--bad-ink); } .chip.none { background:var(--surface-2); color:var(--ink-2); }
h1 { font-size:21px; margin:0; } h2 { font-size:15px; margin:0; }
table { width:100%; border-collapse:collapse; }
.foot { margin-top:18px; font-size:12px; color:var(--muted); }
/* the statement */
.st { background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:32px 36px; }
.st-top { display:flex; justify-content:space-between; gap:16px; border-bottom:2px solid var(--ink); padding-bottom:12px; }
.st-top p { margin:2px 0 0; color:var(--ink-2); } .st-top .right { text-align:right; font-size:13px; color:var(--ink-2); }
.tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:16px 0 4px; }
.tiles div { border:1px solid var(--border); border-radius:6px; padding:8px 10px; } .tiles small { display:block; color:var(--ink-2); font-size:12px; } .tiles b { font-size:17px; }
.st h2 { margin:22px 0 6px; padding-bottom:4px; border-bottom:1px solid var(--grid); } .st h2 span { color:var(--muted); font-weight:400; }
.st td, .st th { padding:4px 0; vertical-align:top; } .st td + td, .st th + th { padding-left:10px; } .st th { text-align:left; font-size:12px; color:var(--ink-2); border-bottom:1px solid var(--grid); }
.st .amt { text-align:right; width:120px; white-space:nowrap; } .st .ref { color:var(--muted); width:160px; font-size:13px; }
.st tr.sum td { border-top:1px solid var(--ink); font-weight:700; } .st tr.diff td { font-weight:700; } .st tr.sub td:first-child { padding-left:18px; color:var(--ink-2); }
.st .note { font-size:13px; color:var(--ink-2); margin:6px 0 0; }
.sign { display:grid; grid-template-columns:1fr 1fr; gap:32px; margin-top:36px; font-size:13px; color:var(--ink-2); } .sign div { border-top:1px solid var(--ink); padding-top:4px; }
/* the bridge */
.br { display:grid; gap:14px; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px 18px; }
.card > p { margin:2px 0 12px; color:var(--ink-2); }
.head { display:flex; align-items:center; gap:14px; flex-wrap:wrap; } .head p { margin:0; color:var(--ink-2); } .head .net { margin-left:auto; text-align:right; } .head .net b { font-size:21px; display:block; }
.av { width:40px; height:40px; border-radius:50%; background:var(--blue); color:#fff; display:grid; place-items:center; font-weight:700; }
.bars { display:grid; gap:6px; }
.bars .row { display:grid; grid-template-columns:180px 1fr 100px; gap:10px; align-items:center; }
.bars .row small { display:block; color:var(--muted); font-size:12px; line-height:1.2; }
.bars .track { position:relative; height:22px; } .bars .bar { position:absolute; top:3px; height:16px; border-radius:3px; min-width:2px; }
.bar.total { background:#8fb6e8; } .bar.in { background:#7cc79a; } .bar.out { background:#e7a3a3; } .bar.found { background:var(--blue); } .bar.gap { background:repeating-linear-gradient(45deg,var(--bad) 0 4px,#f3c2c2 4px 8px); }
.bars .v { text-align:right; font-weight:600; } .bars .row.end { border-top:1px solid var(--grid); padding-top:6px; }
.minis { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; } .minis .card p { margin:4px 0 0; }
.dcards { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.dcard { border:1px solid var(--border); border-left:4px solid var(--warn); border-radius:8px; padding:10px 12px; background:#fff; }
.dcard.bad { border-left-color:var(--bad); } .dcard.none, .dcard.good { border-left-color:var(--muted); }
.dcard b { display:block; } .dcard .amt { font-size:17px; font-weight:700; } .dcard p { margin:4px 0 0; font-size:13px; color:var(--ink-2); }
/* the checklist */
.ck { background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.ck-head { padding:14px 18px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:baseline; } .ck-head p { margin:0; color:var(--ink-2); }
.ck th { text-align:left; font-size:12px; color:var(--ink-2); padding:8px 10px; background:var(--surface-2); }
.ck td { padding:9px 10px; border-top:1px solid var(--grid); vertical-align:top; } .ck .n { text-align:right; white-space:nowrap; }
.ck .ic { width:24px; height:24px; border-radius:50%; display:grid; place-items:center; font-weight:800; color:#fff; font-size:13px; }
.ic.good { background:var(--good); } .ic.warn { background:var(--warn); } .ic.bad { background:var(--bad); } .ic.none { background:#b9b7af; }
.ck td small { display:block; color:var(--ink-2); font-size:12.5px; margin-top:2px; }
.ck tr.group td { background:var(--surface-2); font-weight:700; font-size:12px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-2); padding:6px 10px; }
.ck-foot { padding:12px 18px; border-top:1px solid var(--border); display:grid; gap:4px; } .ck-foot b { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-2); }
@media (max-width:640px) {
  .st { padding:18px 14px; } .tiles { grid-template-columns:1fr 1fr; } .st .ref { display:none; } .st-top { flex-direction:column; } .st-top .right { text-align:left; }
  .bars .row { grid-template-columns:110px 1fr 76px; font-size:13px; } .minis, .dcards { grid-template-columns:1fr; }
  .ck th:nth-child(3), .ck td:nth-child(3) { display:none; }
}
@page { size:A4; margin:12mm; }
@media print { body { background:#fff; } .page { padding:0; max-width:none; } .st, .card, .ck { border:0; box-shadow:none; } .card, .dcard, tr { break-inside:avoid; } }
`;

function doc(m, layout, body) {
  const title = `Reconciliation · ${m.who} · ${m.when} ${m.slot.toLowerCase()}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body><main class="page" data-layout="${esc(layout)}">${body}`
    + `<p class="foot">Made by Insight on ${esc(m.made)}. Amounts in ${esc(m.currency || 'GH₵')}. The figures are as they stood then: a journal or statement loaded later, or an answer given since, may change them.</p>`
    + '</main></body></html>';
}

const statusChip = (m) => {
  const c = counts(m);
  if (m.open) return chip('none', 'Journal ends inside this shift');
  if (c.answer) return chip('answer', `${c.answer} answer${c.answer === 1 ? '' : 's'} needed`);
  if (c.approve) return chip('approve', `${c.approve} to approve`);
  return chip('done', 'All agreed or answered');
};

// ------------------------------------------------------- A: the statement --

function statement(m) {
  const dr = m.drawer;
  const row = (label, ref, value, cls = '') => `<tr class="${cls}"><td>${esc(label)}</td><td class="ref">${esc(ref || '')}</td><td class="amt num ${cls === 'diff' ? tone(value) : ''}">${value == null ? '—' : bracket(value)}</td></tr>`;
  const tiles = [
    ['Drawer', dr ? (dr.variance == null ? '—' : dr.variance === 0 ? 'Agrees' : signed(dr.variance)) : '—', dr ? (dr.variance === 0 ? 'good' : dr.settled ? 'good' : tone(dr.variance)) : ''],
    ['Card & MoMo', m.card ? (m.card.difference === 0 ? 'Agrees' : signed(m.card.difference)) : '—', m.card ? (m.card.difference === 0 ? 'good' : 'warn') : ''],
    ['Expenses & POs', m.expenses ? (m.expenses.difference == null ? 'No POs yet' : m.expenses.difference === 0 ? 'Agree' : signed(m.expenses.difference)) : 'None', m.expenses?.difference === 0 ? 'good' : m.expenses?.difference == null ? '' : 'bad'],
    ['Stock & laundry', [...(m.goods || []).map((g) => g.diff), m.laundry?.difference].some((d) => d != null && d !== 0) ? 'Look at it' : 'Agree',
      [...(m.goods || []).map((g) => g.diff), m.laundry?.difference].some((d) => d != null && d !== 0) ? 'bad' : 'good'],
  ];
  let n = 0;
  const sec = (title, sub = '') => `<h2>${++n}. ${esc(title)}${sub ? ` <span>${esc(sub)}</span>` : ''}</h2>`;
  const parts = [];
  if (dr) {
    parts.push(sec('The drawer', '(notes and coins)'), '<table>');
    for (const x of dr.steps) {
      parts.push(row(`${x.kind === 'in' ? 'Add: ' : x.kind === 'out' ? 'Less: ' : ''}${x.label}`, x.ref, x.kind === 'out' ? -x.amount : x.amount));
      for (const p of x.parts || []) parts.push(row(p.label, p.ref, p.amount, 'sub'));
    }
    parts.push(row('Should hold', '', dr.expected, 'sum'), row(`Counted at the close${dr.recounted ? ' (recount)' : ''}`, dr.countedRef, dr.counted),
      row(`Difference${dr.variance ? `: ${drawerWord(dr).toLowerCase()}` : ''}`, dr.settled || '', dr.variance, 'diff'), '</table>');
    if (dr.notes?.length) parts.push(`<p class="note">${dr.notes.map(esc).join(' ')}</p>`);
  }
  if (m.card) {
    const c = m.card;
    parts.push(sec('Card and MoMo'), '<table><tr><th>Source</th><th class="ref"></th><th class="amt">Amount</th></tr>',
      row('As ASSD has it', `${c.assdLines} line${c.assdLines === 1 ? '' : 's'}`, c.assd),
      row('Taken on the card machine and MoMo', `${c.foundCount} payment${c.foundCount === 1 ? '' : 's'}`, c.found),
      row(c.difference === 0 ? 'Difference' : c.difference > 0 ? 'Difference: more taken than ASSD shows' : 'Difference: ASSD shows more than was taken', '', c.difference, 'diff'));
    for (const x of c.items) parts.push(row(x.label, x.ref, x.amount, 'sub'));
    parts.push('</table>');
  }
  if (m.expenses) {
    const e = m.expenses;
    parts.push(sec('Expenses and POs'), '<table>', row('Expenses this shift', e.ref, e.amount));
    for (const o of e.orders) parts.push(row(`${o.name} · ${o.vendor || ''}${o.ok ? '' : ' (not approved in Odoo, not counted)'}`, 'Odoo', o.total));
    parts.push(row('Difference', e.poTotal == null ? 'no PO numbers yet' : '', e.difference, 'diff'), '</table>');
  }
  if ((m.goods || []).length || m.laundry) {
    parts.push(sec('The desk’s stock and the laundry'), '<table><tr><th>Item</th><th class="ref">Should be left → counted</th><th class="amt">Difference</th></tr>');
    for (const g of m.goods) parts.push(`<tr><td>${esc(g.name)} <span class="muted">(${g.start ?? '—'} at the start, ${g.out} out, ${g.back} back)</span></td><td class="ref">${g.should ?? '—'} → ${g.end ?? '—'}</td><td class="amt num ${tone(g.diff)}">${g.diff == null ? '—' : g.diff === 0 ? '0' : `${g.diff > 0 ? '+' : '−'}${Math.abs(g.diff)}`}</td></tr>`);
    if (m.laundry) parts.push(row(`Laundry: ASSD ${amount(m.laundry.assd)}, the laundry system ${m.laundry.system == null ? 'not read yet' : amount(m.laundry.system)}`, '', m.laundry.difference, 'diff'));
    parts.push('</table>');
  }
  parts.push(sec('Differences and answers'));
  parts.push(m.diffs.length
    ? `<table><tr><th>#</th><th>What</th><th class="amt">Amount</th><th class="amt">Where it stands</th></tr>${m.diffs.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.title)}${x.ref ? ` <span class="muted">${esc(x.ref)}</span>` : ''}${x.said ? `<br><span class="muted">${esc(x.said)}</span>` : ''}</td><td class="amt num">${amount(x.amount == null ? null : Math.abs(x.amount))}</td><td class="amt">${chip(x.state)}</td></tr>`).join('')}</table>`
    : '<p class="note">Nothing that does not agree.</p>');
  return doc(m, 'statement', `<section class="st">
    <div class="st-top"><div><h1>Shift reconciliation</h1><p>${esc(m.when)} · ${esc(m.slot)} (${esc(m.hours)}) · <b>${esc(m.who)}</b></p><p>${esc(m.seqs)}</p></div>
    <div class="right">Made by Insight<br>${esc(m.made)}<br>${statusChip(m)}</div></div>
    <div class="tiles">${tiles.map(([a, b, c]) => `<div><small>${esc(a)}</small><b class="num ${c}">${esc(b)}</b></div>`).join('')}</div>
    ${parts.join('')}
    <div class="sign"><div>Checked by</div><div>Date</div></div></section>`);
}

// ---------------------------------------------------------- B: the bridge --

function bars(rows) {
  const ends = rows.flatMap((r) => r.segs.flatMap((s) => [s.from, s.to])).filter((v) => Number.isFinite(v));
  const top = Math.max(1, ...ends);
  const low = Math.min(0, ...ends);
  const pos = (v) => ((v - low) / (top - low)) * 100;
  return `<div class="bars">${rows.map((r) => `<div class="row${r.end ? ' end' : ''}"><span>${r.strong ? `<b>${esc(r.label)}</b>` : esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>`
    + `<div class="track">${r.segs.map((s) => `<div class="bar ${s.cls}" style="left:${pos(Math.min(s.from, s.to)).toFixed(2)}%;width:${(Math.abs(s.to - s.from) / (top - low) * 100).toFixed(2)}%"></div>`).join('')}</div>`
    + `<span class="v num ${r.cls || ''}">${esc(r.value)}</span></div>`).join('')}</div>`;
}

function bridge(m) {
  const c = counts(m);
  const parts = [`<div class="card head"><span class="av">${esc((m.who || '?')[0])}</span><div><h1>${esc(m.who)} · ${esc(m.when)}, ${esc(m.slot.toLowerCase())}</h1>`
    + `<p>${esc(m.hours)} · ${esc(m.seqs)} · made ${esc(m.made)}</p></div><div class="net"><small class="muted">Still to answer</small><b class="${c.answer ? 'bad' : 'good'}">${c.answer ? `${c.answer} of ${c.all}` : 'None'}</b></div></div>`];
  const dr = m.drawer;
  if (dr) {
    const rows = [];
    let at = 0;
    for (const x of dr.steps) {
      if (x.kind === 'start') { rows.push({ label: x.label, sub: x.ref, segs: [{ cls: 'total', from: 0, to: x.amount }], value: amount(x.amount) }); at = x.amount; continue; }
      const to = x.kind === 'out' ? at - x.amount : at + x.amount;
      rows.push({ label: x.label, sub: x.ref, segs: [{ cls: x.kind === 'out' ? 'out' : 'in', from: at, to }], value: `${x.kind === 'out' ? '−' : '+'}${amount(x.amount)}`, cls: x.kind === 'out' ? 'bad' : 'good' });
      at = to;
    }
    rows.push({ label: 'Should hold', strong: true, end: true, segs: [{ cls: 'total', from: 0, to: dr.expected ?? 0 }], value: amount(dr.expected) });
    const v = dr.variance;
    rows.push({
      label: 'Counted', strong: true, sub: dr.countedRef,
      segs: v == null ? [] : v < 0 ? [{ cls: 'found', from: 0, to: dr.counted }, { cls: 'gap', from: dr.counted, to: dr.expected }] : [{ cls: 'found', from: 0, to: dr.expected }, ...(v ? [{ cls: 'gap', from: dr.expected, to: dr.counted }] : [])],
      value: amount(dr.counted),
    });
    if (v) rows.push({ label: v < 0 ? 'Short' : 'Over', strong: true, sub: dr.settled || '', segs: [], value: signed(v), cls: dr.settled ? 'good' : 'bad' });
    parts.push(`<div class="card"><h2>The drawer: from the opening count to the closing count</h2><p>Each step as ASSD has it. ${v ? 'The striped bar is the difference.' : ''}</p>${bars(rows)}</div>`);
  }
  if (m.card) {
    const k = m.card;
    const rows = [{ label: 'ASSD', sub: `${k.assdLines} line${k.assdLines === 1 ? '' : 's'}`, segs: [{ cls: 'total', from: 0, to: k.assd }], value: amount(k.assd) }];
    let at = k.assd;
    for (const x of k.items) {
      rows.push({ label: x.label, sub: x.ref, segs: [{ cls: x.amount > 0 ? 'gap' : 'out', from: at, to: at + x.amount }], value: signed(x.amount), cls: x.amount > 0 ? 'warn' : 'bad' });
      at += x.amount;
    }
    rows.push({ label: 'Card machine and MoMo', strong: true, end: true, sub: `${k.foundCount} payment${k.foundCount === 1 ? '' : 's'}`, segs: [{ cls: 'found', from: 0, to: k.found }], value: amount(k.found) });
    parts.push(`<div class="card"><h2>Card and MoMo: ASSD against what was taken</h2><p>${k.difference === 0 ? 'They agree.' : `ASSD is ${amount(Math.abs(k.difference))} ${k.difference > 0 ? 'below' : 'above'} what was taken.`}</p>${bars(rows)}</div>`);
  }
  const mini = [];
  if (m.expenses) {
    const e = m.expenses;
    mini.push(`<div class="card"><h2>Expenses</h2><p>${e.difference === 0 ? '<b class="good">✓ Agree</b> · ' : e.difference == null ? '<b class="muted">No POs yet</b> · ' : `<b class="bad">${esc(signed(e.difference))}</b> · `}${amount(e.amount)}${e.orders.length ? ` against ${esc(e.orders.map((o) => `${o.name} (${o.vendor || ''})`).join(', '))}` : ''}</p></div>`);
  }
  if ((m.goods || []).length) {
    const bad = m.goods.some((g) => g.diff);
    mini.push(`<div class="card"><h2>The desk’s stock</h2><p>${bad ? '<b class="bad">! Look at it</b>' : '<b class="good">✓ Agree</b>'} · ${esc(m.goods.map((g) => `${g.name.toLowerCase()} ${g.start ?? '—'} → ${g.end ?? '—'}`).join(' · '))}</p></div>`);
  }
  if (m.laundry) {
    const l = m.laundry;
    mini.push(`<div class="card"><h2>Laundry</h2><p>${l.system == null ? '<span class="muted">Not read yet</span>' : l.difference === 0 ? '<b class="good">✓ Agrees</b>' : `<b class="bad">${esc(signed(l.difference))}</b>`} · ASSD ${amount(l.assd)}</p></div>`);
  }
  if (mini.length) parts.push(`<div class="minis">${mini.join('')}</div>`);
  parts.push(`<div class="card"><h2>What does not agree, and where it stands</h2><p></p>${m.diffs.length ? `<div class="dcards">${m.diffs.map((x) => `<div class="dcard ${STATE[x.state]?.[0] || 'none'}"><b class="${x.state === 'answer' ? 'bad' : ''}">${esc(x.title)}</b>`
    + `<span class="amt num">${amount(x.amount == null ? null : Math.abs(x.amount))}</span><p>${esc([x.ref, x.text, x.said].filter(Boolean).join(' · '))} ${chip(x.state)}</p></div>`).join('')}</div>` : '<p class="muted">Nothing that does not agree.</p>'}</div>`);
  return doc(m, 'bridge', `<section class="br">${parts.join('')}</section>`);
}

// ------------------------------------------------------- C: the checklist --

function checklist(m) {
  const list = checks(m);
  const agree = list.filter((x) => x.state === 'good').length;
  const c = counts(m);
  const cell = (x, v) => (v == null ? (x.note ? `<span class="muted">${esc(x.note)}</span>` : '—') : x.count ? String(v) : amount(v));
  const diffCell = (x) => (x.diff == null ? cell(x, null) : x.count ? (x.diff === 0 ? '0' : `${x.diff > 0 ? '+' : '−'}${Math.abs(x.diff)}`) : signed(x.diff));
  let group = null;
  const rows = [];
  for (const x of list) {
    if (x.group !== group) { group = x.group; rows.push(`<tr class="group"><td colspan="5">${esc(group)}</td></tr>`); }
    rows.push(`<tr><td><span class="ic ${x.state}">${esc(x.mark)}</span></td><td>${esc(x.title)}${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</td>`
      + `<td class="n num">${cell(x, x.assd)}</td><td class="n num">${cell(x, x.found)}</td><td class="n num ${x.state === 'good' ? 'good' : x.state === 'bad' ? 'bad' : 'warn'}">${diffCell(x)}</td></tr>`);
  }
  const todo = m.diffs.filter((x) => ['answer', 'approve'].includes(x.state))
    .map((x, i) => `${i + 1}. ${x.state === 'approve' ? 'Approve or reject the answer on' : 'Answer'} ${x.title.charAt(0).toLowerCase()}${x.title.slice(1)}${x.ref ? ` (${x.ref})` : ''}${x.amount != null ? `, ${amount(Math.abs(x.amount))}` : ''}.`);
  return doc(m, 'checklist', `<section class="ck">
    <div class="ck-head"><div><h1>${esc(m.when)} · ${esc(m.slot)} · ${esc(m.who)}</h1><p>${esc(m.hours)} · ${esc(m.seqs)} · made ${esc(m.made)}</p></div>
    <p>${chip('done', `${agree} agree`)} ${c.answer ? chip('answer', `${c.answer} to answer`) : ''} ${c.approve ? chip('approve', `${c.approve} to approve`) : ''}</p></div>
    <table><tr><th></th><th>Check</th><th class="n">ASSD</th><th class="n">Found</th><th class="n">Difference</th></tr>${rows.join('')}</table>
    <div class="ck-foot"><b>To do</b><span>${todo.length ? esc(todo.join(' ')) : 'Nothing: every difference is answered.'}</span><span class="muted">Checked by ______________________ &nbsp; Date __________</span></div></section>`);
}

/** The whole page, as text, in the layout chosen. */
export function reportHtml(m, layout = 'statement') {
  if (layout === 'bridge') return bridge(m);
  if (layout === 'checklist') return checklist(m);
  return statement(m);
}

/** A file name for it: "reconciliation-2026-10-13-afternoon-statement.html". */
export function fileName(m, layout, ext = 'html') {
  const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `reconciliation-${m.day}-${slug(m.slot)}-${slug(m.who)}-${layout}.${ext}`;
}
