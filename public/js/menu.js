/**
 * What goes in the menu.
 *
 * The app had twenty-three screens and twenty-three links, and an
 * administrator opening it was reading a list longer than anybody ever used.
 * Every screen is still here and still has its own address; what this decides
 * is which of them share a link, what that link is called, and where a heading
 * earns its line.
 *
 * Kept apart from the app so it can be reasoned about on its own. Who sees
 * what is the part of a menu that goes quietly wrong, and it is not something
 * you find by clicking around as yourself.
 */

/**
 * Below this many links a heading is furniture.
 *
 * A supervisor's menu is two entries long. Putting THE DAY over one of them
 * explains nothing and takes a line doing it.
 *
 * Seven rather than six since a member of staff got their own contract. Their
 * menu is six links, and cutting it gave them MINE over three, THE PEOPLE over
 * a single Directory, and the last two under nothing: two lines of heading for
 * a list that was already readable in one look.
 */
export const HEADINGS_FROM = 7;

/**
 * The groups this login can open, and which screens of each.
 *
 * `holds` answers "may they open this screen", which is the app's own
 * permission test rather than a second copy of it. A group nobody holds a
 * single screen of is not in the list at all, which is what keeps a rota
 * reader's menu two entries long.
 */
export function openGroups(routes, groups, holds, keyOf = (r) => r.group) {
  const out = [];
  for (const group of groups) {
    const all = routes.filter((r) => keyOf(r) === group.key && !r.hidden);
    // A screen that is a tab in one menu and only an address in the other.
    const screens = all.filter((r) => holds(r))
      .map((r) => (keyOf.mode === 'manager' && r.mnotab ? { ...r, notab: true } : r));
    if (!screens.length) continue;
    // The group's own name when its first screen is one of them, and that
    // screen's name when it is not. A manager holds the workload and the
    // lunch list but not the rota itself, and a link reading "Rota" that
    // cannot open the rota is a link that lies.
    const named = all[0] && screens[0].path === all[0].path;
    out.push({ ...group, screens, label: named ? group.label : screens[0].label });
  }
  return out;
}

/** Which group the screen on the page belongs to. */
export function groupOf(groups, path) {
  if (!path) return null;
  return groups.find((g) => g.screens.some((r) => r.path === path)) ?? null;
}

/**
 * The menu, cut into runs that share a heading.
 *
 * A group with no section of its own ends the run it followed rather than
 * joining it, which is how Setup and Guide come out as a plain pair at the
 * bottom instead of being swept under whatever heading came last.
 */
export function menuRuns(groups) {
  // Short enough to read at a glance, so it stays one run with nothing over
  // it. Cutting a menu of three into three headed sections is worse than not
  // cutting it at all.
  if (groups.length < HEADINGS_FROM) return [{ section: null, groups }];

  const runs = [];
  for (const group of groups) {
    const section = group.section ?? null;
    const last = runs[runs.length - 1];
    if (last && last.section === section) last.groups.push(group);
    else runs.push({ section, groups: [group] });
  }
  return runs;
}

/**
 * Which tab a screen lights.
 *
 * A screen with `part` is one view of a bigger page (Leave's Plans, Reports'
 * Month) and lights that page's tab; `lights` does the same for a screen that
 * is reached from a page rather than from the menu.
 */
export const familyOf = (r) => r?.part ?? r?.lights ?? r?.path;

/**
 * The tab labels for a group, in the order they are read.
 *
 * One tab per page, however many views the page has. The tab opens the first
 * view this login may see, so somebody who holds Month but not Week still
 * gets a Reports tab, and it opens on Month.
 */
export function tabsOf(group) {
  if (!group) return [];
  const tabs = [];
  for (const r of group.screens) {
    if (r.notab) continue;
    const family = familyOf(r);
    if (tabs.some((t) => t.family === family)) continue;
    tabs.push({ path: r.path, family, label: r.tab ?? r.label });
  }
  return tabs.length < 2 ? [] : tabs;
}

/**
 * The views of the page somebody is on, as a smaller row under the tabs.
 *
 * Empty when the page has only one view this login can open.
 */
export function segmentsOf(group, path) {
  if (!group) return [];
  const here = group.screens.find((r) => r.path === path);
  if (!here) return [];
  const family = familyOf(here);
  const views = group.screens.filter((r) => !r.notab && (r.part ?? r.path) === family);
  return views.length < 2 ? [] : views.map((r) => ({ path: r.path, label: r.seg ?? r.tab ?? r.label }));
}

/** Where a route sits in a given menu. */
export const groupKeyFor = (mode) => Object.assign(mode === 'manager' ? (r) => r.mgroup ?? r.group : (r) => r.group, { mode });

/**
 * The tabs of a person's own screens in the manager menu.
 *
 * Only the ones marked `mtab` are tabs. A screen `under` one of them (swaps
 * under shifts, claims under pay) lights its parent and brings its own
 * siblings up as a second, smaller row, so a manager's own pages read the way
 * a member of staff's do without five rows of tabs.
 */
export function mineTabs(group, path) {
  if (!group) return { tabs: [], parent: null, siblings: [] };
  const tabs = group.screens.filter((r) => r.mtab).map((r) => ({ path: r.path, label: r.mtab }));
  const here = group.screens.find((r) => r.path === path);
  const parent = here?.mtab ? here.path : here?.under ?? null;
  const siblings = parent
    ? group.screens.filter((r) => !r.notab && (r.path === parent || r.under === parent))
      .map((r) => ({ path: r.path, label: r.tab ?? r.label }))
    : [];
  return { tabs, parent, siblings: siblings.length > 1 ? siblings : [] };
}
