// What a person is allowed to reach.
//
// Permissions are checked on the server for every request. The menu hides what
// you cannot use, but hiding is a courtesy — the gate is the API.
//
// Split four ways, and the split is the point. A supervisor settling this
// morning's missing clock-outs needs to see who was in and to record what
// happened; they have no business seeing what anybody is paid, and no reason to
// be able to delete a shift. Whoever sets the property up does the opposite,
// twice a year.

export const PERMISSIONS = [
  {
    key: 'att_view',
    label: 'Attendance today',
    detail: "Who clocked in, and what needs dealing with",
  },
  {
    key: 'att_reports',
    label: 'Attendance reports',
    detail: 'Days worked, hours, lateness, leave balances, exports',
  },
  {
    key: 'att_manage',
    label: 'Rota & decisions',
    detail: 'Set the rota, settle incomplete days, approve leave',
  },
  {
    key: 'att_setup',
    label: 'Attendance setup',
    detail: 'Staff, shifts, absence reasons, holidays, terminals, rules',
  },
  {
    key: 'users',
    label: 'Users & data',
    detail: 'Manage logins, notifications and erasing data',
  },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export const ROLES = [
  {
    key: 'supervisor',
    label: 'Supervisor',
    detail: "Clears the morning's list — who was in, who was late, whose clock-out is missing. "
      + 'Sees no wages and no leave balances.',
    defaults: ['att_view', 'att_manage'],
  },
  {
    key: 'manager',
    label: 'Manager',
    detail: 'Everything a supervisor does, plus the reports, the rota and approving leave.',
    defaults: ['att_view', 'att_reports', 'att_manage'],
  },
  {
    key: 'viewer',
    label: 'Reports only',
    detail: 'Reads the reports and exports them. Changes nothing — right for whoever does the wages.',
    defaults: ['att_view', 'att_reports'],
  },
  {
    key: 'admin',
    label: 'Administrator',
    detail: 'Everything, including setting the property up and managing logins.',
    defaults: PERMISSION_KEYS,
  },
];

const ROLE_MAP = new Map(ROLES.map((r) => [r.key, r]));

export function isRole(value) {
  return ROLE_MAP.has(value);
}

export function defaultPermissions(role) {
  return [...(ROLE_MAP.get(role)?.defaults ?? ['att_view'])];
}

/**
 * Resolve a user's effective permissions. A stored list overrides the role
 * defaults, which is how "what they see" is customised per person.
 *
 * Admins always keep `users`; otherwise the last administrator could edit
 * themselves out of the only screen that can undo it.
 */
export function effectivePermissions(user) {
  if (!user) return [];
  let list = defaultPermissions(user.role);

  if (user.permissions) {
    try {
      const parsed = typeof user.permissions === 'string'
        ? JSON.parse(user.permissions)
        : user.permissions;
      if (Array.isArray(parsed)) {
        list = parsed.filter((p) => PERMISSION_KEYS.includes(p));
      }
    } catch {
      // A malformed override falls back to the role defaults rather than
      // locking the person out of everything.
    }
  }

  if (user.role === 'admin' && !list.includes('users')) list.push('users');
  // Anybody who can set the property up can obviously run the rota; a setup
  // holder who could not touch it would be looking at a control that refused
  // them.
  if (list.includes('att_setup') && !list.includes('att_manage')) list.push('att_manage');
  // And anybody who can do anything here needs the screen the rest hangs off.
  if (list.length && !list.includes('att_view') && list.some((p) => p.startsWith('att_'))) {
    list.push('att_view');
  }
  return list;
}

export function can(user, permission) {
  if (!permission) return true;
  return effectivePermissions(user).includes(permission);
}

/**
 * Does a signed-in person's list satisfy what a route asks for?
 *
 * A route may name a list instead of a single permission, and a list means
 * "any one of these" — the rota is reachable both by whoever maintains it and
 * by whoever only reads it into a report.
 *
 * `null` — a route with nothing to check — lets anybody signed in through.
 */
export function allows(required, held = []) {
  if (!required) return true;
  const needed = Array.isArray(required) ? required : [required];
  if (!needed.length) return true;
  return needed.some((p) => held.includes(p));
}
