/**
 * Somebody holding a float, on their own link: what they hold, a picture of
 * each receipt sent in, and where each stands. No sign-in: the link is the key.
 */

// Their short link (/float/igna) or the long one (?t=…).
const s = (/^\/float\/([A-Za-z0-9-]+)\/?$/.exec(location.pathname) || [])[1] || '';
const t = s ? '' : new URLSearchParams(location.search).get('t') || '';
const key = s ? `s=${encodeURIComponent(s)}` : `t=${encodeURIComponent(t)}`;
const page = document.getElementById('page');
const who = document.getElementById('who');
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

let message = '';

async function paint() {
  let d;
  try { d = await call(`me?${key}`); } catch (err) {
    who.textContent = '';
    page.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    return;
  }
  who.textContent = `${d.name} · ${d.ref}`;
  const pct = d.given ? Math.min(100, Math.round(((d.spent + d.back) / d.given) * 100)) : 0;
  const chip = (s) => (s.status === 'accepted' ? '<span class="chip ok">✓ Accepted</span>'
    : s.status === 'refused' ? '<span class="chip no">✕ Refused</span>'
      : s.unread ? '<span class="chip">Could not be read</span>' : '<span class="chip">Being checked</span>');
  const today = new Date().toISOString().slice(0, 10);
  const moves = d.moves || [];
  page.innerHTML = `
    <div class="card"><p class="note">Still with you</p><div class="big">${esc(ghs(d.held))}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="note">${esc(ghs(d.spent))} spent of ${esc(ghs(d.given))} given${d.back ? ` · ${esc(ghs(d.back))} given back` : ''} · ${d.receipts} receipt${d.receipts === 1 ? '' : 's'}</p></div>
    ${message}
    <label>What it was for (if the receipt does not say)<input id="hint" placeholder="e.g. Diesel for the generator"></label>
    <button class="add" id="add" type="button">📷 Add a receipt</button>
    <input id="pick" type="file" accept="image/*,application/pdf" multiple hidden>
    <p class="note">Take a clear picture of the whole receipt, one at a time or several together.</p>
    <div class="card"><h2>Sent</h2>
      ${d.sent.length ? d.sent.map((s) => `<div class="row"><span class="t"><b>${esc(s.vendor || 'Receipt')}${s.amount != null ? ` · ${esc(ghs(s.amount))}` : ''}</b>
        <small>${esc(dayText(s.day))}${s.description ? ` · ${esc(s.description)}` : ''} · ${esc(s.ref)}</small>
        ${s.status === 'refused' && s.reason ? `<small>Why: ${esc(s.reason)}</small>` : ''}
        ${s.unread && s.status === 'checking' ? '<small>The office will fill it in.</small>' : ''}</span>${chip(s)}</div>`).join('') : '<p class="note">Nothing sent yet.</p>'}
    </div>
    <div class="card"><h2>Money given to you</h2>
      ${moves.length ? moves.map((m) => `<div class="row"><span class="t"><b>${m.kind === 'given' ? 'Given' : 'You gave back'} · ${esc(ghs(m.amount))}</b>
        <small>${esc(dayText(m.day))}${m.source ? ` · from ${esc(m.source.charAt(0).toLowerCase() + m.source.slice(1))}` : ''}${m.by ? ` · by ${esc(m.by)}` : ''}</small>
        ${m.note ? `<span class="memo">${esc(m.note)}</span>` : ''}</span></div>`).join('') : '<p class="note">Nothing given yet.</p>'}
    </div>
    <div class="card"><h2>Your statement</h2>
      <p class="note">Everything given, spent and given back, with what was still with you after each.</p>
      <div class="dates"><label>From<input id="from" type="date" value="${today.slice(0, 8)}01" max="${today}"></label><label>To<input id="to" type="date" value="${today}" max="${today}"></label></div>
      <div class="links"><a class="btn" id="see" target="_blank" rel="noopener">View statement</a><a class="btn" id="csv">Spreadsheet</a></div>
    </div>`;
  const dates = () => `${key}&from=${document.getElementById('from').value}&to=${document.getElementById('to').value}`;
  const links = () => {
    document.getElementById('see').href = `/api/float/statement?${dates()}`;
    document.getElementById('csv').href = `/api/float/statement?${dates()}&format=csv`;
  };
  document.getElementById('from').onchange = links;
  document.getElementById('to').onchange = links;
  links();
  const pick = document.getElementById('pick');
  document.getElementById('add').onclick = () => pick.click();
  pick.onchange = async () => {
    const hint = document.getElementById('hint').value;
    const said = [];
    const button = document.getElementById('add');
    button.disabled = true;
    for (const f of pick.files) {
      button.textContent = `Sending ${f.name}…`;
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await call('send', { file: await shrink(f), name: f.name, hint });
        said.push(`<p class="ok-note">${esc(out.ref ? `${out.ref}: ` : '')}${esc(out.said)}</p>`);
      } catch (err) { said.push(`<p class="err">${esc(f.name)}: ${esc(err.message)}</p>`); }
    }
    message = said.join('');
    paint();
  };
}

if (!t && !s) page.innerHTML = '<p class="err">This link is not complete. Open the whole link you were sent.</p>';
else paint();
