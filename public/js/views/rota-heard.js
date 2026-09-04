import { api } from '../api.js';
import { fmtDayShort, h, mount, toast } from '../util.js';
import { showSheet } from './att-shared.js';

/**
 * Who heard that the rota was out.
 *
 * Publishing told everybody at once and then forgot what it had done. What a
 * planner got back was three numbers, and the question that actually arrives a
 * day later is not a number: it is "Doreen says she never got hers". Answering
 * that meant publishing the whole fortnight again and buzzing twenty-one
 * people who had already read it.
 *
 * So the list is by name, it says what each way out came back with, and Send
 * again goes to the ones ticked and to nobody else.
 *
 * NONE OF THIS IS A READ RECEIPT and the wording never pretends otherwise.
 * Web push has none; a gateway says it accepted a text rather than that a
 * phone rang. Two different problems look identical from the office, and only
 * one of them is fixed by sending it again: "we had no way of telling her"
 * wants a phone number, "we told her and she has not looked" wants a word.
 */

/** A tick, a cross, or a dash for a way out that was never tried. */
function mark(state, tried, missing) {
  if (state === 1) return h('span.heard-yes', { title: tried }, '✓');
  if (state === -1) return h('span.heard-no', { title: `${tried}, and it did not go` }, '✕');
  return h('span.heard-none', { title: missing }, '·');
}

/** One person, and what became of theirs. */
function personRow(person, picked) {
  const box = h('input', {
    type: 'checkbox',
    checked: !person.reached,
    onchange: () => (box.checked ? picked.add(person.staffId) : picked.delete(person.staffId)),
  });
  if (box.checked) picked.add(person.staffId);

  const week = person.shifts
    ? `${person.shifts} shift${person.shifts === 1 ? '' : 's'}`
    : `${person.offDays} day${person.offDays === 1 ? '' : 's'} off`;

  return h('label.heard-row', { class: person.reached ? null : 'heard-row-missed' },
    box,
    h('div.heard-who',
      h('strong', person.name),
      h('small.muted', [week, person.department].filter(Boolean).join(' · ')),
      person.why ? h('small.heard-why', person.why) : null,
      person.sends > 1
        ? h('small.muted', `Sent ${person.sends} times, last ${(person.lastAt ?? '').slice(0, 16)}`)
        : null),
    h('div.heard-ways',
      mark(person.buzzed, 'Alert on their phone', 'No device with alerts turned on'),
      mark(person.emailed, 'Email', 'No email address on their login'),
      mark(person.texted, 'Text message', 'No mobile number on their record'),
      person.opened ? h('span.pill.good', 'Opened') : null),
  );
}

/**
 * One publish, person by person, with Send again underneath.
 *
 * Everybody it did not reach starts ticked, because that is the answer nine
 * times in ten and a list of twenty unticked boxes is a list nobody works
 * through. Anybody else can be ticked as well, for the case the app cannot
 * see: she read it, and her week changed again since.
 */
export async function showWhoHeard(publishId, after = null) {
  const host = h('div');
  const sheet = showSheet({ title: 'Who heard about it', body: host });

  const draw = async () => {
    mount(host, h('p.muted', 'Loading…'));
    const data = await api.attPublishTold(publishId).catch((err) => ({ error: err.message }));
    if (data.error) { mount(host, h('p.muted', data.error)); return; }

    const picked = new Set();
    const missed = data.people.filter((p) => !p.reached);

    const send = async (event) => {
      if (!picked.size) { toast('Tick somebody first.', 'bad'); return; }
      event.target.disabled = true;
      try {
        const out = await api.attPublishAgain(publishId, [...picked]);
        toast(out.stillSilent
          ? `Sent to ${out.asked}. ${out.stillSilent} still could not be reached at all.`
          : `Sent again to ${out.asked} ${out.asked === 1 ? 'person' : 'people'}.`,
        out.stillSilent ? 'bad' : 'good');
        await draw();
        if (after) await after();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    };

    mount(host,
      h('p.muted',
        `${fmtDayShort(data.publish.from)} to ${fmtDayShort(data.publish.to)}, `
        + `published by ${data.publish.actor} on ${(data.publish.at ?? '').slice(0, 16)}.`),

      h('div.heard-tally',
        h('div', h('strong', String(data.reached)), h('span', 'reached')),
        h('div', h('strong', String(data.missed)), h('span', 'not reached')),
        h('div', h('strong', String(data.opened)), h('span', 'opened it')),
      ),

      h('p.muted', { style: { fontSize: '.82rem' } },
        'A tick means the message left the building and was accepted. Nothing here can '
        + 'say it was read: an alert has no receipt, and a gateway confirms it took a text '
        + 'rather than that a phone rang. Opened means they have looked at their bell since.'),

      data.people.length
        ? h('div.heard-list', data.people.map((p) => personRow(p, picked)))
        : h('p.muted', 'Nobody was told about this one. It was published quietly.'),

      data.people.length
        ? h('div.btn-row', { style: { justifyContent: 'space-between', alignItems: 'center' } },
          h('small.muted', missed.length
            ? `${missed.length} ticked to begin with, the ones nothing reached.`
            : 'Everybody was reached. Tick anybody who should hear it again anyway.'),
          h('button.btn.btn-primary', { onclick: send }, 'Send it again'))
        : null,
    );
  };

  await draw();
  return sheet;
}

/**
 * The last twenty publishes, newest first.
 *
 * The way in when nobody has just pressed Publish: somebody comes back on
 * Tuesday about a rota that went out on Sunday.
 */
export async function showPublishHistory() {
  const host = h('div');
  showSheet({ title: 'Rota alerts', body: host });

  const draw = async () => {
    mount(host, h('p.muted', 'Loading…'));
    const data = await api.attPublishes().catch((err) => ({ error: err.message }));
    if (data.error) { mount(host, h('p.muted', data.error)); return; }
    if (!data.publishes.length) {
      mount(host, h('p.muted', 'Nothing has been published yet.'));
      return;
    }

    mount(host, h('div.heard-list', data.publishes.map((p) => h('button.heard-publish', {
      type: 'button',
      onclick: () => showWhoHeard(p.id, draw),
    },
    h('div.heard-who',
      h('strong', `${fmtDayShort(p.from)} to ${fmtDayShort(p.to)}`),
      h('small.muted', `${p.changes} shift${p.changes === 1 ? '' : 's'} · ${p.actor} · `
        + `${(p.at ?? '').slice(0, 16)}`)),
    p.notify === 'none'
      ? h('span.pill', 'Quiet')
      : p.missed
        ? h('span.pill.bad', `${p.missed} not reached`)
        : h('span.pill.good', `${p.reached} reached`)))));
  };

  await draw();
}
