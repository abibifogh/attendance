import { api } from '../api.js';
import { h, mount } from '../util.js';
import { emptyState } from './components.js';

/**
 * Everything out for signature: contracts and letters together, the way
 * somebody chasing signatures thinks about them.
 */
const TABS = [
  ['waitingOnUs', 'Waiting on us'],
  ['withOthers', 'With others'],
  ['completed', 'Completed'],
  ['stopped', 'Stopped'],
];

const day = (at) => {
  if (!at) return '';
  const d = new Date(`${String(at).replace(' ', 'T').slice(0, 19)}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

export async function renderSigning(params = {}) {
  const host = h('div');
  const data = await api.signing();
  let tab = TABS.some(([k]) => k === params.tab) ? params.tab : (data.waitingOnUs.length ? 'waitingOnUs' : 'withOthers');

  const paint = () => {
    const rows = data[tab] ?? [];
    mount(host,
      h('div.page-head', h('div', h('h1', 'Signatures'),
        h('div.sub', 'Contracts and letters out for signature, in one place'))),
      h('div.chips', { role: 'tablist' }, TABS.map(([k, label]) => h('button.chip', {
        type: 'button', class: k === tab ? 'chip on' : 'chip', 'aria-pressed': String(k === tab),
        onclick: () => { tab = k; paint(); },
      }, label, h('small', String((data[k] ?? []).length))))),
      rows.length
        ? h('div.sign-list', rows.map((r) => h('a.sign-row', { href: r.link },
          h('span.sign-kind', r.kind === 'contract' ? 'Contract' : 'Letter'),
          h('span.sign-main',
            h('strong', r.title),
            h('small.muted', [r.reference, r.who, r.progress].filter(Boolean).join(' · '))),
          h('span.sign-state',
            h(`span.pill${tab === 'stopped' ? '.bad' : tab === 'completed' ? '.good' : tab === 'waitingOnUs' ? '.warn' : ''}`, r.status),
            h('small.muted', [
              r.waitingOn && tab === 'withOthers' ? `with ${r.waitingOn}` : null,
              r.remindedAt ? `reminded ${day(r.remindedAt)}` : r.sentAt ? `sent ${day(r.sentAt)}` : null,
              r.expiresAt && tab === 'withOthers' ? `runs out ${day(r.expiresAt)}` : null,
              r.note ? `"${r.note}"` : null,
            ].filter(Boolean).join(' · '))))))
        : emptyState({
          waitingOnUs: 'Nothing waiting on you', withOthers: 'Nothing out for signature',
          completed: 'Nothing signed yet', stopped: 'Nothing stopped',
        }[tab], tab === 'waitingOnUs' ? 'Contracts to countersign and documents not yet sent appear here.' : null),
    );
  };
  paint();
  return host;
}
