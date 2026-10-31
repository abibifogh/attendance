/**
 * Somebody holding a float, on their own link: what they hold, a picture of
 * each receipt sent in, and where each stands. No sign-in: the link is the key.
 */

// Their short link (/float/igna) or the long one (?t=…).
const s = (/^\/float\/([A-Za-z0-9-]+)\/?$/.exec(location.pathname) || [])[1] || '';
const t = s ? '' : new URLSearchParams(location.search).get('t') || '';
const key = s ? `s=${encodeURIComponent(s)}` : `t=${encodeURIComponent(t)}`;
const page = document.getElementById('page');
const ghs = (minor) => `GH₵${(Number(minor || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function call(path, body) {
  const res = await fetch(`/api/float/${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t, s, ...body }) }
    : { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again in a minute.');
  return data;
}

/** A photo made at most 1600 pixels across, as a JPEG: small enough to send, clear enough to read. */
async function shrink(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 7_000_000) throw new Error(`${file.name} is too large: take a photo of it instead.`);
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error(`${file.name} could not be opened: take the photo again.`)); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

const dock = document.getElementById('dock');
const sendButton = document.getElementById('send');
const pick = document.getElementById('pick');
const overlay = document.getElementById('overlay');
const whole = (minor) => `GH₵${Math.round(Number(minor || 0) / 100).toLocaleString('en-GB')}`;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const lastMonth = () => {
  const d = new Date(`${monthStart(today())}T12:00:00Z`);
  d.setUTCDate(0);
  const end = d.toISOString().slice(0, 10);
  return [monthStart(end), end];
};
const RANGES = { this: 'This month', last: 'Last month', all: 'All of it', pick: 'Choose dates' };
const TABS = { all: 'All', given: 'Given', receipts: 'Receipts', statement: 'Statement' };

let d = null;
let tab = 'all';
let range = 'this';
let dates = [monthStart(today()), today()];
let said = [];
let totals = null;

/** The dates the statement covers, for the chosen range. */
function span() {
  if (range === 'this') return [monthStart(today()), today()];
  if (range === 'last') return lastMonth();
  if (range === 'all') return ['start', today()];
  return dates;
}
const statementUrl = (format) => {
  const [from, to] = span();
  return `/api/float/statement?${key}&from=${from}&to=${to}${format ? `&format=${format}` : ''}`;
};

async function load() {
  try { d = await call(`me?${key}`); } catch (err) {
    page.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    dock.hidden = true;
    return;
  }
  document.title = `${d.name} · your float`;
  dock.hidden = false;
  paint();
}

/** A line in the list: money given or given back, or a receipt and where it stands. */
function line(i) {
  if (i.move) {
    const m = i.move;
    const given = m.kind === 'given';
    const from = m.source ? `${given ? 'from' : 'into'} ${m.source.charAt(0).toLowerCase()}${m.source.slice(1)}` : '';
    return `<div class="item"><div class="ico ${given ? 'in' : 'out'}">${given ? '↓' : '↑'}</div>
      <div><b>${given ? 'Given to you' : 'You gave back'}</b><small>${esc([from, given && m.by ? `by ${m.by}` : ''].filter(Boolean).join(' · '))}</small></div>
      <div class="amt num ${given ? 'in' : ''}">${given ? '+' : '−'}${esc(ghs(m.amount))}</div>
      ${m.note ? `<div class="memo">${esc(m.note)}</div>` : ''}</div>`;
  }
  const s = i.receipt;
  const refused = s.status === 'refused';
  const chip = s.status === 'accepted' ? '<span class="chip ok">✓ Accepted</span>'
    : refused ? '<span class="chip no">✕ Refused</span>'
      : s.unread ? '<span class="chip">Could not be read</span>' : '<span class="chip wait">Being checked</span>';
  return `<div class="item"><div class="ico ${refused ? 'no' : 'out'}">🧾</div>
    <div><b>${esc(s.vendor || 'Receipt')}</b><small>${esc([s.description, s.ref].filter(Boolean).join(' · '))}</small>${chip}</div>
    <div class="amt num ${refused ? 'off' : ''}">${s.amount != null ? `−${esc(ghs(s.amount))}` : '—'}${refused && s.amount != null ? '<small><br>not counted</small>' : ''}</div>
    ${refused && s.reason ? `<div class="memo why">Why: ${esc(s.reason)}</div>` : ''}
    ${s.unread && s.status === 'checking' ? '<div class="memo">The office will fill it in.</div>' : ''}
    ${s.change ? changeBox(s) : ''}</div>`;
}

/** Its PO was changed in Odoo to another total: theirs to accept, or to say it is not right. */
function changeBox(s) {
  const c = s.change;
  const said = c.admin === 'accept' ? `The office accepted ${ghs(c.now)}.` : c.admin === 'keep' ? `The office kept the receipt’s ${ghs(c.was)}.`
    : !c.asksHolder ? 'The office will decide which amount counts.'
      : c.holder === 'accept' ? `You accepted ${ghs(c.now)}.` : c.holder === 'dispute' ? 'You said it is not right: the office will decide.' : '';
  return `<div class="memo ask"><b>The PO was changed in Odoo to ${esc(ghs(c.now))}</b> (the receipt said ${esc(ghs(c.was))}).
    ${said ? `<span>${esc(said)}</span>` : `<span>Is the new amount right?</span>
    <span class="askbtns"><button type="button" class="btn pri" data-amount="accept" data-id="${s.id}">Yes, ${esc(ghs(c.now))}</button><button type="button" class="btn" data-amount="dispute" data-id="${s.id}">No, it is not right</button></span>`}</div>`;
}

function listHtml() {
  const items = [
    ...(tab !== 'receipts' ? (d.moves || []).map((m) => ({ day: m.day, sort: `${m.day} 0`, move: m })) : []),
    ...(tab !== 'given' ? d.sent.map((s) => ({ day: s.day, sort: `${s.day} 1 ${s.at}`, receipt: s })) : []),
  ].sort((a, b) => (a.sort < b.sort ? 1 : -1));
  if (!items.length) return `<p class="empty">${tab === 'given' ? 'Nothing given yet.' : tab === 'receipts' ? 'No receipts sent yet.' : 'Nothing yet.'}</p>`;
  let last = '';
  return items.map((i) => {
    const head = i.day !== last ? `<div class="day">${esc(dayText((last = i.day)))}</div>` : '';
    return head + line(i);
  }).join('');
}

function statementHtml() {
  const t = totals;
  const row = (label, v) => `<div><span>${label}</span><span class="num">${t ? esc(ghs(v)) : '…'}</span></div>`;
  return `<div class="card"><h2>Your statement</h2><p class="lead">Everything given, spent and given back, with what was left after each.</p>
    <div class="chips">${Object.entries(RANGES).map(([k, l]) => `<button type="button" data-range="${k}" class="${range === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${range === 'pick' ? `<div class="dates"><label>From<input type="date" id="from" value="${dates[0]}" max="${today()}"></label><label>To<input type="date" id="to" value="${dates[1]}" max="${today()}"></label></div>` : ''}
    <div class="sumrows">${row('At the start', t?.opening)}${row('Given to you', t?.given)}${row('Spent (receipts)', t?.spent)}${row('Given back', t?.back)}${row('Still with you', t?.closing)}</div>
    <div class="btns"><a class="btn pri" href="${esc(statementUrl(''))}" target="_blank" rel="noopener">View · print</a><a class="btn" href="${esc(statementUrl('csv'))}">Spreadsheet</a></div></div>`;
}

async function loadTotals() {
  totals = null;
  const asked = statementUrl('json');
  try {
    const t = await call(asked.replace('/api/float/', ''));
    if (asked === statementUrl('json')) { totals = t; paint(); }
  } catch (err) { said = [{ err: true, text: err.message }]; paint(); }
}

function paint() {
  const given = d.given || 1;
  const recent = new Date(Date.now() - 14 * 86400000).toISOString();
  const refused = d.sent.filter((s) => s.status === 'refused' && (!s.decidedAt || s.decidedAt.replace(' ', 'T') >= recent.slice(0, 19)));
  const changed = d.sent.filter((s) => s.change && s.change.asksHolder && !s.change.holder && !s.change.admin);
  page.innerHTML = `
    <div class="top"><div class="avatar">${esc((d.name || '?').trim().charAt(0).toUpperCase())}</div><div><small>Hello,</small><b>${esc(d.name)}</b></div><span class="ref">${esc(d.ref)}</span></div>
    <div class="hero"><small>Still with you</small><div class="big num">${esc(ghs(d.held))}</div>
      <div class="stack"><i style="width:${Math.min(100, (d.spent / given) * 100)}%;background:#a5b4fc"></i><i style="width:${Math.min(100, (d.back / given) * 100)}%;background:#5eead4"></i></div>
      <div class="trio"><div><small>Given</small><b class="num">${esc(whole(d.given))}</b></div>
        <div><small><span class="dot" style="background:#a5b4fc"></span>Spent</small><b class="num">${esc(whole(d.spent))}</b></div>
        <div><small><span class="dot" style="background:#5eead4"></span>Back</small><b class="num">${esc(whole(d.back))}</b></div></div></div>
    ${said.map((m) => `<div class="said ${m.err ? 'err' : ''}">${esc(m.text)}</div>`).join('')}
    ${refused.length ? `<div class="alert"><b>${refused.length} receipt${refused.length === 1 ? '' : 's'} refused</b>${refused.map((s) => esc(`${s.description || s.vendor || s.ref}${s.amount != null ? `, ${ghs(s.amount)}` : ''}: ${s.reason || 'refused'}`)).join('<br>')}<br>${refused.length === 1 ? 'It does not count: the money is still with you.' : 'They do not count: the money is still with you.'}</div>` : ''}
    ${changed.length ? `<div class="alert ask"><b>${changed.length === 1 ? 'A PO was changed in Odoo' : `${changed.length} POs were changed in Odoo`}</b>${changed.map((s) => esc(`${s.vendor || s.ref}: ${ghs(s.change.was)} → ${ghs(s.change.now)}`)).join('<br>')}<br>Is the new amount right? Answer it under Receipts.</div>` : ''}
    <div class="seg" role="tablist">${Object.entries(TABS).map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="list">${tab === 'statement' ? statementHtml() : listHtml()}</div>`;
  const from = document.getElementById('from');
  const to = document.getElementById('to');
  if (from && to) [from, to].forEach((el) => { el.onchange = () => { dates = [from.value, to.value]; loadTotals(); paint(); }; });
}

page.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-amount]');
  if (a) {
    a.disabled = true;
    try {
      await call('amount', { id: Number(a.dataset.id), answer: a.dataset.amount });
      said = [{ text: a.dataset.amount === 'accept' ? 'Accepted: the new amount counts.' : 'Sent: the office will decide.' }];
      await load();
    } catch (err) { said = [{ err: true, text: err.message }]; paint(); }
    return;
  }
  const b = e.target.closest('[data-tab],[data-range]');
  if (!b) return;
  if (b.dataset.tab) { tab = b.dataset.tab; if (tab === 'statement' && !totals) loadTotals(); }
  if (b.dataset.range) { range = b.dataset.range; loadTotals(); }
  paint();
});

// Sending: pick the pictures, say what they were for if the receipt does not, send.
sendButton.onclick = () => pick.click();
pick.onchange = () => {
  const files = [...pick.files];
  if (!files.length) return;
  const urls = files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null));
  overlay.innerHTML = `<div class="sheet"><div class="in"><h2>Send ${files.length === 1 ? 'this receipt' : `these ${files.length} receipts`}</h2>
    <div class="thumbs">${urls.map((u, i) => (u ? `<img src="${u}" alt="">` : `<span>${esc(files[i].name.slice(0, 12))}</span>`)).join('')}</div>
    <label>What it was for (if the receipt does not say)<input id="hint" placeholder="e.g. Diesel for the generator"></label>
    <div class="btns"><button type="button" class="btn" id="cancel">Cancel</button><button type="button" class="btn pri" id="go">Send ${files.length === 1 ? 'it' : 'them'}</button></div></div></div>`;
  const close = () => { overlay.innerHTML = ''; urls.forEach((u) => u && URL.revokeObjectURL(u)); pick.value = ''; };
  document.getElementById('cancel').onclick = close;
  document.getElementById('go').onclick = async () => {
    const hint = document.getElementById('hint').value;
    close();
    sendButton.disabled = true;
    said = [];
    for (const f of files) {
      sendButton.textContent = `Sending ${f.name}…`;
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await call('send', { file: await shrink(f), name: f.name, hint });
        said.push({ text: `${out.ref ? `${out.ref}: ` : ''}${out.said}` });
      } catch (err) { said.push({ err: true, text: `${f.name}: ${err.message}` }); }
    }
    sendButton.disabled = false;
    sendButton.textContent = '📷 Send a receipt';
    tab = 'all';
    totals = null;
    await load();
    scrollTo(0, 0);
  };
};

if (!t && !s) page.innerHTML = '<p class="err">This link is not complete. Open the whole link you were sent.</p>';
else load();
