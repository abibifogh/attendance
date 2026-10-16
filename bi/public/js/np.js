/**
 * Nice Place, end of shift: the open link staff send the counters from.
 *
 * No account: the link's own code (after # in the address) is the key, and a
 * new link from the manager stops the old one. Staff choose their name, the
 * shift (the one after the last sent is suggested) and take a picture of the
 * four counters. The picture is made smaller on the phone, then read: the four
 * numbers fill in by themselves and cannot be typed over. A number that cannot
 * be read for certain, or reads wrong, means a new picture. Only when the
 * reader cannot be reached are the numbers typed (and Insight says so).
 */

const page = document.getElementById('page');
const when = document.getElementById('when');
const token = location.hash.replace(/^#/, '').trim();
const SHIFT = { day: 'Day shift', night: 'Night shift' };
const COUNTERS = [['gb', 'GB · Gents bath'], ['gt', 'GT · Gents toilet'], ['lb', 'LB · Ladies bath'], ['lt', 'LT · Ladies toilet']];

const el = (tag, props = {}, ...kids) => {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) { kids.unshift(props); props = {}; }
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function call(path, body) {
  const res = await fetch(`/api/np/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

/** The picture, made at most 1600 pixels across and sent as a JPEG. */
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } finally { URL.revokeObjectURL(url); }
}

async function start() {
  if (!token) { page.replaceChildren(el('p', { class: 'err' }, 'This link is not complete. Ask the manager for the Nice Place link.')); when.textContent = ''; return; }
  let form;
  try { form = await call(`form?t=${encodeURIComponent(token)}`); } catch (err) { page.replaceChildren(el('p', { class: 'err' }, err.message)); when.textContent = ''; return; }
  const remembered = (() => { try { return localStorage.getItem('np-name'); } catch { return null; } })();
  const name = el('select', { 'aria-label': 'Your name' }, el('option', { value: '' }, 'Choose your name'),
    form.staff.map((n) => el('option', { value: n, selected: n === remembered }, n)));
  const day = el('select', { 'aria-label': 'Date of the shift' },
    [form.today, addDays(form.today, -1)].map((d) => el('option', { value: d, selected: d === form.suggest.day }, `${d === form.today ? 'Today' : 'Yesterday'} · ${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}`)));
  const shift = el('select', { 'aria-label': 'Shift' }, Object.entries(SHIFT).map(([k, v]) => el('option', { value: k, selected: k === form.suggest.shift }, v)));
  const showWhen = () => { when.textContent = `${dayText(day.value)} · ${SHIFT[shift.value]}`; };
  day.addEventListener('change', showWhen); shift.addEventListener('change', showWhen); showWhen();

  let photo = null;
  // What the picture was read as.
  let read = null;
  const readSaid = el('div', { class: 'readsaid' });
  const file = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const shot = el('div', { class: 'shot', role: 'button', tabindex: '0' }, el('div', {}, el('b', '📷 Take picture'), 'or choose one from the phone', el('br'), el('small', {}, 'All four counters in one picture, clear and straight')));
  shot.addEventListener('click', () => file.click());
  // Read only: filled from the picture. Typed only when the reader cannot be reached.
  const inputs = Object.fromEntries(COUNTERS.map(([k]) => [k, el('input', { inputmode: 'numeric', autocomplete: 'off', placeholder: 'from the picture', readonly: true, 'aria-label': k.toUpperCase() })]));
  const typing = (on) => { for (const [k] of COUNTERS) { inputs[k].readOnly = !on; inputs[k].placeholder = on ? '0' : 'from the picture'; } };
  const retake = el('button', { type: 'button', class: 'retake', onclick: () => file.click() }, '📷 Take the picture again');
  /** The numbers off the picture: filled in, or the picture asked for again. */
  const readPicture = async () => {
    read = null;
    said.replaceChildren();
    readSaid.replaceChildren(el('p', { class: 'note' }, 'Reading the counters…'));
    for (const [k] of COUNTERS) { inputs[k].classList.remove('auto', 'missing'); inputs[k].value = ''; }
    typing(false);
    let out;
    try { out = await call('read', { t: token, photo }); } catch (err) { out = { available: false }; }
    if (!out.available) {
      typing(true);
      readSaid.replaceChildren(el('p', { class: 'warn' }, 'The picture could not be read automatically just now. Type the numbers on the counters; the manager will see they were typed.'));
      return;
    }
    read = out;
    for (const [k, label] of COUNTERS) {
      const v = out.values[k];
      inputs[k].value = v == null ? '' : String(v);
      inputs[k].classList.toggle('auto', v != null);
      inputs[k].classList.toggle('missing', v == null);
      inputs[k].placeholder = v == null ? 'not read' : 'from the picture';
      inputs[k].setAttribute('aria-label', `${label}${v == null ? ', not read from the picture' : ', read from the picture'}`);
    }
    const lower = (out.lower || []).map((x) => el('p', { class: 'warn' }, `${x.counter.toUpperCase()} reads ${x.now.toLocaleString('en-GB')}, lower than the last reading (${x.was.toLocaleString('en-GB')}). If the counter was not reset, take the picture again.`));
    if (!out.unreadable.length) {
      readSaid.replaceChildren(el('p', { class: 'ok-note' }, '✓ Read from the picture. Check each number against the counters: if one is wrong, take the picture again.'), retake, ...lower);
      return;
    }
    const names = out.unreadable.map((c) => c.toUpperCase());
    readSaid.replaceChildren(
      el('p', { class: 'err' }, `${names.join(' and ')} could not be read from this picture${out.problem ? ` (${out.problem})` : ''}. Take the picture again: all four counters, close and straight, with no glare.`),
      retake,
      ...lower);
  };
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    shot.replaceChildren(el('div', {}, 'Getting the picture ready…'));
    try { photo = await shrink(file.files[0]); shot.replaceChildren(el('img', { src: photo, alt: 'The counters' })); } catch { photo = null; read = null; shot.replaceChildren(el('div', {}, el('b', 'That picture could not be read'), 'Take it again')); return; }
    file.value = '';
    await readPicture();
  });
  const said = el('div');
  const send = el('button', { type: 'button' }, 'Send');
  send.addEventListener('click', async () => {
    said.replaceChildren();
    const missing = [!name.value && 'your name', !photo && 'the picture', ...COUNTERS.filter(([k]) => !inputs[k].value.trim()).map(([k]) => k.toUpperCase())].filter(Boolean);
    // A picture with a counter that could not be read is taken again: the numbers come only from the picture.
    if (read?.unreadable?.length) { said.replaceChildren(el('p', { class: 'err' }, 'Take the picture again first: not every counter could be read from it.')); return; }
    if (missing.length) { said.replaceChildren(el('p', { class: 'err' }, `Still needed: ${missing.join(', ')}.`)); return; }
    send.disabled = true; send.textContent = 'Sending…';
    try {
      const out = await call('send', { t: token, name: name.value, day: day.value, shift: shift.value, photo, ...Object.fromEntries(COUNTERS.map(([k]) => [k, inputs[k].value])) });
      try { localStorage.setItem('np-name', name.value); } catch { /* not kept */ }
      page.replaceChildren(el('div', { class: 'done' },
        el('img', { src: photo, alt: 'The counters', style: 'width:100%;border-radius:12px' }),
        el('div', { class: 'ok' }, '✓'),
        el('b', { style: 'font-size:19px' }, `Sent at ${String(out.sentAt).slice(11, 16)}`),
        el('p', { class: 'note' }, `Thank you, ${name.value}.`),
        el('p', { class: 'note' }, `A number wrong? Send again with a new picture within ${out.resendUntil} minutes of the first time and the new one is kept.`),
        el('button', { type: 'button', class: 'link', onclick: () => start() }, 'Send again')));
    } catch (err) {
      said.replaceChildren(el('p', { class: 'err' }, err.message));
      send.disabled = false; send.textContent = 'Send';
    }
  });

  page.replaceChildren(
    el('label', {}, 'Your name', name),
    el('div', { class: 'two' }, el('label', {}, 'Date', day), el('label', {}, 'Shift', shift)),
    el('div', { class: 'lbl' }, '1. Take a picture of the counters'), shot, file,
    readSaid,
    el('div', { class: 'lbl' }, '2. Check the numbers on the counters'),
    el('div', { class: 'two' }, COUNTERS.map(([k, label]) => el('label', { class: 'num' }, el('small', {}, label), inputs[k]))),
    said, send);
}

start();
