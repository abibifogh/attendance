import { api } from '../api.js';
import { confirmAction, h, mount, toast } from '../util.js';
import { navigate, replaceParams } from '../app.js';
import { field, formDialog } from './att-shared.js';
import { asBase64 } from './letters.js';
import { fileLink } from '../file-view.js';
import {
  FIELD_SIZE, FIELD_TEXT, PROPERTY_COLOUR, SIGNER_COLOURS, drawPages, pointOn,
} from '../doc-pages.js';

/**
 * A document to sign: prepared in three steps, then followed until done.
 *
 * 1 · Document and signers. The PDF (or a template), and who signs, each
 *     with an order number. The same number signs at the same time.
 * 2 · Place the boxes. Pick a person, pick a kind of box, click the page.
 *     Drag to move, drag the corner to resize, Delete removes.
 * 3 · Check and send. How it goes out, and checks that must pass.
 *
 * Once sent, the same address shows where it has got to: each person and
 * whether they have signed, what has happened in order, and the signed copy
 * at the end.
 */

const STATUS = {
  draft: ['Draft', ''],
  awaiting_signature: ['Out for signature', 'blue'],
  signed: ['Completed', 'good'],
  void: ['Withdrawn', ''],
};
const KIND_LABEL = { email: 'By email', text: 'By text', staff: 'Staff login', property: 'The property signs' };

const when = (at) => {
  if (!at) return '';
  const d = new Date(`${String(at).replace(' ', 'T').slice(0, 19)}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Accra',
  });
};
const dayOf = (at) => (at ? new Date(`${String(at).replace(' ', 'T').slice(0, 19)}Z`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const sizeOf = (bytes) => (bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round((bytes || 0) / 1000))} KB`);

/** The colour a person's boxes are drawn in, the same on every screen. */
function colourOf(s) {
  if (!s) return '#8b95a5';
  if (s.kind === 'property' || s.rid === 'property' || s.id === 'property') return PROPERTY_COLOUR;
  if (s.role === 'copy') return '#9aa3b2';
  return SIGNER_COLOURS[((s.position ?? 1) - 1) % SIGNER_COLOURS.length];
}

let onKey = null;
const pageCache = new Map();

/** Wait a moment before saving; `flush` saves now if one is waiting. */
function later(fn, ms) {
  let timer = null;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  run.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    fn();
  };
  return run;
}

export async function renderSignDoc(params = {}) {
  const host = h('div.sd');
  const id = Number(params.id);
  let data = await api.doc(id);
  let people = null;
  let step = [1, 2, 3].includes(Number(params.step)) ? Number(params.step) : 1;

  if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }

  const header = () => {
    const [label, tone] = data.doc.status === 'awaiting_signature' && data.signers.some((s) => s.status === 'declined')
      ? ['Declined', 'bad'] : (STATUS[data.doc.status] ?? [data.doc.status, '']);
    return h('div.sd-head',
      h('a.sd-back', { href: '#/signing' }, '‹ Signatures'),
      h('div.sd-title-row', h('h1', data.doc.title), h(`span.pill${tone ? `.${tone}` : ''}`, label)),
      h('div.sd-meta', [
        'Letter', data.doc.reference, data.doc.createdBy ? `prepared by ${data.doc.createdBy}` : null,
        data.doc.status === 'draft' ? 'not sent' : null,
        data.doc.expiresAt && data.doc.status === 'awaiting_signature' ? `expires ${dayOf(data.doc.expiresAt)}` : null,
      ].filter(Boolean).join(' · ')));
  };

  const paint = () => (data.doc.status === 'draft' ? paintWizard() : paintTracking());

  // -------------------------------------------------------------------------
  // The three steps
  // -------------------------------------------------------------------------

  let local = null;          // who signs, as being edited in step 1
  let inOrder = true;
  let title = '';
  let dirty = false;
  const fromData = () => {
    local = data.signers.map((s) => ({ ...s }));
    inOrder = data.doc.inOrder;
    title = data.doc.title;
    dirty = false;
  };
  fromData();

  const saveStep1 = async () => {
    if (!dirty) return true;
    try {
      data = await api.docSave(id, {
        title,
        inOrder,
        signers: local.map((s) => ({
          id: typeof s.id === 'number' ? s.id : undefined,
          kind: s.kind, role: s.role, step: s.step, name: s.name, email: s.email, phone: s.phone,
          capacity: s.capacity, userId: s.userId,
        })),
      });
      fromData();
      return true;
    } catch (err) {
      toast(err.message, 'bad');
      return false;
    }
  };

  const goTo = async (n) => {
    if (step === 1 && !(await saveStep1())) return;
    if (step === 2) await flushFields();
    if (step === 3) await flushSettings();
    step = n;
    replaceParams('sign-doc', { id, step: n });
    paint();
  };

  const stepsNav = () => h('div.sd-steps-row',
    h('nav.sd-steps', { 'aria-label': 'Steps' }, [[1, 'Document and signers'], [2, 'Place the boxes'], [3, 'Check and send']].map(([n, label]) => h('button.sd-step', {
      type: 'button', class: step === n ? 'on' : '', 'aria-current': step === n ? 'step' : null,
      onclick: () => (step === n ? null : goTo(n)),
    }, `${n} · ${label}`))),
    h('div.sd-steps-tools',
      step === 1 ? h('span.sd-saved', dirty ? 'Not saved' : 'Saved') : null,
      step === 1 ? h('button.btn.btn-ghost', { type: 'button', onclick: async () => { if (await saveStep1()) paint(); } }, 'Save') : null,
      step < 3 ? h('button.btn.btn-primary', { type: 'button', onclick: () => goTo(step + 1) }, step === 1 ? 'Next: place the boxes' : 'Next: check and send') : null));

  async function paintWizard() {
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    if (step === 1) {
      people ??= await api.docPeople().catch(() => ({ users: [], templates: [] }));
      mount(host, header(), stepsNav(), stepOne());
    } else if (step === 2) {
      fields = data.fields.map((f) => ({ ...f }));
      mount(host, header(), stepsNav(), await stepTwo());
    } else {
      mount(host, header(), stepsNav(), stepThree());
    }
  }

  // ---- Step 1 --------------------------------------------------------------

  function stepOne() {
    const touched = () => {
      dirty = true;
      const saved = host.querySelector('.sd-saved');
      if (saved) saved.textContent = 'Not saved';
    };

    const fileCard = data.doc.source === 'uploaded'
      ? h('div.sd-file',
        h('span.sd-pdf', 'PDF'),
        h('div.sd-file-name',
          data.doc.fileId ? fileLink({ href: api.corrFileUrl(data.doc.fileId), name: data.doc.fileName || 'The PDF', mime: 'application/pdf' }) : 'No file yet',
          h('small', data.doc.fileBytes ? sizeOf(data.doc.fileBytes) : '')),
        h('button.btn-sm', { type: 'button', onclick: () => replaceFile() }, data.doc.fileId ? 'Replace with another PDF' : 'Upload a PDF'))
      : h('div.sd-file',
        h('span.sd-pdf.sd-tpl', 'HIVE'),
        h('div.sd-file-name', 'Written in HIVE from a template', h('small', 'Edit the words, then place the boxes in step 2.')),
        h('button.btn-sm', { type: 'button', onclick: () => navigate('letter-compose', { id }) }, 'Edit the words'));

    const left = h('section.card.sd-card',
      h('h2', 'The document'),
      field('Name of the document', h('input', {
        type: 'text', value: title, maxlength: 200,
        oninput: (event) => { title = event.target.value; touched(); },
      }), 'What signers see in the email and on the certificate.'),
      h('div.sd-field', h('span', 'The file'), fileCard),
      data.fields.length
        ? h('div.sd-ok', `✓ ${data.fields.length} ${data.fields.length === 1 ? 'box is' : 'boxes are'} placed already. You can move them in step 2.`)
        : null,
      h('p.sd-hint', 'Type ', h('code', '[sign:1]'), ', ', h('code', '[date:1]'), ' or ', h('code', '[initials:2]'),
        ' in the document where each person signs, numbered in the order on the right, and ', h('code', '[sign:0]'),
        ' where the property signs. The boxes are placed there for you. Make the markers white so they do not show.'));

    const tiles = h('div.sd-tiles');
    const drawTiles = () => {
      let pos = 0;
      mount(tiles, local.length ? local.map((s, i) => {
        if (s.kind !== 'property') pos += 1;
        return tile(s, i, s.kind === 'property' ? null : pos);
      }) : h('p.muted', 'Nobody yet.'));
    };

    const tile = (s, i, position) => {
      const colour = colourOf({ ...s, position });
      const set = (key) => (event) => { s[key] = event.target.value; touched(); };
      const remove = h('button.sd-x', {
        type: 'button', 'aria-label': `Remove ${s.name || 'this person'}`,
        onclick: () => { local.splice(i, 1); touched(); drawTiles(); },
      }, '×');
      const head = h('div.sd-tile-head',
        h('span.sd-swatch', { style: { background: colour }, 'aria-hidden': 'true' }),
        inOrder && s.role !== 'copy'
          ? h('label.sd-order', 'Order', h('input', {
            type: 'number', min: 1, max: 20, value: s.step ?? i + 1,
            oninput: (event) => { s.step = Number(event.target.value) || 1; touched(); },
          }))
          : null,
        ['email', 'text'].includes(s.kind)
          ? h('select.sd-how', {
            'aria-label': 'How they are reached',
            onchange: (event) => { s.kind = event.target.value; touched(); drawTiles(); },
          }, ['email', 'text'].map((k) => h('option', { value: k, selected: s.kind === k }, KIND_LABEL[k])))
          : h('span.sd-kind', KIND_LABEL[s.kind]),
        s.kind !== 'property'
          ? h('select', {
            'aria-label': 'Signs or gets a copy',
            onchange: (event) => { s.role = event.target.value; touched(); drawTiles(); },
          }, h('option', { value: 'signer', selected: s.role !== 'copy' }, 'Signs'),
          h('option', { value: 'copy', selected: s.role === 'copy' }, 'Gets a copy'))
          : null,
        remove);

      let inputs;
      if (s.kind === 'property') {
        inputs = h('div.sd-grid',
          h('label.field.sd-span2', h('span', `Who signs for ${data.property}`),
            h('select', { onchange: (event) => { s.userId = Number(event.target.value) || null; touched(); } },
              h('option', { value: '' }, 'Anybody who can sign letters'),
              (people?.users ?? []).map((u) => h('option', { value: u.id, selected: Number(s.userId) === u.id }, u.name)))),
          field('Signs as', h('input', { type: 'text', value: s.capacity ?? '', maxlength: 120, placeholder: 'General manager', oninput: set('capacity') })));
      } else if (s.kind === 'staff') {
        inputs = h('div.sd-grid',
          h('label.field.sd-span2', h('span', 'Member of staff'),
            h('select', {
              onchange: (event) => {
                s.userId = Number(event.target.value) || null;
                s.name = (people?.users ?? []).find((u) => u.id === s.userId)?.name ?? s.name;
                touched();
              },
            }, h('option', { value: '' }, 'Choose…'),
            (people?.users ?? []).map((u) => h('option', { value: u.id, selected: Number(s.userId) === u.id }, u.name)))),
          s.role === 'copy' ? null : field('Signs as', h('input', { type: 'text', value: s.capacity ?? '', maxlength: 120, oninput: set('capacity') })));
      } else {
        inputs = h('div.sd-grid',
          field('Name', h('input', { type: 'text', value: s.name ?? '', maxlength: 160, oninput: set('name') })),
          s.kind === 'text'
            ? field('Mobile', h('input', { type: 'tel', value: s.phone ?? '', maxlength: 40, placeholder: '024 000 0000', oninput: set('phone') }))
            : field('Email', h('input', { type: 'email', value: s.email ?? '', maxlength: 200, oninput: set('email') })),
          s.role === 'copy' ? null : field('Signs as', h('input', { type: 'text', value: s.capacity ?? '', maxlength: 120, placeholder: 'Director, Witness…', oninput: set('capacity') })));
      }
      return h(`div.sd-tile${s.role === 'copy' ? '.is-copy' : ''}`, head, inputs);
    };
    drawTiles();

    const nextStep = () => Math.max(0, ...local.filter((s) => s.role !== 'copy').map((s) => Number(s.step) || 0)) + 1;
    const add = (person) => { local.push({ role: 'signer', step: nextStep(), ...person }); touched(); drawTiles(); };
    const hasProperty = local.some((s) => s.kind === 'property');
    const staffPick = h('select', {
      'aria-label': 'Add a member of staff',
      onchange: (event) => {
        const u = (people?.users ?? []).find((x) => x.id === Number(event.target.value));
        event.target.value = '';
        if (u) add({ kind: 'staff', userId: u.id, name: u.name });
      },
    }, h('option', { value: '' }, 'Add a member of staff'), (people?.users ?? []).map((u) => h('option', { value: u.id }, u.name)));

    const right = h('section.card.sd-card',
      h('div.sd-card-head',
        h('h2', 'Who signs'),
        h('label.sd-inline', h('input', {
          type: 'checkbox', checked: inOrder,
          onchange: (event) => { inOrder = event.target.checked; touched(); drawTiles(); },
        }), 'In order')),
      tiles,
      h('div.sd-add',
        staffPick,
        h('button.btn-sm', { type: 'button', onclick: () => add({ kind: 'email', name: '', email: '' }) }, 'Add someone by email or phone'),
        h('button.btn-sm', {
          type: 'button', disabled: hasProperty,
          onclick: () => add({ kind: 'property', name: data.property }),
        }, `${data.property} signs`),
        h('button.btn-sm.btn-ghost', { type: 'button', onclick: () => add({ kind: 'email', role: 'copy', name: '', email: '', step: undefined }) }, 'Add someone who gets a copy')),
      h('p.sd-hint', inOrder
        ? 'The same order number signs at the same time; the next number is sent when they have all signed. '
        : 'Everyone is sent it at once. ',
      'A member of staff signs from their own HIVE login, without a code.'));

    return h('div.sd-two', left, right);
  }

  async function replaceFile() {
    const picker = h('input', { type: 'file', accept: 'application/pdf' });
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        const { findMarkers } = await import('../pdf-markers.js');
        const fields = await findMarkers(file).catch(() => []);
        data = await api.docReplaceFile(id, {
          content: await asBase64(file), filename: file.name, mime: 'application/pdf',
          fields: fields.map((f) => ({ ...f, signer: Number(f.signer) })),
        });
        pageCache.clear();
        fromData();
        toast('The PDF was replaced.', 'good');
        paint();
      } catch (err) { toast(err.message, 'bad'); }
    });
    picker.click();
  }

  // ---- Step 2 --------------------------------------------------------------

  let fields = data.fields.map((f) => ({ ...f }));
  let placing = null;
  let tool = 'signature';
  let selected = null;
  let saving = Promise.resolve();
  const signersToPlace = () => data.signers.filter((s) => s.role !== 'copy').map((s) => ({ ...s, rid: s.id }));
  const ownerOf = (rid) => data.signers.find((s) => s.id === rid) ?? null;

  const saveFields = later(() => {
    saving = api.docSave(id, { fields: fields.map(({ signer, ...f }) => f) })
      .then((fresh) => { data = fresh; paintInspector(); })
      .catch((err) => toast(err.message, 'bad'));
  }, 600);
  const flushFields = async () => { saveFields.flush?.(); await saving; };
  const changed = () => { saveFields(); paintInspector(); };

  const inspector = h('aside.sd-inspector');
  const layers = new Map();

  function paintBoxes() {
    for (const [page, layer] of layers) {
      mount(layer, fields.filter((f) => f.page === page).map((f) => box(f)));
    }
  }

  function box(f) {
    const owner = ownerOf(f.rid);
    const colour = colourOf(owner ?? { id: f.rid });
    const el = h('div.sd-box', {
      class: selected === f.id ? 'is-on' : '',
      style: {
        left: `${f.x}%`, top: `${f.y}%`, width: `${f.w}%`, height: `${f.h}%`,
        borderColor: colour, background: `${colour}22`, color: colour,
      },
      tabindex: 0,
      'aria-label': `${FIELD_TEXT[f.field]} for ${owner?.name ?? 'nobody'}`,
    },
    h('span.sd-box-label', f.field === 'checkbox' ? '☐' : `${FIELD_TEXT[f.field]} · ${String(owner?.name ?? 'Nobody').split(' ')[0]}`),
    h('span.sd-box-handle', { 'aria-hidden': 'true' }));

    el.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      selected = f.id;
      paintBoxes();
      paintInspector();
      const sheet = el.parentElement?.parentElement;
      const start = pointOn(sheet, event);
      const from = { x: f.x, y: f.y, w: f.w, h: f.h };
      const resizing = event.target.classList.contains('sd-box-handle');
      const move = (e) => {
        const now = pointOn(sheet, e);
        const dx = now.x - start.x;
        const dy = now.y - start.y;
        if (resizing) {
          f.w = Math.max(2, Math.min(100 - f.x, from.w + dx));
          f.h = Math.max(1.5, Math.min(100 - f.y, from.h + dy));
        } else {
          f.x = Math.max(0, Math.min(100 - f.w, from.x + dx));
          f.y = Math.max(0, Math.min(100 - f.h, from.y + dy));
        }
        const live = sheet.querySelector('.sd-box.is-on');
        if (live) Object.assign(live.style, { left: `${f.x}%`, top: `${f.y}%`, width: `${f.w}%`, height: `${f.h}%` });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (from.x !== f.x || from.y !== f.y || from.w !== f.w || from.h !== f.h) changed();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return el;
  }

  function paintInspector() {
    if (!inspector.isConnected && step !== 2) return;
    const f = fields.find((x) => x.id === selected);
    const counts = signersToPlace().map((s) => [s, fields.filter((x) => x.rid === s.rid).length]);
    mount(inspector,
      h('div.card.sd-card.sd-small',
        f
          ? h('div.sd-stack',
            h('b', FIELD_TEXT[f.field]),
            field('For', h('select', {
              onchange: (event) => { f.rid = event.target.value === 'property' ? 'property' : Number(event.target.value); paintBoxes(); changed(); },
            }, signersToPlace().map((s) => h('option', { value: s.rid, selected: s.rid === f.rid }, s.name)))),
            ['text', 'checkbox'].includes(f.field)
              ? field('What it asks', h('input', {
                type: 'text', value: f.ask ?? '', maxlength: 120,
                placeholder: f.field === 'checkbox' ? 'I have read the price list' : 'Room numbers',
                oninput: (event) => { f.ask = event.target.value; saveFields(); },
              }))
              : null,
            f.field === 'date' ? null : h('label.sd-inline', h('input', {
              type: 'checkbox', checked: f.required !== false,
              onchange: (event) => { f.required = event.target.checked; changed(); },
            }), 'Must be filled'),
            h('p.sd-hint', 'Drag to move; drag the corner to resize. Delete removes it.'),
            h('button.btn-sm.btn-danger', { type: 'button', onclick: () => removeSelected() }, 'Remove this box'))
          : h('p.sd-hint', 'Click a box on the page to change it. Drag to move; drag the corner to resize.')),
      h('div.card.sd-card.sd-small',
        h('b', 'On this document'),
        counts.length ? counts.map(([s, n]) => h('div.sd-count',
          h('span.sd-swatch', { style: { background: colourOf(s) }, 'aria-hidden': 'true' }),
          h('span', `${s.name}: `, n ? `${n} ${n === 1 ? 'box' : 'boxes'}` : h('span.sd-none', 'none yet'))))
          : h('p.sd-hint', 'Add who signs in step 1 first.')));
  }

  function removeSelected() {
    if (!selected) return;
    fields = fields.filter((x) => x.id !== selected);
    selected = null;
    paintBoxes();
    changed();
  }

  async function stepTwo() {
    const options = signersToPlace();
    placing = options.some((s) => s.rid === placing) ? placing : options[0]?.rid ?? null;
    const bar = h('div.sd-placing-bar', { style: { background: colourOf(ownerOf(placing) ?? { id: placing }) } });
    const tools = h('div.sd-tools');
    const drawTools = () => mount(tools, Object.entries(FIELD_TEXT).map(([k, label]) => h('button.sd-tool', {
      type: 'button', class: tool === k ? 'on' : '', 'aria-pressed': String(tool === k),
      onclick: () => { tool = k; drawTools(); },
    }, label)));
    drawTools();
    const markerNote = h('p.sd-hint');

    const palette = h('aside.card.sd-card.sd-palette',
      field('Placing for', h('select', {
        onchange: (event) => {
          placing = event.target.value === 'property' ? 'property' : Number(event.target.value);
          bar.style.background = colourOf(ownerOf(placing) ?? { id: placing });
        },
      }, options.map((s) => h('option', { value: s.rid, selected: s.rid === placing }, s.name)))),
      bar,
      h('span.sd-label', 'Click a box, then the page'),
      tools,
      data.doc.source === 'uploaded'
        ? h('button.btn-sm.btn-ghost', { type: 'button', onclick: () => fromMarkers(markerNote) }, 'Place at [sign:1] markers')
        : null,
      markerNote);

    const desk = h('div.sd-desk', h('p.muted', 'Opening the document…'));
    layers.clear();
    const key = `${id}:${data.doc.fileId ?? 'paper'}:${data.doc.source}`;
    try {
      if (!pageCache.has(key) || data.doc.source === 'composed') {
        pageCache.set(key, await drawPages({
          fileUrl: data.doc.source === 'uploaded' && data.doc.fileId ? api.corrFileUrl(data.doc.fileId) : null,
          letter: data.doc.source === 'composed'
            ? { layout: data.doc.layout, letterhead: data.doc.letterheadId ? { image: api.corrLetterheadUrl(data.doc.letterheadId), laterPages: false } : null }
            : null,
        }));
      }
      const pages = pageCache.get(key);
      mount(desk, pages.map(({ sheet, layer, page }) => {
        layers.set(page, layer);
        layer.onpointerdown = (event) => {
          if (event.target !== layer) return;
          if (!placing) { toast('Add who signs in step 1 first.', 'bad'); return; }
          const at = pointOn(sheet, event);
          const [w, hgt] = FIELD_SIZE[tool];
          const f = {
            id: `f${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`,
            page, field: tool, rid: placing, required: tool !== 'checkbox',
            x: Math.max(0, Math.min(100 - w, at.x - w / 2)),
            y: Math.max(0, Math.min(100 - hgt, at.y - hgt / 2)),
            w, h: hgt,
          };
          fields.push(f);
          selected = f.id;
          paintBoxes();
          changed();
        };
        return h('div.sd-page', sheet, h('div.sd-page-no', `Page ${page} of ${pages.length}`));
      }));
    } catch (err) {
      mount(desk, h('div.alert.warn', h('div', err.message)));
    }
    paintBoxes();
    paintInspector();

    onKey = (event) => {
      if (!selected || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
    };
    document.addEventListener('keydown', onKey);
    return h('div.sd-three', palette, desk, inspector);
  }

  async function fromMarkers(note) {
    try {
      const response = await fetch(api.corrFileUrl(data.doc.fileId), { credentials: 'same-origin' });
      const blob = await response.blob();
      const { findMarkers } = await import('../pdf-markers.js');
      const found = await findMarkers(blob);
      const byPosition = new Map(data.signers.filter((s) => s.kind !== 'property').map((s) => [s.position, s.id]));
      let added = 0;
      for (const m of found) {
        const rid = Number(m.signer) === 0 ? (data.signers.some((s) => s.kind === 'property') ? 'property' : null) : byPosition.get(Number(m.signer));
        if (!rid) continue;
        if (fields.some((f) => f.page === m.page && Math.abs(f.x - m.x) < 1 && Math.abs(f.y - m.y) < 1)) continue;
        fields.push({ id: `m${Date.now().toString(36)}${added}`, page: m.page, field: m.field, rid, x: m.x, y: m.y, w: m.w, h: m.h, required: true });
        added += 1;
      }
      note.textContent = found.length
        ? `${added} ${added === 1 ? 'box was' : 'boxes were'} placed at the markers.`
        : 'No [sign:1] style markers were found in this PDF.';
      paintBoxes();
      changed();
    } catch (err) { toast(err.message, 'bad'); }
  }

  // ---- Step 3 --------------------------------------------------------------

  const settings = {
    mailSubject: data.doc.mailSubject ?? data.defaults.mailSubject,
    mailMessage: data.doc.mailMessage ?? '',
    remindDays: data.doc.remindDays ?? data.defaults.remindDays,
    expireDays: data.doc.expireDays ?? data.defaults.expireDays,
  };
  let settingsSaving = Promise.resolve();
  const checksBox = h('div.sd-checks');
  const paintChecks = () => mount(checksBox, data.checks.length
    ? data.checks.map((c) => h(`div.sd-check.is-${c.tone}`,
      h('span.sd-mark', { 'aria-label': { ok: 'Passed', warn: 'Worth reading', bad: 'Must be put right' }[c.tone] }, { ok: '✓', warn: '!', bad: '✕' }[c.tone]),
      h('span', c.text)))
    : h('p.muted', 'Nothing to check yet.'));
  const saveSettings = later(() => {
    settingsSaving = api.docSave(id, settings).then((fresh) => { data = fresh; paintChecks(); })
      .catch((err) => toast(err.message, 'bad'));
  }, 600);
  const flushSettings = async () => { saveSettings.flush?.(); await settingsSaving; };

  function stepThree() {
    const set = (key, number = false) => (event) => { settings[key] = number ? Number(event.target.value) : event.target.value; saveSettings(); };
    paintChecks();
    // The saved settings, once, so the checks reflect what is stored.
    if (data.doc.mailSubject == null) saveSettings();
    const signerCount = data.signers.filter((s) => s.role !== 'copy').length;
    return h('div.sd-two',
      h('section.card.sd-card',
        h('h2', 'How it goes out'),
        field('Email subject', h('input', { type: 'text', value: settings.mailSubject, maxlength: 200, oninput: set('mailSubject') })),
        field('Message', h('textarea', { rows: 4, maxlength: 2000, oninput: set('mailMessage') }, settings.mailMessage),
          'Shown in the email above the button, in your words.'),
        h('div.sd-grid2',
          field('Reminders', h('select', { onchange: set('remindDays', true) },
            [[0, 'None'], [1, 'Every day'], [2, 'Every 2 days'], [3, 'Every 3 days'], [5, 'Every 5 days'], [7, 'Every 7 days']]
              .map(([v, l]) => h('option', { value: v, selected: Number(settings.remindDays) === v }, l)))),
          field('Expires after', h('select', { onchange: set('expireDays', true) },
            [7, 14, 30, 60, 90].map((v) => h('option', { value: v, selected: Number(settings.expireDays) === v }, `${v} days`))))),
        h('p.sd-hint', 'Each person opens it from their email or text and enters a six-digit code sent to them. '
          + 'Staff signed in to HIVE sign there without one.')),
      h('section.card.sd-card',
        h('h2', 'Checks'),
        checksBox,
        h('div.btn-row.sd-send-row',
          h('button.btn.btn-primary', {
            type: 'button',
            onclick: async () => {
              await flushSettings();
              if (data.checks.some((c) => c.tone === 'bad')) { toast('Put right what is marked ✕ first.', 'bad'); return; }
              const sent = await formDialog({
                title: 'Send for signature',
                submitLabel: 'Send',
                body: h('p', `Send “${data.doc.title}” to ${signerCount} ${signerCount === 1 ? 'signer' : 'signers'}? `
                  + 'It cannot be changed once sent; you would withdraw it and send a corrected one.'),
                onSubmit: () => api.docSend(id),
              });
              if (!sent) return;
              toast('Sent. Each person is sent a link as their turn comes.', 'good');
              if (sent.handBack?.length) await passOn(sent.handBack);
              data = await api.doc(id);
              paint();
            },
          }, 'Send for signature'),
          h('button.btn.btn-ghost.sd-danger', {
            type: 'button',
            onclick: async () => {
              if (!(await confirmAction('Delete this draft? It cannot be brought back.'))) return;
              await api.docDelete(id);
              navigate('signing');
            },
          }, 'Delete the draft'))));
  }

  // -------------------------------------------------------------------------
  // After it is sent
  // -------------------------------------------------------------------------

  function paintTracking() {
    const d = data.doc;
    const declined = data.signers.find((s) => s.status === 'declined');
    const banners = [];
    if (data.you.signAs && d.status === 'awaiting_signature') {
      banners.push(h('div.sd-banner.is-blue',
        h('span', data.you.signAs === 'property' ? `It is your turn to sign this for ${data.property}.` : 'It is your turn to sign this.'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => navigate('sign-in', { id }) }, 'Sign it now')));
    }
    if (declined) {
      banners.push(h('div.sd-banner.is-bad',
        h('span', `${declined.name} declined${declined.declineNote ? `: “${declined.declineNote}”` : ''}. Correct it and send a new one.`)));
    }
    if (d.status === 'void') banners.push(h('div.sd-banner', h('span', `Withdrawn${d.closedNote ? `: ${d.closedNote}` : ''}`)));
    if (d.status === 'signed') {
      const last = data.events.filter((e) => e.kind === 'fully_signed').pop();
      banners.push(h('div.sd-banner.is-good',
        h('div',
          h('div', `Signed by everyone${last ? ` ${when(last.at)}` : ''}. `
            + (data.ways.email ? 'The signed copy was emailed to everyone on it with an email address.' : 'Email is not set up, so download the signed copy and send it on.')),
          d.finalHash ? h('div.sd-mono', `Fingerprint (SHA-256): ${d.finalHash} · check it at ${location.host}/verify`) : null),
        h('a.btn.btn-good', { href: `/api/corr/letters/${id}/signed.pdf?download=1` }, 'Download the signed PDF')));
    }

    const live = d.status === 'awaiting_signature';
    const signerTiles = data.signers.filter((s) => s.role !== 'copy').sort((a, b) => a.step - b.step);
    const copies = data.signers.filter((s) => s.role === 'copy');

    const signersCard = h('section.card.sd-card',
      h('h2', 'Signers'),
      signerTiles.map((s) => {
        const [label, tone] = pillFor(s, data.you.signAs === 'property');
        return h('div.sd-signer',
          h('span.sd-swatch', { style: { background: colourOf(s) }, 'aria-hidden': 'true' }),
          h('div.sd-signer-main',
            h('div.sd-signer-top',
              h('span', h('b', `${d.inOrder ? `${s.step}. ` : ''}${s.name}`), s.capacity ? ` · ${s.capacity}` : ''),
              h(`span.pill${tone ? `.${tone}` : ''}`, label)),
            h('div.sd-small-line', contactOf(s)),
            h('div.sd-small-line', lineFor(s)),
            live && s.kind !== 'property' && !['signed', 'declined', 'revoked'].includes(s.status)
              ? h('div.sd-links',
                s.yourTurn ? h('button.sd-link', { type: 'button', onclick: () => remind(s) }, s.kind === 'staff' ? 'Remind now' : (data.ways[s.kind === 'text' ? 'text' : 'email'] ? 'Remind now' : 'Get a new link')) : null,
                s.kind !== 'staff' ? h('button.sd-link', { type: 'button', onclick: () => correct(s) }, 'Correct the address') : null,
                h('button.sd-link', { type: 'button', onclick: () => paper(s) }, 'Record a paper signature'))
              : null));
      }),
      copies.length ? h('div.sd-copies', `Copies to: ${copies.map((c) => `${c.name}${c.email ? ` (${c.email})` : ''}`).join(', ')}`) : null,
      h('div.btn-row',
        d.source === 'uploaded' && d.fileId
          ? fileLink({ href: api.corrFileUrl(d.fileId), name: d.fileName || 'The document', mime: 'application/pdf', label: 'The document as sent', className: 'btn-sm' })
          : h('button.btn-sm', { type: 'button', onclick: () => navigate('letter', { id }) }, 'The document as sent'),
        live && data.you.canWrite ? h('button.btn-sm.btn-danger', { type: 'button', onclick: () => withdraw() }, 'Withdraw it') : null));

    const timeline = h('section.card.sd-card',
      h('h2', 'What has happened'),
      [...data.events].reverse().map((e) => h('div.sd-event', h('span.sd-when', when(e.at)), h('span', e.text))));

    mount(host, header(), ...banners, h('div.sd-two', signersCard, timeline));
  }

  function pillFor(s, iSignForProperty) {
    if (s.kind === 'property') {
      if (s.status === 'signed') return ['Signed', 'good'];
      if (s.status === 'turn') return [iSignForProperty ? 'Your turn' : 'Their turn', 'blue'];
      return ['Not yet', ''];
    }
    if (s.status === 'signed') return [s.signerCheck === 'paper' ? 'Signed on paper' : 'Signed', 'good'];
    if (s.status === 'declined') return ['Declined', 'bad'];
    if (s.status === 'revoked') return ['Cancelled', ''];
    if (s.status === 'opened') return ['Opened', 'warn'];
    if (s.yourTurn && s.toldAt) return ['Sent', 'blue'];
    if (s.yourTurn) return ['Their turn', 'blue'];
    return ['Not yet', ''];
  }

  function contactOf(s) {
    if (s.kind === 'property') return 'Signs in HIVE, with their PIN or password';
    if (s.kind === 'staff') return 'Signs in HIVE';
    if (s.kind === 'text') return `${s.phone ?? ''} · by text`;
    return `${s.email ?? ''} · by email`;
  }

  function lineFor(s) {
    const parts = [];
    if (s.signedAt) parts.push(`Signed ${when(s.signedAt)}`);
    else if (s.openedAt) parts.push(`Opened ${when(s.openedAt)}`);
    else if (s.toldAt) parts.push(`Sent ${when(s.toldAt)}`);
    else if (!s.yourTurn && data.doc.status === 'awaiting_signature') parts.push('Gets it when those before have signed');
    else if (s.yourTurn && data.doc.status === 'awaiting_signature') parts.push(s.kind === 'property' ? 'Told in HIVE' : 'Waiting for the link to be passed on');
    if (s.reminders) parts.push(`reminded ${s.reminders === 1 ? 'once' : `${s.reminders} times`}`);
    return parts.join(' · ');
  }

  async function remind(s) {
    try {
      const out = await api.docRemind(s.id);
      if (out.sent) toast(`Sent to ${s.name} again.`, 'good');
      else if (out.url) await passOn([{ name: out.name, url: out.url, how: s.kind }]);
      data = await api.doc(id);
      paint();
    } catch (err) { toast(err.message, 'bad'); }
  }

  async function correct(s) {
    const out = await formDialog({
      title: 'Correct the address',
      submitLabel: 'Save and send a new link',
      body: h('div',
        h('p.muted', 'Links sent to the old address stop working.'),
        field('Email', h('input', { type: 'email', name: 'email', value: s.email ?? '', maxlength: 200 })),
        field('Mobile', h('input', { type: 'tel', name: 'phone', value: s.phone ?? '', maxlength: 40 }))),
      onSubmit: (form) => api.corrCorrectRecipient(s.id, { email: String(form.get('email') ?? '').trim(), phone: String(form.get('phone') ?? '').trim() }),
    });
    if (!out) return;
    if (out.url) await passOn([{ name: s.name, url: out.url, how: s.kind }]);
    else toast('Saved.', 'good');
    data = await api.doc(id);
    paint();
  }

  async function paper(s) {
    const file = h('input', { type: 'file', name: 'file', accept: 'application/pdf,image/*', required: true });
    const out = await formDialog({
      title: 'Record a paper signature',
      submitLabel: 'Record it',
      body: h('div',
        h('p.muted', `${s.name} signed a printed copy. Upload a scan or photo of the signed page; it is kept with the document and they count as signed.`),
        field('Scan or photo', file)),
      onSubmit: async () => {
        const chosen = file.files?.[0];
        if (!chosen) throw new Error('Choose the scan first.');
        return api.docPaper(s.id, { content: await asBase64(chosen), filename: chosen.name, mime: chosen.type || 'application/pdf' });
      },
    });
    if (!out) return;
    toast('Recorded.', 'good');
    data = await api.doc(id);
    paint();
  }

  async function withdraw() {
    const out = await formDialog({
      title: 'Withdraw it',
      submitLabel: 'Withdraw it',
      body: h('div',
        h('p.muted', 'Everyone who had it is told it no longer needs signing, with this reason.'),
        field('Reason', h('textarea', { name: 'note', rows: 3, maxlength: 300, required: true }))),
      onSubmit: (form) => api.corrVoid(id, String(form.get('note') ?? '').trim()),
    });
    if (!out) return;
    data = await api.doc(id);
    paint();
  }

  paint();
  return host;
}

/**
 * Links HIVE could not send itself, handed over to pass on by hand. Shown
 * once: only a fingerprint of each is kept.
 */
async function passOn(links) {
  await formDialog({
    title: 'Pass these links on',
    submitLabel: 'Done',
    body: h('div',
      h('p.muted', 'HIVE could not email or text these yet. Copy each link and send it to that person yourself, '
        + 'by WhatsApp or however you reach them. Each link is shown only now.'),
      links.map((l) => {
        const input = h('input', { type: 'text', readonly: true, value: l.url, onfocus: (event) => event.target.select() });
        return h('div.sd-pass',
          h('b', l.name),
          input,
          h('div.btn-row',
            h('button.btn-sm', {
              type: 'button',
              onclick: async () => {
                try { await navigator.clipboard.writeText(l.url); toast('Copied.', 'good'); } catch { input.select(); }
              },
            }, 'Copy the link'),
            navigator.share ? h('button.btn-sm', {
              type: 'button', onclick: () => navigator.share({ title: 'Document to sign', url: l.url }).catch(() => {}),
            }, 'Share') : null));
      })),
    onSubmit: () => true,
  });
}
