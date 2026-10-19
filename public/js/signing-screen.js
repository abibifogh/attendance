import { h, mount } from './util.js';
import { signaturePad } from './fields.js';
import { drawPages } from './doc-pages.js';

/**
 * Filling in and signing a document.
 *
 * The same screen whether somebody opened it from their link or from their
 * own HIVE login. A dark bar along the top says how many boxes are left and
 * whose name they are signing in; Next takes them to each of their boxes in
 * turn and opens it. Their own boxes are yellow. Everybody else's are grey,
 * and show what was put in them once that person has signed.
 *
 * The first signature or initials box asks them to adopt a signature: typed in
 * one of three hands, drawn, or a photograph of the one they use on paper. It
 * is then used for every one of their boxes on the document.
 */

const HANDS = [
  { key: 'allura', css: 'Allura', size: 64 },
  { key: 'caveat', css: 'Caveat', size: 56 },
  { key: 'apple', css: 'Homemade Apple', size: 40 },
];
const INK = '#17304f';
const LABEL = {
  signature: 'Sign here', initials: 'Initial', date: 'Date', name: 'Name', title: 'Title',
  text: 'Type here', checkbox: '', stamp: 'Stamp',
};

let fontsAsked = false;
function loadHands() {
  if (fontsAsked) return;
  fontsAsked = true;
  document.head.append(h('link', {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Allura&family=Caveat:wght@500&family=Homemade+Apple&display=swap',
  }));
}

/** A name, written in one of the hands, as a picture. */
async function writeInHand(text, hand, { width = 600, height = 150 } = {}) {
  await document.fonts?.load?.(`${hand.size}px "${hand.css}"`).catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d');
  let size = hand.size * (height / 150);
  c.font = `${size}px "${hand.css}", cursive`;
  while (c.measureText(text).width > width * 0.92 && size > 12) {
    size -= 2;
    c.font = `${size}px "${hand.css}", cursive`;
  }
  c.fillStyle = INK;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, width / 2, height / 2);
  return canvas.toDataURL('image/png');
}

const initialsOf = (name) => String(name ?? '').trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 4);

/** A picture chosen from the phone, shrunk to something sensible, as a PNG. */
function pictureFrom(file, most = 600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, most / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('That picture could not be read.'));
    img.src = URL.createObjectURL(file);
  });
}

/** A small dialog of our own: this screen is also used where the office dialogs are not loaded. */
export function sheetDialog({ title, body, actions, wide = false }) {
  const dialog = h(`dialog.sign-dialog${wide ? '.sign-dialog-wide' : ''}`);
  dialog.append(
    h('div.sign-dialog-head', h('h2', title),
      h('button.dialog-close', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕')),
    h('div.sign-dialog-body', body),
    h('div.sign-dialog-foot', actions(dialog)));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dayOf = (at) => (at ? new Date(`${String(at).replace(' ', 'T').slice(0, 19)}Z`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

/**
 * The screen. `submit(body)` signs; `decline(note)` declines (leave it out
 * where declining is not offered); `beforeSubmit()` may add to what is sent,
 * such as a PIN, or return null to stop.
 */
export async function signingScreen({
  packet, fileUrl = null, headers = {}, submit, decline = null, beforeSubmit = null, onDone,
  stamps = [], savedSignature = null,
}) {
  loadHands();
  const you = packet.you;
  const mineFields = packet.fields.filter((f) => f.mine)
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const values = {};
  const filled = new Set();
  const boxes = new Map();
  let adopted = null;
  let stampId = null;
  let current = null;

  for (const f of mineFields) {
    if (f.field === 'name') values[f.id] = you.name;
    if (f.field === 'title') values[f.id] = you.capacity || '';
    if (f.field === 'date') filled.add(f.id);
  }

  const isDone = (f) => {
    if (f.field === 'date') return true;
    if (f.field === 'signature' || f.field === 'initials') return filled.has(f.id);
    if (f.field === 'checkbox') return values[f.id] === true;
    if (f.field === 'stamp') return Boolean(values[f.id] || (filled.has(f.id) && stampId));
    return String(values[f.id] ?? '').trim() !== '';
  };
  const left = () => mineFields.filter((f) => f.required && !isDone(f));

  const countLine = h('div.sign-count');
  const actionButton = h('button.sign-go', { type: 'button' }, 'Start');
  const agree = h('input', { type: 'checkbox', id: 'sign-agree', checked: you.as === 'link' });
  const bar = h('div.sign-bar',
    countLine,
    h('div.sign-bar-buttons',
      decline ? h('button.sign-decline', { type: 'button', onclick: () => askDecline() }, 'Decline to sign') : null,
      actionButton));
  const agreeRow = you.as === 'link' ? null : h('label.sign-agree', agree,
    h('span', 'I agree to sign this document electronically. It has the same effect as signing on paper.'));
  const stack = h('div.sign-pages', h('p.muted', 'Opening the document…'));
  const screen = h('div.sign-screen', bar, agreeRow, stack);

  const paintCount = () => {
    const n = left().length;
    mount(countLine,
      n ? h('b', `${n} ${n === 1 ? 'box' : 'boxes'} to fill`) : h('b', 'All your boxes are filled'),
      ` · signing as ${you.name}${you.capacity ? `, ${you.capacity}` : ''}`);
    actionButton.textContent = n ? (current ? 'Next' : 'Start') : 'Finish';
  };

  /** Draw one of this person's boxes as it stands. */
  const paintMine = (f) => {
    const el = boxes.get(f.id);
    if (!el) return;
    el.classList.toggle('is-next', current === f.id);
    el.classList.toggle('is-filled', isDone(f) && f.field !== 'date');
    if (['text', 'name', 'title', 'checkbox'].includes(f.field)) return;
    if (f.field === 'date') { mount(el, h('span.box-text', today())); return; }
    if ((f.field === 'signature' || f.field === 'initials') && filled.has(f.id) && adopted) {
      mount(el, h('img.box-ink', { src: f.field === 'initials' ? adopted.initialsInk : adopted.ink, alt: f.field === 'initials' ? 'Your initials' : 'Your signature' }));
      return;
    }
    if (f.field === 'stamp' && (values[f.id] || (filled.has(f.id) && stampId))) {
      const src = values[f.id] || stamps.find((s) => s.id === stampId)?.image;
      mount(el, h('img.box-ink', { src, alt: 'Company stamp' }));
      return;
    }
    mount(el, h('span.box-label', f.ask || LABEL[f.field]));
  };

  const open = async (f) => {
    current = f.id;
    mineFields.forEach(paintMine);
    const el = boxes.get(f.id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (f.field === 'signature' || f.field === 'initials') {
      if (!adopted) {
        const ok = await adopt();
        if (!ok) return;
      }
      filled.add(f.id);
    } else if (f.field === 'stamp') {
      await chooseStamp(f);
    } else if (['text', 'name', 'title'].includes(f.field)) {
      el?.querySelector('input')?.focus({ preventScroll: true });
    }
    mineFields.forEach(paintMine);
    paintCount();
  };

  const next = () => {
    const todo = left();
    if (!todo.length) return finish();
    const after = todo.find((f) => mineFields.indexOf(f) > mineFields.findIndex((m) => m.id === current)) ?? todo[0];
    return open(after);
  };
  actionButton.addEventListener('click', () => next());

  /** Adopt a signature: typed, drawn, or a photograph. */
  const adopt = () => new Promise((resolve) => {
    let tab = savedSignature ? 'saved' : 'type';
    let hand = HANDS[0].key;
    const nameInput = h('input', { type: 'text', value: you.name, maxlength: 120, autocomplete: 'name' });
    const initialsInput = h('input', { type: 'text', value: initialsOf(you.name), maxlength: 6 });
    // Made when their tab is shown: a pad sizes itself on the next frame, and
    // one made while hidden would size itself to nothing.
    let signPad = null;
    let initialsPad = null;
    let photoPad = null;
    const area = h('div');
    const tabs = h('div.sign-tabs', { role: 'tablist' });
    const paint = () => {
      mount(tabs, [
        savedSignature ? ['saved', 'My saved signature'] : null,
        ['type', 'Type'], ['draw', 'Draw'], ['photo', 'Upload a photo'],
      ].filter(Boolean).map(([k, label]) => h('button.sign-tab', {
        type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '',
        onclick: () => { tab = k; paint(); },
      }, label)));
      if (tab === 'saved') {
        mount(area, h('div.sign-saved', h('img', { src: savedSignature, alt: 'Your saved signature' })),
          h('p.muted', 'Your saved signature, used for every signature box of yours. Initials are typed from your name.'));
      } else if (tab === 'type') {
        const options = h('div.sign-hands');
        const drawHands = () => mount(options, HANDS.map((hd) => h('label.sign-hand', { class: hand === hd.key ? 'on' : '' },
          h('input', {
            type: 'radio', name: 'hand', checked: hand === hd.key,
            onchange: () => { hand = hd.key; drawHands(); },
          }),
          h('span.sign-hand-name', { style: { fontFamily: `"${hd.css}", cursive` } }, nameInput.value || 'Your name'),
          h('span.sign-hand-initials', { style: { fontFamily: `"${hd.css}", cursive` } }, initialsInput.value || 'AB'))));
        nameInput.oninput = drawHands;
        initialsInput.oninput = drawHands;
        drawHands();
        mount(area,
          h('div.sign-two',
            h('label.field', h('span', 'Full name'), nameInput),
            h('label.field', h('span', 'Initials'), initialsInput)),
          options);
      } else if (tab === 'draw') {
        signPad = signaturePad({ height: 140 });
        initialsPad = signaturePad({ height: 110 });
        mount(area,
          h('div.field', h('span', 'Draw your signature'), signPad.element),
          h('div.field', h('span', 'Draw your initials'), initialsPad.element));
      } else {
        photoPad = signaturePad({ height: 140 });
        mount(area,
          h('p.muted', 'Sign on plain white paper, take a photo close up, and choose it with "Upload an image". The paper is taken out.'),
          photoPad.element);
      }
    };
    paint();
    let done = false;
    const dialog = sheetDialog({
      title: 'Adopt your signature',
      wide: true,
      body: h('div',
        h('p.muted', 'Used for every signature and initials box of yours on this document.'),
        tabs, area,
        h('p.fineprint', 'By choosing Adopt and sign, I agree that this signature and these initials are mine, '
          + 'and that they mean the same as signing on paper.')),
      actions: (d) => [
        h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel'),
        h('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => {
            const name = nameInput.value.trim() || you.name;
            let ink = null;
            let initialsInk = null;
            if (tab === 'saved') {
              ink = savedSignature;
              initialsInk = await writeInHand(initialsOf(name), HANDS[0], { width: 300 });
            } else if (tab === 'type') {
              const hd = HANDS.find((x) => x.key === hand);
              if (name.split(/\s+/).length < 2) { window.alert('Type your full name.'); return; }
              ink = await writeInHand(name, hd);
              initialsInk = await writeInHand(initialsInput.value.trim() || initialsOf(name), hd, { width: 300 });
            } else if (tab === 'draw') {
              ink = signPad?.read() ?? null;
              initialsInk = initialsPad?.read() || ink;
            } else {
              ink = photoPad?.read() ?? null;
              initialsInk = ink;
            }
            if (!ink) { window.alert('Draw, type or upload your signature first.'); return; }
            adopted = { ink, initialsInk, name };
            done = true;
            d.close();
          },
        }, 'Adopt and sign'),
      ],
    });
    dialog.addEventListener('close', () => resolve(done), { once: true });
  });

  const chooseStamp = (f) => new Promise((resolve) => {
    const picker = h('input', { type: 'file', accept: 'image/*' });
    const dialog = sheetDialog({
      title: 'Company stamp',
      body: h('div',
        stamps.length ? h('div.sign-stamps', stamps.map((s) => h('button.sign-stamp', {
          type: 'button',
          onclick: () => { stampId = s.id; values[f.id] = undefined; filled.add(f.id); dialog.close(); },
        }, h('img', { src: s.image, alt: s.label || 'Stamp' }), h('span', s.label || 'Use it')))) : null,
        h('label.field', h('span', stamps.length ? 'Or upload a new one' : 'A photo of the stamp, on plain paper'), picker)),
      actions: (d) => [
        h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel'),
        h('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => {
            const file = picker.files?.[0];
            if (!file) { d.close(); return; }
            try {
              values[f.id] = await pictureFrom(file);
              filled.add(f.id);
              d.close();
            } catch (err) { window.alert(err.message); }
          },
        }, 'Use this stamp'),
      ],
    });
    dialog.addEventListener('close', () => resolve(), { once: true });
  });

  const askDecline = () => {
    const why = h('textarea', { rows: 3, maxlength: 400, placeholder: 'For example: the price per kilo is wrong' });
    sheetDialog({
      title: 'Decline to sign',
      body: h('div',
        h('p', 'The document stops for everyone, and the sender is told at once with your reason, so they can put it right and send a corrected one.'),
        h('label.field', h('span', 'Why'), why)),
      actions: (d) => [
        h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel'),
        h('button.btn.btn-danger', {
          type: 'button',
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              await decline(why.value.trim());
              d.close();
              onDone({ declined: true });
            } catch (err) {
              event.target.disabled = false;
              window.alert(err.message);
            }
          },
        }, 'Decline to sign'),
      ],
    });
  };

  const finish = async () => {
    if (agreeRow && !agree.checked) {
      agreeRow.classList.add('is-wanted');
      agreeRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const extra = beforeSubmit ? await beforeSubmit() : {};
    if (extra === null) return;
    actionButton.disabled = true;
    actionButton.textContent = 'Signing…';
    try {
      const out = await submit({
        agreed: true,
        name: adopted?.name || you.name,
        ink: adopted?.ink ?? null,
        initialsInk: adopted?.initialsInk ?? null,
        values,
        stampId,
        capacity: you.capacity,
        ...extra,
      });
      onDone({ signed: true, ...(out ?? {}) });
    } catch (err) {
      actionButton.disabled = false;
      paintCount();
      window.alert(err.message);
    }
  };

  // The pages, and every box on them.
  try {
    const pages = await drawPages({ fileUrl, headers, letter: packet.doc.layout ? { layout: packet.doc.layout, letterhead: packet.doc.letterhead } : null });
    mount(stack, pages.map(({ sheet, layer, page }) => {
      for (const f of packet.fields.filter((x) => x.page === page)) {
        const place = { left: `${f.x}%`, top: `${f.y}%`, width: `${f.w}%`, height: `${f.h}%` };
        if (!f.mine) {
          const shown = f.shown;
          layer.append(h('div.box-other', { style: place, title: f.owner },
            shown?.ink ? h('img.box-ink', { src: shown.ink, alt: `${f.owner}` })
              : shown?.tick ? h('span.box-text', '✓')
                : shown?.text ? h('span.box-text', f.field === 'date' ? dayOf(shown.text) : shown.text)
                  : h('span.box-label', f.signed ? `Signed by ${f.owner}` : f.owner)));
          continue;
        }
        let el;
        if (['text', 'name', 'title'].includes(f.field)) {
          el = h('label.box-mine.box-input', { style: place },
            h('input', {
              type: 'text', value: values[f.id] ?? '', placeholder: f.ask || LABEL[f.field],
              'aria-label': f.ask || LABEL[f.field],
              maxlength: f.field === 'text' ? 300 : 160,
              oninput: (event) => { values[f.id] = event.target.value; paintMine(f); paintCount(); },
              onfocus: () => { current = f.id; mineFields.forEach(paintMine); paintCount(); },
            }));
        } else if (f.field === 'checkbox') {
          el = h('label.box-mine.box-check', { style: place, title: f.ask || 'Tick' },
            h('input', {
              type: 'checkbox', 'aria-label': f.ask || 'Tick',
              onchange: (event) => { values[f.id] = event.target.checked; paintMine(f); paintCount(); },
            }));
        } else {
          el = h('button.box-mine', { type: 'button', style: place, onclick: () => open(f) });
        }
        boxes.set(f.id, el);
        layer.append(el);
        paintMine(f);
      }
      return h('div.sign-page', sheet, h('div.sign-page-no', `Page ${page} of ${pages.length}`));
    }));
  } catch (err) {
    mount(stack, h('div.alert.warn', h('div', err.message)));
  }
  paintCount();
  return screen;
}
