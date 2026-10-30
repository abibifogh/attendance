import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { state } from '../app.js';

/**
 * The Assistant: what needs the admin, from every system, with what Insight
 * would do about each.
 *
 * The morning summary on top (written by Workers AI from the list, or plain
 * counts), four numbers, then the list in four tabs: Decide, Fix, Review and
 * Done for you. A line opens to say why and what to do, with the buttons that
 * do it: a decision that needs nothing typed is made here, the rest open the
 * page where it is done. Beside it: Ask Insight, and what was read.
 */
const TABS = [['decide', 'Decide'], ['fix', 'Fix'], ['review', 'Review'], ['done', 'Done for you']];
const MARK = { crit: '!', warn: '!', info: 'i', good: '✓' };
const SEV = { crit: 'Urgent', warn: 'Soon', info: 'Routine', good: 'Done' };

export async function renderAssistant(root) {
  let tab = 'decide';
  try { tab = sessionStorage.getItem('insight-assistant-tab') || 'decide'; } catch { /* private mode */ }
  const opened = new Set();
  const done = new Map();
  let data = await api('/assistant');
  if (!data.counts[tab] && tab !== 'done') tab = TABS.find(([k]) => data.counts[k])?.[0] || 'decide';

  const brief = h('p.as-brief-text', plainBrief(data));
  const briefBy = h('small.as-by');
  const list = h('div.as-list');
  const tabs = h('div.seg', { role: 'tablist', 'aria-label': 'What needs you' });
  const name = (state.me?.account?.name || '').split(' ')[0];
  const hour = new Date().getHours();

  mount(root,
    h('div.as',
      h('div.as-main',
        h('div.as-hello',
          h('h1', `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}${name ? `, ${name}` : ''}`),
          h('p', h('span.as-dot', { class: data.read.every((r) => r.ok) ? '' : 'warn' }), readLine(data))),
        h('section.card.as-brief', h('div.as-tag', '✨ Your day, in short'), brief, briefBy,
          h('div.as-acts', h('button.btn.primary', { type: 'button', onclick: startUrgent }, 'Start with the urgent ones'))),
        h('div.as-kpis',
          kpi('Need you', String(data.tiles.needYou), data.tiles.urgent ? `${data.tiles.urgent} urgent` : 'nothing urgent'),
          kpi('Money at stake', data.tiles.atStake ? money(data.tiles.atStake, { places: 0 }) : '—', 'differences, floats, bills'),
          kpi('Oldest waiting', data.tiles.oldest ? `${data.tiles.oldest} day${data.tiles.oldest === 1 ? '' : 's'}` : '—', ''),
          kpi('Done for you', String(data.tiles.done), 'in the last day')),
        tabs,
        list,
        h('p.small.muted', 'Decide: waiting on your yes or no. Fix: going wrong, with how to put it right. Review: worth a read. Done for you: what Insight did by itself.')),
      h('aside.as-side', askCard(), readCard())));
  paintTabs();
  paintList();

  // The summary in words, after the page: it takes a few seconds.
  api('/assistant/brief').then((b) => {
    brief.textContent = b.text;
    briefBy.textContent = b.by === 'ai' ? 'Written by Insight from the list below.' : '';
  }).catch(() => {});

  function paintTabs() {
    mount(tabs, TABS.map(([k, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === k),
      onclick: () => { tab = k; try { sessionStorage.setItem('insight-assistant-tab', k); } catch { /* private mode */ } paintTabs(); paintList(); },
    }, label, h('span.n', String(data.counts[k] || 0)))));
  }

  function paintList() {
    const items = data.items.filter((x) => x.tab === tab);
    if (!items.length) {
      mount(list, h('div.card.as-empty', tab === 'done' ? 'Nothing done by itself in the last day.' : '✓ Nothing here. Everything Insight reads agrees, or has an answer.'));
      return;
    }
    mount(list, h('div.as-rows', items.map(row)));
  }

  function row(x) {
    const isOpen = opened.has(x.key);
    const said = done.get(x.key);
    const head = h('button.as-row-h', { type: 'button', 'aria-expanded': String(isOpen), onclick: () => { if (isOpen) opened.delete(x.key); else opened.add(x.key); paintList(); } },
      h(`span.as-sev.${x.sev}`, { title: SEV[x.sev] }, MARK[x.sev]),
      h('span.as-row-t',
        h('b', x.title),
        h('span.as-row-m', x.source ? h('span.as-src', x.system && x.system !== x.source ? `${x.source} · ${x.system}` : x.source) : null,
          x.age != null ? h('span', ageWords(x.age)) : null,
          said ? h('span.as-said', `✓ ${said}`) : null)),
      h('span.as-row-r', x.amount ? h('b.num', `${money(x.amount, { places: 0 })}${x.amountNote ? ` ${x.amountNote}` : ''}`) : null,
        x.tab !== 'done' ? h('span.as-chev', '›') : null));
    if (!isOpen || x.tab === 'done') return h('div.as-row', { class: said ? 'done' : '' }, head);
    const note = h('span.small');
    return h('div.as-row.open', { class: said ? 'done' : '' }, head,
      h('div.as-row-b',
        x.why ? h('p', x.why) : null,
        x.advice ? h('div.as-advice', h('b', '✨ What I’d do: '), x.advice) : null,
        h('div.as-acts', (x.actions || []).map((a) => (a.decide
          ? h(`button.btn${a.primary ? '.primary' : ''}`, { type: 'button', disabled: Boolean(said), onclick: (e) => decide(e.currentTarget, x, a, note) }, a.label)
          : h(`a.btn${a.primary ? '.primary' : ''}`, { href: a.href }, a.label))), note)));
  }

  async function decide(button, x, a, note) {
    button.disabled = true;
    note.textContent = 'Sending…';
    try {
      const out = await api('/approvals/decide', { method: 'POST', body: a.decide });
      done.set(x.key, `${out.said || a.label}${out.as ? ` as ${out.as}` : ''}`);
      opened.delete(x.key);
      paintList();
      window.dispatchEvent(new CustomEvent('approvals:count', { detail: Math.max(0, data.counts.decide - done.size) }));
    } catch (err) {
      note.textContent = err.message;
      note.className = 'small form-error';
      button.disabled = false;
    }
  }

  function startUrgent() {
    const first = data.items.find((x) => x.tab !== 'done' && x.sev === 'crit') || data.items.find((x) => x.tab !== 'done');
    if (!first) return;
    tab = first.tab;
    opened.add(first.key);
    paintTabs();
    paintList();
    list.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function askCard() {
    const box = h('div.as-chat');
    const input = h('input', { type: 'text', placeholder: 'Ask about anything Insight reads…', 'aria-label': 'Ask Insight' });
    const send = async (q) => {
      const question = (q || input.value).trim();
      if (!question) return;
      input.value = '';
      box.append(h('div.as-q', question));
      const answer = h('div.as-a', 'Thinking…');
      box.append(answer);
      try { answer.textContent = (await api('/assistant/ask', { method: 'POST', body: { question } })).answer; } catch (err) { answer.textContent = err.message; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    return h('section.card.as-ask',
      h('h2', '✨ Ask Insight'),
      box,
      h('div.as-askrow', input, h('button.btn.primary', { type: 'button', onclick: () => send() }, 'Ask')),
      h('div.as-sugs', ['What needs me most today?', 'Which supplier are we owing most?', 'Why is anything urgent?'].map((s) => h('button', { type: 'button', onclick: () => send(s) }, s))));
  }

  function readCard() {
    return h('section.card.as-read',
      h('h2', 'What I read'),
      h('div.as-feed', data.read.map((r) => h('div',
        h('span', r.label),
        r.ok ? h('small.ok', r.count ? `✓ ${r.count}` : '✓') : h('small.bad', { title: r.error }, '× not read')))),
      data.read.some((r) => !r.ok) ? h('p.small.muted', 'Hover a “not read” to see why. The rest of the list still came.') : null);
  }
}

function kpi(label, big, small) {
  return h('div.as-kpi', h('small', label), h('b.num', big), h('span', small));
}

function readLine(data) {
  const bad = data.read.filter((r) => !r.ok).length;
  const at = new Date(data.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `Read ${data.read.length - bad} of ${data.read.length} places at ${at}${bad ? ` · ${bad} could not be read` : ''}`;
}

function ageWords(n) {
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days`;
}

/** The counts in words, shown until the written summary comes. */
function plainBrief(data) {
  const { tiles, counts } = data;
  if (!tiles.needYou) return 'Nothing needs you right now. Everything Insight reads agrees, or has an answer.';
  const parts = [];
  if (tiles.urgent) parts.push(`${tiles.urgent} urgent`);
  if (counts.decide) parts.push(`${counts.decide} to decide`);
  if (counts.fix) parts.push(`${counts.fix} going wrong`);
  if (counts.review) parts.push(`${counts.review} to look at`);
  return `${parts.join(', ')}.`;
}
