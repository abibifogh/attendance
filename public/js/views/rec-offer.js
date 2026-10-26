import { api } from '../api.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * Making an offer, from the candidate's page.
 *
 * The offer goes with the contract it would become: the office fills in the
 * job and the terms, HIVE renders the contract from a template, and the
 * candidate reads it and accepts by signing it. Nothing goes on the books
 * until they have, and then Take them on carries the signed contract onto
 * their new record.
 */

const first = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';
const stampOf = (at) => {
  const text = String(at ?? '');
  return text ? `${fmtDay(text.slice(0, 10))}, ${text.slice(11, 16)}` : '';
};
const dayOf = (at) => (at ? fmtDay(String(at).slice(0, 10), { withYear: true }) : '');

/** Words for the offer lines on the trail. */
export const OFFER_SAYS = {
  offer_made: 'An offer was made',
  offer_sent: 'The offer was sent',
  offer_reminded: 'The offer was sent again',
  offer_opened: 'They opened the offer',
  offer_code: 'They asked for a code to sign',
  offer_accepted: 'They accepted and signed',
  offer_declined: 'They declined the offer',
  offer_withdrawn: 'The offer was withdrawn',
};

/**
 * The offer card: make one, or where the one made stands. Shown from the
 * interview onwards, and whenever an offer has been made.
 */
export function offerCard(data, reload) {
  const person = data.candidate;
  const offers = data.offers ?? [];
  const latest = offers[0] ?? null;
  const state = latest?.state ?? null;
  const name = first(person.name);
  if (state === 'accepted') return null;

  const actions = [];
  const make = (label, primary = true) => h(primary ? 'button.btn.btn-primary' : 'button.btn-sm', {
    onclick: () => makeOffer(data, reload),
  }, label);

  let body;
  if (!latest || state === 'withdrawn') {
    body = [
      h('p.muted', `Send ${name} the offer and the contract to read. They accept by signing it on their phone, or `
        + 'decline with a reason. Once they have signed, taking them on carries the signed contract onto their staff record.'),
      h('ul.rec-next',
        h('li', 'Their pay, start date and terms go into the contract from the template.'),
        h('li', person.email ? `It goes by email to ${person.email}${person.phone ? ', or by text' : ''}.`
          : person.phone ? `It goes by text to ${person.phone}.` : 'They have no email or phone on file, so you will get a link to send yourself.'),
        h('li', 'The offer stays open for the days you choose, with a reminder before it runs out.')),
      latest ? h('p.muted', { style: { fontSize: '.85rem' } }, `The last offer was withdrawn ${dayOf(latest.withdrawnAt)}.`) : null,
    ];
    if (data.canManage) actions.push(make('Make an offer'));
  } else if (state === 'sent' || state === 'expired') {
    body = [
      h('p', state === 'expired'
        ? h('span', h('strong', `The offer ran out on ${dayOf(latest.expiresAt)}`), ` without an answer from ${name}.`)
        : h('span', h('strong', `Offer sent ${dayOf(latest.createdAt)}`), `. Open until ${dayOf(latest.expiresAt)}.`)),
      offerFacts(latest),
      h('p.muted', latest.openedAt ? `${name} opened it on ${stampOf(latest.openedAt)}.` : `${name} has not opened it yet.`),
    ];
    actions.push(h('button.btn-sm', { onclick: () => readOffer(latest.id) }, 'Read the contract'));
    if (data.canManage) {
      actions.push(h('button.btn-sm', { onclick: () => resend(latest, person, reload) },
        state === 'expired' ? 'Open it again and send' : 'Send it again'));
      actions.push(h('button.btn-sm', { onclick: () => withdraw(latest, reload) }, 'Withdraw'));
      actions.push(make('Make a new offer', false));
    }
  } else if (state === 'declined') {
    body = [
      h('p', h('strong', `${name} declined the offer`), ` on ${dayOf(latest.declinedAt)}.`),
      latest.declineReason || latest.declineNote
        ? h('blockquote.rec-offer-why', [latest.declineReason, latest.declineNote].filter(Boolean).join(': '))
        : h('p.muted', 'No reason given.'),
    ];
    actions.push(h('button.btn-sm', { onclick: () => readOffer(latest.id) }, 'Read what was offered'));
    if (data.canManage) actions.push(make('Make a new offer', false));
  }

  return card(state ? 'The offer' : 'Make an offer', {
    wide: true,
    cls: `rec-offer${!latest || state === 'withdrawn' ? ' is-new' : ''}`,
    note: state === 'sent' ? 'Waiting for their answer' : state === 'expired' ? 'Ran out' : state === 'declined' ? 'Declined'
      : 'Nothing goes on the books until they say yes',
  },
  ...body,
  actions.length ? h('div.btn-row', ...actions) : null);
}

function offerFacts(offer) {
  const rows = [
    ['Job', offer.jobTitle],
    ['Starts', offer.startDate ? fmtDay(offer.startDate, { withYear: true }) : null],
    ['Pay', offer.salary],
    ['Probation', offer.probation],
    ['Sent', offer.sentBy === 'link' ? 'As a link you passed on' : offer.sentBy === 'text' ? 'By text' : 'By email'],
  ].filter(([, v]) => v);
  return h('div.rec-offer-facts', rows.map(([k, v]) => h('div', h('b', k), h('span', v))));
}

/** The accepted offer, at the top of the Take them on card. */
export function acceptedBanner(offer, name) {
  return h('div.rec-offer-yes',
    h('span', h('b', `${first(name)} accepted the offer`),
      ` and signed the contract on ${stampOf(offer.signedAt)}`,
      offer.signerCheck && offer.signerCheck !== 'offer link' ? `, with a code sent by ${offer.signerCheck.replace(' code', '')}.` : '.'),
    h('button.btn-sm', { onclick: () => readOffer(offer.id) }, 'Read the signed contract'));
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

const ALWAYS = ['salary', 'probation', 'notice'];
const UNKNOWN = [
  ['employeeNo', 'employee_no', 'Employee number', 'If you know it already. Otherwise the contract says it is given on joining.'],
  ['address', 'address', 'Their home address', 'Otherwise the contract says “the address given on joining”.'],
  ['idType', 'id_type', 'Their ID document', 'For example: Ghana Card GHA-000000000-0'],
];

async function makeOffer(data, reload) {
  const person = data.candidate;
  const setup = await api.recOfferSetup(person.id);
  if (!setup.templates.length) {
    toast('There are no contract templates yet. Add one under People › Templates first.', 'bad');
    return;
  }
  const asked = new Map(setup.asked.map((a) => [a.key, a]));
  // Where there is more than one company, each template says whose it is:
  // the company a template is for makes the offer and takes them on.
  const companyName = new Map((setup.companies ?? []).map((c) => [c.id, c.name]));
  const several = (setup.companies ?? []).length > 1;
  const templateSelect = h('select', { name: 'templateId', required: true },
    setup.templates.map((t) => h('option', { value: t.id },
      several && t.companyId ? `${t.name} (${companyName.get(t.companyId) ?? 'one company'})` : t.name)));
  const employer = h('p.muted', { style: { fontSize: '.82rem', margin: '-.3rem 0 0' } });
  const drawEmployer = () => {
    const t = setup.templates.find((x) => String(x.id) === templateSelect.value);
    const id = t?.companyId ?? setup.companies?.[0]?.id;
    employer.textContent = several ? `The employer named in it, and the company that takes them on: ${companyName.get(id) ?? ''}.` : '';
    employer.hidden = !several;
  };
  templateSelect.addEventListener('change', drawEmployer);
  drawEmployer();
  const extras = h('div.rec-offer-extras');
  const drawExtras = () => {
    const uses = new Set(setup.templates.find((t) => String(t.id) === templateSelect.value)?.uses ?? []);
    const more = setup.asked.filter((a) => uses.has(a.key) && !ALWAYS.includes(a.key) && a.key !== 'note');
    const unknown = UNKNOWN.filter(([, key]) => uses.has(key));
    mount(extras,
      more.length || unknown.length ? h('p.muted', { style: { fontSize: '.82rem', margin: '0 0 .2rem' } }, 'This template also asks for:') : null,
      ...more.map((a) => field(a.label, h('input', {
        type: a.key.endsWith('_date') ? 'date' : 'text', name: `v_${a.key}`, maxlength: 300, placeholder: a.fallback ?? '',
      }), a.fallback ? `Left empty: “${a.fallback}”` : null)),
      ...unknown.map(([name, , label, hint]) => field(label, h('input', { type: 'text', name, maxlength: name === 'address' ? 300 : 120 }), hint)));
  };
  templateSelect.addEventListener('change', () => { drawExtras(); mount(preview, null); });
  drawExtras();

  const preview = h('div.rec-offer-preview');
  const readBody = (form) => {
    const values = {};
    for (const key of ALWAYS) values[key] = form.get(`v_${key}`) || '';
    for (const a of setup.asked) if (form.has(`v_${a.key}`)) values[a.key] = form.get(`v_${a.key}`) || '';
    return {
      templateId: form.get('templateId'),
      jobTitle: form.get('jobTitle'),
      department: form.get('department'),
      startDate: form.get('startDate'),
      employeeNo: form.get('employeeNo') || '',
      address: form.get('address') || '',
      idType: form.get('idType') || '',
      values,
      message: form.get('message'),
      days: form.get('days'),
      sendBy: form.get('sendBy'),
      remind: form.get('remind') === 'on',
    };
  };

  const how = [
    ['email', person.email ? `By email to ${person.email}` : 'By email (no address on file)', Boolean(person.email)],
    ['text', person.phone ? `By text to ${person.phone}` : 'By text (no number on file)', Boolean(person.phone)],
    ['link', 'Make the link, I will send it myself', true],
  ];
  const reachNote = [
    person.email && !setup.reach.email ? 'Email is not set up yet, so an email offer gives you the link to send instead.' : null,
    person.phone && !setup.reach.text ? 'Texts are not set up yet.' : null,
  ].filter(Boolean).join(' ');

  let form;
  const done = await formDialog({
    title: `Make an offer to ${person.name}`,
    submitLabel: 'Send the offer',
    wide: true,
    body: form = h('div.rec-offer-form',
      h('h3.rec-offer-sec', 'The job'),
      h('div.grid.grid-2',
        field('Job title', h('input', { type: 'text', name: 'jobTitle', maxlength: 80, required: true, value: setup.defaults.jobTitle })),
        field('Department', h('input', { type: 'text', name: 'department', maxlength: 80, value: setup.defaults.department }))),
      h('div.grid.grid-3',
        field('Starts on', h('input', { type: 'date', name: 'startDate', required: true })),
        field(asked.get('probation')?.label ?? 'Probation', h('input', { type: 'text', name: 'v_probation', maxlength: 300, placeholder: asked.get('probation')?.fallback ?? '' })),
        field(asked.get('notice')?.label ?? 'Notice period', h('input', { type: 'text', name: 'v_notice', maxlength: 300, placeholder: asked.get('notice')?.fallback ?? '' }))),
      field(asked.get('salary')?.label ?? 'Remuneration', h('input', {
        type: 'text', name: 'v_salary', maxlength: 300, placeholder: 'For example: GH₵ [amount] a month, paid on the last working day',
      }), 'Shown to them on the offer and written into the contract.'),

      h('h3.rec-offer-sec', 'The contract'),
      field('Template', templateSelect),
      employer,
      extras,
      h('p.muted', { style: { fontSize: '.82rem', margin: 0 } },
        'Their name, the job, the start date and the property’s details are filled in from what HIVE already knows. ',
        h('button.link-button', {
          type: 'button',
          onclick: async () => {
            const formEl = form.closest('form');
            try {
              const out = await api.recOfferPreview(person.id, readBody(new FormData(formEl)));
              mount(preview, h('pre.contract-text', out.body));
            } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'Read the contract as it will go')),
      preview,

      h('h3.rec-offer-sec', 'The offer'),
      field('A line to them', h('textarea', { name: 'message', rows: 3, maxlength: 600, placeholder: 'Thank you for coming in last week…' })),
      h('div.grid.grid-2',
        field('Open for', h('select', { name: 'days' },
          [[3, '3 days'], [7, '7 days'], [14, '14 days']].map(([v, l]) => h('option', { value: v, selected: v === 7 }, l)))),
        field('Send it', h('select', { name: 'sendBy' },
          how.map(([v, l, ok]) => h('option', { value: v, disabled: !ok, selected: v === setup.defaults.sendBy }, l))),
        reachNote || null)),
      h('label.tickline',
        h('input', { type: 'checkbox', name: 'remind', checked: true }),
        h('span', 'Remind them two days before it runs out')),
      h('p.muted', { style: { fontSize: '.82rem', margin: 0 } },
        'They read the contract and accept by signing it, with a code sent to them first. You countersign for the property when you take them on.'),
    ),
    onSubmit: async (formData) => api.recMakeOffer(person.id, readBody(formData)),
  });
  if (!done) return;

  if (done.delivered?.sent) {
    toast(`Offer sent by ${done.delivered.how} to ${done.delivered.to}.`, 'good');
  } else {
    await copyDialog(person, done, done.delivered?.reason);
  }
  await reload();
}

async function copyDialog(person, out, reason) {
  await formDialog({
    title: 'Send them the offer yourself',
    submitLabel: 'Done',
    body: h('div',
      reason && reason !== 'Send the link yourself.'
        ? h('div.alert.warn', h('span.alert-icon', '⚠️'), h('div', h('div.alert-detail', `HIVE did not send it: ${reason}`)))
        : null,
      h('p.muted', 'Copy this message and send it however you talk to them. The link is private to them.'),
      h('textarea.link-box', { rows: 6, readonly: true, onclick: (e) => e.target.select() }, out.message),
      h('div.btn-row',
        h('button.btn.btn-primary', {
          type: 'button',
          onclick: async (e) => {
            try { await navigator.clipboard.writeText(out.message); e.target.textContent = 'Copied ✓'; } catch { toast('Select the text above and copy it.', 'bad'); }
          },
        }, 'Copy the message'),
        person.phone
          ? h('a.btn-sm', {
            href: `https://wa.me/${String(person.phone).replace(/\D/g, '')}?text=${encodeURIComponent(out.message)}`,
            target: '_blank', rel: 'noopener',
          }, 'Send on WhatsApp')
          : null)),
    onSubmit: async () => true,
  });
}

async function resend(offer, person, reload) {
  const done = await formDialog({
    title: 'Send the offer again',
    submitLabel: 'Send it',
    body: h('div',
      offer.state === 'expired'
        ? field('Open it again for', h('select', { name: 'days' },
          [[3, '3 days'], [7, '7 days'], [14, '14 days']].map(([v, l]) => h('option', { value: v, selected: v === 7 }, l))))
        : h('p.muted', `It stays open until ${dayOf(offer.expiresAt)}, on the same link.`),
      field('Send it', h('select', { name: 'sendBy' },
        [['email', person.email ? `By email to ${person.email}` : 'By email (no address on file)', Boolean(person.email)],
          ['text', person.phone ? `By text to ${person.phone}` : 'By text (no number on file)', Boolean(person.phone)],
          ['link', 'Give me the link to send myself', true]]
          .map(([v, l, ok]) => h('option', { value: v, disabled: !ok, selected: v === offer.sentBy }, l))))),
    onSubmit: async (form) => api.recResendOffer(offer.id, {
      sendBy: form.get('sendBy'),
      days: form.get('days') || undefined,
    }),
  });
  if (!done) return;
  if (done.delivered?.sent) toast(`Sent again by ${done.delivered.how}.`, 'good');
  else await copyDialog(person, done, done.delivered?.reason);
  await reload();
}

async function withdraw(offer, reload) {
  const done = await formDialog({
    title: 'Withdraw the offer?',
    submitLabel: 'Withdraw it',
    body: h('div',
      h('p.muted', 'Their link stops working and shows that the offer is no longer open. Nothing is sent to them.'),
      field('Why (kept on the trail)', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
    onSubmit: async (form) => api.recWithdrawOffer(offer.id, form.get('note')),
  });
  if (done) { toast('Offer withdrawn.'); await reload(); }
}

/** The offer and its contract, as it went, with the signature under it once they have signed. */
export async function readOffer(id) {
  const { offer, events } = await api.recOffer(id);
  await formDialog({
    title: offer.title,
    submitLabel: 'Close',
    wide: true,
    body: h('div.rec-offer-read',
      offer.intact ? null : h('div.alert.high', h('span.alert-icon', '⛔'),
        h('div', h('div.alert-title', 'The words no longer match the fingerprint'),
          h('div.alert-detail', 'Do not rely on this text. Tell whoever looks after the system.'))),
      h('pre.contract-text', offer.body),
      offer.signedAt
        ? h('div.rec-offer-sig',
          offer.ink ? h('img', { src: offer.ink, alt: `Signature of ${offer.signerName}` }) : null,
          h('div', h('b', offer.signerName), h('br'),
            h('small.muted', `Signed ${stampOf(offer.signedAt)}${offer.signerCheck ? ` · ${offer.signerCheck}` : ''}${offer.signerIp ? ` · ${offer.signerIp}` : ''}`)))
        : null,
      h('p.mono', { style: { fontSize: '.75rem', overflowWrap: 'anywhere' } }, `Fingerprint ${offer.hash}`),
      events.length
        ? h('ol.rec-trail', events.map((e) => h('li',
          h('div.rec-trail-what', h('strong', OFFER_SAYS[e.kind] ?? e.kind)),
          e.detail ? h('div.rec-trail-detail', e.detail) : null,
          h('div.rec-trail-who', h('small.muted', `${e.actor ?? ''}${e.actor ? ' · ' : ''}${stampOf(e.at)}`)))))
        : null),
    onSubmit: async () => true,
  });
}
