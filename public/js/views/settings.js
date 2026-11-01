import { can, replaceParams } from '../app.js';
import { h, mount } from '../util.js';
import { renderAttSetup } from './att-setup.js';
import { renderAdmin } from './admin.js';
import { renderNotifications } from './notifications.js';
import { renderCompanies } from './companies.js';
import { renderPeopleForm } from './people-form.js';
import { renderChecklistSetup } from './onboarding.js';
import { renderLunchSetup } from './att-lunch.js';
import { renderLateRuleSetup } from './late-charges.js';
import { renderLeavePlanSetup } from './leave-plans.js';

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
const cards = (titles) => setup('rules', { cards: titles });
const admin = (tab) => () => renderAdmin({ tab, embedded: true });
const notices = (tab) => () => renderNotifications({ tab, embedded: true });

/**
 * Eight sections, each one page somebody scrolls down.
 *
 * It was eight topics holding twenty-two panels behind a second row of tabs,
 * and six more setup screens kept on the pages they set up: the lunch times,
 * the year's leave planning, the new-starter form, the first-week checklist.
 * Now every rule and switch is here, under the part of the business it is
 * about, and each panel still saves on its own.
 */
export const SECTIONS = [
  {
    key: 'business', label: 'Business', hint: 'Companies, departments',
    panels: [
      { key: 'company', label: 'Main company', need: 'att_setup', render: setup('company'), words: 'name address tin ssnit employer logo phone email website tax office lto tsc' },
      { key: 'companies', label: 'Companies', need: 'att_setup', render: () => renderCompanies(), words: 'company employer second abibifo payroll payslips tin ssnit' },
      { key: 'property', label: 'Departments and links', need: 'att_setup', render: rules(['The property itself']), words: 'departments links days letter code otp' },
    ],
  },
  {
    key: 'people', label: 'People & logins', hint: 'Staff, roles, new starters',
    panels: [
      { key: 'staff', label: 'Staff', need: 'att_setup', render: setup('staff'), words: 'employee number department clock rota import' },
      { key: 'logins', label: 'Logins and roles', need: 'users', render: admin('people'), words: 'pin password role permission payroll access invite user' },
      { key: 'newstarter', label: 'New-starter form', need: 'hr_manage', render: () => renderPeopleForm({ embedded: true }), words: 'what to ask for form details documents new starter hire' },
      {
        key: 'firstweek', label: 'First week', need: ['att_setup', 'hr_manage'],
        render: async () => h('div',
          can('att_setup') ? await cards(['A first week for new hires'])() : null,
          can('hr_manage') ? await renderChecklistSetup() : null),
        words: 'onboarding checklist welcome steps first week new hire',
      },
      { key: 'staffsee', label: 'What staff can see', need: 'att_setup', render: cards(['The staff directory', 'The staff handbook']), words: 'directory handbook features' },
    ],
  },
  {
    key: 'rota', label: 'Rota & clocking', hint: 'Shifts, clocking, limits, lunch',
    panels: [
      { key: 'shifts', label: 'Shifts', need: 'att_setup', render: setup('shifts'), words: 'start end break grace colour' },
      { key: 'clocking', label: 'Clocking rules', need: 'att_setup', render: rules(['A day at work']), words: 'missing punch repeat taps window late early overtime quiet chasing' },
      { key: 'reasons', label: 'Absence reasons', need: 'att_setup', render: setup('reasons'), words: 'absent sick reason code' },
      { key: 'workload', label: 'Workload limits', need: 'att_setup', render: setup('workload'), words: 'hours limit days sunday sustainable rest' },
      { key: 'swaps', label: 'Swapping shifts', need: 'att_setup', render: cards(['Swapping shifts']), words: 'swap give up shift trade' },
      { key: 'lunch', label: 'Lunch', need: 'lunch', render: () => renderLunchSetup(), words: 'lunch link opens shuts times kitchen' },
    ],
  },
  {
    key: 'leave', label: 'Leave & holidays', hint: 'Rules, away at once, planning',
    panels: [
      { key: 'leave', label: 'Leave rules', need: 'att_setup', render: rules(['Time off']), words: 'annual leave days carry over qualify away at once year' },
      { key: 'planning', label: 'Planning the year', need: 'att_setup', render: () => renderLeavePlanSetup(), words: 'leave plan year busy season away at once department limit remind' },
      { key: 'staffleave', label: 'What staff see', need: 'att_setup', render: cards(['How much leave they have left', 'Public holidays on their report']), words: 'balance holidays report' },
      { key: 'holidays', label: 'Public holidays', need: 'att_setup', render: setup('holidays'), words: 'public holiday bank holiday' },
    ],
  },
  {
    key: 'pay', label: 'Pay & tax', hint: 'PAYE, SSNIT',
    panels: [
      { key: 'tax', label: 'Tax and SSNIT', need: 'att_setup', render: setup('tax'), words: 'paye bands ssnit tier bonus rate gra' },
      { key: 'late', label: 'Late charges', need: 'hr_pay', render: () => renderLateRuleSetup(), words: 'late charge fine deduction minutes clock in lateness' },
    ],
  },
  {
    key: 'notifications', label: 'Notifications', hint: 'What goes out, reminders',
    panels: [
      { key: 'kinds', label: 'What goes out', need: 'users', render: notices('kinds'), words: 'alert email text push kind' },
      { key: 'reminders', label: 'Reminders to staff', need: 'att_setup', render: rules(['What their phone tells them']), words: 'clock in reminder chase clock out phone' },
      { key: 'birthdays', label: 'Birthdays', need: 'att_setup', render: setup('birthdays'), words: 'birthday wish card' },
    ],
  },
  {
    key: 'connections', label: 'Connections', hint: 'Terminals, email, maps',
    panels: [
      { key: 'devices', label: 'Terminals', need: 'att_setup', render: setup('devices'), words: 'device terminal hikvision clock quiet' },
      { key: 'delivery', label: 'Email and texts', need: 'users', render: notices('setup'), words: 'from address reply copy cc sms gateway digest medical pay' },
      { key: 'maps', label: 'Maps', need: 'att_setup', render: setup('rules', { only: 'maps' }), words: 'maps key google places address' },
    ],
  },
  {
    key: 'data', label: 'Data & history', hint: 'What was sent, audit, backups',
    panels: [
      { key: 'sent', label: 'What was sent', need: 'users', render: notices('sent'), words: 'log sent history email push text' },
      { key: 'reach', label: 'Who can be reached', need: 'users', render: notices('reach'), words: 'reach phone email' },
      { key: 'audit', label: 'Audit trail', need: 'users', render: admin('audit'), words: 'audit decision history who' },
      { key: 'data', label: 'Backups and data', need: 'users', render: admin('data'), words: 'backup copy export erase' },
      { key: 'rebuild', label: 'Rebuild', need: 'att_setup', render: setup('rules', { only: 'rebuild' }), words: 'rebuild recompute work out again' },
    ],
  },
];

/** Section keys from before the eight, so an old link still lands. */
const OLD_SECTIONS = { company: 'business', shifts: 'rota', features: 'people' };
/** And panel keys that changed. */
const OLD_PANELS = { 'staff-can': 'staffsee' };

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
  const askedSection = OLD_SECTIONS[params.section] ?? params.section ?? fromOld.section;
  const askedPanel = OLD_PANELS[params.panel] ?? params.panel ?? fromOld.panel;
  let section = mine.find((s) => s.key === askedSection)
    ?? mine.find((s) => s.panels.some((p) => p.key === askedPanel))
    ?? mine[0];
  let query = '';

  const content = h('div.settings-body');
  const nav = h('nav.settings-nav', { 'aria-label': 'Settings sections' });

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
        onclick: () => open(s),
      }, h('span', s.label), s.hint ? h('small', s.hint) : null))
      : h('p.muted', 'No setting matches that.'));
    // On a phone the sections are a row that scrolls; keep the chosen one in view.
    const on = nav.querySelector('.settings-topic.on');
    if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, on.offsetLeft - 16);
  };

  // Which panels of this section the search leaves showing. Hidden rather
  // than thrown away, so clearing the box does not lose what was typed.
  const blocks = new Map();
  const filterPanels = () => {
    for (const p of section?.panels ?? []) {
      const el = blocks.get(p.key);
      if (el) el.hidden = !matches(p, section);
    }
  };

  const open = async (s, focus = null) => {
    section = s;
    replaceParams('settings', focus ? { section: s.key, panel: focus } : { section: s.key });
    paintNav();
    blocks.clear();
    const heads = s.panels.map((p) => {
      const body = h('div.settings-panel-body', h('div.card', h('div.skeleton', { style: { height: '120px' } })));
      const el = h('section.settings-panel', { id: `settings-${p.key}`, 'aria-labelledby': `settings-${p.key}-h` },
        s.panels.length > 1 ? h('h2.settings-panel-head', { id: `settings-${p.key}-h` }, p.label) : null,
        body);
      blocks.set(p.key, el);
      return { p, el, body };
    });
    // A long section is still one page; these jump down it.
    const jumps = s.panels.length > 2
      ? h('nav.settings-jumps', { 'aria-label': `Parts of ${s.label}` }, s.panels.map((p) => h('a', {
        href: `#/settings?section=${s.key}&panel=${p.key}`,
        onclick: (e) => {
          e.preventDefault();
          replaceParams('settings', { section: s.key, panel: p.key });
          blocks.get(p.key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      }, p.label)))
      : null;
    mount(content,
      h('div.settings-section-head', h('h2', s.label), s.hint ? h('p.muted', s.hint) : null, jumps),
      heads.map((x) => x.el));
    filterPanels();
    await Promise.all(heads.map(async ({ p, body }) => {
      try {
        mount(body, await p.render());
      } catch (err) {
        mount(body, h('div.card.empty', h('h3', 'Could not load this'), h('p.muted', err.message)));
      }
    }));
    if (focus && blocks.get(focus)) blocks.get(focus).scrollIntoView({ block: 'start' });
  };

  const search = h('input', {
    type: 'search',
    placeholder: 'Search settings, e.g. grace or PAYE',
    'aria-label': 'Search settings',
    oninput: () => {
      query = search.value.trim().toLowerCase();
      const first = mine.find((s) => s.panels.some((p) => matches(p, s)));
      if (query && first && !section.panels.some((p) => matches(p, section))) open(first);
      else { paintNav(); filterPanels(); }
    },
  });

  mount(host,
    h('div.page-head',
      h('div', h('h1', 'Settings'), h('div.sub', 'Everything that is set once, in one place')),
      h('label.settings-search', search)),
    h('div.settings-layout', nav, h('div.settings-main', content)));

  if (section) await open(section, section.panels.some((p) => p.key === askedPanel) ? askedPanel : null);
  else mount(content, h('p.muted', 'Nothing here for your login.'));
  return host;
}
