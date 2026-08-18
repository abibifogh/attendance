import { h, mount, toast } from './util.js';
import { control, listEditor, signaturePad } from './fields.js';

/**
 * The page somebody opens on their phone.
 *
 * Its own entry point, sharing nothing with the office app but the stylesheet
 * and two helpers. That is deliberate: this page is loaded by people who have
 * no account, over a link that may have been forwarded, and the less of the
 * system it can reach the better. There is no session here, no navigation, and
 * nothing that reads a record back — the form starts empty, because a form
 * that showed what the property already knows would be a form that leaks it to
 * whoever is holding the phone.
 *
 * Written for a phone on a slow connection at the end of a shift. One column,
 * large targets, a list of what is left, and nothing that has to be scrolled
 * sideways.
 */

const root = document.getElementById('invite');
/**
 * The token, read from the segment after `/i/` in the address.
 *
 * Two ways of getting this wrong, and both have bitten.
 *
 * Stripping `/i/` off the front assumes the link was built on a bare origin,
 * which is not something the page can know — the address links are built from
 * is a setting somebody typed once, and a path left in it puts an extra
 * segment in the middle of every link the property sends.
 *
 * Taking the last segment instead assumes the address still has a token in it
 * at all. When it does not — the page reached at `/invite` rather than
 * `/i/<token>`, because something along the way tidied the URL — the last
 * segment is the word `invite`, and the page confidently reports a dead link
 * when the truth is that the address lost its code.
 *
 * So: find the prefix, take what follows it, and treat its absence as an
 * address problem rather than an expired link. Nothing follows from a guess
 * here except somebody being sent to ask for a replacement that will fail in
 * exactly the same way.
 */
const token = tokenFrom(location.pathname, 'i');

function tokenFrom(pathname, prefix) {
  const parts = pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf(prefix);
  if (at === -1 || at === parts.length - 1) return '';
  try {
    return decodeURIComponent(parts[at + 1]);
  } catch {
    // A stray % in a forwarded link is not a reason to show a blank page.
    return parts[at + 1];
  }
}

let packet = null;

start();

async function start() {
  if (!token) return fail('This address has no code in it.');

  try {
    const head = await call(`/api/i/${encodeURIComponent(token)}`, null, 'GET');
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

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(root.querySelector('.btn-primary')); });
  input.focus();
}

async function open(pin) {
  packet = await call(`/api/i/${encodeURIComponent(token)}/open`, { pin });
  draw();
}

// ---------------------------------------------------------------------------
// The list of what is left
// ---------------------------------------------------------------------------

function draw() {
  const tasks = [];
  if (packet.wantsDetails) {
    tasks.push({
      key: 'details',
      title: 'Your details',
      done: packet.detailsSent,
      detail: packet.detailsSent ? 'Sent — thank you' : 'Address, ID, who to ring in an emergency',
      go: showDetails,
    });
  }
  for (const contract of packet.contracts) {
    tasks.push({
      key: `c${contract.id}`,
      title: contract.title,
      done: contract.signed,
      refused: contract.declined,
      detail: contract.signed
        ? `Signed by ${contract.signerName}`
        : contract.declined ? 'You said no to this' : 'Read it and sign',
      go: () => showContract(contract),
    });
  }

  const left = tasks.filter((t) => !t.done && !t.refused).length;

  mount(root, shell(packet.property,
    h('div.card',
      h('h2', `Hello ${packet.name.split(' ')[0]}`),
      packet.message ? h('p.note-from', packet.message) : null,
      h('p.muted', left
        ? `There ${left === 1 ? 'is one thing' : `are ${left} things`} to do. You can stop and `
          + 'come back to this link later.'
        : 'Everything here is done. Thank you — you can close this page.'),
    ),

    h('div.tasks', tasks.map((task) => h('button.task', {
      class: task.done ? 'task done' : task.refused ? 'task refused' : 'task',
      onclick: task.done || task.refused ? null : task.go,
      disabled: task.done || task.refused,
    },
      h('span.task-mark', task.done ? '✓' : task.refused ? '×' : '›'),
      h('span.task-text',
        h('strong', task.title),
        h('small', task.detail),
      ),
    ))),

    h('p.fineprint',
      'This link is private to you and stops working on '
      + `${String(packet.expiresAt).slice(0, 10)}. `
      + 'Nothing you send is visible to anyone but the office.'),
  ));
}

// ---------------------------------------------------------------------------
// Their details
// ---------------------------------------------------------------------------

function showDetails() {
  const values = {};
  const editors = {};

  const sections = packet.sections.map((section) => h('section.card',
    h('h3', section.label),
    section.note ? h('p.muted', section.note) : null,
    section.fields.map((f) => h('label.field',
      h('span', f.label),
      control(f, '', { oninput: (e) => { values[f.key] = e.target.value; },
        onchange: (e) => { values[f.key] = e.target.value; } }),
      f.hint ? h('small.muted', f.hint) : null,
    )),
  ));

  const lists = packet.lists.map((list) => {
    const editor = listEditor(list, [], { labels: LABELS[list.key] ?? {} });
    editors[list.key] = editor;
    return h('section.card',
      h('h3', list.label),
      list.key === 'contacts'
        ? h('p.muted', 'Who should we ring if something happens to you at work? '
          + 'Put the person who actually answers their phone first.')
        : null,
      editor.element,
    );
  });

  const send = async (button) => {
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const payload = {
        profile: values,
        lists: Object.fromEntries(Object.entries(editors).map(([k, e]) => [k, e.read()])),
      };
      await call(`/api/i/${encodeURIComponent(token)}/details`, payload);
      packet.detailsSent = true;
      thanks('Sent. The office will check it over.',
        'Nothing is changed on your record until somebody there looks at it.');
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
      button.textContent = 'Send it in';
    }
  };

  mount(root, shell(packet.property,
    back(),
    h('div.card',
      h('h2', 'Your details'),
      h('p.muted', 'Fill in what you can. Anything you leave blank is simply not sent — it does '
        + 'not delete what the office already has.'),
    ),
    ...sections,
    ...lists,
    h('div.card',
      h('button.btn.btn-primary.btn-wide', { onclick: (e) => send(e.target) }, 'Send it in'),
      h('p.fineprint', 'Your details are used to run payroll, SSNIT and your personnel file, '
        + 'and are not shared outside the property.'),
    ),
  ));
  window.scrollTo(0, 0);
}

const LABELS = {
  contacts: {
    kind: 'Emergency or next of kin', name: 'Their name', relationship: 'Relationship to you',
    phone: 'Phone', alt_phone: 'Another number', email: 'Email', address: 'Where they live',
  },
  education: {
    level: 'Level', institution: 'School or college', qualification: 'Qualification',
    field: 'Subject', finished_on: 'Year finished',
  },
  employment: {
    employer: 'Employer', job_title: 'What you did', from_on: 'From', to_on: 'To',
    reason_left: 'Why you left',
  },
};

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * A contract, and then a signature.
 *
 * The signing controls sit below the whole text rather than floating over it,
 * so reaching them means scrolling past the words. That is not a
 * technicality — what makes an electronic signature stand up is evidence that
 * the person was shown the terms and acted deliberately, and a button that can
 * be pressed without the text ever leaving the bottom of the screen is a worse
 * version of that evidence.
 */
function showContract(contract) {
  call(`/api/i/${encodeURIComponent(token)}/viewed`, { contractId: contract.id }).catch(() => {});

  const pad = signaturePad();
  let agreed = false;
  let typed = '';

  const sign = async (button) => {
    if (!agreed) return toast('Tick the box first.', 'bad');
    if (!pad.isDrawn() && typed.trim().split(/\s+/).length < 2) {
      return toast('Sign with your finger, or type your full name.', 'bad');
    }

    button.disabled = true;
    button.textContent = 'Signing…';
    try {
      await call(`/api/i/${encodeURIComponent(token)}/sign`, {
        contractId: contract.id,
        name: typed.trim() || packet.name,
        ink: pad.read(),
        hash: contract.hash,
        agreed: true,
      });
      contract.signed = true;
      contract.signerName = typed.trim() || packet.name;
      thanks('Signed. Thank you.',
        'The office has a copy with the time and date on it. Ask them for one whenever you want it.');
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
      button.textContent = 'Sign this';
    }
    return undefined;
  };

  const refuse = async () => {
    const why = window.prompt('You do not have to sign. Tell the office why, if you want to:');
    if (why === null) return;
    try {
      await call(`/api/i/${encodeURIComponent(token)}/decline`, { contractId: contract.id, note: why });
      contract.declined = true;
      thanks('Noted.', 'Nothing has been signed. The office will get in touch.');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  mount(root, shell(packet.property,
    back(),
    h('div.card',
      h('h2', contract.title),
      h('p.muted', 'Read all of it. Scroll to the bottom to sign.'),
    ),
    h('div.card', h('pre.contract-text', contract.body)),
    h('div.card',
      h('h3', 'Sign here'),
      h('label.tickline',
        h('input', { type: 'checkbox', onchange: (e) => { agreed = e.target.checked; } }),
        h('span', 'I have read this document and I agree to sign it electronically. '
          + 'I understand this has the same effect as signing on paper.'),
      ),
      pad.element,
      h('label.field',
        h('span', 'Or type your full name'),
        h('input', {
          type: 'text', maxlength: 120, autocomplete: 'name', placeholder: packet.name,
          oninput: (e) => { typed = e.target.value; },
        }),
      ),
      h('button.btn.btn-primary.btn-wide', { onclick: (e) => sign(e.target) }, 'Sign this'),
      h('button.btn-sm.btn-wide', { onclick: refuse, style: { marginTop: '.6rem' } },
        'I do not want to sign this'),
      h('p.fineprint',
        'When you sign, the time, your network address and a fingerprint of these exact words '
        + 'are recorded, so both you and the property can show later what was agreed.'),
    ),
  ));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

function shell(property, ...children) {
  return h('div.invite-inner',
    h('header.invite-head', h('div.invite-brand', property || 'Staff')),
    ...children,
  );
}

const back = () => h('button.btn-sm.invite-back', { onclick: draw }, '‹ Back');

function thanks(title, detail) {
  mount(root, shell(packet.property,
    h('div.card.card-done',
      h('div.done-mark', '✓'),
      h('h2', title),
      h('p.muted', detail),
      h('button.btn.btn-primary.btn-wide', { onclick: draw }, 'Back to the list'),
    ),
  ));
  window.scrollTo(0, 0);
}

function fail(message) {
  mount(root, shell('',
    h('div.card',
      h('h2', 'This link will not open'),
      h('p', message),
      // Two different faults, and telling somebody the wrong one sends them to
      // ask for a new link that will fail in exactly the same way. A server
      // that does not recognise the address at all is not a link that has run
      // out; it is a link that arrived wrong, and the address is worth reading
      // back to whoever sent it.
      /no code in it|unknown endpoint/i.test(message)
        ? h('div',
          h('p.muted', 'The address is missing the long code that makes it yours, so there is '
            + 'nothing here to look up. Nothing has expired — the link was almost certainly '
            + 'shortened, retyped, or opened from a preview rather than tapped.'),
          h('p.muted', 'Go back to the message and tap the link itself. If it still lands here, '
            + 'send whoever gave it to you the whole line from your address bar and they can '
            + 'see what is missing.'))
        : h('p.muted', 'Links are private to one person and stop working after a few weeks. '
          + 'Ask whoever sent it for a new one.'),
    ),
  ));
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
