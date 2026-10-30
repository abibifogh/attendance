/**
 * Nice Place, end of shift: the open link the ladies at the desk send from.
 *
 * Made to be as plain as it can be: big letters, big buttons, one thing at a
 * time. No account: the link's own code (after # in the address) is the key,
 * and a new link from the manager stops the old one.
 *
 * 0. Tap your name (the phone remembers it).
 * 1. The shift is already there, in big letters, from the clock. Type the
 *    money: the shower and the toilet, children and adults. The totals add up
 *    as she types.
 * 2. One picture of the four counters. They are read from it; a number that
 *    cannot be read is read again when sent, and by the manager after that.
 * 3. A big tick, what was sent, and what to write on the envelope.
 *
 * Insight works out how many people paid from the money and holds it against
 * the counters (niceplace.js).
 */

/*
 * Written for old phones as well as new: a plain script, not a module, and
 * nothing newer than the browsers of 2017 (no ?., no ??, no .flat(), no
 * replaceChildren, no { ...object }). The desk phone may be years old, and
 * one unknown word stops the whole page at "Loading…".
 */
// Its own names, kept apart from the browser's (a plain script's `top` would be window.top).
(function () {
window.npStarted = true;

// Putting the page on the phone as an app (as install.js does for Insight, here without modules).
var offer = null;
var waiting = [];
window.addEventListener('beforeinstallprompt', function (event) { event.preventDefault(); offer = event; waiting.forEach(function (fn) { fn(); }); });
window.addEventListener('appinstalled', function () { offer = null; waiting.forEach(function (fn) { fn(); }); });
const installed = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const isIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
// Offered whenever it is not the app already: where the browser makes no offer of its own, the steps.
const canInstall = () => !installed();
const ANDROID_STEPS = 'Tap Chrome’s menu (the three dots ⋮ at the top right), then “Add to Home screen” or “Install app”.';
// The link with ?plain: no app, only a shortcut that opens the page in Chrome. For an old phone
// whose installed app will not start ("Nice Place keeps stopping").
const plain = /[?&]plain(=|&|$)/.test(location.search);
const SHORTCUT_STEPS = 'Tap Chrome’s menu (the three dots ⋮ at the top right), then “Add to Home screen”, then “Add”. Nice Place opens in Chrome from it.';
async function install() {
  if (plain) return 'shortcut';
  if (!offer) return isIphone() ? 'iphone' : 'android';
  offer.prompt();
  const choice = await offer.userChoice;
  offer = null;
  return choice.outcome;
}
const onInstallChange = (fn) => { waiting.push(fn); };
const IPHONE_STEPS = 'On an iPhone: tap the Share button (the square with an arrow, at the bottom), then “Add to Home Screen”.';
const registerWorker = () => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); };
/** An array of arrays, one level flat. */
const flatten = (list) => list.reduce((out, x) => out.concat(Array.isArray(x) ? x : [x]), []);

const page = document.getElementById('page');
const head = document.getElementById('head');
// The short link (/niceplace) names itself; the long one carries its code after #.
const ending = /^\/([A-Za-z0-9-]+)\/?$/.exec(location.pathname);
const slug = ending ? ending[1].toLowerCase() : '';
const short = slug && slug !== 'np' && slug !== 'np.html' ? slug : '';
// The link's code: from the address, or kept on this phone from the first time it was opened.
const token = short ? '' : (() => {
  const fromLink = location.hash.replace(/^#/, '').trim();
  try {
    if (fromLink) localStorage.setItem('np-token', fromLink);
    return fromLink || localStorage.getItem('np-token') || '';
  } catch (e) { return fromLink; }
})();
/** What the server is shown to know the link: its ending, or its code. */
const key = short ? { s: short } : { t: token };
const keyQuery = short ? `s=${encodeURIComponent(short)}` : `t=${encodeURIComponent(token)}`;
if ((short || token) && !plain) {
  // So it can be put on the phone as the Nice Place app, opening on this link.
  document.head.append(Object.assign(document.createElement('link'), { rel: 'manifest', href: `/api/np/manifest?${keyQuery}` }));
}
if (!plain) registerWorker();
const SHIFT = { day: 'DAY SHIFT', night: 'NIGHT SHIFT' };
const COLOURS = ['#0e7490', '#7c3aed', '#b45309', '#15803d', '#be185d', '#1d4ed8'];

const el = (tag, props = {}, ...kids) => {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) { kids.unshift(props); props = {}; }
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  flatten(kids).forEach((k) => { if (k != null && k !== false) e.append(k); });
  return e;
};
/** Fill a node, skipping what is not there. */
const put = (node, ...kids) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  flatten(kids).forEach((k) => { if (k != null && k !== false) node.append(k); });
};
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const cedi = (n) => `GH₵ ${Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
const typed = (input) => { const n = Number(String(input.value).replace(/[\s,]/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };

async function call(path, body) {
  const res = await fetch(`/api/np/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

/** The picture, made at most 1280 pixels across and sent as a JPEG: clear enough to read, small enough to send. */
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}

const remember = (name) => { try { if (name) localStorage.setItem('np-name', name); else localStorage.removeItem('np-name'); } catch (e) { /* not kept */ } };
const remembered = () => { try { return localStorage.getItem('np-name'); } catch (e) { return null; } };

/** The dark band at the top: small words over big ones, and how far through. */
function top(small, big, step = 0, extra = null) {
  put(head, 
    step ? el('div', { class: 'steps' }, [1, 2, 3].map((n) => el('i', { class: n <= step ? 'on' : '' }))) : null,
    el('small', {}, small), el('b', {}, big), extra);
}

let form = null;
let name = null;
let when = null;
let sales = { showerChild: '', showerAdult: '', toiletChild: '', toiletAdult: '' };
let photo = null;

async function start() {
  if (!short && !token) { top('Nice Place', 'This link is not complete'); put(page, el('p', { class: 'err' }, 'Ask the manager for the Nice Place link.')); return; }
  top('Nice Place', 'Loading…');
  try { form = await call(`form?${keyQuery}`); } catch (err) { top('Nice Place', 'This link does not open'); put(page, el('p', { class: 'err' }, err.message)); return; }
  name = form.staff.includes(remembered()) ? remembered() : null;
  when = { day: form.suggest.day, shift: form.suggest.shift };
  sales = { showerChild: '', showerAdult: '', toiletChild: '', toiletAdult: '' };
  photo = null;
  if (name) money(); else who();
}

/**
 * "Put Nice Place on this phone": the browser's own question on Android, the
 * steps on an iPhone. Gone once it is installed, or opened as the app.
 */
function installBox() {
  if (!canInstall()) return null;
  const said = el('p', {}, 'Then it opens with one tap, like any other app.');
  const go = el('button', { type: 'button', class: 'big app' }, '📲 Put Nice Place on this phone');
  go.addEventListener('click', async () => {
    const out = await install();
    if (out === 'iphone') put(said, IPHONE_STEPS);
    else if (out === 'android') put(said, ANDROID_STEPS);
    else if (out === 'shortcut') put(said, SHORTCUT_STEPS);
    else if (out === 'accepted') put(said, '✓ Done. Find Nice Place on the phone’s home screen.');
  });
  return el('div', { class: 'install' }, el('b', {}, 'Make it an app'), said, go);
}

/** Step 0: whose shift. */
function who() {
  top('Nice Place', 'Who are you?');
  put(page, installBox(), 
    form.staff.length ? el('div', { class: 'names' }, form.staff.map((n, i) => el('button', {
      type: 'button', class: `name${n === name ? ' on' : ''}`, onclick: () => { name = n; remember(n); money(); },
    }, el('span', { class: 'face', style: `background:${COLOURS[i % COLOURS.length]}` }, n.trim().charAt(0).toUpperCase()), n)))
      : el('p', { class: 'err' }, 'No names yet. Ask the manager to add yours.'));
}

/** Step 1: the money. */
function money() {
  const pill = el('span', { class: `shiftpill ${when.shift}` }, `${when.shift === 'day' ? '☀' : '☾'} ${SHIFT[when.shift]}`);
  top(`Hello, ${name}`, dayText(when.day), 1, el('div', {}, pill, el('small', { class: 'hours' }, form.hours[when.shift])));
  const inputs = {};
  const box = (key, label) => {
    inputs[key] = el('input', { inputmode: 'decimal', autocomplete: 'off', 'aria-label': label, value: sales[key], placeholder: '0' });
    inputs[key].addEventListener('input', () => { sales[key] = inputs[key].value; sum(); });
    return el('label', { class: 'fld' }, el('span', {}, label.split(', ')[1]), el('span', { class: 'in' }, el('em', {}, 'GH₵'), inputs[key]));
  };
  const showerTotal = el('b');
  const toiletTotal = el('b');
  const all = el('b');
  const sum = () => {
    const s = typed(inputs.showerChild) + typed(inputs.showerAdult);
    const t = typed(inputs.toiletChild) + typed(inputs.toiletAdult);
    showerTotal.textContent = cedi(s);
    toiletTotal.textContent = cedi(t);
    all.textContent = cedi(s + t);
  };
  const said = el('div');
  const next = el('button', { type: 'button', class: 'big go' }, 'Next: picture ›');
  next.addEventListener('click', () => {
    const bad = Object.entries(inputs).find(([, i]) => i.value.trim() && !(Number(i.value.replace(/[\s,]/g, '')) >= 0));
    if (bad) { put(said, el('p', { class: 'err' }, 'Type only numbers, like 120 or 45.50.')); bad[1].focus(); return; }
    if (!Object.values(inputs).some((i) => typed(i) > 0)) { put(said, el('p', { class: 'err' }, 'Type the money first. If a box had nothing, leave it empty.')); return; }
    picture();
  });
  const chosen = form.choices.find((c) => c.day === when.day && c.shift === when.shift);
  const sent = chosen && chosen.sent;
  put(page, 
    sent ? el('p', { class: 'warn' }, 'This shift is sent already. Send again only to correct it.') : null,
    el('section', { class: 'sale shower' }, el('h3', {}, '🚿 Shower'),
      el('div', { class: 'row2' }, box('showerChild', 'Shower, Children'), box('showerAdult', 'Shower, Adults')),
      el('div', { class: 'tot' }, el('span', {}, 'Shower total'), showerTotal)),
    el('section', { class: 'sale toilet' }, el('h3', {}, '🚽 Toilet'),
      el('div', { class: 'row2' }, box('toiletChild', 'Toilet, Children'), box('toiletAdult', 'Toilet, Adults')),
      el('div', { class: 'tot' }, el('span', {}, 'Toilet total'), toiletTotal)),
    el('div', { class: 'grand' }, el('span', {}, 'All money'), all),
    said, next,
    el('div', { class: 'small-row' },
      el('button', { type: 'button', class: 'plain', onclick: chooseShift }, 'This is not my shift'),
      el('button', { type: 'button', class: 'plain', onclick: () => { remember(null); name = null; who(); } }, `Not ${name}?`)));
  sum();
}

/** The shifts that may be sent, as big buttons. */
function chooseShift() {
  top(`Hello, ${name}`, 'Which shift?');
  put(page, el('div', { class: 'names' }, form.choices.map((c) => el('button', {
    type: 'button', class: `name shift${c.day === when.day && c.shift === when.shift ? ' on' : ''}`,
    onclick: () => { when = { day: c.day, shift: c.shift }; money(); },
  }, el('span', { class: `face ${c.shift}` }, c.shift === 'day' ? '☀' : '☾'),
  el('span', {}, `${c.day === form.today ? 'Today' : 'Yesterday'} · ${c.shift === 'day' ? 'Day' : 'Night'}`, el('small', {}, c.sent ? 'sent already' : form.hours[c.shift]))))));
}

/** Step 2: one picture of the counters. */
function picture() {
  top(`${dayText(when.day)} · ${when.shift === 'day' ? 'Day' : 'Night'} shift`, 'Picture of the counters', 2);
  const file = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const shot = el('div', { class: 'shot' }, photo ? el('img', { src: photo, alt: 'The counters' }) : null);
  const said = el('div');
  const take = el('button', { type: 'button', class: 'big cam' }, photo ? '📷 Take it again' : '📷 Take the picture');
  take.addEventListener('click', () => file.click());
  const send = el('button', { type: 'button', class: 'big go', hidden: !photo }, 'Send ›');
  const back = el('button', { type: 'button', class: 'plain', onclick: money }, '‹ Back to the money');
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    put(said, el('p', { class: 'note' }, 'Getting the picture ready…'));
    try { photo = await shrink(file.files[0]); } catch (e) { photo = null; put(said, el('p', { class: 'err' }, 'That picture could not be used. Take it again.')); return; }
    file.value = '';
    put(shot, el('img', { src: photo, alt: 'The counters' }));
    take.textContent = '📷 Take it again';
    send.hidden = false;
    put(said, el('p', { class: 'note' }, 'Reading the numbers…'));
    let out;
    try { out = await call('read', Object.assign({}, key, { photo })); } catch (e) { out = { available: false }; }
    if (!out.available) { put(said, el('p', { class: 'warn' }, 'It could not be read just now. Send it: it will be read again, or the manager will read it.')); return; }
    if (!out.unreadable.length) { put(said, el('p', { class: 'readok' }, '✓ All four numbers read from the picture')); return; }
    put(said, el('p', { class: 'warn' }, `${out.unreadable.map((c) => c.toUpperCase()).join(' and ')} could not be read. Take it again, closer and straight, or send it as it is: the manager will read it.`));
  });
  send.addEventListener('click', async () => {
    send.disabled = true; send.textContent = 'Sending…';
    try {
      const out = await call('send', Object.assign({}, key, { name, day: when.day, shift: when.shift, photo, sales }));
      done(out);
    } catch (err) {
      put(said, el('p', { class: 'err' }, err.message));
      send.disabled = false; send.textContent = 'Send ›';
    }
  });
  put(page, shot, file, said, take, send, back);
}

/** Step 3: sent. */
function done(out) {
  top('Nice Place', 'Sent', 3);
  const words = `${shortDay(when.day)} · ${when.shift === 'day' ? 'Day' : 'Night'}`;
  put(page, 
    el('div', { class: 'done' }, el('div', { class: 'tick' }, '✓'), el('h3', {}, `Thank you, ${name}`),
      el('p', {}, 'Put the money in the envelope and write ', el('b', {}, words), ' on it.')),
    out.sales ? el('div', { class: 'summ' },
      el('div', {}, el('span', {}, '🚿 Shower'), el('b', {}, cedi(out.sales.shower / 100))),
      el('div', {}, el('span', {}, '🚽 Toilet'), el('b', {}, cedi(out.sales.toilet / 100))),
      el('div', { class: 'all' }, el('span', {}, 'All money'), el('b', {}, cedi(out.sales.total / 100)))) : null,
    (out.pending || []).length ? el('p', { class: 'note' }, 'One number on the counters could not be read. The manager will read it from the picture: nothing more to do.') : null,
    el('button', { type: 'button', class: 'big soft', onclick: () => start() }, 'Done'),
    installBox());
}

// The browser's offer comes a moment after the page: show the button then, on the names.
onInstallChange(() => { if (head.textContent.includes('Who are you?')) who(); });

start();
})();
