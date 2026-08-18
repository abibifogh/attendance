import { h } from './util.js';

/**
 * Turning the server's description of a field into something to type into.
 *
 * Shared by the office screen and the page somebody opens on their phone, so
 * the two cannot drift. The server says what is asked for; this decides only
 * how it is asked.
 */

export function control(field, value, props = {}) {
  const shared = { name: field.key, ...props };

  if (field.type === 'select') {
    return h('select', shared,
      h('option', { value: '' }, '—'),
      (field.options ?? []).map((option) => h('option', {
        value: option, selected: String(option) === String(value ?? ''),
      }, option)),
    );
  }

  if (field.type === 'textarea') {
    return h('textarea', { rows: 2, maxlength: 600, ...shared }, String(value ?? ''));
  }

  return h('input', {
    // A phone that offers a number pad for a mobile number and a date wheel
    // for a birthday is the difference between a form people finish and one
    // they abandon halfway down.
    type: field.type === 'tel' ? 'tel' : field.type === 'email' ? 'email' : field.type === 'date' ? 'date' : 'text',
    inputmode: field.type === 'tel' ? 'tel' : undefined,
    autocomplete: AUTOCOMPLETE[field.key] ?? 'off',
    maxlength: 200,
    placeholder: field.placeholder ?? '',
    value: value ?? '',
    ...shared,
  });
}

// Letting the browser fill in what it already knows. Only the handful where it
// is genuinely the same thing — nothing here invites a guess at somebody's
// SSNIT number.
const AUTOCOMPLETE = {
  personal_phone: 'tel',
  personal_email: 'email',
  address_line: 'street-address',
  town: 'address-level2',
  date_of_birth: 'bday',
};

export function fieldRow(field, value, props = {}) {
  return h('label.field',
    h('span', field.label),
    control(field, value, props),
    field.hint ? h('small.muted', field.hint) : null,
  );
}

/**
 * A small repeating table — emergency contacts, qualifications, past jobs.
 *
 * Rows are added and removed in place and read back on save, rather than each
 * row being its own request. Somebody adding three emergency contacts on a
 * phone should press save once.
 */
export function listEditor(list, rows, { labels = {}, minRows = 1 } = {}) {
  const body = h('div.list-rows');
  const state = (rows?.length ? rows.map((r) => ({ ...r })) : []);
  while (state.length < minRows) state.push({});

  const draw = () => {
    body.replaceChildren(...state.map((row, index) => h('div.list-row',
      h('div.list-row-fields',
        list.columns.map((column) => h('label.field',
          h('span', labels[column] ?? titleise(column)),
          h('input', {
            type: column.endsWith('_on') ? 'text' : 'text',
            value: row[column] ?? '',
            maxlength: 200,
            placeholder: PLACEHOLDER[column] ?? '',
            oninput: (e) => { state[index][column] = e.target.value; },
          }),
        )),
      ),
      h('button.btn-sm.list-row-remove', {
        type: 'button',
        title: 'Remove this one',
        onclick: () => { state.splice(index, 1); if (!state.length) state.push({}); draw(); },
      }, '×'),
    )));
  };
  draw();

  return {
    element: h('div',
      body,
      h('button.btn-sm', {
        type: 'button',
        onclick: () => { state.push({}); draw(); },
      }, `+ Add another`),
    ),
    // Empty rows are dropped here rather than sent and filtered at the far
    // end, so what the screen shows and what is saved are the same thing.
    read: () => state.filter((row) => Object.values(row).some((v) => String(v ?? '').trim() !== '')),
  };
}

const PLACEHOLDER = {
  kind: 'emergency',
  relationship: 'Sister, husband, friend…',
  finished_on: '2019',
  from_on: '2019',
  to_on: '2023',
  level: 'WASSCE, Diploma, Degree…',
};

function titleise(key) {
  return key.replace(/_on$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Somewhere to sign with a finger.
 *
 * A canvas rather than a font that looks like handwriting: a mark somebody
 * made is evidence of an act, and a name rendered in a script face is evidence
 * of a dropdown. Both are accepted — the law here asks that a signature be the
 * signatory's own and under their control, not that it be pretty — but only
 * one of them is worth showing on a contract.
 */
export function signaturePad({ height = 160 } = {}) {
  const canvas = h('canvas.sig-pad', { height });
  let drawn = false;
  let ctx = null;

  const size = () => {
    const width = Math.max(240, canvas.clientWidth || 320);
    const ratio = window.devicePixelRatio || 1;
    // Redrawing what is already there after a resize is not worth the code;
    // resizing before signing is the only case, and it starts blank anyway.
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
  };

  let drawing = false;
  const point = (event) => {
    const box = canvas.getBoundingClientRect();
    const touch = event.touches?.[0] ?? event;
    return { x: touch.clientX - box.left, y: touch.clientY - box.top };
  };

  const start = (event) => {
    event.preventDefault();
    if (!ctx) size();
    drawing = true;
    const { x, y } = point(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (event) => {
    if (!drawing) return;
    event.preventDefault();
    const { x, y } = point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    drawn = true;
  };
  const end = () => { drawing = false; };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  // The canvas has no width until it is in the document, so the first size is
  // taken on the next frame rather than now.
  requestAnimationFrame(size);

  /**
   * A signature that already exists on paper.
   *
   * Drawing with a finger is fine on a phone and poor with a mouse, and some
   * people simply have a signature — scanned once, used on everything — and no
   * interest in inventing a second one that looks nothing like it. So an image
   * can be brought in instead.
   *
   * It is not pasted in as-is. A photograph of a signature is dark ink on a
   * grey-white page, and dropped whole onto a letter that is a grey rectangle
   * with a name in it. So the page is taken out: anything light enough to be
   * paper becomes transparent, what is left is cropped to the ink, and the ink
   * is what gets stored. That is the difference between this being usable and
   * being something everybody tries once.
   */
  const take = async (file) => {
    const bitmap = await createImageBitmap(file);
    const cut = trimToInk(bitmap);
    if (!cut) throw new Error('Nothing dark enough to be a signature was found in that image.');

    size();
    const box = { width: canvas.clientWidth || 320, height };
    const scale = Math.min(box.width / cut.width, box.height / cut.height) * 0.92;
    ctx.drawImage(
      cut.canvas,
      (box.width - cut.width * scale) / 2,
      (box.height - cut.height * scale) / 2,
      cut.width * scale,
      cut.height * scale,
    );
    drawn = true;
  };

  const picker = h('input', {
    type: 'file',
    accept: 'image/*',
    style: { display: 'none' },
    onchange: async (event) => {
      const file = event.target.files?.[0];
      // Reset first, so choosing the same file twice after a Clear still fires.
      event.target.value = '';
      if (!file) return;
      try {
        await take(file);
      } catch (err) {
        const message = err?.message || 'That image could not be read.';
        if (typeof window !== 'undefined') window.alert(message);
      }
    },
  });

  return {
    element: h('div.sig-wrap',
      canvas,
      h('div.sig-tools',
        h('span.muted', 'Sign above, or use a picture of your signature'),
        h('button.btn-sm', {
          type: 'button',
          onclick: () => picker.click(),
        }, 'Upload an image'),
        h('button.btn-sm', {
          type: 'button',
          onclick: () => { size(); drawn = false; },
        }, 'Clear'),
      ),
      picker,
    ),
    isDrawn: () => drawn,
    // A PNG rather than a path list: what is stored should be the thing that
    // will be shown years later, without needing this code to still exist.
    //
    // Shrunk if it has to be. A signature drawn on a high-density phone screen,
    // or lifted off a twelve-megapixel photograph, can encode larger than the
    // record will take, and failing on save after somebody has signed is the
    // worst possible moment to mention it.
    read: () => {
      if (!drawn) return null;
      let url = canvas.toDataURL('image/png');
      let source = canvas;
      for (let attempt = 0; url.length > MAX_INK && attempt < 3; attempt += 1) {
        source = halve(source);
        url = source.toDataURL('image/png');
      }
      return url;
    },
  };
}

/** What the record will take for one signature. */
const MAX_INK = 380_000;

/**
 * Ink, without the paper it was photographed on.
 *
 * Everything lighter than the threshold becomes transparent and the rest is
 * cropped to its own bounding box, so a snapshot of a signature in the middle
 * of an A4 sheet comes out as the signature. Luminance rather than pure white,
 * because paper under a hotel office light is never white and a threshold that
 * demanded it would keep the whole page every time.
 *
 * Returns nothing when there is no ink to find, which is a photograph of
 * something else and worth saying rather than silently accepting a blank.
 */
function trimToInk(bitmap, threshold = 190) {
  const work = document.createElement('canvas');
  work.width = bitmap.width;
  work.height = bitmap.height;
  const paint = work.getContext('2d', { willReadFrequently: true });
  paint.drawImage(bitmap, 0, 0);

  const image = paint.getImageData(0, 0, work.width, work.height);
  const { data } = image;
  let top = Infinity; let left = Infinity; let right = -1; let bottom = -1;

  for (let y = 0; y < work.height; y += 1) {
    for (let x = 0; x < work.width; x += 1) {
      const at = (y * work.width + x) * 4;
      const luminance = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
      if (data[at + 3] < 8 || luminance > threshold) {
        data[at + 3] = 0;
        continue;
      }
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0) return null;
  paint.putImageData(image, 0, 0);

  // A little air round the ink, so a descender does not sit flush to the edge.
  const pad = Math.round(Math.max(work.width, work.height) * 0.01);
  const x = Math.max(0, left - pad);
  const y = Math.max(0, top - pad);
  const width = Math.min(work.width - x, right - left + 1 + pad * 2);
  const height = Math.min(work.height - y, bottom - top + 1 + pad * 2);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  out.getContext('2d').drawImage(work, x, y, width, height, 0, 0, width, height);
  return { canvas: out, width, height };
}

function halve(source) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(source.width / 2));
  out.height = Math.max(1, Math.round(source.height / 2));
  out.getContext('2d').drawImage(source, 0, 0, out.width, out.height);
  return out;
}
