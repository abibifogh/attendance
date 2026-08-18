import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import { navigate } from '../app.js';
import { field, formDialog } from './att-shared.js';
import { signaturePad } from '../fields.js';

/**
 * Your signature, and the company stamp.
 *
 * The two are stored in completely different ways and the screen says so.
 *
 * A stamp belongs to the property. Anybody who may sign can apply it, and what
 * it looks like is not a secret — it is printed on paper that goes out of the
 * building every week.
 *
 * A signature belongs to a person. Nobody else can see it, nobody else can
 * apply it, and saving or using it costs that person their own password or PIN
 * at the moment they do. Anything less and a stored signature is a forgery
 * machine sitting on an unlocked phone in a hotel office.
 */
export async function renderLetterSigning() {
  const host = h('div');
  const [me, stamps] = await Promise.all([api.corrMe(), api.corrStamps()]);
  const reload = async () => mount(host, await renderLetterSigning());

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Signature & stamp'),
        h('div.sub', 'What goes at the bottom of a letter'),
      ),
      h('button.btn-sm', { onclick: () => navigate('letters') }, '‹ Letters'),
    ),

    card('Your signature', {
      note: me.signatory?.hasSignature ? 'Saved' : 'Not saved',
      actions: h('div.btn-row',
        me.signatory?.hasSignature
          ? h('button.btn-sm', {
            onclick: async () => {
              if (!window.confirm('Remove your saved signature? You can draw one on each letter '
                + 'instead, or save a new one whenever you like.')) return;
              await api.corrDeleteMySignature();
              toast('Removed.');
              await reload();
            },
          }, 'Remove')
          : null,
        h('button.btn.btn-primary', { onclick: () => saveSignature(me, reload) },
          me.signatory?.hasSignature ? 'Replace it' : 'Save one'),
      ),
    },
      me.signatory?.hasSignature
        ? h('div',
          h('p', h('strong', me.signatory.displayName),
            me.signatory.jobTitle ? h('span.muted', ` · ${me.signatory.jobTitle}`) : null),
          h('p.muted', { style: { marginBottom: 0 } },
            'Saved. It is applied when you sign a letter, and you are asked for your '
            + `${me.method === 'password' ? 'password' : 'PIN'} each time.`),
        )
        : h('p.muted', { style: { marginBottom: 0 } },
          'Draw it once and you will not have to draw it on every letter. It is stored against '
          + 'your login only — nobody else can see it or use it, not an administrator and not '
          + 'whoever set this system up.'),

      me.method === 'none'
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'Your login has no password or PIN'),
            h('div.alert-detail', 'Signing asks you to confirm it is you, and there is nothing '
              + 'to confirm with. Set one under your account first.'),
          ))
        : null,
    ),

    card('The company stamp', {
      note: `${stamps.rows.filter((s) => s.active).length} held`,
      actions: h('button.btn.btn-primary', { onclick: () => addStamp(reload) }, '+ Add a stamp'),
    },
      stamps.rows.filter((s) => s.active).length
        ? h('div.stamp-row', stamps.rows.filter((s) => s.active).map((s) => h('div.stamp-card',
          h('img', { src: s.image, alt: s.label }),
          h('div', h('strong', s.label), h('small.muted', ` · ${s.uploaded_by || ''}`)),
          h('button.btn-sm', {
            onclick: async () => {
              if (!window.confirm(`Remove the "${s.label}" stamp? Letters already stamped keep it.`)) return;
              await api.corrDeleteStamp(s.id);
              toast('Removed.');
              await reload();
            },
          }, 'Remove'),
        )))
        : h('p.muted', { style: { marginBottom: 0 } },
          'Photograph the rubber stamp on a white sheet, or export the seal from wherever it '
          + 'was drawn. A PNG with a transparent background sits best beside a signature.'),
    ),

    card('Who can sign for the property', { wide: true },
      table([
        { key: 'display_name', label: 'Name' },
        { key: 'job_title', label: 'Job title', format: (v) => v || h('span.muted', '—') },
        { key: 'login_name', label: 'Login', format: (v) => h('small.muted', v) },
        {
          key: 'has_signature',
          label: 'Signature saved',
          format: (v) => (v ? h('span.pill.good', 'Yes') : h('span.muted', 'draws each time')),
        },
      ], stamps.signatories, { empty: 'Nobody has saved one yet.' }),

      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'That somebody has a signature saved is useful to know. What it looks like is not shown '
        + 'here, and there is no route in the system that hands one person another person’s.'),
    ),
  );

  return host;
}

/**
 * The box that asks you to prove, again, that you are who the session says.
 *
 * Shared with the signing dialog on a letter, so the wording and the field
 * name cannot drift apart from what the server checks.
 */
export function confirmItIsYou(me) {
  if (me.method === 'none') {
    return h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div', h('div.alert-detail',
        'Your login has no password or PIN, so there is nothing to confirm with. '
        + 'Set one under your account first.')));
  }

  return h('div',
    field(me.method === 'password' ? 'Your password' : 'Your PIN',
      h('input', {
        type: 'password', name: 'confirm', required: true,
        autocomplete: 'current-password',
        inputmode: me.method === 'pin' ? 'numeric' : undefined,
      }),
      'Asked every time a signature is applied, because a session left open on a desk is not '
      + 'the same thing as you'),
  );
}

async function saveSignature(me, reload) {
  const pad = signaturePad({ height: 150 });

  const done = await formDialog({
    title: 'Save your signature',
    submitLabel: 'Save it',
    body: h('div',
      h('p.muted', 'Sign in the box with a finger or a mouse. It is stored against your login '
        + 'and used when you sign a letter.'),

      h('div.field-row',
        field('Your name, as it should read', h('input', {
          type: 'text', name: 'displayName', required: true, maxlength: 120,
          value: me.signatory?.displayName ?? '',
        })),
        field('Job title', h('input', {
          type: 'text', name: 'jobTitle', maxlength: 120,
          value: me.signatory?.jobTitle ?? '', placeholder: 'General Manager',
        })),
      ),

      pad.element,
      confirmItIsYou(me),
    ),
    onSubmit: async (form) => {
      const secret = String(form.get('confirm') ?? '');
      let proof = { pin: secret };
      if (me.method === 'password') {
        const { deriveLoginKey } = await import('../crypto.js');
        proof = {
          passwordKey: await deriveLoginKey(secret, me.salt.passwordSalt, me.salt.passwordIterations),
        };
      }
      return api.corrSaveMySignature({
        ...proof,
        displayName: form.get('displayName'),
        jobTitle: form.get('jobTitle'),
        ink: pad.read(),
      });
    },
  });

  if (done) { toast('Saved.', 'good'); await reload(); }
}

async function addStamp(reload) {
  let image = null;

  const preview = h('div');
  const picker = h('input', {
    type: 'file',
    accept: 'image/*',
    required: true,
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        image = await shrinkStamp(file);
        mount(preview, h('img', { src: image, style: { maxHeight: '7rem', marginTop: '.5rem' } }));
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  });

  const done = await formDialog({
    title: 'Add the company stamp',
    submitLabel: 'Save it',
    body: h('div',
      h('p.muted', 'Photograph the rubber stamp on a clean white sheet, or export the seal as a '
        + 'PNG. A transparent background sits best beside a signature.'),
      field('Call it', h('input', {
        type: 'text', name: 'label', required: true, maxlength: 80,
        placeholder: 'Company seal',
      })),
      field('Image', picker),
      preview,
    ),
    onSubmit: async (form) => {
      if (!image) throw new Error('Choose an image first.');
      return api.corrSaveStamp({ label: form.get('label'), image });
    },
  });

  if (done) { toast('Saved.', 'good'); await reload(); }
}

/**
 * A stamp, made small enough to sit in a row.
 *
 * A photograph of a rubber stamp is four megabytes and needs to be about four
 * hundred pixels. Shrinking here rather than refusing there is the difference
 * between a feature people use and one they give up on.
 */
async function shrinkStamp(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  // PNG rather than JPEG: a stamp is usually a shape on a white or transparent
  // ground, and JPEG puts a grey halo round exactly that.
  const url = canvas.toDataURL('image/png');
  if (url.length > 480_000) {
    throw new Error('That image is too large even after shrinking. Crop it to the stamp itself.');
  }
  return url;
}
