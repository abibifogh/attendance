import { api } from '../api.js';
import { navigate } from '../app.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { emptyState } from './components.js';

/**
 * Your say: the feedback survey on somebody's own phone, one question at a
 * time, and You said, we did from the last round.
 *
 * Nothing is said about names unless the round is anonymous; then the survey
 * says so, because then it is true.
 */

const WORDS = ['Very bad', 'Bad', 'Okay', 'Good', 'Very good'];
const STATUS = { doing: 'Doing now', done: 'Done', looking: 'Looking at it', keeping: 'Keeping' };

export async function renderMyFeedback() {
  const host = h('div.my-fb');
  const data = await api.myFeedback();
  const round = data.round;

  const said = data.said ? saidCard(data.said) : null;

  if (!round || round.done) {
    mount(host,
      h('div.page-head', h('h1', 'Your say')),
      round?.done
        ? h('div.card.my-fb-done', h('strong', 'Thank you. That is in.'),
          h('p.muted', `You have answered the ${round.label} round. When it closes you will hear what the team said and what is being done about it.`))
        : emptyState('Nothing to answer just now', 'The feedback comes round every few months, and your phone will tell you.'),
      said);
    return host;
  }

  const qs = round.questions;
  const answers = {};
  let step = 0;
  const body = h('div.my-fb-body');

  const send = async () => {
    try {
      await api.answerFeedback({ roundId: round.id, answers });
      toast('Thank you. That is in.', 'good');
      renderMyFeedback().then((el) => host.replaceWith(el));
    } catch (err) { toast(err.message, 'bad'); }
  };

  const draw = () => {
    const q = qs[step];
    const a = answers[q.id] ?? (answers[q.id] = {});
    const last = step === qs.length - 1;
    mount(body,
      h('div.my-fb-progress',
        h('span', `${step + 1} of ${qs.length}`),
        h('div.my-fb-dots', qs.map((_, i) => h('i', { class: i < step ? 'is-done' : i === step ? 'is-now' : '' })))),
      h('span.my-fb-area', q.area),
      h('h2.my-fb-q', q.text),
      q.kind === 'scale'
        ? h('div.my-fb-faces', WORDS.map((w, i) => h('button', {
          type: 'button',
          class: a.score === i + 1 ? `my-fb-face on f${i + 1}` : `my-fb-face f${i + 1}`,
          'aria-pressed': String(a.score === i + 1),
          onclick: () => { a.score = i + 1; draw(); },
        }, h('b', String(i + 1)), w)))
        : null,
      q.kind === 'recommend'
        ? h('div.my-fb-choices', [['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']].map(([v, l]) => h('button', {
          type: 'button', class: a.choice === v ? 'my-fb-choice on' : 'my-fb-choice', 'aria-pressed': String(a.choice === v),
          onclick: () => { a.choice = v; draw(); },
        }, l)))
        : null,
      h('label.my-fb-why', q.kind === 'text' ? 'Your answer' : 'Anything to add? (optional)',
        h('textarea', {
          rows: q.kind === 'text' ? 5 : 3, maxlength: 1000, placeholder: q.kind === 'text' ? '' : 'What would make it better',
          oninput: (e) => { a.comment = e.target.value; },
        }, a.comment ?? '')),
      h('div.my-fb-nav',
        step > 0 ? h('button.btn', { type: 'button', onclick: () => { step -= 1; draw(); } }, 'Back') : h('span'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => { if (last) send(); else { step += 1; draw(); } } }, last ? 'Send' : 'Next')));
  };
  draw();

  mount(host,
    h('div.page-head', h('div', h('h1', 'Your say'), h('div.sub', `${round.label} · open until ${fmtDay(round.closesOn)}`))),
    round.anonymous
      ? h('div.card.my-fb-anon', 'This round is anonymous. Your name is not kept with your answers, and nobody can see who said what.')
      : null,
    h('div.card', body),
    said);
  return host;
}

function saidCard(said) {
  return h('section.card.my-fb-said',
    h('div', h('strong', 'You said, we did'), h('div.muted', `From the ${said.label} round${said.answered != null ? ` · ${said.answered} of ${said.asked} answered` : ''}`)),
    (said.actions ?? []).map((a) => h('div', { class: `my-fb-said-item is-${a.status}` },
      h('span.my-fb-said-status', STATUS[a.status] ?? a.status),
      h('strong', a.title),
      a.body ? h('p', a.body) : null)));
}

/** The card on My shifts while a round is waiting for them. */
export function myFeedbackCard() {
  const host = h('div.my-fb-card-host');
  api.myFeedback().then((data) => {
    const round = data.round;
    if (!round || round.done) return;
    mount(host, h('div.card.my-fb-invite',
      h('span.my-fb-invite-label', `Your say · ${round.label.replace(/ \d{4}$/, '')}`),
      h('strong', 'How is work going? A few quick questions.'),
      h('span', `Open until ${fmtDay(round.closesOn)}.${round.anonymous ? ' This round is anonymous.' : ''}`),
      h('button.btn.btn-primary', { type: 'button', onclick: () => navigate('my-feedback') }, 'Start')));
  }).catch(() => {});
  return host;
}
