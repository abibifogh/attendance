import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * People › Feedback: what staff are saying.
 *
 * The round's numbers at the top, each area with its score and change, the
 * comments read into themes, what HIVE would do first, and You said, we did.
 * An admin sees who said what in a round that was not anonymous.
 */

const STATUS = {
  doing: ['Doing now', 'is-doing'],
  done: ['Done', 'is-done'],
  looking: ['Looking at it', 'is-looking'],
  keeping: ['Keeping', 'is-keeping'],
};
const tone = (v) => (v == null ? 'is-none' : v >= 3.8 ? 'is-good' : v >= 3.2 ? 'is-mid' : 'is-low');
const delta = (d) => (d == null ? '' : d === 0 ? '—' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}`);

export async function renderFeedback(params = {}) {
  const host = h('div.fb-page');
  const data = await api.feedback(params.round ? { round: params.round } : {});
  const reload = (next = {}) => {
    const merged = { ...params, ...next };
    replaceParams('feedback', { round: merged.round ?? null });
    renderFeedback(merged).then((el) => host.replaceWith(el));
  };
  const act = async (fn, okText) => {
    try { await fn(); if (okText) toast(okText, 'good'); reload(); } catch (err) { toast(err.message, 'bad'); }
  };

  const round = data.round;
  const r = data.result;

  const openNow = async () => {
    const { people } = await api.feedbackPeople();
    const done = await choosePeople({
      title: 'Send a round now',
      submitLabel: 'Send it',
      people,
      ticked: (p) => p.eligible,
      intro: `Ticked: everybody employed ${data.settings.minServiceDays} days or more. Untick anybody, or tick somebody newer. `
        + `Only these are asked, reminded and shown the survey. It stays open ${data.settings.openDays} days.`,
      extra: data.isAdmin
        ? h('label.fb-switch', h('input', { type: 'checkbox', name: 'anonymous', checked: data.settings.anonymous }),
          h('span', h('strong', 'Anonymous'), h('small.muted', 'No name is kept with any answer, and staff are told so on the survey.')))
        : null,
      send: (staffIds, form) => api.openFeedbackRound({ staffIds, anonymous: data.isAdmin ? form.get('anonymous') === 'on' : undefined }),
    });
    if (done) { toast(`Sent to ${done.asked} ${done.asked === 1 ? 'person' : 'people'}.`, 'good'); reload({ round: done.id }); }
  };

  const head = h('div.page-head',
    h('div',
      h('h1', 'What staff are saying'),
      h('div.sub', round
        ? `${round.label} · ${round.status === 'open' ? `open until ${fmtDay(round.closesOn)}` : `closed ${fmtDay(round.closesOn)}`}`
          + (round.anonymous ? ' · anonymous' : data.canSeeNames ? ' · names kept (admins only)' : '')
        : 'Nothing asked yet')),
    h('div.btn-row',
      data.rounds.length > 1
        ? h('div.seg', data.rounds.slice(0, 4).reverse().map((x) => h('button', {
          type: 'button', class: round?.id === x.id ? 'active' : '', onclick: () => reload({ round: x.id }),
        }, x.label.replace(/ \d{4}$/, ''))))
        : null,
      data.canManage && !data.rounds.some((x) => x.status === 'open')
        ? h('button.btn-sm', { type: 'button', onclick: openNow }, 'Send a round now')
        : null));

  if (!round) {
    mount(host, head, emptyState('No feedback yet',
      data.nextRound ? `The first round opens by itself on ${fmtDay(data.nextRound, { withYear: true })}.` : 'Rounds are switched off in the schedule.'));
    return host;
  }

  // ---- a round still open: how many have answered ---------------------
  if (round.status === 'open') {
    const pct = round.asked ? Math.round((round.answered / round.asked) * 100) : 0;
    mount(host, head,
      h('section.fb-card.fb-open',
        h('span.fb-label', 'Answering now'),
        h('div.fb-big', h('strong', String(round.answered)), h('span', ` of ${round.asked} have answered · ${pct}%`)),
        h('div.fb-track', h('i', { style: { width: `${pct}%` } })),
        h('p.muted', `Reminders go to those who have not on the third and eighth days and the last. `
          + `The results come the morning after it closes on ${fmtDay(round.closesOn, { withYear: true })}.`),
        data.canManage
          ? h('div.btn-row', h('button.btn-sm', {
            type: 'button',
            onclick: () => { if (window.confirm('Close it now and read the answers?')) act(() => api.closeFeedbackRound(round.id), 'Closed and read.'); },
          }, 'Close it now'))
          : null));
    return host;
  }

  if (!r) {
    mount(host, head, emptyState('Not read yet', 'The answers are read when the round closes.'),
      data.canManage ? h('button.btn-sm', { type: 'button', onclick: () => act(() => api.analyseFeedbackRound(round.id), 'Read again.') }, 'Read the answers') : null);
    return host;
  }
  if (r.tooFew) {
    mount(host, head, emptyState('Too few answers to show',
      `Fewer than ${r.minGroup} people in ${r.department || 'your department'} answered, so nothing is shown.`));
    return host;
  }

  // ---- the numbers ------------------------------------------------------
  const neg = (r.themes ?? []).filter((t) => t.tone === 'negative').sort((a, b) => b.comments.length - a.comments.length)[0];
  const tiles = h('div.fb-tiles',
    h('div.fb-card', h('span.fb-label', 'Answered'),
      h('div.fb-big', h('strong', String(r.answered)), h('span', ` of ${r.asked}${r.asked ? ` · ${Math.round((r.answered / r.asked) * 100)}%` : ''}`)),
      h('div.fb-track', h('i', { style: { width: `${r.asked ? Math.round((r.answered / r.asked) * 100) : 0}%` } }))),
    h('div.fb-card', h('span.fb-label', 'How it feels to work here'),
      h('div.fb-big', h('strong', r.feel?.score != null ? r.feel.score.toFixed(1) : '—'), h('span', ' of 5 '),
        r.feel?.delta != null ? h('em', { class: r.feel.delta >= 0 ? 'is-up' : 'is-down' }, delta(r.feel.delta)) : null)),
    h('div.fb-card', h('span.fb-label', 'Would recommend working here'),
      r.recommend?.total
        ? h('div.fb-big', h('strong', `${r.recommend.score > 0 ? '+' : ''}${r.recommend.score}`),
          h('span', ` ${r.recommend.yes} yes · ${r.recommend.maybe} maybe · ${r.recommend.no} no`))
        : h('div.fb-big', h('span', 'Not asked'))),
    h('div.fb-card.fb-needs', h('span.fb-label', 'Needs you'),
      neg ? h('p', h('strong', neg.title), ` came up in ${neg.comments.length} comment${neg.comments.length === 1 ? '' : 's'}.`)
        : h('p', 'Nothing stands out as a complaint this round.')));

  // ---- area by area, and the one picked ------------------------------
  const areas = r.areas ?? [];
  let picked = Math.max(0, areas.findIndex((a) => a.score != null && a.score === Math.min(...areas.map((x) => x.score ?? 9))));
  const areaList = h('div.fb-areas');
  const areaDetail = h('div.fb-detail');
  const drawAreas = () => {
    mount(areaList, areas.map((a, i) => h('button', {
      type: 'button', class: i === picked ? 'fb-area on' : 'fb-area',
      onclick: () => { picked = i; drawAreas(); },
    },
    h('span.fb-area-name', a.area),
    h('span.fb-track', h('i', { class: tone(a.score), style: { width: `${((a.score ?? 0) / 5) * 100}%` } })),
    h('strong', a.score != null ? a.score.toFixed(1) : '—'),
    h('em', { class: a.delta > 0 ? 'is-up' : a.delta < 0 ? 'is-down' : '' }, delta(a.delta)))));
    const a = areas[picked];
    if (!a) { mount(areaDetail); return; }
    const quotes = (r.comments ?? []).filter((c) => c.area === a.area).slice(0, 4);
    mount(areaDetail,
      h('span.fb-label', a.area),
      h('div.fb-headline', a.headline || `${a.score != null ? a.score.toFixed(1) : '—'} of 5 from ${a.n} answer${a.n === 1 ? '' : 's'}`),
      h('p.muted', a.text),
      (a.byDepartment ?? []).length
        ? [h('span.fb-label', 'By department'),
          h('div.fb-depts', a.byDepartment.map((d) => h('div',
            h('div', { class: `fb-cell ${tone(d.score)}` }, d.score != null ? d.score.toFixed(1) : `under ${data.settings.minGroup}`),
            h('small', d.department))))]
        : null,
      quotes.length ? [h('span.fb-label', 'In their words'), quotes.map(quoteEl)] : h('p.muted', 'No comments on this one.'));
  };
  const quoteEl = (c) => h('div', { class: c.sensitive ? 'fb-quote is-sensitive' : 'fb-quote' },
    `“${c.text}”`,
    h('small', [c.name, c.department, c.score != null ? `scored ${c.score} of 5` : null, c.choice ? `would recommend: ${c.choice}` : null]
      .filter(Boolean).join(' · ') || 'department not shown'));
  drawAreas();

  // ---- themes -----------------------------------------------------------
  const themes = r.themes ?? [];
  let theme = 0;
  const themeList = h('div.fb-themes');
  const themeDetail = h('div.fb-detail');
  const byIndex = new Map((r.comments ?? []).map((c) => [c.i, c]));
  const drawThemes = () => {
    mount(themeList, themes.map((t, i) => {
      const pos = t.tone === 'positive' ? 100 : t.tone === 'negative' ? 0 : 50;
      return h('button', { type: 'button', class: i === theme ? 'fb-theme on' : 'fb-theme', onclick: () => { theme = i; drawThemes(); } },
        h('span', t.title), h('strong', String(t.comments.length)),
        h('span.fb-tone', h('i.is-pos', { style: { width: `${pos}%` } }), h('i.is-neg', { style: { width: `${100 - pos}%` } })));
    }));
    const t = themes[theme];
    mount(themeDetail, t
      ? [h('span.fb-label', `${t.title} · ${t.comments.length} comment${t.comments.length === 1 ? '' : 's'}`),
        t.summary ? h('div.fb-headline', t.summary) : null,
        t.comments.map((i) => byIndex.get(i)).filter(Boolean).map(quoteEl)]
      : h('p.muted', 'No comments this round.'));
  };
  drawThemes();

  // ---- You said, we did -------------------------------------------------
  const saidEl = saidEditor(data, round, r, act);

  const sensitive = (r.comments ?? []).filter((c) => c.sensitive);

  mount(host, head,
    tiles,
    h('div.fb-two',
      h('section.fb-card', h('div.fb-card-head', h('strong', 'Area by area'), h('span.muted', 'Average of 1 to 5 · change on the round before')), areaList),
      h('section.fb-card', areaDetail)),
    h('div.fb-two',
      h('section.fb-card', h('div.fb-card-head', h('strong', 'In their own words'),
        h('span.muted', `${(r.comments ?? []).length} comments, sorted ${r.by === 'ai' ? 'into themes by HIVE' : 'by area'}`)), themeList),
      h('section.fb-card', themeDetail)),
    sensitive.length && data.canManage
      ? h('section.fb-card.fb-sensitive', h('span.fb-label', 'Needs care'),
        h('p', `${sensitive.length} comment${sensitive.length === 1 ? ' describes' : 's describe'} harassment, abuse or danger. `
          + 'Follow the grievance procedure.'), sensitive.map(quoteEl))
      : null,
    (r.actions ?? []).length && data.canManage
      ? h('section.fb-card', h('span.fb-label', 'What HIVE would do first'),
        r.actions.map((a, i) => h('p', h('strong', `${i + 1}. ${a.title}.`), ` ${a.why}`)))
      : null,
    saidEl);
  return host;
}

/** You said, we did: the list, edited in place, and sent to everybody. */
function saidEditor(data, round, r, act) {
  if (!data.canManage) return null;
  let rows = (data.actions ?? []).map((a) => ({ ...a }));
  if (!rows.length && (r.actions ?? []).length) rows = r.actions.map((a) => ({ status: 'doing', title: a.title, body: a.why }));
  const list = h('div.fb-said-list');
  const draw = () => mount(list,
    rows.map((row, i) => h('div.fb-said-row',
      h('select', { 'aria-label': 'Where it stands', onchange: (e) => { row.status = e.target.value; } },
        Object.entries(STATUS).map(([k, [label]]) => h('option', { value: k, selected: row.status === k }, label))),
      h('div.fb-said-text',
        h('input', { type: 'text', value: row.title ?? '', placeholder: 'What is being done', maxlength: 160, oninput: (e) => { row.title = e.target.value; } }),
        h('textarea', { rows: 2, placeholder: 'A line on why, for staff', maxlength: 600, oninput: (e) => { row.body = e.target.value; } }, row.body ?? '')),
      h('button.btn-sm', { type: 'button', 'aria-label': 'Remove', onclick: () => { rows.splice(i, 1); draw(); } }, '✕'))),
    h('button.btn-sm', { type: 'button', onclick: () => { rows.push({ status: 'doing', title: '', body: '' }); draw(); } }, '+ Add one'));
  draw();
  const save = () => api.saveFeedbackActions(round.id, { actions: rows });
  return h('section.fb-card.fb-said',
    h('div.fb-card-head', h('strong', 'You said, we did'),
      h('span.muted', round.saidAt ? `Sent to everybody ${fmtDay(round.saidAt.slice(0, 10))}` : 'Not sent yet. Staff see it on My day.')),
    list,
    h('div.btn-row',
      h('button.btn-sm', { type: 'button', onclick: () => act(save, 'Saved.') }, 'Save'),
      h('button.btn.btn-primary', {
        type: 'button',
        onclick: async () => {
          try {
            await save();
            const { people } = await api.feedbackPeople();
            const out = await choosePeople({
              title: 'Send You said, we did',
              submitLabel: 'Send it',
              people,
              ticked: (p) => p.hasLogin,
              intro: 'Ticked: everybody with a login. Untick anybody it should not go to. Only those ticked are told and see it.',
              send: (staffIds) => api.publishSaid(round.id, { staffIds }),
            });
            if (out) { toast(`Sent to ${out.told} ${out.told === 1 ? 'person' : 'people'}.`, 'good'); act(async () => {}); }
          } catch (err) { toast(err.message, 'bad'); }
        },
      }, round.saidAt ? 'Send again' : 'Send it')));
}

/** People › Feedback › Questions and schedule. */
export async function renderFeedbackSetup() {
  const host = h('div.fb-page');
  const [data, qs] = await Promise.all([api.feedback(), api.feedbackQuestions()]);
  const s = data.settings;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const picked = new Set(s.months);
  const edit = data.isAdmin;

  const on = h('input', { type: 'checkbox', checked: s.on, disabled: !edit });
  const anon = h('input', { type: 'checkbox', checked: s.anonymous, disabled: !edit });
  const sup = h('input', { type: 'checkbox', checked: s.supervisors, disabled: !edit });
  const openDays = h('input', { type: 'number', min: 1, max: 60, value: s.openDays, disabled: !edit });
  const minGroup = h('input', { type: 'number', min: 1, max: 50, value: s.minGroup, disabled: !edit });
  const service = h('input', { type: 'number', min: 0, max: 365, value: s.minServiceDays, disabled: !edit });
  const monthChips = h('div.fb-months');
  const drawMonths = () => mount(monthChips, months.map((m, i) => h('button', {
    type: 'button', disabled: !edit, class: picked.has(i + 1) ? 'fb-month on' : 'fb-month',
    onclick: () => { if (picked.has(i + 1)) picked.delete(i + 1); else picked.add(i + 1); drawMonths(); },
  }, m)));
  drawMonths();

  const saveSettings = async () => {
    try {
      await api.saveFeedbackSettings({
        on: on.checked, anonymous: anon.checked, supervisors: sup.checked,
        months: [...picked], openDays: Number(openDays.value), minGroup: Number(minGroup.value), minServiceDays: Number(service.value),
      });
      toast('Saved.', 'good');
      renderFeedbackSetup().then((el) => host.replaceWith(el));
    } catch (err) { toast(err.message, 'bad'); }
  };

  let rows = qs.questions.map((q) => ({ ...q }));
  const qList = h('div.fb-q-list');
  const drawQs = () => mount(qList,
    rows.map((q, i) => h('div.fb-q-row',
      h('input', { type: 'text', value: q.area, maxlength: 60, 'aria-label': 'Area', oninput: (e) => { q.area = e.target.value; } }),
      h('input', { type: 'text', value: q.text, maxlength: 300, 'aria-label': 'Question', oninput: (e) => { q.text = e.target.value; } }),
      h('select', { 'aria-label': 'Answer', onchange: (e) => { q.kind = e.target.value; } },
        [['scale', '1 to 5'], ['recommend', 'Yes · maybe · no'], ['text', 'Written']].map(([v, l]) => h('option', { value: v, selected: q.kind === v }, l))),
      h('label.fb-q-on', h('input', { type: 'checkbox', checked: q.active, onchange: (e) => { q.active = e.target.checked; } }), 'Asked'),
      h('span.fb-q-move',
        h('button.btn-sm', { type: 'button', 'aria-label': 'Up', disabled: i === 0, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; drawQs(); } }, '↑'),
        h('button.btn-sm', { type: 'button', 'aria-label': 'Down', disabled: i === rows.length - 1, onclick: () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; drawQs(); } }, '↓')))),
    h('button.btn-sm', { type: 'button', onclick: () => { rows.push({ area: '', text: '', kind: 'scale', active: true }); drawQs(); } }, '+ Add a question'));
  drawQs();

  mount(host,
    h('div.page-head', h('div', h('h1', 'Questions and schedule'),
      h('div.sub', s.on && data.nextRound ? `Runs by itself. Next round ${fmtDay(data.nextRound, { withYear: true })}.` : 'Rounds are switched off.'))),
    h('div.fb-two',
      h('section.fb-card',
        h('div.fb-card-head', h('strong', 'The schedule')),
        h('label.fb-switch', on, h('span', h('strong', 'Run every quarter by itself'), h('small.muted', 'A round opens on the first Monday of each month picked.'))),
        field('Months', monthChips),
        field('Open for', openDays, 'days, with reminders on the third and eighth and the last'),
        field('Who is asked', service, 'days employed at least'),
        h('div.fb-card-head', { style: { marginTop: '.8rem' } }, h('strong', 'Names')),
        h('label.fb-switch', anon, h('span', h('strong', 'Anonymous'),
          h('small.muted', 'Off: names are kept with answers and admins can see who said what. On: no name is kept with any answer, '
            + 'and staff are told their answers are anonymous. Applies to rounds opened after it is changed.'))),
        h('label.fb-switch', sup, h('span', h('strong', 'Supervisors see their own department'),
          h('small.muted', 'Scores and comments for their department only, never names.'))),
        field('Smallest group shown', minGroup, 'A department with fewer answers than this is never shown on its own.'),
        edit ? h('div.btn-row', h('button.btn.btn-primary', { type: 'button', onclick: saveSettings }, 'Save')) : h('p.muted', 'Only an administrator changes these.')),
      h('section.fb-card',
        h('div.fb-card-head', h('strong', 'The questions'), h('span.muted', 'The same each round, so rounds can be compared')),
        qList,
        h('div.btn-row', h('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => {
            try { await api.saveFeedbackQuestions({ questions: rows }); toast('Saved. The next round asks these.', 'good'); } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'Save the questions')))));
  return host;
}

/**
 * Pick who something goes to: everybody, ticked as the caller says, with a
 * department to narrow the list and a search box. Returns what `send`
 * returned, or nothing if cancelled.
 */
function choosePeople({ title, submitLabel, people, ticked, intro, extra = null, send }) {
  const depts = [...new Set(people.map((p) => p.department || 'No department'))].sort();
  let dept = null;
  let search = '';
  const boxes = new Map();
  const count = h('strong.fb-pick-count');
  const list = h('div.fb-pick-list');
  const rows = people.map((p) => {
    const box = h('input', { type: 'checkbox', name: 'staff', value: String(p.id), checked: Boolean(ticked(p)), onchange: () => recount() });
    boxes.set(p.id, box);
    const row = h('label.fb-pick-row', box,
      h('span', h('strong', p.name), h('small.muted', [p.department, !p.eligible ? 'new, not usually asked' : null, !p.hasLogin ? 'no login: sees it only if they sign in' : null]
        .filter(Boolean).join(' · '))));
    return { p, row };
  });
  const recount = () => {
    const n = [...boxes.values()].filter((b) => b.checked).length;
    count.textContent = `${n} of ${people.length} chosen`;
  };
  const shown = () => rows.filter(({ p }) => (!dept || (p.department || 'No department') === dept)
    && (!search || p.name.toLowerCase().includes(search)));
  const drawList = () => mount(list, shown().map(({ row }) => row));
  const chips = h('div.fb-pick-depts');
  const drawChips = () => mount(chips, [[null, 'Everybody'], ...depts.map((d) => [d, d])].map(([v, l]) => h('button', {
    type: 'button', class: dept === v ? 'fb-month on' : 'fb-month', onclick: () => { dept = v; drawChips(); drawList(); },
  }, l)));
  drawChips(); drawList(); recount();
  const setShown = (on) => { for (const { p } of shown()) boxes.get(p.id).checked = on; recount(); };
  return formDialog({
    title,
    submitLabel,
    wide: true,
    body: h('div.fb-pick',
      h('p.muted', { style: { marginTop: 0 } }, intro),
      extra,
      chips,
      h('div.fb-pick-tools',
        h('input', { type: 'search', placeholder: 'Find somebody', 'aria-label': 'Find somebody', oninput: (e) => { search = e.target.value.trim().toLowerCase(); drawList(); } }),
        h('button.btn-sm', { type: 'button', onclick: () => setShown(true) }, 'Tick all shown'),
        h('button.btn-sm', { type: 'button', onclick: () => setShown(false) }, 'Untick all shown'),
        count),
      list),
    onSubmit: async (form) => {
      const staffIds = [...boxes.entries()].filter(([, b]) => b.checked).map(([id]) => Number(id));
      if (!staffIds.length) throw new Error('Pick at least one person.');
      return send(staffIds, form);
    },
  });
}
