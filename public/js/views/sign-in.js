import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { navigate } from '../app.js';
import { field, formDialog } from './att-shared.js';
import { confirmItIsYou } from './letter-signing.js';
import { proofFrom } from './letter.js';
import { signingScreen } from '../signing-screen.js';

/**
 * Signing a document from a HIVE login: a member of staff whose turn it is,
 * or whoever signs for the property. No code: they are signed in. Signing for
 * the property asks for their own PIN or password, as every signature applied
 * for the property does.
 */
export async function renderSignIn(params = {}) {
  const host = h('div.sign-in-page');
  const id = Number(params.id);
  let packet;
  try {
    packet = await api.docToSign(id);
  } catch (err) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'Nothing to sign'), h('div.sub', err.message))),
      h('button.btn', { type: 'button', onclick: () => navigate('signing') }, '‹ Signatures'));
    return host;
  }

  const forProperty = packet.you.as === 'property';
  const me = forProperty ? await api.corrMe().catch(() => ({ method: 'none' })) : null;

  const screen = await signingScreen({
    packet,
    fileUrl: packet.fileUrl,
    savedSignature: packet.you.savedSignature,
    stamps: packet.stamps ?? [],
    submit: (body) => api.docSignInHive(id, body),
    beforeSubmit: forProperty
      ? () => formDialog({
        title: 'Confirm it is you',
        submitLabel: 'Sign it',
        body: h('div',
          h('p.muted', `You are signing “${packet.doc.title}” for the property.`),
          field('Signs as', h('input', { type: 'text', name: 'capacity', value: packet.you.capacity || '', maxlength: 120 })),
          confirmItIsYou(me)),
        onSubmit: async (form) => ({ ...(await proofFrom(form, me)), capacity: String(form.get('capacity') ?? '') }),
      })
      : null,
    onDone: () => {
      toast('Signed. Thank you.', 'good');
      navigate('signing');
    },
  });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', packet.doc.title),
        h('div.sub', [packet.doc.reference, forProperty ? 'Signing for the property' : 'Your turn to sign'].filter(Boolean).join(' · '))),
      h('div.btn-row', h('button.btn-sm', { type: 'button', onclick: () => navigate('signing') }, '‹ Signatures'))),
    screen);
  return host;
}
