import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, emptyState, face } from './components.js';
import { field, formDialog, shiftColour } from './att-shared.js';

/**
 * Giving up a shift, and taking one.
 *
 * The screen a member of staff opens when they cannot do Saturday. It replaces
 * a phone call: ask around, get a name, get a supervisor to change the grid on
 * somebody's word.
 *
 * FOUR LISTS RATHER THAN ONE. What anybody can take, what was put to them by
 * name, a swap waiting on their answer, and their own. A single pile sorted by
 * date is the same information and none of the meaning: the second and third
 * are addressed to them and the first is not.
 *
 * Nothing on this screen changes the rota. Taking a shift is a request, and it
 * says so on the button.
 */

const when = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
});

const dayNumber = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', timeZone: 'UTC',
});

const hoursOf = (shift) => `${shift.starts_at}–${shift.ends_at}`;

/** One offer, as a card. */
function offerCard(swap, { onTake, onDrop, mine = false }) {
  const shift = swap.shift;
  const box = h('div.swap-card', {
    'data-shift-colour': String(shiftColour(shift ?? {})),
  });

  const heading = h('div.swap-when',
    h('span.swap-day', dayNumber(swap.day)),
    h('small.muted', new Date(`${swap.day}T12:00:00Z`)
      .toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })),
    swap.kind === 'trade' ? h('span.pill.info', 'A swap') : null,
    !mine && swap.aimedAt.length ? h('span.pill.info', 'Put to you') : null,
    mine && swap.status === 'claimed' ? h('span.pill.warn', 'With a manager') : null,
  );

  const body = h('div.swap-shift',
    h('span.swap-swatch'),
    h('div',
      h('div.swap-name', shift?.name ?? 'That shift'),
      h('div.swap-hours', shift ? `${hoursOf(shift)} · ${shift.department ?? 'No department'}` : '')));

  const from = swap.from
    ? h('div.swap-from', face(swap.from.name, { size: '1.5rem' }),
      h('span', mine ? 'You are giving it up' : 'Given up by ',
        mine ? null : h('strong', swap.from.name)))
    : null;

  // A swap names the shift coming back, because that is the half the person
  // answering is actually deciding about.
  const back = swap.back
    ? h('div.swap-back',
      h('span.muted', 'For yours: '),
      h('strong', `${when(swap.back.day)} · ${swap.back.name}`),
      h('span.muted', ` ${swap.back.starts_at}–${swap.back.ends_at}`))
    : null;

  const taken = swap.takenBy && !mine
    ? h('div.swap-from', face(swap.takenBy.name, { size: '1.5rem' }),
      h('span', h('strong', swap.takenBy.name), ' has taken it'))
    : null;

  const mineTaken = mine && swap.takenBy
    ? h('div.swap-from', face(swap.takenBy.name, { size: '1.5rem' }),
      h('span', h('strong', swap.takenBy.name), ' has taken it'))
    : null;

  const foot = h('div.swap-foot');
  if (mine) {
    foot.append(
      h('button.btn.btn-sm', {
        type: 'button',
        onclick: () => onDrop(swap),
      }, swap.from?.name && swap.takenBy ? 'Take it back' : 'Take it off the board'),
      h('span.spacer'),
      h('small.muted', swap.status === 'claimed'
        ? 'Waiting for a manager'
        : 'Nobody yet'));
  } else if (swap.canTake) {
    foot.append(
      h('button.btn.btn-sm.btn-primary', {
        type: 'button',
        onclick: () => onTake(swap),
      }, swap.kind === 'trade' ? 'Agree to the swap' : 'Take it'),
      swap.aimedAt.length
        ? h('button.btn.btn-sm', { type: 'button', onclick: () => onDrop(swap) }, 'No, thanks')
        : null,
      h('span.spacer'),
      h('small.muted', 'A manager still has to say yes'));
  } else {
    foot.append(h('small.muted.swap-why', swap.why || 'Not one you can take.'));
  }

  // Filtered before it is appended: Element.append writes the word "null"
  // where h() would have skipped it.
  const parts = [
    heading,
    body,
    mine ? mineTaken : from,
    back,
    mine ? null : taken,
    swap.reason ? h('div.swap-note', `“${swap.reason}”`) : null,
    foot,
  ].filter(Boolean);
  box.append(...parts);
  return box;
}

/** The staff board. */
export async function renderSwaps() {
  const host = h('div');

  const paint = async () => {
    const data = await api.swaps();

    if (!data.on) {
      mount(host,
        h('div.page-head', h('div', h('h1', 'Swaps'))),
        emptyState('Swaps are turned off',
          'An administrator can turn them on under Setup → Rules. With them on, you can put '
          + 'a shift you cannot work in front of the colleagues who could cover it, instead of '
          + 'ringing round.'));
      return;
    }

    const onTake = async (swap) => {
      try {
        const out = await api.swapTake(swap.id);
        toast(out.approved
          ? 'Taken. It is on your rota.'
          : 'Taken. A manager has to say yes before it is yours.', 'good');
        await paint();
      } catch (err) { toast(err.message || 'That did not work.', 'bad'); }
    };

    const onDrop = async (swap) => {
      try {
        await api.swapDrop(swap.id);
        toast('Done.', 'good');
        await paint();
      } catch (err) { toast(err.message || 'That did not work.', 'bad'); }
    };

    const section = (title, list, note) => (list.length
      ? card(title, { note: note ?? String(list.length), wide: true },
        h('div.swap-grid', list.map((swap) => offerCard(swap, {
          onTake, onDrop, mine: swap.mine,
        }))))
      : null);

    const nothing = !data.offers.length && !data.aimed.length
      && !data.trades.length && !data.mine.length;

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Swaps'),
          h('div.sub', summary(data))),
        h('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => { if (await offerDialog()) await paint(); },
        }, 'Give up a shift')),

      section('Waiting on your answer', data.trades),
      section('Put to you', data.aimed),
      section('Anybody can take these', data.offers),
      section('Yours', data.mine),

      nothing
        ? emptyState('Nothing going',
          'Nobody has a shift on the board. If you cannot work one of yours, put it up here '
          + 'and the people who could cover it will be told.')
        : null,
    );
  };

  await paint();
  return host;
}

const summary = (data) => {
  const bits = [];
  const going = data.offers.length + data.aimed.length + data.trades.length;
  bits.push(going === 0 ? 'Nothing going you can take'
    : going === 1 ? '1 shift you can take' : `${going} shifts you can take`);

  const waiting = data.mine.filter((s) => s.status === 'claimed').length;
  const up = data.mine.length - waiting;
  if (up) bits.push(up === 1 ? '1 of yours on the board' : `${up} of yours on the board`);
  if (waiting) {
    bits.push(waiting === 1 ? '1 of yours with a manager' : `${waiting} of yours with a manager`);
  }
  return bits.join(' · ');
};

/**
 * Putting a shift up.
 *
 * Three answers in one dialog, because they are one decision: which shift, who
 * to ask, and whether the board sees it too. The people who can cover it are
 * listed by name with a tick each, so "ask Doreen and Henry" is one action
 * rather than a message somebody sends outside the app.
 */
async function offerDialog() {
  let data;
  try {
    data = await api.swapsOfferable();
  } catch (err) {
    toast(err.message || 'Could not read your shifts.', 'bad');
    return false;
  }

  if (!data.on) { toast('Swaps are turned off.', 'bad'); return false; }
  if (!data.shifts.length) {
    toast('You have no published shifts far enough ahead to give away.', 'bad');
    return false;
  }
  if (data.cap && data.used >= data.cap) {
    toast(`You have already given away ${data.used} shifts this month.`, 'bad');
    return false;
  }

  const pick = h('select', { name: 'rosterId' },
    data.shifts.map((s) => h('option', { value: String(s.rosterId) },
      `${when(s.day)} · ${s.shift.name} · ${hoursOf(s.shift)}`)));

  const whoBox = h('div.swap-who');
  const countLine = h('p.swap-count');
  const reason = h('input', {
    type: 'text', name: 'reason', maxlength: 300,
    placeholder: 'Why, if you want to say',
  });

  // Named people, held here rather than read back off the boxes so the count
  // and the wording under it can follow along as they are ticked.
  let picked = new Set();
  let openToo = true;

  const openBox = h('input', {
    type: 'checkbox', checked: true, onchange: () => { openToo = openBox.checked; say(); },
  });
  const openRow = h('label.swap-open', openBox,
    h('span', 'Put it on the board as well, so anybody who can cover it sees it'));

  const shiftOf = () => data.shifts.find((s) => String(s.rosterId) === pick.value) ?? data.shifts[0];

  const say = () => {
    const can = shiftOf().canCover;
    if (!can.length) {
      countLine.textContent = 'Nobody else can cover this one. Speak to your supervisor.';
      countLine.className = 'swap-count is-none';
      return;
    }
    countLine.className = 'swap-count';
    if (!picked.size) {
      countLine.textContent = can.length === 1
        ? 'One colleague can cover this. They will be told once.'
        : `${can.length} colleagues can cover this. They will be told once.`;
      return;
    }
    const names = [...picked].map((id) => can.find((p) => p.id === id)?.name).filter(Boolean);
    countLine.textContent = openToo
      ? `${names.join(', ')} first, and the board behind them.`
      : `Only ${names.join(', ')} will see it.`;
  };

  const drawWho = () => {
    const can = shiftOf().canCover;
    picked = new Set([...picked].filter((id) => can.some((p) => p.id === id)));

    mount(whoBox, can.length
      ? can.map((person) => {
        const box = h('input', {
          type: 'checkbox',
          checked: picked.has(person.id),
          onchange: () => {
            if (box.checked) picked.add(person.id); else picked.delete(person.id);
            say();
          },
        });
        return h('label.swap-pick', box,
          face(person.name, { size: '1.6rem' }),
          h('span.swap-pick-who', person.name,
            person.department ? h('small.muted', ` ${person.department}`) : null));
      })
      : h('p.muted', 'Nobody else is free and able to work that shift.'));
    say();
  };

  pick.addEventListener('change', drawWho);
  drawWho();

  const body = h('div.form-grid',
    field('Which shift', pick),
    h('div.swap-ask',
      h('div.swap-ask-head', 'Ask anybody in particular?'),
      h('p.muted.swap-ask-note',
        'Tick the people you want asked first. Leave them all unticked and it simply goes '
        + 'to everybody who can cover it.'),
      whoBox,
      openRow,
      countLine),
    field('Say why (optional)', reason),
    h('p.muted.swap-small',
      'It stays yours until a manager approves whoever takes it. Nothing changes on the rota '
      + 'before that.'),
  );

  const done = await formDialog({
    title: 'Give up a shift',
    body,
    submitLabel: 'Put it up',
    wide: true,
    onSubmit: async () => {
      const chosen = shiftOf();
      const out = await api.swapOffer({
        rosterId: chosen.rosterId,
        aimedAt: [...picked],
        aimedOnly: picked.size > 0 && !openToo,
        reason: reason.value.trim() || null,
      });
      return out;
    },
  });

  if (done) {
    toast(done.aimedAt
      ? `Put to ${done.aimedAt}.`
      : `On the board. ${done.told} ${done.told === 1 ? 'person was' : 'people were'} told.`,
    'good');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The planner's queue
// ---------------------------------------------------------------------------

const FINDING_MARK = { high: '⛔', warn: '⚠️', ok: '✓' };

/** What a swap would do to the two people's fortnight. */
function findingList(findings) {
  if (!findings?.length) {
    return h('div.swap-flags',
      h('div.swap-flag.ok', `${FINDING_MARK.ok} Nothing flagged on either side.`));
  }
  return h('div.swap-flags', findings.map((f) => h(`div.swap-flag.${f.level}`,
    `${FINDING_MARK[f.level] ?? ''} ${f.text}`)));
}

/** One row of the queue. */
function queueRow(swap, { onDecide }) {
  const shift = swap.shift;
  return h('div.swap-row',
    h('div',
      h('div.swap-day', dayNumber(swap.day)),
      h('small.muted', new Date(`${swap.day}T12:00:00Z`)
        .toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' }))),
    h('div',
      h('div.swap-move',
        face(swap.from?.name ?? '?', { size: '1.6rem' }),
        h('strong', swap.from?.name ?? 'Somebody'),
        h('span.swap-arrow', swap.kind === 'trade' ? 'swaps' : 'gives'),
        h('span.pill', shift ? `${shift.name} · ${hoursOf(shift)}` : 'that shift'),
        swap.back
          ? [h('span.swap-arrow', 'for'),
            h('span.pill', `${swap.back.name} · ${when(swap.back.day)}`)]
          : null,
        h('span.swap-arrow', swap.kind === 'trade' ? 'with' : 'to'),
        face(swap.takenBy?.name ?? '?', { size: '1.6rem' }),
        h('strong', swap.takenBy?.name ?? 'somebody')),
      swap.reason ? h('div.swap-note', `“${swap.reason}”`) : null,
      findingList(swap.findings)),
    h('div.btn-row',
      h('button.btn.btn-sm', {
        type: 'button',
        class: swap.findings?.some((f) => f.level === 'high') ? 'btn btn-sm' : 'btn btn-sm btn-primary',
        onclick: () => onDecide(swap, true),
      }, swap.findings?.some((f) => f.level === 'high') ? 'Approve anyway' : 'Approve'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => onDecide(swap, false) }, 'Turn down')),
  );
}

/** The planner's screen: what is waiting, what is going, what was decided. */
export async function renderSwapQueue() {
  const host = h('div');

  const paint = async () => {
    const data = await api.swapQueue();

    if (!data.on) {
      mount(host,
        h('div.page-head', h('div', h('h1', 'Swaps'))),
        emptyState('Swaps are turned off',
          'Turn them on under Setup → Rules and staff can put a shift they cannot work in '
          + 'front of the colleagues who could cover it. Nothing moves on the rota without '
          + 'somebody here approving it.'));
      return;
    }

    const onDecide = async (swap, approve) => {
      try {
        await api.swapDecide(swap.id, { approve });
        toast(approve ? 'Approved. The rota has changed.' : 'Turned down.', approve ? 'good' : '');
        await paint();
      } catch (err) { toast(err.message || 'That did not work.', 'bad'); }
    };

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Swaps'),
          h('div.sub', [
            data.waiting.length
              ? `${data.waiting.length} waiting on you`
              : 'Nothing waiting on you',
            `${data.board.length} on the board`,
          ].join(' · ')))),

      card('Waiting on you', { note: String(data.waiting.length), wide: true },
        data.waiting.length
          ? data.waiting.map((swap) => queueRow(swap, { onDecide }))
          : h('p.muted', 'Nothing to decide.')),

      card('On the board', { note: String(data.board.length), wide: true },
        data.board.length
          ? data.board.map((swap) => h('div.swap-row',
            h('div',
              h('div.swap-day', dayNumber(swap.day)),
              h('small.muted', 'nobody yet')),
            h('div',
              h('div.swap-move',
                face(swap.from?.name ?? '?', { size: '1.6rem' }),
                h('strong', swap.from?.name ?? 'Somebody'),
                h('span.swap-arrow', 'is giving up'),
                h('span.pill', swap.shift ? `${swap.shift.name} · ${hoursOf(swap.shift)}` : 'a shift')),
              swap.reason ? h('div.swap-note', `“${swap.reason}”`) : null,
              h('div.swap-flags',
                h('div.swap-flag',
                  swap.aimedOnly && swap.aimedAt.length
                    ? `Put to ${swap.aimedAt.map((p) => p.name).join(', ')} only.`
                    : `${swap.canCover} ${swap.canCover === 1 ? 'person' : 'people'} can cover it.`))),
            h('div')))
          : h('p.muted', 'Nothing on it.')),

      card('How swaps work here', { wide: true },
        h('div.detail-list',
          pair('Staff may give up a shift',
            data.rules.noticeHours >= 24
              ? `Up to ${Math.round(data.rules.noticeHours / 24)} day`
                + `${data.rules.noticeHours >= 48 ? 's' : ''} before it starts`
              : `Up to ${data.rules.noticeHours} hours before it starts`),
          pair('Who is offered it',
            'Anybody who can work that shift, is free, and is not on leave'),
          pair('Approval',
            data.rules.approval === 'clean'
              ? 'Only when something is flagged. A clean one goes straight through'
              : 'Always, whatever the swap looks like'),
          pair('A cap on how many',
            data.rules.monthlyCap
              ? `${data.rules.monthlyCap} a month each`
              : 'None'))),

      data.done.length
        ? card('Settled', { note: String(data.done.length), wide: true },
          h('div.swap-done', data.done.map((swap) => h('div.swap-done-row',
            h('span.muted', when(swap.day)),
            h('strong', swap.shift?.name ?? 'a shift'),
            h('span.muted',
              ` ${swap.from?.name ?? 'somebody'} → ${swap.takenBy?.name ?? 'nobody'}`),
            h('span.pill', DONE_LABEL[swap.status] ?? swap.status),
            swap.decidedBy ? h('small.muted', ` ${swap.decidedBy}`) : null))))
        : null,
    );
  };

  await paint();
  return host;
}

const DONE_LABEL = {
  approved: 'Approved',
  declined: 'Turned down',
  withdrawn: 'Taken back',
  expired: 'Ran out of time',
};

const pair = (label, value) => h('div.detail-pair', h('div', label), h('div', value));
