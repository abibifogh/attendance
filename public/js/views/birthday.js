import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { field, formDialog, showSheet } from './att-shared.js';

/**
 * Birthdays.
 *
 * The one thing on this screen that is not about hours, lateness or money, and
 * the only reason it was going unnoticed is that nothing was looking. The date
 * has been on every record since the day it was filled in.
 *
 * WHAT THE APP DOES AND WHAT IT DELIBERATELY LEAVES TO A PERSON. The app wishes
 * them, quietly and on the day. It does not send the card. A card is somebody
 * choosing to send one, and an app that sends it by itself has taken the
 * gesture rather than prompted it — which is the opposite of what a birthday
 * is for.
 *
 * THE CARD IS AN IMAGE ON PURPOSE. What actually happens to a birthday card at
 * this property is that it goes into a group chat, so the thing to produce is
 * a picture, drawn here and handed to the phone's own share sheet. No server
 * involved: it is a canvas, a font and a name.
 */

/** Eight quiet grounds. Chosen from the name so one person's card is theirs. */
const GROUNDS = [
  { from: '#2f6df6', to: '#7aa2ff', ink: '#ffffff' },
  { from: '#12a594', to: '#5fd6c6', ink: '#04302b' },
  { from: '#d97706', to: '#fbbf24', ink: '#3d2200' },
  { from: '#8b5cf6', to: '#c4b5fd', ink: '#2a1259' },
  { from: '#e11d48', to: '#fb7185', ink: '#ffffff' },
  { from: '#0891b2', to: '#67e8f9', ink: '#04303a' },
  { from: '#65a30d', to: '#bef264', ink: '#1d2b03' },
  { from: '#db2777', to: '#f9a8d4', ink: '#4a0726' },
];

/**
 * The strip on the morning screen.
 *
 * Absent entirely on the days nobody has a birthday, which is most of them. A
 * permanent "no birthdays today" line is a row of the screen given over to
 * saying nothing.
 */
export async function birthdayStrip() {
  const data = await api.attBirthdays().catch(() => null);
  if (!data?.todays?.length && !data?.soon?.length) return null;

  const host = h('div');

  const draw = (state) => mount(host,
    state.todays.length
      ? h('div.bd-strip',
        h('div.bd-strip-mark', '🎂'),
        h('div.bd-strip-text',
          h('strong', state.todays.length === 1
            ? `It is ${firstName(state.todays[0])}'s birthday today`
            : `${state.todays.length} birthdays today`),
          h('div.muted', state.todays.map((p) => p.name).join(', '))),
        h('div.btn-row',
          state.todays.map((person) => h('button.btn-sm.btn-primary', {
            onclick: () => openCard(person, state, async () => {
              const fresh = await api.attBirthdays().catch(() => state);
              draw(fresh);
            }),
          }, state.todays.length === 1
            ? (person.cardSent ? 'Card sent — open it' : 'Make a card')
            : `${firstName(person)}…`))))
      : null,

    state.soon.length
      ? h('details.bd-soon',
        h('summary', `${state.soon.length} birthday${state.soon.length === 1 ? '' : 's'} coming up`),
        h('ul.bd-list', state.soon.map((p) => h('li',
          h('span', p.name),
          h('small.muted', p.inDays === 1 ? 'tomorrow' : `in ${p.inDays} days`)))))
      : null,
  );

  draw(data);
  return host;
}

const firstName = (person) => (person.preferred || person.name).split(/\s+/)[0];

/**
 * Draw the card, and offer the two things anybody actually does with one.
 *
 * Share hands it to the phone's own sheet, which is how it reaches a group
 * chat. Send tells the person and the rest of the place through the app, for
 * whoever is not in the chat.
 */
export function openCard(person, state, reload) {
  const canvas = h('canvas.bd-canvas', { width: 1080, height: 1080 });
  const line = h('input', {
    type: 'text',
    maxlength: 120,
    value: `Everybody at ${state.property || 'work'} hopes you have a lovely day.`,
    placeholder: 'Say something',
  });

  const redraw = () => paint(canvas, {
    name: person.preferred || person.name,
    line: line.value,
    property: state.property || '',
  });
  line.addEventListener('input', redraw);
  redraw();

  const share = h('button.btn.btn-primary', {
    onclick: async () => {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) { toast('The card could not be drawn on this browser.', 'bad'); return; }
      const file = new File([blob], `${firstName(person)}-birthday.png`, { type: 'image/png' });

      // The phone's own share sheet where there is one, a download where there
      // is not. Both end up in the same group chat.
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `Happy birthday, ${firstName(person)}` });
          return;
        } catch {
          // Dismissed, or refused. Fall through to the download rather than
          // leaving somebody with nothing.
        }
      }
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: file.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Saved. Send it wherever you like.', 'good');
    },
  }, 'Share the card');

  const send = h('button.btn-sm', {
    disabled: person.cardSent,
    onclick: async () => {
      const done = await formDialog({
        title: `Tell ${firstName(person)} and the rest`,
        submitLabel: 'Send it',
        body: h('div',
          h('p.muted', { style: { fontSize: '.85rem' } },
            person.hasLogin
              ? `${firstName(person)} gets this on their phone, and everybody else is told it `
                + 'is their birthday.'
              : `${firstName(person)} has no login yet, so this only tells everybody else. `
                + 'The card is still yours to share.'),
          field('Anything to add', h('input', {
            type: 'text', name: 'message', maxlength: 300, value: line.value,
          })),
          h('label.tickline',
            h('input', { type: 'checkbox', name: 'everybody', checked: true }),
            h('span', 'Tell the whole place, not only them')),
        ),
        onSubmit: async (form) => api.attBirthdayCard({
          staffId: person.id,
          message: form.get('message') || null,
          everybody: form.get('everybody') === 'on',
        }),
      });
      if (!done) return;
      toast(done.told ? `Sent. ${firstName(person)} has it.` : 'Sent to everybody.', 'good');
      await reload();
    },
  }, person.cardSent ? 'Already sent today' : 'Send it through the app');

  showSheet({
    title: `Happy birthday, ${firstName(person)}`,
    body: h('div',
      h('div.bd-preview', canvas),
      field('What it says', line),
      h('div.btn-row', { style: { marginTop: '.8rem' } }, share, send),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'The picture is drawn here on your device and never leaves it until you send it. '
        + 'Nobody’s age is on it.'),
    ),
  });
}

/**
 * The card.
 *
 * A square, because every chat crops to one. Two colours from the name so the
 * same person gets the same card every year and two people on the same day get
 * different ones, and nothing on it but the wish — no logo lockup, no age, no
 * date. A birthday card that looks like a memo is not a birthday card.
 */
function paint(canvas, { name, line, property }) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const size = canvas.width;
  const ground = GROUNDS[hash(name) % GROUNDS.length];

  const wash = ctx.createLinearGradient(0, 0, size, size);
  wash.addColorStop(0, ground.from);
  wash.addColorStop(1, ground.to);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, size, size);

  // Confetti, seeded from the name so it is the same card every time it is
  // drawn rather than a different one on every keystroke.
  let seed = hash(name) || 1;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  ctx.save();
  ctx.fillStyle = ground.ink;
  for (let i = 0; i < 130; i += 1) {
    const x = random() * size;
    const y = random() * size;
    // Kept out of the middle third, where the name goes. Confetti behind
    // somebody's name is confetti making their name harder to read.
    const middle = Math.abs(y - size * 0.48) < size * 0.12
      && Math.abs(x - size / 2) < size * 0.42;
    if (middle) continue;

    ctx.globalAlpha = 0.16 + random() * 0.3;
    ctx.translate(x, y);
    ctx.rotate(random() * Math.PI);
    if (random() < 0.28) {
      ctx.beginPath();
      ctx.arc(0, 0, 4 + random() * 7, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const w = 10 + random() * 22;
      const hgt = 5 + random() * 9;
      ctx.fillRect(-w / 2, -hgt / 2, w, hgt);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.restore();

  // A soft glow behind the name, so it sits on the card rather than in front
  // of it.
  const glow = ctx.createRadialGradient(
    size / 2, size * 0.47, size * 0.05, size / 2, size * 0.47, size * 0.46,
  );
  glow.addColorStop(0, `${ground.from}00`);
  glow.addColorStop(1, `${ground.from}55`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  ctx.textAlign = 'center';
  ctx.fillStyle = ground.ink;

  ctx.globalAlpha = 0.75;
  ctx.font = '600 34px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText('HAPPY BIRTHDAY', size / 2, size * 0.30);

  ctx.globalAlpha = 1;
  fitted(ctx, String(name), size * 0.86, 150, 'italic 700 %dpx Georgia, "Times New Roman", serif');
  ctx.fillText(String(name), size / 2, size * 0.50);

  ctx.globalAlpha = 0.88;
  ctx.font = '400 40px system-ui, -apple-system, Segoe UI, sans-serif';
  wrapped(ctx, String(line || ''), size / 2, size * 0.65, size * 0.76, 54);

  if (property) {
    ctx.globalAlpha = 0.6;
    ctx.font = '600 26px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(String(property).toUpperCase(), size / 2, size * 0.90);
  }
  ctx.globalAlpha = 1;
}

/** Shrink the font until the text fits, rather than letting it run off the edge. */
function fitted(ctx, text, maxWidth, startPx, template) {
  let px = startPx;
  do {
    ctx.font = template.replace('%d', String(px));
    px -= 4;
  } while (ctx.measureText(text).width > maxWidth && px > 40);
}

/** Two or three lines of a message, centred, never wider than the card. */
function wrapped(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  lines.slice(0, 3).forEach((row, i) => ctx.fillText(row, x, y + i * lineHeight));
}

/** A stable number from a name, so the same person gets the same card. */
function hash(text) {
  let n = 0;
  for (const ch of String(text)) n = (n * 31 + ch.codePointAt(0)) % 2147483647;
  return n;
}
