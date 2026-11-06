import { api } from '../api.js';
import { h, mount, toast } from '../util.js';

/**
 * The lunch list on My day, while it is open.
 *
 * Asked for, it is the order itself: the week with their shift days ticked,
 * one press to send it, or "not eating". Answered, it says what they ordered
 * and lets them change it until the list shuts.
 */

const POT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 11h16v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z"></path><path d="M2 11h20M9 4c0 1.5 1 1.5 1 3M13 4c0 1.5 1 1.5 1 3"></path></svg>';

const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
const span = (days) => {
  const f = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f(days[0].day)} – ${f(days[6].day)}`;
};
const shuts = (stamp) => {
  if (!stamp) return 'when it shuts';
  const at = new Date(`${stamp.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return stamp.slice(11) === '00:00' ? `${new Date(Date.parse(`${stamp.slice(0, 10)}T12:00:00Z`) - 864e5).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} at midnight` : `${at} at ${stamp.slice(11)}`;
};

export function lunchAskCard(data, reload) {
  if (!data?.show) return null;
  const host = h('section.lunch-ask');
  const icon = h('span.lunch-ask-icon');
  icon.innerHTML = POT;

  const ordering = () => {
    // Their shift days ticked where they have not said; their answer where they have.
    const picked = new Set(data.days.filter((d) => d.on && (d.taking ?? true)).map((d) => d.day));
    const button = h('button.btn.btn-primary.lunch-ask-go', { type: 'button' });
    const sync = () => {
      button.textContent = picked.size ? `Order ${picked.size} lunch${picked.size === 1 ? '' : 'es'}` : 'Choose your days';
      button.disabled = !picked.size;
    };
    const rows = data.days.map((d) => {
      const box = h('input', {
        type: 'checkbox', checked: picked.has(d.day), disabled: !d.on,
        onchange: (e) => { if (e.target.checked) picked.add(d.day); else picked.delete(d.day); sync(); },
      });
      return h('label.lunch-ask-day', { class: d.on ? '' : 'is-off' },
        box,
        h('strong', shortDay(d.day)),
        h('span.lunch-ask-meal', d.meal || ''),
        d.on ? null : h('small', 'Off'));
    });
    const save = async (body) => {
      try {
        await api.saveMyLunchWeek(body);
        toast(body.none ? 'Noted: no lunch next week.' : 'Lunch ordered.', 'good');
        await reload();
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    button.onclick = () => save({ days: data.days.filter((d) => d.on).map((d) => ({ day: d.day, taking: picked.has(d.day) })) });
    sync();
    mount(host,
      h('div.lunch-ask-head', icon, h('div',
        h('strong', 'Lunch for next week is open'),
        h('small', `${span(data.days)} · tick the days you will eat. Open until ${shuts(data.closesOn)}.`))),
      h('div.lunch-ask-days', rows),
      h('small.muted', 'Your shift days are ticked for you. Change any you like.'),
      button,
      h('button.lunch-ask-none', { type: 'button', onclick: () => save({ none: true }) }, 'I won’t be eating next week'));
  };

  const answered = () => {
    const yes = data.days.filter((d) => d.taking === true);
    mount(host,
      h('div.lunch-ask-head', icon, h('div',
        h('strong', yes.length ? `Lunch ordered: ${yes.length} day${yes.length === 1 ? '' : 's'}` : 'No lunch next week'),
        h('small', `${yes.length ? yes.map((d) => shortDay(d.day)).join(', ') + '. ' : ''}You can change it until ${shuts(data.closesOn)}.`))),
      h('button.lunch-ask-none', { type: 'button', onclick: ordering }, 'Change my days'));
    host.classList.add('is-done');
  };

  if (data.answered) answered(); else ordering();
  return host;
}
