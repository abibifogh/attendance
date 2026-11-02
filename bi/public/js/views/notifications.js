import { h, mount } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * Assistant › Notifications: everything Insight told you, as an inbox.
 *
 * All, Unread, Urgent and Read across the top; newest (or newest reminded)
 * first. Opening one takes you where it is about and marks it read; each can
 * be marked read or unread again; Mark all read clears the lot. Above the
 * list, whether this phone or computer gets them as notifications too, with
 * Turn on, Send a test and Turn off.
 */

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['urgent', 'Urgent'], ['read', 'Read']];
let filter = 'unread';

const ago = (at) => {
  const t = Date.parse(`${String(at).replace(' ', 'T')}Z`);
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ago`;
  return new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

/** Tell the menu's bell how many are unread. */
export const sayUnread = (n) => window.dispatchEvent(new CustomEvent('notices:count', { detail: n }));

export async function renderNotifications(root) {
  const view = h('div.nt');
  mount(root, view);
  await paint();

  async function paint(message = null) {
    let d;
    try { d = await api(`/notices?filter=${filter}`); } catch (err) { mount(view, banner('problem', err.message)); return; }
    sayUnread(d.counts.unread);
    const c = d.counts;
    mount(view,
      h('div.nt-head', h('h1', 'Notifications'), h('span.sp'),
        c.unread ? h('button.btn', { type: 'button', onclick: () => markAll() }, '✓ Mark all read') : null),
      message,
      await deviceCard(d.devices),
      h('div.seg.nt-seg', { role: 'tablist', 'aria-label': 'Which notifications' }, FILTERS.map(([k, label]) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(filter === k), onclick: () => { filter = k; paint(); },
      }, label, k === 'read' ? null : h('span.nt-n', String(c[k] ?? 0))))),
      d.items.length
        ? h('div.nt-list', d.items.map(row))
        : h('p.muted.nt-empty', { all: 'Nothing yet. What Insight emails you, and anything waiting on you, comes here too.', unread: 'Nothing unread.', urgent: 'Nothing urgent.', read: 'Nothing read yet.' }[filter]));
  }

  function row(n) {
    const open = async () => {
      if (!n.read) await api('/notices/read', { method: 'POST', body: { ids: [n.id], read: true } }).catch(() => null);
      if (n.link) location.hash = n.link.replace(/^#?/, '#');
      else paint();
    };
    const toggle = async (e) => {
      e.stopPropagation();
      try { await api('/notices/read', { method: 'POST', body: { ids: [n.id], read: !n.read } }); paint(); } catch (err) { paint(banner('problem', err.message)); }
    };
    return h(`div.nt-row${n.read ? '' : '.unread'}${n.urgent && !n.done ? '.urgent' : ''}`, { role: 'button', tabindex: '0', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
      h('span.nt-dot', { 'aria-hidden': 'true' }),
      h('div.nt-main',
        h('div.nt-top', h('b', n.title),
          n.urgent && !n.done ? h('span.sh-chip.short', 'Urgent') : null,
          n.done ? h('span.sh-chip.ok', '✓ Done') : null),
        n.body ? h('p.nt-body', n.body) : null,
        h('small.muted', ago(n.lastAt), n.times > 1 ? ` · told ${n.times} times, first ${ago(n.at)}` : '')),
      h('button.sh-link.nt-mark', { type: 'button', onclick: toggle, 'aria-label': n.read ? 'Mark unread' : 'Mark read' }, n.read ? 'Mark unread' : 'Mark read'));
  }

  async function markAll() {
    try { await api('/notices/read', { method: 'POST', body: { all: true, read: true } }); paint(banner('good', 'All marked read.')); } catch (err) { paint(banner('problem', err.message)); }
  }

  /** This phone or computer: getting them as notifications, or not, and the others of yours that do. */
  async function deviceCard(devices) {
    const said = h('span.small');
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const sub = supported ? await navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).catch(() => null) : null;
    const iphone = /iPhone|iPad/.test(navigator.userAgent) && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
    const on = Boolean(sub) && Notification.permission === 'granted';
    const turnOn = async () => {
      said.textContent = 'Asking…';
      try {
        if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for Insight in this browser: allow them in its site settings, then try again.');
        const reg = await navigator.serviceWorker.ready;
        const { publicKey } = await api('/push/key');
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(publicKey) });
        await api('/push/subscribe', { method: 'POST', body: { subscription: s.toJSON(), device: deviceName() } });
        await api('/push/test', { method: 'POST' }).catch(() => null);
        paint(banner('good', 'Notifications are on for this device: a test was sent.'));
      } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
    };
    const turnOff = async () => {
      try {
        const s = await navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription());
        if (s) { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: s.endpoint } }).catch(() => null); await s.unsubscribe(); }
        paint(banner('good', 'Notifications are off for this device. They are still here in the inbox.'));
      } catch (err) { said.textContent = err.message; }
    };
    const test = async () => {
      try { const out = await api('/push/test', { method: 'POST' }); said.textContent = out.sent ? `Sent to ${out.sent} device${out.sent === 1 ? '' : 's'}.` : 'Nothing was sent: turn notifications on first.'; } catch (err) { said.textContent = err.message; }
    };
    const others = devices.length - (on ? 1 : 0);
    return h(`section.card.nt-dev${on ? '.on' : ''}`,
      h('div.nt-devrow',
        h('span.nt-bell', on ? '🔔' : '🔕'),
        h('div', h('b', on ? 'Notifications are on for this device' : 'Get these on this phone or computer'),
          h('small.muted', on ? 'Urgent ones, like the kitchen waiting on the store room, buzz until they are dealt with.'
            : iphone ? 'On an iPhone: Share › Add to Home Screen first, open Insight from there, then turn them on.'
              : supported ? 'Insight tells you the moment something needs you, even when it is closed.' : 'This browser cannot get notifications from Insight.')),
        h('span.sp'),
        on ? [h('button.btn', { type: 'button', onclick: test }, 'Send a test'), h('button.btn', { type: 'button', onclick: turnOff }, 'Turn off')]
          : supported && !iphone ? h('button.btn.primary', { type: 'button', onclick: turnOn }, 'Turn on') : null),
      others > 0 ? h('small.muted', `Also on ${others} other device${others === 1 ? '' : 's'} of yours.`) : null,
      said);
  }
}

function fromB64(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function deviceName() {
  const ua = navigator.userAgent;
  const what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows computer' : 'Computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  return `${what}, ${browser}`;
}
