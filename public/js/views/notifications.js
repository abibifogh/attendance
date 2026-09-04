import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import { showPublishHistory } from './rota-heard.js';

/**
 * Every notification in one place.
 *
 * They had grown up one at a time, each with its own judgement baked in about
 * whether it was worth a phone buzzing, and the only way to see the whole set
 * was to read the source. A property that cannot see what it sends cannot
 * decide what it sends, and the two ways that ends are both bad: nothing is
 * ever turned off, or somebody turns the lot off.
 *
 * Four questions, one tab each. What goes out. Who could actually be told
 * anything. What has been sent and what failed. And the addresses, gateways
 * and devices it all runs on.
 */

const TABS = [
  ['kinds', 'What goes out'],
  ['reach', 'Who can be reached'],
  ['sent', 'What has been sent'],
  ['setup', 'Setup'],
];

const WAYS = [
  ['push', 'Alert'],
  ['email', 'Email'],
  ['text', 'Text'],
];

export async function renderNotifications(params = {}) {
  const host = h('div');
  const tab = TABS.some(([key]) => key === params.tab) ? params.tab : 'kinds';

  const reload = async (next = tab) => {
    history.replaceState(null, '', `#/notifications?tab=${next}`);
    mount(host, await renderNotifications({ tab: next }));
  };

  const data = await api.notifications().catch((err) => ({ error: err.message }));
  if (data.error) {
    mount(host, h('div.page-head', h('h1', 'Notifications')), h('p.muted', data.error));
    return host;
  }

  const body = tab === 'kinds' ? kindsTab(data, reload)
    : tab === 'reach' ? await reachTab()
      : tab === 'sent' ? sentTab(data)
        : setupTab(data);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Notifications'),
        h('div.sub', 'What the app tells people, how it reaches them, and what happened'),
      ),
    ),
    h('div.seg.seg-wrap', TABS.map(([key, label]) =>
      h('button', { class: tab === key ? 'active' : '', onclick: () => reload(key) }, label))),
    body,
  );

  return host;
}

// ---------------------------------------------------------------------------
// What goes out
// ---------------------------------------------------------------------------

/**
 * Every kind, grouped, with a switch per way out.
 *
 * The bell has no switch. Every notice is recorded whether or not anybody is
 * interrupted about it, because the list in the bell is the record of what
 * happened and a record with holes where somebody flipped a switch is worse
 * than no record at all. What can be turned off is the interrupting.
 */
function kindsTab(data, reload) {
  // Worked on as a plain object and sent whole, so one Save covers the screen
  // rather than forty separate writes as somebody works down it.
  const wanted = JSON.parse(JSON.stringify(data.channels ?? {}));

  const isOn = (kind, way) => {
    const row = wanted[kind];
    return !row || (row[way] !== 0 && row[way] !== false);
  };

  const box = (kind, way) => {
    const input = h('input', {
      type: 'checkbox',
      checked: isOn(kind.key, way),
      onchange: () => {
        wanted[kind.key] = wanted[kind.key] ?? {};
        if (input.checked) delete wanted[kind.key][way];
        else wanted[kind.key][way] = 0;
      },
    });
    return input;
  };

  const save = async (event) => {
    event.target.disabled = true;
    try {
      await api.updateNotifications({ channels: wanted });
      toast('Saved.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const groups = data.groups ?? [];
  const kinds = data.kinds ?? [];

  return h('div',
    h('p.muted', { style: { maxWidth: '52rem' } },
      'A tick means this kind may interrupt somebody that way. Untick it and the notice '
      + 'still happens and still shows in the bell, it just stops buzzing a phone or '
      + 'landing in an inbox. A dash means this kind never went out that way in the first '
      + 'place.'),

    ...groups.map((group) => {
      const mine = kinds.filter((k) => k.group === group.key);
      if (!mine.length) return null;

      return card(group.label, { wide: true, note: `${mine.length}` },
        h('div.notice-kinds',
          h('div.notice-head',
            h('span', 'Notice'),
            ...WAYS.map(([, label]) => h('span.notice-way', label))),
          ...mine.map((kind) => h('div.notice-kind',
            h('div.notice-what',
              h('strong', kind.label),
              h('small.muted', `${kind.who}. ${kind.when}.`),
              kind.note ? h('small.notice-note', kind.note) : null),
            ...WAYS.map(([way]) => h('span.notice-way',
              kind.ways.includes(way)
                ? box(kind, way)
                : h('span.muted', { title: `This kind never goes out by ${way}` }, '·'))))),
        ));
    }),

    h('div.btn-row', { style: { justifyContent: 'flex-end' } },
      h('button.btn.btn-primary', { onclick: save }, 'Save what goes out')),
  );
}

// ---------------------------------------------------------------------------
// Who can be reached
// ---------------------------------------------------------------------------

/**
 * The gaps, before the morning they matter.
 *
 * A login with no alerts turned on looks exactly like one with them on, right
 * up until a rota goes out and somebody hears nothing. This is the same
 * picture in advance: everybody on the rota, and which of the three ways out
 * actually exists for them.
 */
async function reachTab() {
  const data = await api.notificationReach().catch((err) => ({ error: err.message }));
  if (data.error) return h('p.muted', data.error);

  const yes = (on, title) => (on
    ? h('span.heard-yes', { title }, '✓')
    : h('span.heard-none', { title: `No ${title.toLowerCase()}` }, '·'));

  const rows = data.people.map((p) => ({
    ...p,
    ways: p.ways,
    state: !p.onRota ? 'off' : p.ways === 0 ? 'none' : p.ways === 1 ? 'one' : 'ok',
  }));

  return h('div',
    data.unreachable
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', `${data.unreachable} on the rota cannot be told anything`),
          h('div.alert-detail',
            'No alerts turned on, no email address and no mobile number. When a rota goes '
            + 'out they hear nothing, and somebody has to tell them in person. A mobile '
            + 'number on their record under People is the quickest fix.')))
      : h('p.muted', 'Everybody on the rota can be reached at least one way.'),

    card('Everybody', { wide: true, note: `${rows.length}` },
      table([
        { key: 'name', label: 'Name' },
        { key: 'department', label: 'Department', format: (v) => v || h('span.muted', '—') },
        {
          key: 'devices',
          label: 'Alert',
          format: (v) => yes(v > 0, v > 1 ? `${v} devices` : 'Device with alerts on'),
        },
        { key: 'email', label: 'Email', format: (v) => yes(v, 'Email address') },
        { key: 'phone', label: 'Text', format: (v) => yes(v, 'Mobile number') },
        {
          key: 'state',
          label: '',
          format: (v) => (v === 'none' ? h('span.pill.bad', 'No way to reach them')
            : v === 'off' ? h('span.pill', 'Not on the rota')
              : v === 'one' ? h('span.pill.warn', 'One way only')
                : ''),
        },
      ], rows, { empty: 'Nobody on the staff list yet.' })),
  );
}

// ---------------------------------------------------------------------------
// What has been sent
// ---------------------------------------------------------------------------

function sentTab(data) {
  const when = (v) => h('small', String(v ?? '').slice(0, 16));
  const result = (v, good = ['sent']) =>
    h(`span.pill${good.includes(v) ? '.good' : v === 'skipped' ? '' : '.bad'}`, v);

  return h('div',
    card('The rota, person by person', {
      wide: true,
      note: 'Who heard, and who did not',
      actions: h('button.btn-sm', { onclick: () => showPublishHistory() }, 'Open'),
    },
      h('p.muted', { style: { marginBottom: 0 } },
        'Every rota that has gone out, with what became of each person’s. This is the '
        + 'place to answer "she says she never got hers", and to send it again to her '
        + 'without buzzing everybody who read it the first time.')),

    h('div.grid.grid-3',
      card('Alerts', { note: 'Phones and desktops' },
        table([
          { key: 'at', label: 'When', format: when },
          { key: 'sent', label: 'Devices', align: 'right' },
          { key: 'status', label: 'Result', format: (v) => result(v) },
          { key: 'detail', label: '', format: (v) => (v ? h('small.muted', v) : '') },
        ], (data.pushLog ?? []).slice(0, 15), { empty: 'Nothing sent yet.' })),

      card('Email', { note: data.providerConfigured ? 'Provider set' : 'No provider key' },
        table([
          { key: 'at', label: 'When', format: when },
          { key: 'status', label: 'Result', format: (v) => result(v) },
          { key: 'detail', label: '', format: (v) => (v ? h('small.muted', v) : '') },
        ], (data.log ?? []).slice(0, 15), { empty: 'Nothing sent yet.' })),

      card('Texts', { note: data.smsReady ? 'Gateway ready' : 'Not set up' },
        table([
          { key: 'at', label: 'When', format: when },
          { key: 'sent', label: 'Sent', align: 'right' },
          { key: 'status', label: 'Result', format: (v) => result(v, ['sent', 'part sent']) },
          { key: 'detail', label: '', format: (v) => (v ? h('small.muted', v) : '') },
        ], (data.smsLog ?? []).slice(0, 15), { empty: 'Nothing sent yet.' })),
    ),
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** The addresses, the gateway and the devices. One Save for the lot. */
function setupTab(data) {
  const host = h('div');
  mount(host, h('p.muted', 'Loading…'));
  // Built by the Users & data screen, which owns these boxes and their rules.
  // Imported rather than copied, so there is one set of them and not two that
  // drift.
  import('./admin-alerts.js')
    .then(({ alertsSetup }) => mount(host, alertsSetup(data, async () => {
      mount(host, await renderNotifications({ tab: 'setup' }));
    })))
    .catch((err) => mount(host, h('p.muted', err.message)));
  return host;
}
