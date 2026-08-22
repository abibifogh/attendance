import { api } from '../api.js';
import { confirmAction, h, mount, toast } from '../util.js';
import { emptyState } from './components.js';
import { navigate } from '../app.js';
import { field, formDialog } from './att-shared.js';
import { PAGE_H, PAGE_W, faceCss, lastPage, paperPage } from './letter-paper.js';

/**
 * Writing a letter.
 *
 * WHAT WAS HERE BEFORE WAS A TEXTAREA IN A DIALOG. Everything around it — the
 * register, the reference, the signing, the evidence chain — was sound, and
 * none of it mattered, because the thing that came out did not look like a
 * letter from this property. So letters kept being written in Word and
 * uploaded, which is precisely what the register exists to prevent.
 *
 * SO THE PAGE IS THE SCREEN. The property's own letterhead behind, the words
 * on top of it where they will actually print, and everything about them —
 * the face, the size, where the block sits — changed by picking the block up
 * and moving it or by pressing something in the bar above.
 *
 * NOTHING IS PIXELS. A block knows where it is as a percentage of the page, so
 * the same letter draws identically at 40% in this editor, at full size in the
 * preview, on a supplier's phone and on A4 out of the printer.
 *
 * IT SAVES BY ITSELF. Somebody who has just written three paragraphs and
 * closed the tab has lost three paragraphs, and no amount of "remember to
 * press Save" makes that acceptable.
 */

const GRID = 0.5;                       // per cent, the step a drag snaps to
const AUTOSAVE_MS = 2500;

export async function renderLetterCompose(params) {
  const host = h('div');
  const id = Number(params.id);
  if (!id) {
    mount(host, emptyState('No letter chosen', 'Open one from the register.'));
    return host;
  }

  const [data, heads] = await Promise.all([
    api.corrLetter(id),
    api.corrLetterheads().catch(() => ({ letterheads: [], defaultId: null })),
  ]);
  const { letter } = data;

  if (letter.status !== 'draft') {
    mount(host, emptyState('This letter is no longer a draft',
      'The words and the layout are fixed once it has gone out for signature.'),
    h('div.btn-row', { style: { justifyContent: 'center' } },
      h('button.btn', { onclick: () => navigate('letter', { id }) }, 'Open the letter')));
    return host;
  }

  // The working copy. Everything below edits this and the page redraws from
  // it, so there is one truth on screen rather than a DOM somebody has to
  // read back.
  const state = {
    letterhead: letter.letterhead ?? null,
    letterheadId: letter.letterhead_id ?? null,
    layout: letter.layout ?? { blocks: [], pages: 1 },
    selected: letter.layout?.blocks?.[0]?.id ?? null,
    dirty: false,
    saving: false,
  };

  const canvas = h('div.compose-canvas');
  const bar = h('div.compose-bar');
  const status = h('span.compose-status', 'Saved');

  let timer = null;
  const touched = () => {
    state.dirty = true;
    status.textContent = 'Saving…';
    clearTimeout(timer);
    timer = setTimeout(save, AUTOSAVE_MS);
  };

  async function save() {
    if (state.saving) return;
    clearTimeout(timer);
    state.saving = true;
    try {
      await api.corrUpdateLetter(id, {
        layout: state.layout,
        letterheadId: state.letterheadId,
      });
      state.dirty = false;
      status.textContent = 'Saved';
    } catch (err) {
      status.textContent = 'Not saved';
      toast(err.message, 'bad');
    } finally {
      state.saving = false;
    }
  }

  // Leaving with words unsaved is the one thing this must not do quietly.
  const beforeUnload = (event) => {
    if (!state.dirty) return undefined;
    event.preventDefault();
    return '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  const watcher = new MutationObserver(() => {
    if (!host.isConnected) {
      window.removeEventListener('beforeunload', beforeUnload);
      watcher.disconnect();
      if (state.dirty) save();
    }
  });
  watcher.observe(document.body, { childList: true, subtree: true });

  const selected = () => state.layout.blocks.find((b) => b.id === state.selected) ?? null;

  const redraw = () => {
    drawBar();
    drawPages();
  };

  // ---- the page ---------------------------------------------------------

  function drawPages() {
    const scale = fitScale();
    drawnAt = scale;
    mount(canvas, Array.from({ length: lastPage(state.layout) }, (_, i) => {
      const page = i + 1;
      const wrap = h('div.compose-sheet');
      const sheet = paperPage(
        { ...letter, letterhead: state.letterhead, layout: state.layout },
        page,
        {
          scale,
          interactive: true,
          selected: state.selected,
          onBlock: (block, el) => wire(block, el, scale),
        },
      );

      // The safe area, drawn over the paper so nobody has to guess where the
      // crest ends. Only while editing — it is not part of the letter.
      const margins = state.letterhead?.margins;
      // The sheet is the page itself at full size and a wrapper around it when
      // it is scaled down, so look for both rather than only inside.
      const page2 = sheet.classList.contains('paper-page')
        ? sheet
        : sheet.querySelector('.paper-page');
      if (margins && page2) {
        page2.append(h('div.compose-safe', {
          style: {
            top: `${margins.top}%`,
            right: `${margins.right}%`,
            bottom: `${margins.bottom}%`,
            left: `${margins.left}%`,
          },
        }));
      }

      wrap.append(sheet, h('div.compose-page-no', `Page ${page}`));
      return wrap;
    }));
  }

  // How much of a real page fits across the screen. A phone gets a third of
  // one, which is still the whole page rather than the left-hand strip of it.
  let drawnAt = null;
  const fitScale = () => {
    const room = Math.max(280, canvas.clientWidth || host.clientWidth || 900) - 24;
    return Math.min(1, Math.round((room / PAGE_W) * 100) / 100);
  };

  /** Make one block on the page selectable, editable and draggable. */
  function wire(block, el, scale) {
    // A place to sign is not words. Making it editable would let somebody type
    // into the box the other party is meant to fill.
    const isField = block.role === 'field';
    if (!isField) {
      el.contentEditable = 'true';
      el.spellcheck = true;
      el.setAttribute('role', 'textbox');
    }

    const select = () => {
      if (state.selected === block.id) return;
      state.selected = block.id;
      for (const other of canvas.querySelectorAll('.paper-on')) other.classList.remove('paper-on');
      el.classList.add('paper-on');
      drawBar();
    };
    el.addEventListener('focus', select);
    el.addEventListener('pointerdown', select);

    if (!isField) {
      el.addEventListener('input', () => {
        block.html = htmlOf(el);
        touched();
      });
    }

    // A handle rather than the whole box, so somebody clicking into the words
    // is editing and somebody grabbing the corner is moving. Making the block
    // itself draggable would mean text you cannot put a cursor in.
    const grip = h('span.compose-grip', { contentEditable: 'false', title: 'Move this block' }, '⠿');
    const size = h('span.compose-size', { contentEditable: 'false', title: 'Make it wider or narrower' });
    el.append(grip, size);

    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const page = el.closest('.paper-page');
      const start = { x: event.clientX, y: event.clientY, bx: block.x, by: block.y };
      grip.setPointerCapture(event.pointerId);

      const move = (e) => {
        const dx = ((e.clientX - start.x) / scale / PAGE_W) * 100;
        const dy = ((e.clientY - start.y) / scale / PAGE_H) * 100;
        block.x = snap(Math.min(100 - block.w, Math.max(0, start.bx + dx)));
        block.y = snap(Math.min(98, Math.max(0, start.by + dy)));
        el.style.left = `${block.x}%`;
        el.style.top = `${block.y}%`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        page?.classList.remove('compose-moving');
        touched();
        drawBar();
      };
      page?.classList.add('compose-moving');
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });

    size.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const start = { x: event.clientX, y: event.clientY, w: block.w, h: block.h ?? 7 };
      size.setPointerCapture(event.pointerId);

      const move = (e) => {
        const dx = ((e.clientX - start.x) / scale / PAGE_W) * 100;
        block.w = snap(Math.min(100 - block.x, Math.max(8, start.w + dx)));
        el.style.width = `${block.w}%`;
        // Words grow downwards on their own; a place to sign has to be told
        // how tall it is, so its handle drags both ways.
        if (isField) {
          const dy = ((e.clientY - start.y) / scale / PAGE_H) * 100;
          block.h = snap(Math.min(40, Math.max(3, start.h + dy)));
          el.style.height = `${block.h}%`;
        }
      };
      const up = () => {
        size.removeEventListener('pointermove', move);
        size.removeEventListener('pointerup', up);
        touched();
        drawBar();
      };
      size.addEventListener('pointermove', move);
      size.addEventListener('pointerup', up);
    });
  }

  /**
   * The words in a block, without the furniture.
   *
   * The move and resize handles sit inside the editable box — anywhere else
   * and they would not follow it around the page — so reading innerHTML
   * straight off it would file two little spans as part of the letter and
   * print them.
   */
  const htmlOf = (el) => {
    const copy = el.cloneNode(true);
    for (const junk of copy.querySelectorAll('.compose-grip, .compose-size')) junk.remove();
    return copy.innerHTML;
  };

  const snap = (value) => Math.round(value / GRID) * GRID;

  // ---- the bar ----------------------------------------------------------

  function drawBar() {
    const block = selected();

    const face = h('select.compose-face', {
      title: 'Typeface',
      disabled: !block,
      onchange: (e) => { const now = selected(); if (!now) return; now.face = e.target.value; apply(); },
    },
    [['serif', 'Serif'], ['sans', 'Sans'], ['mono', 'Typewriter']].map(([key, label]) =>
      h('option', { value: key, selected: block?.face === key, style: { fontFamily: faceCss(key) } }, label)));

    const size = h('select.compose-pt', {
      title: 'Size',
      disabled: !block,
      onchange: (e) => { const now = selected(); if (!now) return; now.size = Number(e.target.value); apply(); },
    },
    [8, 9, 10, 11, 12, 14, 16, 18, 22, 28, 36].map((pt) =>
      h('option', { value: pt, selected: Number(block?.size) === pt }, `${pt} pt`)));

    // Drawn rather than lettered. Four buttons that all said a word would be
    // wider than the rest of the toolbar put together, and the arrows that
    // stood here before read as "go back" rather than "line these up left".
    const align = (key, title) => h('button.btn-sm.compose-align', {
      class: block?.align === key ? 'on' : '',
      disabled: !block,
      title,
      onclick: () => { const now = selected(); if (!now) return; now.align = key; apply(); },
    }, h('span.compose-align-mark', { 'data-align': key }, h('i'), h('i'), h('i'), h('i')));

    const inline = (command, label, title) => h('button.btn-sm', {
      title,
      disabled: !block,
      // The block keeps the selection: pressing a button in a toolbar moves
      // focus, and formatting applies to whatever was selected before it did.
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        const now = selected();
        if (!now) return;
        document.execCommand(command);
        const el = canvas.querySelector(`[data-block="${now.id}"]`);
        if (el) { now.html = htmlOf(el); touched(); }
      },
    }, label);

    mount(bar,
      h('div.compose-bar-group',
        h('button.btn-sm', { onclick: () => navigate('letter', { id }) }, '‹ The letter'),
        h('strong.compose-ref', letter.reference)),

      // A place to sign has nothing to do with typefaces, so the middle of the
      // bar changes to the two things it does have: whose it is, and what
      // goes in it. A toolbar offering bold on a signature box is a toolbar
      // nobody trusts the rest of.
      block?.role === 'field'
        ? h('div.compose-bar-group',
          h('span.compose-what', 'Place to sign'),
          h('select', {
            title: 'Whose place this is',
            onchange: (e) => { const now = selected(); if (!now) return; now.signer = Number(e.target.value); apply(); },
          },
          h('option', { value: 0, selected: block.signer === 0 }, 'The property'),
          [1, 2, 3, 4, 5, 6].map((n) => h('option', {
            value: n, selected: block.signer === n,
          }, `Signer ${n}`))),
          h('select', {
            title: 'What goes in it',
            onchange: (e) => { const now = selected(); if (!now) return; now.field = e.target.value; apply(); },
          },
          [['signature', 'Signature'], ['initials', 'Initials'], ['date', 'Date signed']]
            .map(([value, label]) => h('option', {
              value, selected: block.field === value,
            }, label))),
          h('input.compose-label', {
            type: 'text', maxlength: 60, placeholder: 'Label (optional)',
            value: block.label ?? '',
            title: 'What the box says before it is signed',
            onchange: (e) => {
              const now = selected();
              if (!now) return;
              now.label = e.target.value.trim() || null;
              apply();
            },
          }))
        : h('div.compose-bar-group',
          face, size,
          inline('bold', h('strong', 'B'), 'Bold'),
          inline('italic', h('em', 'I'), 'Italic'),
          inline('underline', h('u', 'U'), 'Underline'),
          inline('insertUnorderedList', 'List', 'A list'),
          align('left', 'Line up on the left'),
          align('center', 'Centre it'),
          align('right', 'Line up on the right'),
          align('justify', 'Justified, both edges straight'),
          h('select.compose-line', {
            title: 'Line spacing',
            disabled: !block,
            onchange: (e) => { const now = selected(); if (!now) return; now.line = Number(e.target.value); apply(); },
          },
          [['1.15', 'Tight'], ['1.45', 'Normal'], ['1.8', 'Airy'], ['2.4', 'Double']]
            .map(([value, label]) => h('option', {
              value, selected: String(block?.line ?? 1.45) === value,
            }, label)))),

      h('div.compose-bar-group',
        h('button.btn-sm', { onclick: () => addBlock() }, '+ Text'),
        h('button.btn-sm', {
          title: 'A place on the page for somebody to put their name',
          onclick: () => addField('signature'),
        }, '+ Sign here'),
        h('button.btn-sm', {
          disabled: !block,
          title: 'Take this block off the page',
          onclick: () => {
            if (!confirmAction('Take this block off the letter?')) return;
            state.layout.blocks = state.layout.blocks.filter((b) => b.id !== block.id);
            state.selected = state.layout.blocks[0]?.id ?? null;
            touched();
            redraw();
          },
        }, 'Remove'),
        h('button.btn-sm', { onclick: () => addPage() }, '+ Page')),

      h('div.compose-bar-group.compose-bar-end',
        h('button.btn-sm', { onclick: () => pickLetterhead() }, state.letterhead
          ? state.letterhead.name ?? 'Letterhead'
          : 'Choose a letterhead'),
        status,
        h('button.btn-sm', { onclick: async () => { await save(); preview(); } }, 'Preview'),
        h('button.btn.btn-primary', {
          onclick: async () => { await save(); finish(); },
        }, 'Done, how is it signed?')));
  }

  /** A change to the selected block that needs the page redrawn. */
  const apply = () => { touched(); drawPages(); drawBar(); };

  function addBlock() {
    const id2 = `b${Date.now().toString(36)}`;
    const page = lastPage(state.layout);
    state.layout.blocks.push({
      id: id2, page, x: 10, y: 55, w: 60, face: 'serif', size: 11, line: 1.45,
      align: 'left', bold: false, role: 'text', html: '<p>New text</p>',
    });
    state.selected = id2;
    touched();
    redraw();
  }

  /**
   * A place on the page for somebody to sign.
   *
   * Dropped where the sign-off already is, because that is where a signature
   * goes on nine letters out of ten and dragging it from the middle of the
   * page every time would be the app making work.
   */
  function addField(what = 'signature') {
    const id2 = `f${Date.now().toString(36)}`;
    const page = lastPage(state.layout);
    const already = state.layout.blocks.filter((b) => b.role === 'field').length;
    state.layout.blocks.push({
      id: id2,
      page,
      x: already % 2 ? 55 : 10,
      // Below the sign-off rather than on top of it. The words there are
      // "Yours faithfully" and a name, and a box dropped over them is the
      // first thing somebody has to move every single time.
      y: Math.min(90, 84 + Math.floor(already / 2) * 10),
      w: what === 'date' ? 22 : 33,
      h: what === 'date' ? 4 : 8,
      face: 'sans',
      size: 9,
      line: 1.2,
      align: 'left',
      bold: false,
      role: 'field',
      // Whoever it is sent to first. Most letters have one signer, and the
      // ones that have three are the ones somebody is paying attention to.
      signer: 1,
      field: what,
      html: '',
    });
    state.selected = id2;
    touched();
    redraw();
  }

  function addPage() {
    const page = lastPage(state.layout) + 1;
    const id2 = `b${Date.now().toString(36)}`;
    state.layout.blocks.push({
      id: id2, page, x: 10, y: 12, w: 80, face: 'serif', size: 11, line: 1.45,
      align: 'justify', bold: false, role: 'text', html: '<p></p>',
    });
    state.selected = id2;
    touched();
    redraw();
  }

  // ---- the letterhead ---------------------------------------------------

  async function pickLetterhead() {
    const fresh = await api.corrLetterheads().catch(() => ({ letterheads: [] }));
    const list = fresh.letterheads ?? [];

    const choose = (head) => {
      state.letterhead = head;
      state.letterheadId = head?.id ?? null;
      touched();
      redraw();
    };

    await formDialog({
      title: 'The paper this is written on',
      submitLabel: 'Done',
      body: h('div',
        h('p.muted', { style: { fontSize: '.85rem' } },
          'A letterhead is a picture of the property’s printed page: the crest at the top, '
          + 'the address along the bottom. Upload it once and every letter is laid out on it.'),

        h('div.head-choices',
          h('button.head-choice', {
            type: 'button',
            class: state.letterheadId ? '' : 'on',
            onclick: () => { choose(null); toast('Plain paper.', 'good'); },
          }, h('div.head-blank'), h('small', 'Plain paper')),

          list.map((head) => h('button.head-choice', {
            type: 'button',
            class: head.id === state.letterheadId ? 'on' : '',
            onclick: () => { choose(head); toast(`On ${head.name}.`, 'good'); },
          },
          h('img', { src: head.image, alt: head.name }),
          h('small', head.name),
          h('span.head-edit', {
            title: 'Set the safe area, or take it out of use',
            onclick: (e) => { e.stopPropagation(); editLetterhead(head); },
          }, '⚙')))),

        h('div.btn-row', { style: { marginTop: '.8rem' } },
          h('button.btn-sm.btn-primary', {
            type: 'button',
            onclick: () => uploadLetterhead(),
          }, 'Upload a letterhead'))),
      onSubmit: async () => ({ ok: true }),
    });
  }

  async function uploadLetterhead() {
    const picker = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const status2 = h('small.muted');
    let picked = null;

    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      if (!file) return;
      status2.textContent = 'Reading it…';
      try {
        picked = await readImage(file);
        status2.textContent = `${file.name.slice(0, 30)} · ${Math.round(picked.bytes / 1024)} KB`;
      } catch (err) {
        picked = null;
        status2.textContent = err.message;
      }
    });

    const done = await formDialog({
      title: 'Upload a letterhead',
      submitLabel: 'Add it',
      body: h('div',
        h('p.muted', { style: { fontSize: '.85rem' } },
          'A picture of one blank page of the property’s letterhead. A PNG or a JPEG, the '
          + 'whole page including the margins. Export it from the design, or photograph a '
          + 'blank sheet square on.'),
        field('Called', h('input', {
          type: 'text', name: 'name', maxlength: 80, required: true, placeholder: 'Somewhere Nice, headed',
        })),
        h('div.btn-row',
          h('button.btn-sm', { type: 'button', onclick: () => picker.click() }, 'Choose the picture'),
          picker, status2),
        h('label.tickline', { style: { marginTop: '.6rem' } },
          h('input', { type: 'checkbox', name: 'laterPages' }),
          h('span', 'Use the same paper for second and later pages')),
        h('label.tickline',
          h('input', { type: 'checkbox', name: 'makeDefault', checked: true }),
          h('span', 'Start new letters on this one'))),
      onSubmit: async (form) => {
        if (!picked) throw new Error('Choose the picture of the letterhead first.');
        return api.corrAddLetterhead({
          name: form.get('name'),
          content: picked.base64,
          mime: picked.mime,
          filename: picked.filename,
          laterPages: form.get('laterPages') === 'on',
          makeDefault: form.get('makeDefault') === 'on',
        });
      },
    });
    if (!done) return;

    const fresh = await api.corrLetterheads().catch(() => ({ letterheads: [] }));
    const head = (fresh.letterheads ?? []).find((x) => x.id === done.id);
    if (head) {
      state.letterhead = head;
      state.letterheadId = head.id;
      touched();
      redraw();
    }
    toast(`${done.name} added.`, 'good');
  }

  /**
   * The safe area, set by dragging four edges over the paper itself.
   *
   * Typing four percentages would be asking somebody to measure a crest with
   * a ruler. Dragging the guides over the picture is the same decision made
   * by looking at it.
   */
  async function editLetterhead(head) {
    const margins = { ...head.margins };
    const preview2 = h('div.head-preview',
      h('img', { src: head.image, alt: '' }),
      h('div.head-safe'));

    const guides = preview2.querySelector('.head-safe');
    const paint = () => {
      guides.style.top = `${margins.top}%`;
      guides.style.right = `${margins.right}%`;
      guides.style.bottom = `${margins.bottom}%`;
      guides.style.left = `${margins.left}%`;
    };
    paint();

    for (const edge of ['top', 'right', 'bottom', 'left']) {
      const handle = h('span.head-handle', { 'data-edge': edge, title: `The ${edge} margin` });
      guides.append(handle);
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const box = preview2.getBoundingClientRect();
        const move = (e) => {
          const px = ((e.clientX - box.left) / box.width) * 100;
          const py = ((e.clientY - box.top) / box.height) * 100;
          if (edge === 'top') margins.top = clampPc(py);
          if (edge === 'bottom') margins.bottom = clampPc(100 - py);
          if (edge === 'left') margins.left = clampPc(px);
          if (edge === 'right') margins.right = clampPc(100 - px);
          paint();
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }

    const done = await formDialog({
      title: head.name,
      submitLabel: 'Save the safe area',
      body: h('div',
        h('p.muted', { style: { fontSize: '.85rem' } },
          'Drag the edges to where words may go. Everything outside them is the printed '
          + 'letterhead: the crest, the address, the footer. Nothing should land on it.'),
        preview2,
        h('div.btn-row', { style: { marginTop: '.7rem' } },
          h('button.btn-sm.btn-danger', {
            type: 'button',
            onclick: async () => {
              if (!confirmAction(`Take ${head.name} out of use? Letters already on it keep it.`)) return;
              await api.corrRemoveLetterhead(head.id);
              toast('Taken out of use.', 'good');
            },
          }, 'Take it out of use'))),
      onSubmit: () => api.corrSaveLetterhead(head.id, { name: head.name, margins }),
    });
    if (!done) return;

    if (state.letterheadId === head.id) {
      state.letterhead = { ...head, margins };
      redraw();
    }
    toast('Saved.', 'good');
  }

  const clampPc = (n) => Math.min(45, Math.max(0, Math.round(n * 10) / 10));

  // ---- preview and finishing -------------------------------------------

  function preview() {
    const win = h('div.preview-wrap',
      h('div.preview-bar',
        h('strong', letter.reference),
        h('span.muted', letter.subject),
        h('div.btn-row',
          h('button.btn-sm', { onclick: () => window.print() }, 'Print or save as PDF'),
          h('button.btn-sm', { onclick: () => shade.remove() }, 'Close'))),
      h('div.preview-pages',
        Array.from({ length: lastPage(state.layout) }, (_, i) => paperPage(
          { ...letter, letterhead: state.letterhead, layout: state.layout },
          i + 1,
          { scale: Math.min(1, (Math.min(window.innerWidth - 48, 900)) / PAGE_W) },
        ))));

    const shade = h('div.preview-shade', { onclick: (e) => { if (e.target === shade) shade.remove(); } }, win);
    document.body.append(shade);
  }

  /**
   * How this letter gets signed.
   *
   * Three answers and they are not exclusive: the property signs its own
   * letters, sometimes it needs a supplier to sign back, and often both. The
   * old screen made this two unrelated buttons in two places, which is why
   * letters went out signed by nobody.
   */
  async function finish() {
    const done = await formDialog({
      title: 'How is this signed?',
      submitLabel: 'Go on',
      body: h('div',
        h('p.muted', { style: { fontSize: '.85rem' } },
          'The layout is saved. Nothing here changes the words. It decides who puts their '
          + 'name to them.'),
        h('div.answer-choice',
          h('label.tickline',
            h('input', { type: 'radio', name: 'how', value: 'self', checked: true }),
            h('span', h('strong', 'I sign it for the property'),
              h('small.muted', ', your own signature, after confirming it is you'))),
          h('label.tickline',
            h('input', { type: 'radio', name: 'how', value: 'invite' }),
            h('span', h('strong', 'Send it out for signature'),
              h('small.muted', ', a link to whoever has to sign it'))),
          h('label.tickline',
            h('input', { type: 'radio', name: 'how', value: 'both' }),
            h('span', h('strong', 'Both'),
              h('small.muted', ', you sign it first and then it goes out'))),
          h('label.tickline',
            h('input', { type: 'radio', name: 'how', value: 'later' }),
            h('span', h('strong', 'Neither yet'),
              h('small.muted', ', leave it as a draft'))))),
      onSubmit: async (form) => ({ how: form.get('how') }),
    });
    if (!done) return;

    // The letter's own page carries both of those actions already, with the
    // re-authentication and the recipient list they need. Sending somebody
    // there with the right thing open beats building either of them twice.
    // "Neither yet" goes to the same page with nothing asked of them.
    if (done.how === 'later') { navigate('letter', { id }); return; }
    navigate('letter', { id, then: done.how });
  }

  // ---- put it together --------------------------------------------------

  mount(host, bar, canvas);
  redraw();
  window.addEventListener('resize', drawPages);

  // The first draw happens before this is in the document, so the canvas has
  // no width yet and the page comes out full size with its right-hand third
  // off the screen. Watch it instead of guessing, and redraw when the room it
  // has actually changes.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (fitScale() !== drawnAt) drawPages(); }).observe(canvas);
  }
  return host;
}

/** A letterhead picture, read and shrunk enough to store. */
async function readImage(file) {
  const LIMIT = 2_500_000;
  if (!file.type.startsWith('image/')) {
    throw new Error('A letterhead has to be a picture, a PNG or a JPEG of the page.');
  }

  const bitmap = await createImageBitmap(file);
  // 1240 across is A4 at 150 dots to the inch: crisp on paper, and a fraction
  // of what a design tool exports.
  const scale = Math.min(1, 1240 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.92, 0.85, 0.75, 0.65]) {
    // PNG for anything with flat colour and sharp edges, which a letterhead
    // usually is; JPEG once that is too big.
    const url = quality === 0.92
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', quality);
    const bytes = Math.round((url.length - url.indexOf(',') - 1) * 0.75);
    if (bytes <= LIMIT) {
      return {
        base64: url.split(',')[1],
        mime: url.slice(5, url.indexOf(';')),
        bytes,
        filename: file.name,
      };
    }
  }
  throw new Error('That picture is too large even after shrinking. Export it at A4 and 150 dpi.');
}
