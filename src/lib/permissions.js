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
    key: 'att_rota_view',
    label: 'See the rota',
    detail: 'Read the rota for everybody, week by week, and nothing else: who is on what and '
      + 'when. Cannot change a shift, publish, import or copy a week, and sees no clock times, '
      + 'no lateness, no leave balances and nothing anybody has asked for',
  },
  {
    key: 'att_rota',
    label: 'Rota & leave requests',
    detail: 'Set the rota and put leave in for people. No approvals, no balances',
  },
  {
    key: 'att_times',
    label: 'Correct clock times',
    detail: 'Put a wrong or missing clock-in or clock-out right. Every change is recorded '
      + 'and the administrators are told. Does not settle a day or approve anything',
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
    key: 'hr_pay',
    label: 'Pay and labour cost',
    detail: 'See and set what people are paid, and read the rota in money. Held by nobody by '
      + 'default: a manager needs contact details and contracts, and what a colleague earns is a '
      + 'different order of confidence. This alone does not open the payroll: an '
      + 'administrator has to grant that separately, with an end date and a code',
  },
  {
    key: 'rec_view',
    label: 'Recruitment',
    detail: 'See the vacancies, who has applied, the interview diary and what was decided. '
      + 'Reads a candidate\u2019s CV and the scores. Changes nothing',
  },
  {
    key: 'rec_manage',
    label: 'Run the recruitment',
    detail: 'Open vacancies, add candidates, publish interview times, make the link a candidate '
      + 'picks a time on, score an interview and move people along. Taking somebody on is '
      + 'separate: that puts them on the books, which needs attendance setup as well',
  },
  {
    key: 'corr_view',
    label: 'Letters',
    detail: 'Read the correspondence register and what has been sent',
  },
  {
    key: 'corr_write',
    label: 'Write letters',
    detail: 'Draft letters, send them for signature, file replies, keep the address book',
  },
  {
    key: 'corr_sign',
    label: 'Sign for the property',
    detail: 'Sign a letter and apply the company stamp. Requires the signer’s own '
      + 'password or PIN at the moment of signing',
  },
  {
    key: 'att_me',
    label: 'My shifts',
    detail: 'Their own published rota, their own attendance, their own leave requests and the '
      + 'days they cannot work. Nothing about anybody else, and no overtime figure — what '
      + 'somebody is owed is settled at sign-off, not read off a screen midweek',
  },
  {
    key: 'lunch',
    label: 'Lunch orders',
    detail: 'Set the week\u2019s meals, hold the link staff order on, and read the count the '
      + 'kitchen orders against. Sees who is on the rota and who is eating, and nothing else',
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
    detail: 'Builds the rota, puts leave in for people, and can put a wrong clock time right — '
      + 'recorded against their name, with the administrators told each time. Cannot approve '
      + 'leave, cannot settle a missing clock-out, and cannot see how much leave anybody has '
      + 'left. Add "Sign off attendance" to let them close months off as well, still without '
      + 'the balances.',
    defaults: ['att_view', 'att_rota', 'att_times'],
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
    detail: 'Everything a supervisor does, plus the reports, the rota, approving leave, the '
      + 'employee records, recruitment and the letter register. Add "Sign for the property" to '
      + 'let them sign and stamp letters. Taking somebody on stays with an administrator.',
    defaults: ['att_view', 'att_reports', 'att_manage', 'hr_view', 'hr_manage',
      'rec_view', 'rec_manage', 'corr_view', 'corr_write', 'lunch'],
  },
  {
    key: 'viewer',
    label: 'Reports only',
    detail: 'Reads the reports and exports them. Changes nothing — right for whoever does the wages.',
    defaults: ['att_view', 'att_reports'],
  },
  {
    key: 'rota_reader',
    label: 'Rota, read only',
    detail: 'One screen: the rota for everybody, week by week, exactly as the planner left it. '
      + 'Changes nothing and reads nothing else — for a head of department, an owner, or '
      + 'whoever needs to know who is on without being able to move anybody.',
    defaults: ['att_rota_view'],
  },
  {
    key: 'staff',
    label: 'Member of staff',
    detail: 'Sees their own shifts once they are published, their own attendance, and can ask '
      + 'for leave or say which days they cannot work. Sees nothing about anybody else. Give '
      + 'the account a PIN and point it at their staff record.',
    defaults: ['att_me'],
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

  // Somebody who is on the rota as well as running it sees their own week.
  //
  // A supervisor who works shifts, a manager who covers a night, an
  // administrator who is also on the payroll: pointing their login at a staff
  // record is what says so, and once it is said the screens about themselves
  // are theirs whatever else they hold. Nothing else follows from it, and it
  // grants nothing about anybody else.
  if (user.staff_id != null && !list.includes('att_me')) list.push('att_me');

  if (user.role === 'admin' && !list.includes('users')) list.push('users');
  // And the same argument for the employee records: an administrator who could
  // not open them would be looking at the one screen that can grant them.
  if (user.role === 'admin') {
    for (const key of ['hr_view', 'hr_manage', 'rec_view', 'rec_manage',
      'corr_view', 'corr_write', 'corr_sign']) {
      if (!list.includes(key)) list.push(key);
    }
  }
  // Managing records is strictly more than reading them, so holding the larger
  // permission holds the smaller one and no route has to name both.
  if (list.includes('hr_manage') && !list.includes('hr_view')) list.push('hr_view');
  // Running the recruitment is strictly more than reading it, the same way
  // managing records is more than reading them.
  if (list.includes('rec_manage') && !list.includes('rec_view')) list.push('rec_view');
  // Writing a letter and signing one are separate on purpose — the point of
  // the split is that whoever drafts is not necessarily whoever signs — but
  // both of them have to be able to read the register.
  for (const key of ['corr_write', 'corr_sign']) {
    if (list.includes(key) && !list.includes('corr_view')) list.push('corr_view');
  }
  // Anybody who can set the property up can obviously run the rota; a setup
  // holder who could not touch it would be looking at a control that refused
  // them.
  if (list.includes('att_setup') && !list.includes('att_manage')) list.push('att_manage');
  // Settling a day already supplies clock times, so anybody who can do that can
  // obviously correct one on its own. The narrow permission exists so that
  // whoever builds the rota can be given the correcting without the deciding —
  // not so that the deciding can be given without the correcting.
  if (list.includes('att_manage') && !list.includes('att_times')) list.push('att_times');
  // Deciding leave and settling days is strictly more than building the rota,
  // so anybody holding the larger permission holds the smaller one. Without
  // this every rota route would have to name both for the rest of time.
  if (list.includes('att_manage') && !list.includes('att_rota')) list.push('att_rota');
  // And building it is strictly more than reading it, so no route has to name
  // both for the rest of time.
  if (list.includes('att_rota') && !list.includes('att_rota_view')) list.push('att_rota_view');
  // Settling a day and approving leave are both larger than closing a period
  // off, so anybody who can do those can do this. Reports-only does not get it:
  // that role changes nothing by definition, and signing off moves leave.
  if (list.includes('att_manage') && !list.includes('att_signoff')) list.push('att_signoff');
  // And anybody who can do anything here needs the screen the rest hangs off.
  //
  // Two exceptions, and they are the same exception twice. "My shifts" is
  // deliberately the whole of what a member of staff holds, and reading the
  // rota is deliberately the whole of what a rota reader holds: both are
  // leaves rather than a way in, and handing either of them the property's
  // attendance screen — who clocked in, who was late, what needs dealing with
  // — would undo the point of giving them the narrow one.
  const leaves = new Set(['att_me', 'att_rota_view']);
  const running = list.filter((p) => p.startsWith('att_') && !leaves.has(p));
  if (running.length && !list.includes('att_view')) list.push('att_view');
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
