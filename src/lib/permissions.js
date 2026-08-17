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
    key: 'att_rota',
    label: 'Rota & leave requests',
    detail: 'Set the rota and put leave in for people. No approvals, no balances',
  },
  {
    key: 'att_signoff',
    label: 'Sign off attendance',
    detail: 'Close a day, week or month off and move the days. Still no balances',
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
    key: 'hr_view',
    label: 'Employee records',
    detail: 'Read personal details, contacts and contracts. Sensitive numbers stay masked',
  },
  {
    key: 'hr_manage',
    label: 'Manage employee records',
    detail: 'Edit records, send links, accept what people send in, issue and sign contracts',
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
    key: 'planner',
    label: 'Rota planner',
    detail: 'Builds the rota and puts leave in for people. Cannot approve leave, cannot settle '
      + 'a missing clock-out, and cannot see how much leave anybody has left. Add '
      + '"Sign off attendance" to let them close months off as well, still without the balances.',
    defaults: ['att_view', 'att_rota'],
  },
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
    detail: 'Everything a supervisor does, plus the reports, the rota, approving leave and the '
      + 'employee records.',
    defaults: ['att_view', 'att_reports', 'att_manage', 'hr_view', 'hr_manage'],
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
  // And the same argument for the employee records: an administrator who could
  // not open them would be looking at the one screen that can grant them.
  if (user.role === 'admin') {
    for (const key of ['hr_view', 'hr_manage']) if (!list.includes(key)) list.push(key);
  }
  // Managing records is strictly more than reading them, so holding the larger
  // permission holds the smaller one and no route has to name both.
  if (list.includes('hr_manage') && !list.includes('hr_view')) list.push('hr_view');
  // Anybody who can set the property up can obviously run the rota; a setup
  // holder who could not touch it would be looking at a control that refused
  // them.
  if (list.includes('att_setup') && !list.includes('att_manage')) list.push('att_manage');
  // Deciding leave and settling days is strictly more than building the rota,
  // so anybody holding the larger permission holds the smaller one. Without
  // this every rota route would have to name both for the rest of time.
  if (list.includes('att_manage') && !list.includes('att_rota')) list.push('att_rota');
  // Settling a day and approving leave are both larger than closing a period
  // off, so anybody who can do those can do this. Reports-only does not get it:
  // that role changes nothing by definition, and signing off moves leave.
  if (list.includes('att_manage') && !list.includes('att_signoff')) list.push('att_signoff');
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
