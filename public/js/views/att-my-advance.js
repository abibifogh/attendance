import { api } from '../api.js';
import { confirmAction, fmtDay, h, money, mount, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { advanceStatement, field, formDialog, niceMonth } from './att-shared.js';

/**
 * My salary advance.
 *
 * The one screen in this app about money somebody owes rather than money they
 * are owed, and the reason it exists is that the alternative is asking. The
 * question "how much is left on my advance" currently gets answered by a
 * manager looking in a notebook, which means it gets answered slowly, in front
 * of other people, and sometimes wrongly.
 *
 * THREE THINGS, IN THIS ORDER. What is left. What comes off next month. When
 * it ends. Everything else on the page is the working behind those three, and
 * the working matters: somebody who cannot see the months they have already
 * paid has no way of disagreeing with the total.
 *
 * NOTHING HERE IS A DECISION. Asking for an advance is asking. The screen says
 * so plainly, because an app that reads like an approval is how somebody ends
 * up counting on money that is not coming.
 */

export async function renderAttMyAdvance() {
  const host = h('div');
  const data = await api.myAdvances();
  const cash = (n) => money(n, data.currency);
  const reload = async () => mount(host, await renderAttMyAdvance());

  if (!data.linked) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'My advance'))),
      emptyState('This login is not linked to your staff record',
        'Ask whoever set it up to point it at you under Users, and this will fill in.'));
    return host;
  }

  const waiting = data.advances.find((a) => a.status === 'requested');
  const running = data.advances.filter((a) => a.status === 'approved');
  const done = data.advances.filter((a) => ['settled', 'declined', 'withdrawn'].includes(a.status));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'My advance'),
        h('div.sub', 'What you owe, what comes off, and when it ends'),
      ),
      waiting
        ? null
        : h('button.btn-sm.btn-primary', {
          onclick: () => ask(data, reload, cash),
        }, 'Ask for an advance'),
    ),

    waiting ? waitingCard(waiting, reload, cash) : null,

    running.length
      ? running.map((advance) => runningCard(advance, cash))
      : (waiting ? null : card('Nothing owed', {},
        h('p.muted', 'You have no advance running. If you need one, ask and somebody will '
          + 'decide.'))),

    // Everything borrowed and everything paid back, on one running account.
    // Two advances at once is two deductions on one payslip, and adding up two
    // separate tables to find out what is left is asking somebody to take the
    // app's word for it.
    data.account?.length
      ? card('Your account', {
        note: 'every month, and what it left owing',
      },
      advanceStatement(data.account, cash, { title: null, currency: data.currency }),
      h('p.muted', { style: { fontSize: '.82rem' } },
        'The months behind you are what actually came off. The ones ahead are what is '
        + 'expected, and they move if anything changes. If a month here does not match '
        + 'your payslip, say so.'))
      : null,

    // Only worth showing where there is something to show. A permanent "no
    // history" heading is a row of a phone screen given over to saying nothing.
    done.length
      ? card('Before this', { note: `${done.length}` },
        h('ul.adv-history', done.map((advance) => h('li',
          h('div',
            h('strong', cash(advance.amount)),
            h('span.muted', ` · ${STATUS[advance.status] ?? advance.status}`)),
          h('small.muted', advance.takenOn ? fmtDay(advance.takenOn) : '')))))
      : null,
  );

  return host;
}

const STATUS = {
  settled: 'paid off',
  declined: 'turned down',
  withdrawn: 'you took it back',
};

function waitingCard(advance, reload, cash) {
  return card('Waiting on a decision', { note: 'not agreed yet' },
    h('p', h('strong', cash(advance.amount)),
      advance.purposeLabel ? ` for ${advance.purposeLabel.toLowerCase()}` : '',
      `, over ${advance.months} month${advance.months === 1 ? '' : 's'}`,
      advance.reason ? ` — ${advance.reason}` : ''),
    advance.hasPaper
      ? h('p', { style: { margin: '.2rem 0 .6rem' } },
        h('a.btn-sm', {
          href: api.advancePaperUrl(advance.id), target: '_blank', rel: 'noopener',
        }, 'The paper you attached'))
      : null,
    h('p.muted', { style: { fontSize: '.88rem' } },
      'Nothing has been agreed and nothing will come off your pay until somebody says yes. '
      + 'You will get a message either way.'),
    h('button.btn-sm', {
      onclick: async () => {
        if (!confirmAction('Take back your request?')) return;
        await api.myWithdrawAdvance(advance.id);
        toast('Taken back.', 'good');
        await reload();
      },
    }, 'Take it back'));
}

/**
 * The one that is running.
 *
 * A bar rather than a number on its own: "GHS 600 of GHS 1,200" is arithmetic,
 * and a half-filled bar is a fact somebody takes in at a glance on a phone in a
 * corridor.
 */
function runningCard(advance, cash) {
  const paid = Math.max(0, advance.amount - advance.balance);
  const share = advance.amount > 0 ? Math.min(1, paid / advance.amount) : 0;
  const behind = advance.schedule.filter((row) => row.done);

  return card('What is left', {
    note: advance.takenOn ? `taken ${fmtDay(advance.takenOn)}` : null,
  },
  h('div.adv-mine',
    h('div.adv-mine-figure',
      h('div.adv-mine-label', 'Still to pay'),
      h('div.adv-mine-value', cash(advance.balance)),
      h('div.muted', `of ${cash(advance.amount)}`)),
    h('div.adv-mine-bar',
      h('div.adv-mine-track', h('div.adv-mine-fill', { style: { width: `${Math.round(share * 100)}%` } })),
      h('div.adv-mine-ends',
        h('span', `${cash(paid)} paid`),
        h('span', advance.finishes ? `Last one ${niceMonth(advance.finishes)}` : '')))),

  h('div.grid.grid-3', { style: { marginTop: '.9rem' } },
    h('div.stat',
      h('div.stat-label', 'Off your pay each month'),
      h('div.stat-value', cash(advance.monthly)),
      h('div.stat-sub', advance.reason || 'as agreed')),
    h('div.stat',
      h('div.stat-label', 'Paydays left'),
      h('div.stat-value', advance.left == null ? '—' : String(advance.left)),
      h('div.stat-sub', advance.finishes ? `ending ${niceMonth(advance.finishes)}` : '')),
    h('div.stat',
      h('div.stat-label', 'Paid so far'),
      h('div.stat-value', cash(paid)),
      h('div.stat-sub', `${behind.length} month${behind.length === 1 ? '' : 's'} in`))),

  // The month-by-month working used to sit here, one table per advance. It
  // says the same thing as the account below it and says it a second time for
  // anybody with two advances running, which on a phone is a screen of
  // figures somebody has to reconcile by scrolling.
  );
}

/**
 * Ask for one.
 *
 * The purpose comes first, because everything else follows from it: what the
 * ceiling is, how long it is paid back over, and whether a bill has to be
 * attached. Asking for the amount first and then refusing it against a rule
 * nobody had been told is the version of this form that makes people give up
 * and go and find a manager.
 *
 * Somebody already paying one back sees only "something else", and the form
 * says why rather than quietly hiding two options.
 */
async function ask(data, reload, cash) {
  const purposes = data.purposes ?? [];
  const other = purposes.find((p) => p.key === 'other');
  const amount = h('input', {
    type: 'number', name: 'amount', step: '0.01', min: '1', required: true,
  });
  const note = h('p.muted', { style: { fontSize: '.88rem', margin: '.2rem 0 0' } }, ' ');
  const paperRow = h('div');
  const picker = h('input', {
    type: 'file', accept: 'image/*,application/pdf', style: { display: 'none' },
  });
  const paperStatus = h('small.muted');
  let paper = null;
  let chosen = data.hasOpen ? 'other' : (purposes[0]?.key ?? 'other');

  const choices = h('div.adv-purposes');

  const draw = () => {
    const asking = Number(amount.value) || 0;
    const spec = purposes.find((p) => p.key === chosen);

    // What may be asked for, worked out from the same rule the server uses:
    // an advance already running leaves only the small one, and anything over
    // the small one's ceiling has to be a named reason with paper behind it.
    const allowed = purposes.filter((p) => {
      if (data.hasOpen && p.key !== 'other') return false;
      if (asking > p.cap) return false;
      return true;
    });

    mount(choices, purposes.map((p) => {
      const off = !allowed.some((a) => a.key === p.key);
      return h(`button.adv-purpose${p.key === chosen ? '.on' : ''}`, {
        type: 'button',
        disabled: off,
        title: off && data.hasOpen && p.key !== 'other'
          ? 'You are still paying one back'
          : off ? `Not for an amount this size` : '',
        onclick: () => { chosen = p.key; draw(); },
      },
      h('strong', p.label),
      h('small', p.months === 1 ? 'back out of your next pay' : `over ${p.months} months`));
    }));

    // If what they typed rules out what they picked, move them rather than
    // letting them press a button that will be refused.
    if (spec && !allowed.some((a) => a.key === chosen) && allowed.length) {
      chosen = allowed[0].key;
      return draw();
    }

    const now = purposes.find((p) => p.key === chosen);
    amount.max = now?.cap ?? '';

    mount(paperRow, now?.paper
      ? h('div.adv-paper',
        h('button.btn-sm', { type: 'button', onclick: () => picker.click() },
          paper ? 'Use a different picture' : `Attach ${now.paper}`),
        picker,
        paperStatus)
      : null);

    // What it would cost them a month, or — the moment they go past a ceiling
    // — which ceiling and what it is. Said here rather than printed under
    // every choice, so the form reads as three options and not as three rules.
    const overSmall = other && asking > other.cap;
    note.classList.toggle('adv-note-over', Boolean(now && asking > now.cap) || (!now && overSmall));

    note.textContent = !now
      ? `Nothing can be asked for at ${cash(asking)}.`
      : asking > now.cap
        ? `${now.label} goes up to ${cash(now.cap)}.`
        : asking > 0
          ? `${cash(Math.ceil((asking / now.months) * 100) / 100)} would come off your pay `
            + (now.months === 1 ? 'next month.' : `each month for ${now.months} months.`)
          : now.months === 1
            ? 'Paid back out of your next pay.'
            : `Paid back over ${now.months} months.`;

    if (now && asking <= now.cap && overSmall && now.key !== 'other') {
      note.textContent += ` Anything over ${cash(other.cap)} has to be for school fees or rent.`;
    }
    return undefined;
  };

  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    paperStatus.textContent = 'Making it smaller…';
    try {
      paper = await shrinkPaper(file);
      paperStatus.textContent = `${file.name.slice(0, 26)} · ${Math.round(paper.bytes / 1024)} KB`;
    } catch (err) {
      paper = null;
      paperStatus.textContent = err.message;
    }
    draw();
  });
  amount.addEventListener('input', draw);
  draw();

  const done = await formDialog({
    title: 'Ask for a salary advance',
    submitLabel: 'Send the request',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        data.hasOpen
          ? 'You are still paying one back, so the only thing you can ask for now is something '
            + 'else, out of your next pay.'
          : 'This is a request, not an agreement. Somebody will decide, and you will be told '
            + 'either way. Nothing comes off your pay unless it is agreed.'),
      h('p.muted', { style: { fontSize: '.85rem', marginBottom: '.2rem' } }, 'What it is for'),
      choices,
      field('How much', amount),
      note,
      paperRow,
      field('Anything to add', h('input', { type: 'text', name: 'reason', maxlength: 300 }))),
    onSubmit: async (form) => api.myAskForAdvance({
      purpose: chosen,
      amount: form.get('amount'),
      reason: form.get('reason'),
      paper: paper ? { base64: paper.base64, mime: paper.mime, filename: paper.filename } : null,
    }),
  });
  if (!done) return;
  toast('Sent. You will be told when it is decided.', 'good');
  await reload();
}

/**
 * A photograph of a bill, made small enough to keep.
 *
 * The same ladder the personnel scans use. A phone camera produces four
 * megabytes and a legible school bill needs a fraction of that.
 */
async function shrinkPaper(file) {
  const LIMIT = 1_300_000;
  const raw = new Uint8Array(await file.arrayBuffer());

  if (!file.type.startsWith('image/')) {
    if (raw.length > LIMIT) {
      throw new Error(`That file is ${Math.round(raw.length / 1024)} KB and the limit is `
        + `${Math.round(LIMIT / 1024)} KB. Photograph it instead — pictures are shrunk to fit.`);
    }
    let binary = '';
    for (let i = 0; i < raw.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, raw.subarray(i, i + 0x8000));
    }
    return {
      base64: btoa(binary), mime: file.type || 'application/pdf', bytes: raw.length,
      filename: file.name,
    };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.82, 0.7, 0.6, 0.5]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    if (bytes <= LIMIT) {
      return {
        base64: dataUrl.split(',')[1], mime: 'image/jpeg', bytes,
        filename: `${(file.name || 'paper').replace(/\.[^.]+$/, '')}.jpg`,
      };
    }
  }
  throw new Error('That picture is too large even after shrinking. Try photographing it closer.');
}
