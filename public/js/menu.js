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
 */
export const HEADINGS_FROM = 6;

/**
 * The groups this login can open, and which screens of each.
 *
 * `holds` answers "may they open this screen", which is the app's own
 * permission test rather than a second copy of it. A group nobody holds a
 * single screen of is not in the list at all, which is what keeps a rota
 * reader's menu two entries long.
 */
export function openGroups(routes, groups, holds) {
  const out = [];
  for (const group of groups) {
    const all = routes.filter((r) => r.group === group.key && !r.hidden);
    const screens = all.filter((r) => holds(r));
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

/** The tab labels for a group, in the order they are read. */
export function tabsOf(group) {
  if (!group || group.screens.length < 2) return [];
  return group.screens.map((r) => ({ path: r.path, label: r.tab ?? r.label }));
}
