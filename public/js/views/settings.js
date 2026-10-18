import { can, replaceParams } from '../app.js';
import { h, mount } from '../util.js';
import { renderAttSetup } from './att-setup.js';
import { renderAdmin } from './admin.js';
import { renderNotifications } from './notifications.js';
import { renderCompanies } from './companies.js';

/**
 * Everything that is set once, in one place.
 *
 * It was three screens (Setup with ten tabs, Notifications with four, Users
 * and data with three) and a Rules page that mixed clocking, leave, what staff
 * can do and the property's own particulars in one long scroll. Now it is a
 * list of topics down the side, each holding the few panels that belong to it,
 * and a search box for the setting somebody can name but not find.
 *
 * The panels are the same forms as before, drawn without their old headings.
 */

const setup = (tab, extra = {}) => () => renderAttSetup({ tab, embedded: true, ...extra });
const rules = (bands, extra = {}) => setup('rules', { bands, ...extra });
const admin = (tab) => () => renderAdmin({ tab, embedded: true });
const notices = (tab) => () => renderNotifications({ tab, embedded: true });

export const SECTIONS = [
  {
    key: 'company', label: 'Company', hint: 'Name, TIN, logo',
    panels: [
      { key: 'company', label: 'Company', need: 'att_setup', render: setup('company'), words: 'name address tin ssnit employer logo phone email website tax office lto tsc' },
      { key: 'property', label: 'The property', need: 'att_setup', render: rules(['The property itself']), words: 'departments links days' },
      { key: 'companies', label: 'Companies', need: 'att_setup', render: () => renderCompanies(), words: 'company employer second abibifo payroll payslips tin ssnit' },
    ],
  },
  {
    key: 'people', label: 'Staff and logins', hint: 'Who signs in',
    panels: [
      { key: 'staff', label: 'Staff', need: 'att_setup', render: setup('staff'), words: 'employee number department clock rota import' },
      { key: 'logins', label: 'Logins and roles', need: 'users', render: admin('people'), words: 'pin password role permission payroll access invite user' },
    ],
  },
  {
    key: 'shifts', label: 'Shifts and clocking', hint: 'Terminals, rules',
    panels: [
      { key: 'shifts', label: 'Shifts', need: 'att_setup', render: setup('shifts'), words: 'start end break grace colour' },
      { key: 'clocking', label: 'Clocking rules', need: 'att_setup', render: rules(['A day at work'], { extras: true }), words: 'missing punch repeat taps window late early overtime rebuild maps' },
      { key: 'devices', label: 'Terminals', need: 'att_setup', render: setup('devices'), words: 'device terminal hikvision clock quiet' },
      { key: 'reasons', label: 'Absence reasons', need: 'att_setup', render: setup('reasons'), words: 'absent sick reason code' },
      { key: 'workload', label: 'Workload', need: 'att_setup', render: setup('workload'), words: 'hours limit days sunday sustainable' },
    ],
  },
  {
    key: 'leave', label: 'Leave and holidays',
    panels: [
      { key: 'leave', label: 'Leave rules', need: 'att_setup', render: rules(['Time off']), words: 'annual leave days carry over qualify away at once year' },
      { key: 'holidays', label: 'Public holidays', need: 'att_setup', render: setup('holidays'), words: 'public holiday bank holiday' },
    ],
  },
  {
    key: 'pay', label: 'Pay and tax', hint: 'PAYE, SSNIT',
    panels: [
      { key: 'tax', label: 'Tax and SSNIT', need: 'att_setup', render: setup('tax'), words: 'paye bands ssnit tier bonus rate gra' },
    ],
  },
  {
    key: 'notifications', label: 'Notifications', hint: 'Email, push, text',
    panels: [
      { key: 'kinds', label: 'What goes out', need: 'users', render: notices('kinds'), words: 'alert email text push kind' },
      { key: 'reminders', label: 'Reminders to staff', need: 'att_setup', render: rules(['What their phone tells them']), words: 'clock in reminder chase clock out phone' },
      { key: 'reach', label: 'Who can be reached', need: 'users', render: notices('reach'), words: 'reach phone email' },
      { key: 'sent', label: 'What was sent', need: 'users', render: notices('sent'), words: 'log sent history email push text' },
      { key: 'delivery', label: 'Email and texts', need: 'users', render: notices('setup'), words: 'from address reply copy cc sms gateway digest medical pay' },
    ],
  },
  {
    key: 'features', label: 'Features', hint: 'What staff can use',
    panels: [
      { key: 'staff-can', label: 'For staff', need: 'att_setup', render: rules(['What staff can do for themselves']), words: 'directory handbook swaps first week balance holidays' },
      { key: 'birthdays', label: 'Birthdays', need: 'att_setup', render: setup('birthdays'), words: 'birthday wish card' },
    ],
  },
  {
    key: 'data', label: 'Data and history',
    panels: [
      { key: 'data', label: 'Backups and data', need: 'users', render: admin('data'), words: 'backup copy export erase' },
      { key: 'audit', label: 'Audit trail', need: 'users', render: admin('audit'), words: 'audit decision history who' },
    ],
  },
];

/** Where an old address lands: Setup's tabs, Notifications' and Users and data's. */
export function sectionFor(from, tab) {
  const want = {
    'att-setup': { company: 'company', staff: 'staff', shifts: 'shifts', reasons: 'reasons', holidays: 'holidays',
      devices: 'devices', rules: 'clocking', workload: 'workload', tax: 'tax', birthdays: 'birthdays' },
    notifications: { kinds: 'kinds', reach: 'reach', sent: 'sent', setup: 'delivery' },
    admin: { people: 'logins', data: 'data', audit: 'audit' },
  }[from]?.[tab] ?? { 'att-setup': 'staff', notifications: 'kinds', admin: 'logins' }[from];
  for (const section of SECTIONS) {
    if (section.panels.some((p) => p.key === want)) return { section: section.key, panel: want };
  }
  return {};
}

export async function renderSettings(params = {}) {
  const host = h('div.settings');
  const mine = SECTIONS
    .map((s) => ({ ...s, panels: s.panels.filter((p) => can(p.need)) }))
    .filter((s) => s.panels.length);

  const fromOld = params.from ? sectionFor(params.from, params.tab) : {};
  let section = mine.find((s) => s.key === (params.section || fromOld.section)) ?? mine[0];
  let panel = section?.panels.find((p) => p.key === (params.panel || fromOld.panel)) ?? section?.panels[0];
  let query = '';

  const content = h('div.settings-body');
  const nav = h('nav.settings-nav', { 'aria-label': 'Settings topics' });
  const panelTabs = h('div.settings-panels');

  const matches = (p, s) => {
    if (!query) return true;
    const hay = `${s.label} ${s.hint ?? ''} ${p.label} ${p.words ?? ''}`.toLowerCase();
    return query.split(/\s+/).every((w) => hay.includes(w));
  };

  const paintNav = () => {
    const shown = mine.filter((s) => s.panels.some((p) => matches(p, s)));
    mount(nav, shown.length
      ? shown.map((s) => h('button.settings-topic', {
        type: 'button',
        class: s.key === section?.key ? 'settings-topic on' : 'settings-topic',
        'aria-current': s.key === section?.key ? 'true' : null,
        onclick: () => open(s, null),
      }, h('span', s.label), s.hint ? h('small', s.hint) : null))
      : h('p.muted', 'No setting matches that.'));
    // On a phone the topics are a row that scrolls; keep the chosen one in view.
    const on = nav.querySelector('.settings-topic.on');
    if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, on.offsetLeft - 16);
  };

  const paintTabs = () => {
    const shown = section.panels.filter((p) => matches(p, section));
    mount(panelTabs, shown.length > 1 || section.panels.length > 1
      ? h('div.seg.seg-wrap', (shown.length ? shown : section.panels).map((p) => h('button', {
        type: 'button', class: p.key === panel.key ? 'active' : '', onclick: () => open(section, p),
      }, p.label)))
      : null);
  };

  const open = async (s, p) => {
    section = s;
    const shown = s.panels.filter((x) => matches(x, s));
    panel = p ?? shown[0] ?? s.panels[0];
    replaceParams('settings', { section: section.key, panel: panel.key });
    paintNav();
    paintTabs();
    mount(content, h('div.card', h('div.skeleton', { style: { height: '160px' } })));
    try {
      mount(content, await panel.render());
    } catch (err) {
      mount(content, h('div.card.empty', h('h3', 'Could not load this'), h('p.muted', err.message)));
    }
  };

  const search = h('input', {
    type: 'search',
    placeholder: 'Search settings, e.g. grace or PAYE',
    'aria-label': 'Search settings',
    oninput: () => {
      query = search.value.trim().toLowerCase();
      const first = mine.find((s) => s.panels.some((p) => matches(p, s)));
      if (query && first && !first.panels.includes(panel)) open(first, null);
      else { paintNav(); paintTabs(); }
    },
  });

  mount(host,
    h('div.page-head',
      h('div', h('h1', 'Settings'), h('div.sub', 'Everything that is set once, in one place')),
      h('label.settings-search', search)),
    h('div.settings-layout', nav, h('div.settings-main', panelTabs, content)));

  if (section) await open(section, panel);
  else mount(content, h('p.muted', 'Nothing here for your login.'));
  return host;
}
