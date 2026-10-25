import { h } from '../util.js';
import { api } from '../api.js';

/**
 * A Nice Place reading sent with a counter the reader could not read: the
 * picture, the counters read (filled in) and those not (empty), for an admin
 * or a supervisor to read off the picture and save. "Try reading again" asks
 * the reader once more first. Used in the Inbox and on the Nice Place page.
 */

const COUNTER = { gb: 'GB · Gents bath', gt: 'GT · Gents toilet', lb: 'LB · Ladies bath', lt: 'LT · Ladies toilet' };
const SHIFT = { day: 'day', night: 'night' };
const whole = (n) => (n == null ? '—' : Number(n).toLocaleString('en-GB'));
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const names = (cs) => cs.map((c) => c.toUpperCase()).join(cs.length > 2 ? ', ' : ' and ');

/** `p` is one of /np/pending's items; `after(words)` runs once it is saved. `canAct` false shows it only. */
export function npReviewBox(p, { after, canAct = true }) {
  const said = h('span.small');
  const inputs = Object.fromEntries(Object.keys(COUNTER).map((c) => [c, h(`input.num${p.values[c] == null ? '.np-missing' : ''}`, {
    inputmode: 'numeric', autocomplete: 'off', value: p.values[c] == null ? '' : String(p.values[c]),
    placeholder: p.values[c] == null ? 'read it off the picture' : '', 'aria-label': COUNTER[c], disabled: !canAct,
  })]));
  const save = async () => {
    const empty = Object.keys(COUNTER).filter((c) => !inputs[c].value.trim());
    if (empty.length) { said.textContent = `Still empty: ${names(empty)}.`; return; }
    said.textContent = 'Saving…';
    try {
      await api('/np/review', { method: 'POST', body: { day: p.day, shift: p.shift, ...Object.fromEntries(Object.keys(COUNTER).map((c) => [c, inputs[c].value])) } });
      await after('Saved. The shift is worked out with these numbers.');
    } catch (err) { said.textContent = err.message; }
  };
  const again = async (e) => {
    e.target.disabled = true;
    said.textContent = 'Reading the picture again…';
    try {
      const out = await api('/np/reread', { method: 'POST', body: { day: p.day, shift: p.shift } });
      if (!out.pending.length) { await after('Read this time: all four counters are in.'); return; }
      for (const c of Object.keys(COUNTER)) {
        if (out.values[c] != null && !inputs[c].value.trim()) { inputs[c].value = String(out.values[c]); inputs[c].classList.remove('np-missing'); }
      }
      said.textContent = out.error ? `The reader did not answer (${out.error}). Read ${names(out.pending)} off the picture.`
        : `Still not read: ${names(out.pending)}${out.problem ? ` (${out.problem})` : ''}. Read ${out.pending.length === 1 ? 'it' : 'them'} off the picture.`;
    } catch (err) { said.textContent = err.message; }
    e.target.disabled = false;
  };
  const src = p.photoId ? `/api/np/photo/${p.photoId}` : null;
  return h('div.np-review',
    src ? h('a', { href: src, target: '_blank', rel: 'noopener', title: 'Open the picture full size' }, h('img.np-photo', { src, alt: 'The counters as sent' })) : h('div.np-nophoto', 'No picture'),
    h('div',
      h('p', `Sent by ${p.name || 'somebody'} at ${String(p.sentAt || '').slice(11, 16)} for ${dayText(p.day)} ${SHIFT[p.shift]}. `,
        h('b', `${names(p.pending)} could not be read`), p.problem ? ` (${p.problem})` : '', '. ',
        canAct ? `Read ${p.pending.length === 1 ? 'it' : 'them'} off the picture and fill ${p.pending.length === 1 ? 'it' : 'them'} in.${p.pending.length < 4 ? ' The others were read: put any that is wrong right.' : ''}`
          : 'An admin, or a supervisor given Nice Place, fills them in.'),
      h('div.np-fixgrid', Object.entries(COUNTER).map(([c, label]) => h('label', h('small', label), inputs[c],
        p.before?.[c] != null ? h('small.muted', `Last: ${whole(p.before[c])}`) : null))),
      p.before ? h('p.small.muted', `“Last” is the end of ${dayText(p.before.day)} ${SHIFT[p.before.shift]}: a counter only goes up, unless it was reset.`) : null,
      canAct ? h('div.np-inline',
        h('button.btn.primary', { type: 'button', onclick: save }, 'Save the four numbers'),
        src ? h('button.btn', { type: 'button', onclick: again }, 'Try reading again') : null,
        said) : null,
      canAct ? npMoveBox(p, { after }) : null));
}

/**
 * A reading sent for the wrong day or shift, with its picture, moved to the
 * right one. When that shift has a reading of its own, the two can be
 * swapped. `p` has the reading's day and shift; `after(words)` runs once moved.
 */
export function npMoveBox(p, { after }) {
  const said = h('span.small');
  const today = new Date().toISOString().slice(0, 10);
  const day = h('input', { type: 'date', value: p.day, max: today, 'aria-label': 'Day' });
  const shift = h('select', { 'aria-label': 'Shift' }, Object.keys(SHIFT).map((x) => h('option', { value: x, selected: x === p.shift }, x === 'day' ? 'Day' : 'Night')));
  const swap = h('button.btn', { type: 'button', hidden: true }, 'Swap the two');
  const move = async (andSwap) => {
    said.textContent = 'Moving…';
    try {
      const out = await api('/np/move', { method: 'POST', body: { day: p.day, shift: p.shift, toDay: day.value, toShift: shift.value, swap: andSwap } });
      await after(out.swapped
        ? `Swapped: this reading is now ${dayText(out.to.day)} ${SHIFT[out.to.shift]}, and that shift’s is ${dayText(p.day)} ${SHIFT[p.shift]}.`
        : `Moved to ${dayText(out.to.day)} ${SHIFT[out.to.shift]}${p.photoId ? ', with its picture' : ''}.`);
    } catch (err) {
      said.textContent = err.message;
      swap.hidden = !/of its own/.test(err.message);
    }
  };
  swap.addEventListener('click', () => move(true));
  const box = h('div.np-move', { hidden: true },
    h('small', p.photoId ? 'Move this reading, with its picture, to' : 'Move this reading to'), day, shift,
    h('button.btn', { type: 'button', onclick: () => move(false) }, 'Move'), swap, said);
  return h('div.np-movewrap',
    h('button.sh-link', { type: 'button', onclick: () => { box.hidden = !box.hidden; } }, p.movedFrom
      ? `Moved here from ${dayText(p.movedFrom.split('|')[0])} ${SHIFT[p.movedFrom.split('|')[1]]}${p.movedBy ? ` by ${p.movedBy}` : ''} · move again`
      : 'Wrong day or shift? Move it'),
    box);
}
