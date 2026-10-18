import { h, mount } from '../util.js';
import { api } from '../api.js';

/**
 * Proof for an answer, on the answer's own card.
 *
 * `proofBox(target)` shows what was asked and what came back, and for whoever
 * may ask (admins, and anybody given "Ask for proof"), an Ask for proof button:
 * what to send, in a tap or two, and a line saying exactly what. `sendCard`
 * is the other end: the person asked, sending pictures or a PDF, or why not.
 */

export const KINDS = [
  ['momo', 'MoMo screenshot or statement'], ['slip', 'Terminal slip'], ['bank', 'Bank statement'],
  ['receipt', 'Receipt or invoice'], ['other', 'Something else'],
];
const kindName = (k) => KINDS.find(([key]) => key === k)?.[1] || k;
const when = (at) => {
  const d = new Date(`${String(at).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(at || '') : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
};

/** The files sent, as small previews that open full size. */
export function proofFiles(files) {
  if (!files?.length) return null;
  return h('div.pf-files', files.map((f) => h('a.pf-file', { href: `/api/proof/file/${f.id}`, target: '_blank', rel: 'noopener', title: f.name },
    f.type.startsWith('image/') ? h('img', { src: `/api/proof/file/${f.id}`, alt: f.name, loading: 'lazy' }) : h('span.pf-pdf', '📄'),
    h('small', f.name))));
}

/** What was asked, and what came back, for one request. */
function requestView(r, { canAsk, again, sent }) {
  const said = h('span.small');
  const act = (path, words) => async (e) => {
    e.target.disabled = true;
    said.textContent = 'Saving…';
    try { await api(path, { method: 'POST', body: { id: r.id } }); said.textContent = words; await again(); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
  };
  const asked = h('div.pf-asked', '📎 ', h('b', 'Proof asked'), ` from ${r.askedOf}${r.toHive ? ' (in HIVE)' : ''} by ${r.askedBy}, ${when(r.askedAt)}: ${r.kinds.map(kindName).join(', ')}`,
    r.note ? ` · “${r.note}”` : '');
  if (r.status === 'asked' && r.mine) {
    // Asked of whoever is looking: they send it here, on the card itself.
    return h('div', asked, h('div.pf-mine', h('b', 'Send it here'), sendForm(r, sent)));
  }
  if (r.status === 'asked') {
    return h('div', asked,
      h('div.pf-line', h('span.sh-chip.none', `Waiting for ${r.askedOf}`),
        r.reminders ? h('span.small', ` Reminded ${r.reminders} time${r.reminders === 1 ? '' : 's'}${r.remindedAt ? `, last ${when(r.remindedAt)}` : ''}.`) : h('span.small', ' Reminded each morning if nothing comes, three times at most.'),
        canAsk ? [h('button.sh-link', { type: 'button', onclick: act('/proof/remind', 'Reminded.') }, `Remind ${r.askedOf}`),
          h('button.sh-link', { type: 'button', onclick: act('/proof/cancel', 'Cancelled.') }, 'Cancel the request')] : null,
        said));
  }
  return h('div', asked,
    h(`div.pf-got${r.status === 'cannot' ? '.no' : ''}`,
      r.status === 'cannot' ? ['✕ ', h('b', 'Cannot send it'), `, says ${r.askedOf}, ${when(r.repliedAt)}: “${r.reply}”`]
        : ['✓ ', h('b', 'Proof sent'), ` by ${r.askedOf}, ${when(r.repliedAt)}${r.reply ? `: “${r.reply}”` : ''}`],
      proofFiles(r.files)));
}

/** The form to ask: what to send, and exactly what. */
function askForm(target, who, { onDone, onCancel }) {
  const picked = new Set();
  const chips = KINDS.map(([k, label]) => {
    const b = h('button.pf-chip', { type: 'button', 'aria-pressed': 'false' }, label);
    b.addEventListener('click', () => {
      if (picked.has(k)) picked.delete(k); else picked.add(k);
      b.classList.toggle('on', picked.has(k));
      b.setAttribute('aria-pressed', String(picked.has(k)));
    });
    return b;
  });
  const note = h('input', { type: 'text', maxlength: '300', placeholder: 'Exactly what, e.g. the MoMo message showing the 9:51pm payment was declined' });
  const said = h('span.small');
  const sendIt = async (e) => {
    if (!picked.size) { said.textContent = 'Tap what to send first.'; return; }
    e.target.disabled = true;
    said.textContent = 'Sending…';
    try {
      const out = await api('/proof/ask', { method: 'POST', body: { target, kinds: [...picked], note: note.value } });
      await onDone(out.told ? `Asked. ${out.request.askedOf} has been told.` : `Asked. ${out.request.askedOf} could not be told just now: they will see it in their list.`);
    } catch (err) { said.textContent = err.message; e.target.disabled = false; }
  };
  return h('div.pf-ask',
    h('b', `Ask ${who || 'them'} for proof`),
    h('div.pf-chips', chips),
    note,
    h('div.pf-line', h('button.btn.primary', { type: 'button', onclick: sendIt }, 'Send the request'), h('button.btn', { type: 'button', onclick: onCancel }, 'Cancel'), said));
}

/**
 * Proof on an answer's card: what was asked and sent, and Ask for proof.
 * `who` is who gave the answer, for the words; `after` runs once something changed.
 */
export function proofBox(target, { who = null, after = null } = {}) {
  const box = h('div.pf-box');
  let asking = false;
  let data = null;
  const again = async () => {
    try { data = await api(`/proof?targets=${encodeURIComponent(target)}`); } catch { data = { requests: [], canAsk: false }; }
    paint();
  };
  function paint(message = null) {
    const list = data?.requests || [];
    const open = list.find((r) => r.status === 'asked');
    mount(box,
      message ? h('p.small', message) : null,
      list.slice(0, 3).reverse().map((r) => requestView(r, {
        canAsk: data.canAsk, again,
        sent: async (words) => { await again(); paint(words); if (after) after(); },
      })),
      asking ? askForm(target, who, {
        onDone: async (words) => { asking = false; await again(); paint(words); if (after) after(); },
        onCancel: () => { asking = false; paint(); },
      }) : data?.canAsk && !open ? h('div.pf-line', h('button.btn', { type: 'button', onclick: () => { asking = true; paint(); } }, list.length ? '📎 Ask for more' : '📎 Ask for proof')) : null);
  }
  again();
  return box;
}

/** A picture made at most 1600 pixels across, as a JPEG; a PDF as it is. */
async function asFile(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 1_400_000) throw new Error(`${file.name} is over 1.4 MB: take a photo of it instead.`);
    return { name: file.name, data: await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); }) };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error(`${file.name} could not be opened.`)); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { name: file.name.replace(/\.\w+$/, '.jpg'), data: canvas.toDataURL('image/jpeg', 0.82) };
  } finally { URL.revokeObjectURL(url); }
}

/**
 * The person asked: pictures or a PDF, a note, Send; or why not.
 * `r` is one of their requests; `after(words)` runs once it is sent.
 */
function sendForm(r, after) {
  const files = [];
  const list = h('div.pf-files');
  const said = h('span.small');
  const pick = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true });
  const note = h('input', { type: 'text', maxlength: '600', placeholder: 'A note (optional)' });
  const show = () => mount(list, files.map((f, i) => h('div.pf-file',
    f.data.startsWith('data:image') ? h('img', { src: f.data, alt: f.name }) : h('span.pf-pdf', '📄'),
    h('small', f.name), h('button.sh-link', { type: 'button', onclick: () => { files.splice(i, 1); show(); } }, 'Remove'))));
  pick.addEventListener('change', async () => {
    said.textContent = 'Getting it ready…';
    try {
      for (const f of pick.files) files.push(await asFile(f)); // eslint-disable-line no-await-in-loop
      said.textContent = '';
    } catch (err) { said.textContent = err.message; }
    pick.value = '';
    show();
  });
  let cannot = false;
  const body = h('div');
  const send = async (e) => {
    if (cannot ? !note.value.trim() : !files.length) { said.textContent = cannot ? 'Say why it cannot be sent.' : 'Add a picture or a PDF first.'; return; }
    e.target.disabled = true;
    said.textContent = 'Sending…';
    try {
      await api('/proof/send', { method: 'POST', body: { id: r.id, note: note.value, ...(cannot ? { cannot: true } : { files }) } });
      await after(cannot ? 'Sent: why it cannot be had.' : 'Proof sent. It is with the admin now.');
    } catch (err) { said.textContent = err.message; e.target.disabled = false; }
  };
  const paint = () => mount(body,
    cannot ? null : [h('button.pf-add', { type: 'button', onclick: () => pick.click() }, '📷 Take a picture, or choose pictures / a PDF'), pick, list],
    note,
    h('div.pf-line', h('button.btn.primary', { type: 'button', onclick: send }, cannot ? 'Send why' : `Send to ${r.askedBy}`), said),
    h('p.small', cannot ? h('button.sh-link', { type: 'button', onclick: () => { cannot = false; note.placeholder = 'A note (optional)'; paint(); } }, 'I can send it after all')
      : ['Can’t get it? ', h('button.sh-link', { type: 'button', onclick: () => { cannot = true; note.placeholder = 'Why it cannot be had'; paint(); } }, 'Say why instead')]));
  paint();
  return body;
}

/** The same, as its own card: the Inbox's Proof asked. */
export function sendCard(r, after) {
  return h('article.sh-ex.warn.pf-send',
    h('div.hd', h('span.sq', '📎'), h('h3', `${r.askedBy} asks for proof`)),
    h('p', 'Of your answer: ', h('b', `“${r.about || 'your answer'}”`)),
    h('div.pf-asked', `${r.kinds.map(kindName).join(', ')}${r.note ? `: “${r.note}”` : ''}`),
    sendForm(r, after));
}
