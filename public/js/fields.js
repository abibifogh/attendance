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

  return {
    element: h('div.sig-wrap',
      canvas,
      h('div.sig-tools',
        h('span.muted', 'Sign above with your finger'),
        h('button.btn-sm', {
          type: 'button',
          onclick: () => { size(); drawn = false; },
        }, 'Clear'),
      ),
    ),
    isDrawn: () => drawn,
    // A PNG rather than a path list: what is stored should be the thing that
    // will be shown years later, without needing this code to still exist.
    read: () => (drawn ? canvas.toDataURL('image/png') : null),
  };
}
