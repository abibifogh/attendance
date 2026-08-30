import { h, mount, toast } from './util.js';

/**
 * The page somebody opens after applying for a job here.
 *
 * Its own entry point, sharing nothing with the office app but the stylesheet
 * and two helpers — the same split the employee link already uses, and for a
 * stronger reason: this is opened by people who do not work here and may never
 * do. There is no session, no navigation, and nothing that reads a record
 * back. It is told the property, the job, the message the office wrote and the
 * times that are free, and nothing else. Not what anybody thought of them, not
 * who else applied, not who is on the panel.
 *
 * THE POINT OF IT IS THE LIST OF TIMES. A time somebody is told to attend is a
 * time half of them cannot make, and the phone calls that follow are the whole
 * cost of arranging interviews at a place this size. So the property publishes
 * when it is free and the person picks — on their own phone, at eleven at
 * night, without ringing anybody.
 *
 * Written for a cheap phone on a slow connection. One column, large targets,
 * no sideways scrolling, and every screen readable before anything is pressed.
 */

const root = document.getElementById('hiring');

/**
 * The token, out of the segment after `/c/`.
 *
 * The same two traps as the employee link, and they bite the same way. Do not
 * strip a fixed prefix: the address links are built from is a setting somebody
 * typed, and a path in it puts an extra segment in the middle of every link.
 * Do not take the last segment: when the address has been tidied to `/hiring`
 * the last segment is the word "hiring", and the page then reports a dead link
 * when the truth is that the address lost its code — which sends somebody to
 * ask for a replacement that fails in exactly the same way.
 */
const token = tokenFrom(location.pathname, 'c');

function tokenFrom(pathname, prefix) {
  const parts = pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf(prefix);
  if (at === -1 || at === parts.length - 1) return '';
  try {
    return decodeURIComponent(parts[at + 1]);
  } catch {
    return parts[at + 1];
  }
}

let packet = null;
// Held so the page can ask the server for the times again without sending
// somebody back to the code screen. It never leaves this tab.
let code = null;

start();

async function start() {
  if (!token) return fail('This address has no code in it.');
  try {
    const head = await call(`/api/c/${encodeURIComponent(token)}`, null, 'GET');
    if (head.needsPin) return askForPin(head);
    await open(null);
  } catch (err) {
    fail(err.message);
  }
}

// ---------------------------------------------------------------------------
// Getting in
// ---------------------------------------------------------------------------

function askForPin(head) {
  const input = h('input.pin-input', {
    type: 'text', inputmode: 'numeric', maxlength: 4, autocomplete: 'off',
    placeholder: '••••', 'aria-label': 'Four-digit code',
  });

  const go = async (button) => {
    button.disabled = true;
    try {
      await open(input.value);
    } catch (err) {
      toast(err.message, 'bad');
      input.value = '';
      button.disabled = false;
      input.focus();
    }
  };

  mount(root, shell(head.property,
    h('div.card',
      h('h2', 'Enter your code'),
      h('p.muted', 'The four digits you were given. If you were not given one, tell whoever '
        + 'sent you this link.'),
      input,
      h('button.btn.btn-primary.btn-wide', { onclick: (e) => go(e.target) }, 'Open'),
    ),
  ));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(root.querySelector('.btn-primary'));
  });
  input.focus();
}

async function open(pin) {
  packet = await call(`/api/c/${encodeURIComponent(token)}/open`, { pin });
  code = pin ?? null;
  draw();
}

// ---------------------------------------------------------------------------
// What there is to do
// ---------------------------------------------------------------------------

function draw() {
  const first = String(packet.name || '').trim().split(/\s+/)[0] || 'there';

  mount(root, shell(packet.property,
    h('div.card',
      h('h2', `Hello ${first}`),
      h('p.muted', packet.job
        ? `Thank you for applying for ${packet.job}${packet.department ? ` in ${packet.department}` : ''}.`
        : `Thank you for applying to ${packet.property}.`),
      packet.message ? h('p.note-from', packet.message) : null,
    ),

    packet.wantsSlot ? slotSection() : null,
    packet.wantsDetails ? detailsSection() : null,
    packet.wantsCv ? cvSection() : null,

    h('p.invite-foot',
      'This link is private to you and stops working after a few weeks. '
      + 'You can close this page and come back to it.'),
  ));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Picking a time
// ---------------------------------------------------------------------------

/**
 * The times, grouped by day.
 *
 * A flat list of "Tuesday 10:00, Tuesday 10:30, Tuesday 11:00" is eleven rows
 * that all look the same, and on a phone somebody taps the wrong one. Grouped
 * under the day, each row is only a time, which is the only thing that
 * actually differs between them.
 */
function slotSection() {
  if (packet.chosen) return chosenCard();

  if (!packet.slots.length) {
    return h('section.card',
      h('h3', 'Choosing a time'),
      h('p.muted', 'There are no times free at the moment. Whoever sent you this link will be '
        + 'in touch, and you do not need to do anything.'));
  }

  const days = [];
  for (const slot of packet.slots) {
    const last = days[days.length - 1];
    if (last && last.day === slot.day) last.slots.push(slot);
    else days.push({ day: slot.day, slots: [slot] });
  }

  return h('section.card',
    h('h3', 'Choose a time for your interview'),
    h('p.muted', 'Pick whichever suits you. You can change it later if you need to.'),

    h('div.hire-days', days.map((day) => h('div.hire-day',
      h('h4', longDay(day.day)),
      h('div.hire-times', day.slots.map((slot) => h('button.hire-time', {
        type: 'button',
        onclick: (event) => take(slot, event.currentTarget),
      },
      h('strong', slot.at),
      h('small', `to ${slot.ends}`),
      slot.place ? h('small.muted', slot.place) : null)))))),
  );
}

/** The time they hold, and the two things anybody wants to do with it. */
function chosenCard() {
  const slot = packet.chosen;
  return h('section.card.card-done',
    h('div.done-mark', '✓'),
    h('h3', 'Your interview is booked'),
    h('p.hire-when',
      h('strong', longDay(slot.day)),
      h('span', ` at ${slot.at}`)),
    slot.place ? h('p.muted', `Where: ${slot.place}`) : null,
    h('p.muted', `It should take about ${minutesBetween(slot.at, slot.ends)} minutes. `
      + 'Please come a few minutes early.'),

    h('div.btn-row',
      h('button.btn-sm', { onclick: (e) => change(e.currentTarget) }, 'Choose a different time'),
      h('button.btn-sm', { onclick: (e) => cannotMake(e.currentTarget) }, 'I cannot make it')),
  );
}

async function take(slot, button) {
  button.disabled = true;
  try {
    const done = await call(`/api/c/${encodeURIComponent(token)}/choose`, { slotId: slot.id });
    packet.chosen = done.chosen;
    toast(done.changed ? 'Changed. See you then.' : 'Booked. See you then.', 'good');
    draw();
  } catch (err) {
    toast(err.message, 'bad');
    // Somebody else took it while this page was open, so the list on the
    // screen is out of date. Fetch it again rather than leaving a button that
    // will fail every time it is pressed.
    await refresh();
  }
}

/**
 * Change to another time.
 *
 * The old one is not given up first. Releasing and then choosing would leave
 * somebody with nothing if they closed the page in between, and the slot they
 * had would be gone.
 */
async function change(button) {
  button.disabled = true;
  try {
    await refresh();
    if (!packet.slots.length) {
      toast('There are no other times free at the moment.', 'bad');
      draw();
      return;
    }
    const keeping = packet.chosen;
    packet.chosen = null;
    mount(root, shell(packet.property,
      h('div.card',
        h('h3', 'Choose a different time'),
        h('p.muted', `You have ${longDay(keeping.day)} at ${keeping.at}. `
          + 'Pick another and it will move; nothing changes until you do.'),
        h('button.btn-sm', {
          onclick: () => { packet.chosen = keeping; draw(); },
        }, '‹ Keep the one I have')),
      slotSection(),
    ));
    window.scrollTo(0, 0);
  } catch (err) {
    toast(err.message, 'bad');
    button.disabled = false;
  }
}

async function cannotMake(button) {
  button.disabled = true;
  try {
    const done = await call(`/api/c/${encodeURIComponent(token)}/release`, {});
    packet.chosen = null;
    packet.slots = done.slots ?? [];
    mount(root, shell(packet.property,
      h('div.card',
        h('h3', 'Thank you for telling us'),
        h('p.muted', 'That time is free again and we know you cannot make it. '
          + 'Pick another one below if any of them suit you, or leave it and we will be in touch.')),
      slotSection(),
    ));
    window.scrollTo(0, 0);
  } catch (err) {
    toast(err.message, 'bad');
    button.disabled = false;
  }
}

/** The times again, from the server. */
async function refresh() {
  const fresh = await call(`/api/c/${encodeURIComponent(token)}/open`, { pin: code })
    .catch(() => null);
  if (fresh) packet = fresh;
  else draw();
}

// ---------------------------------------------------------------------------
// Their details
// ---------------------------------------------------------------------------

/**
 * A phone number and an email, and nothing else.
 *
 * Somebody who has applied for a job has not agreed to hand over an address, a
 * date of birth or an ID number, and asking for them before there is an offer
 * on the table is asking for what the property has no reason to hold. All of
 * that is on the employee form, which they see if they are taken on.
 */
function detailsSection() {
  const phone = h('input', {
    type: 'tel', value: packet.phone ?? '', maxlength: 40,
    placeholder: '024 000 0000', autocomplete: 'tel',
  });
  const email = h('input', {
    type: 'email', value: packet.email ?? '', maxlength: 160,
    placeholder: 'you@example.com', autocomplete: 'email',
  });

  const save = async (button) => {
    button.disabled = true;
    try {
      await call(`/api/c/${encodeURIComponent(token)}/details`,
        { phone: phone.value, email: email.value });
      packet.phone = phone.value || packet.phone;
      packet.email = email.value || packet.email;
      toast('Thank you, saved.', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
    button.disabled = false;
  };

  return h('section.card',
    h('h3', 'How we reach you'),
    h('p.muted', 'Check these are right. It is how we will let you know either way.'),
    h('label.field', h('span', 'Phone'), phone),
    h('label.field', h('span', 'Email'), email),
    h('button.btn.btn-primary.btn-wide', { onclick: (e) => save(e.currentTarget) }, 'Save'),
  );
}

// ---------------------------------------------------------------------------
// A CV
// ---------------------------------------------------------------------------

function cvSection() {
  const sent = packet.sent ?? [];
  const input = h('input', {
    type: 'file',
    accept: 'image/*,application/pdf,.doc,.docx',
    onchange: (event) => send(event.target),
  });

  const send = async (element) => {
    const chosen = element.files?.[0];
    if (!chosen) return;
    element.disabled = true;
    try {
      await call(`/api/c/${encodeURIComponent(token)}/cv`, {
        filename: chosen.name,
        mime: chosen.type || 'application/octet-stream',
        content: await asBase64(chosen),
      });
      toast('Got it, thank you.', 'good');
      await refresh();
      draw();
    } catch (err) {
      toast(err.message, 'bad');
      element.disabled = false;
      element.value = '';
    }
  };

  return h('section.card',
    h('h3', 'Your CV'),
    h('p.muted', sent.length
      ? `${sent.length} sent. You can add another if you want to.`
      : 'A photograph of a printed one is fine. Use the camera.'),
    sent.length
      ? h('ul.hire-sent', sent.map((f) => h('li', h('span', f.filename),
        h('small.muted', `${Math.round(f.bytes / 1000)} KB`))))
      : null,
    h('label.field', h('span', sent.length ? 'Send another' : 'Choose or photograph it'), input),
  );
}

/** A file as the API takes it. Read in one go: these are photographs, not films. */
function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

function shell(property, ...children) {
  return h('div.invite-inner',
    h('header.invite-head', h('div.invite-brand', property || 'Recruitment')),
    ...children,
  );
}

function fail(message) {
  mount(root, shell('',
    h('div.card',
      h('h2', 'This link will not open'),
      h('p', message),
      /no code in it|unknown endpoint/i.test(message)
        ? h('div',
          h('p.muted', 'The address is missing the long code that makes it yours, so there is '
            + 'nothing here to look up. Nothing has expired: the link was almost certainly '
            + 'shortened, retyped, or opened from a preview rather than tapped.'),
          h('p.muted', 'Go back to the message and tap the link itself. If it still lands here, '
            + 'send whoever gave it to you the whole line from your address bar.'))
        : h('p.muted', 'Links are private to one person and stop working after a few weeks. '
          + 'Ask whoever sent it for a new one.'),
    ),
  ));
}

/** Wednesday, 3 September, which is how somebody reads a date they must attend. */
function longDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

function minutesBetween(from, to) {
  const mins = (text) => {
    const [h1, m1] = String(text).split(':').map(Number);
    return h1 * 60 + m1;
  };
  return Math.max(5, mins(to) - mins(from));
}

async function call(path, body, method = 'POST') {
  const response = await fetch(path, {
    method,
    headers: body === undefined || body === null ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }).catch(() => null);

  if (!response) throw new Error('No connection. Check your data and try again.');

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}
