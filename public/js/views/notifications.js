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

  const embedded = Boolean(params.embedded);
  const reload = async (next = tab) => {
    if (!embedded) history.replaceState(null, '', `#/notifications?tab=${next}`);
    mount(host, await renderNotifications({ ...params, tab: next }));
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

  if (embedded) {
    mount(host, body);
    return host;
  }

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
  const groups = data.groups ?? [];
  const kinds = data.kinds ?? [];
  const audiences = data.audiences ?? [];
  const nameOf = (key) => audiences.find((a) => a.key === key)?.label ?? key;

  // On means: somebody ticked it, or nobody has touched it and the app sends
  // it that way anyway. Both are stored as an answer to the same question, so
  // the screen does not have to explain the difference to anybody.
  const isOnIn = (store, kind, way) => {
    const said = store[kind.key]?.[way];
    if (said === 1 || said === true) return true;
    if (said === 0 || said === false) return false;
    return kind.ways.includes(way);
  };
  const isOn = (kind, way) => isOnIn(wanted, kind, way);
  const alsoIn = (store, kind) => [...(store[kind.key]?.also ?? [])].sort();
  const shape = (store, kind) => JSON.stringify([...WAYS.map(([w]) => isOnIn(store, kind, w)), alsoIn(store, kind)]);

  // What was saved, to tell what is not yet, and what differs from how HIVE sends it.
  const saved = JSON.parse(JSON.stringify(data.channels ?? {}));
  const unsaved = (kind) => shape(wanted, kind) !== shape(saved, kind);
  const changedHere = (kind) => shape(wanted, kind) !== shape({}, kind);

  const FILTERS = [
    ['all', 'All', () => true],
    ['text', 'Sends a text', (k) => isOn(k, 'text')],
    ['changed', 'Changed here', changedHere],
    ['extra', 'Sent to extra people', (k) => alsoIn(wanted, k).length > 0],
  ];
  let filter = 'all';
  let query = '';
  const opened = new Set();
  const showAll = new Set();

  const fits = (kind) => {
    if (!FILTERS.find(([key]) => key === filter)[2](kind)) return false;
    if (!query) return true;
    const hay = `${kind.label} ${kind.who} ${kind.when}`.toLowerCase();
    return query.split(/\s+/).every((w) => hay.includes(w));
  };

  const setWay = (kind, way, on) => {
    wanted[kind.key] = wanted[kind.key] ?? {};
    wanted[kind.key][way] = on ? 1 : 0;
  };

  /**
   * Who else this one goes to.
   *
   * Alongside whoever it already reaches rather than instead of them. Taking
   * "your leave was approved" away from the person who asked for it is not a
   * setting anybody wants, and offering it is how somebody switches it off by
   * accident on a Friday afternoon. Permissions rather than names, so it keeps
   * up with promotions. Shown only once used: a link until then.
   */
  const alsoFor = (kind) => {
    const host = h('div.notice-also');
    let picking = false;
    const draw = () => {
      const chosen = alsoIn(wanted, kind);
      const keep = (list) => {
        wanted[kind.key] = wanted[kind.key] ?? {};
        if (list.length) wanted[kind.key].also = list;
        else delete wanted[kind.key].also;
        picking = false;
        draw();
        changed();
      };
      const left = audiences.filter((a) => !chosen.includes(a.key));
      mount(host,
        chosen.map((key) => h('button.notice-also-one', {
          type: 'button',
          title: 'Stop sending it to them',
          'aria-label': `Stop sending ${kind.label} to ${nameOf(key)}`,
          onclick: () => keep(chosen.filter((k) => k !== key)),
        }, `Also: ${nameOf(key)}`, h('span.notice-also-x', { 'aria-hidden': 'true' }, '×'))),
        picking
          ? h('select.notice-also-pick', {
            'aria-label': `Also send ${kind.label} to`,
            onchange: (event) => { if (event.target.value) keep([...chosen, event.target.value]); },
            // Later, and only if nothing was chosen: choosing redraws the box away itself.
            onblur: () => setTimeout(() => { if (picking) { picking = false; draw(); } }, 0),
          }, h('option', { value: '' }, 'Choose who…'), left.map((a) => h('option', { value: a.key }, a.label)))
          : left.length ? h('button.notice-also-add', {
            type: 'button',
            onclick: () => { picking = true; draw(); host.querySelector('select')?.focus(); },
          }, '+ Also send to…') : null);
    };
    draw();
    return host;
  };

  const host = h('div.notice-page');
  const list = h('div.notice-groups');
  const chips = h('div.notice-filters', { role: 'group', 'aria-label': 'Show' });
  const bar = h('div.notice-savebar', { hidden: true, role: 'status' });

  const paintChips = () => mount(chips, FILTERS.map(([key, label, test]) => h('button.chip', {
    type: 'button',
    class: filter === key ? 'on' : '',
    'aria-pressed': filter === key ? 'true' : 'false',
    onclick: () => { filter = key; paintChips(); paintList(); },
  }, label, h('small', String(kinds.filter(test).length)))));

  const paintBar = () => {
    const n = kinds.filter(unsaved).length;
    bar.hidden = !n;
    if (!n) return;
    mount(bar,
      h('span.notice-dot', { 'aria-hidden': 'true' }),
      h('span', `${n} change${n === 1 ? '' : 's'} not saved`),
      h('span.notice-savebar-gap'),
      h('button.btn.btn-ghost', { type: 'button', onclick: () => reload() }, 'Discard'),
      h('button.btn.btn-primary', { type: 'button', onclick: save }, 'Save'));
  };

  // Something was switched: the dots, the counts and the bar follow.
  function changed() {
    for (const row of list.querySelectorAll('.notice-kind')) {
      const kind = kinds.find((k) => k.key === row.dataset.key);
      if (kind) row.classList.toggle('is-unsaved', unsaved(kind));
    }
    for (const g of list.querySelectorAll('.notice-group')) g._sum?.();
    paintChips();
    paintBar();
  }

  const row = (kind) => h('div.notice-kind', { 'data-key': kind.key, class: unsaved(kind) ? 'is-unsaved' : '' },
    h('div.notice-what',
      h('strong', h('span.notice-dot', { 'aria-hidden': 'true', title: 'Changed, not saved' }), kind.label),
      h('small.muted', `${kind.who} · ${kind.when.charAt(0).toLowerCase()}${kind.when.slice(1)}`),
      kind.note ? h('small.notice-note', kind.note) : null),
    h('div.notice-ways', WAYS.map(([way, label]) => h('label.notice-way',
      h('input', {
        type: 'checkbox',
        role: 'switch',
        checked: isOn(kind, way),
        'aria-label': `${kind.label} by ${label.toLowerCase()}`,
        onchange: (event) => { setWay(kind, way, event.target.checked); changed(); },
      }),
      h('span.notice-way-name', label)))),
    alsoFor(kind));

  const group = (g, mine) => {
    const all = kinds.filter((k) => k.group === g.key);
    const searching = Boolean(query) || filter !== 'all';
    const open = searching || opened.has(g.key);
    const sum = h('span.notice-sum');
    const paintSum = () => mount(sum, WAYS.map(([way, label]) => {
      const on = all.filter((k) => isOn(k, way)).length;
      return h('span.notice-sum-one', { class: on === all.length ? 'all' : on === 0 ? 'none' : '' }, `${label} ${on}/${all.length}`);
    }));
    paintSum();

    const el = h('section.notice-group', { class: open ? 'open' : '' },
      h('button.notice-group-head', {
        type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        onclick: () => {
          if (opened.has(g.key)) opened.delete(g.key); else opened.add(g.key);
          paintList();
        },
      },
      h('span.notice-chev', { 'aria-hidden': 'true' }),
      h('strong', g.label),
      h('span.muted.notice-count', searching ? `${mine.length} of ${all.length}` : `${all.length} notice${all.length === 1 ? '' : 's'}`),
      sum));
    el._sum = paintSum;
    if (!open) return el;

    // One switch per way for the whole group, above the column it sets: a
    // property that wants no texts about pay unticks one box, not nine.
    const whole = (way, label) => {
      const input = h('input', {
        type: 'checkbox',
        'aria-label': `Every ${g.label.toLowerCase()} notice by ${label.toLowerCase()}`,
        title: `Every one in this group by ${label.toLowerCase()}`,
        onchange: () => {
          for (const kind of all) setWay(kind, way, input.checked);
          paintList();
          changed();
        },
      });
      const on = all.filter((k) => isOn(k, way)).length;
      input.checked = on === all.length;
      input.indeterminate = on > 0 && on < all.length;
      return h('label.notice-whole', h('span', label), way === 'text' ? h('small', 'costs money') : null, input);
    };

    const LIMIT = 8;
    const shown = searching || showAll.has(g.key) ? mine : mine.slice(0, LIMIT);
    el.append(
      h('div.notice-head', h('span', 'Notice'), h('div.notice-ways', WAYS.map(([way, label]) => whole(way, label)))),
      ...shown.map(row),
      shown.length < mine.length
        ? h('button.notice-more', { type: 'button', onclick: () => { showAll.add(g.key); paintList(); } },
          `Show ${mine.length - shown.length} more`)
        : null);
    return el;
  };

  function paintList() {
    const drawn = groups.map((g) => {
      const mine = kinds.filter((k) => k.group === g.key && fits(k));
      return mine.length ? group(g, mine) : null;
    }).filter(Boolean);
    mount(list, drawn.length ? drawn : h('p.muted', 'No notice matches that.'));
  }

  async function save(event) {
    event.target.disabled = true;
    try {
      await api.updateNotifications({ channels: wanted });
      toast('Saved.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  }

  const search = h('input.notice-search', {
    type: 'search',
    placeholder: 'Find a notice, e.g. leave or payslip',
    'aria-label': 'Find a notice',
    oninput: () => { query = search.value.trim().toLowerCase(); paintList(); },
  });

  paintChips();
  paintList();
  mount(host,
    h('p.notice-lead',
      'Switch off a way out and the notice still shows in the bell. It just stops buzzing a phone, '
      + 'landing in an inbox or sending a text. The person a notice is about is always told. ',
      h('details.notice-how',
        h('summary', 'How this works'),
        h('p', 'A switch on means this kind goes out that way. Switch one on that was never on and it '
          + 'starts going out that way from the next one.'),
        h('p', h('strong', 'Texts cost money every time. '),
          'Nothing texts unless it is switched on here, and a chatty kind switched on for text is a bill '
          + 'at the end of the month rather than a setting.'),
        h('p', '"Also send to" adds a group alongside whoever the notice already reaches. It never takes '
          + 'anybody away.'))),
    h('div.notice-tools', search, chips),
    list,
    bar);
  return host;
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
