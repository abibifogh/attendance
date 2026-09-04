/**
 * Every kind of notice the app sends, named and grouped.
 *
 * Written down here because a list of switches nobody can read is a list
 * nobody touches. `attendance.availability_decided` is a key; "Your day off
 * was approved" is a thing somebody recognises, and the difference decides
 * whether a property ever manages its own notifications or just leaves them.
 *
 * WHAT EACH ROW SAYS. The label is what arrives. `who` is who it goes to,
 * because a switch is turned off for the wrong reason when somebody thinks a
 * notice everybody gets is one only managers get. `ways` is which routes out
 * this kind ever uses, so the screen shows three columns and greys the ones
 * that were never going to apply.
 *
 * THE BELL IS NOT A SWITCH. Every notice is recorded whether or not anybody is
 * told about it: the list in the bell is the record of what happened, and a
 * record with holes in it where somebody turned a switch off is worse than no
 * record. What can be turned off is the interrupting: the alert on a phone and
 * the email in an inbox.
 */

export const GROUPS = [
  ['rota', 'The rota'],
  ['day', 'The working day'],
  ['leave', 'Leave and availability'],
  ['money', 'Money'],
  ['people', 'People and hiring'],
  ['house', 'The property'],
];

/**
 * ways: the routes this kind takes unless somebody says otherwise. Not a
 * limit. Every kind can be sent every way, and what is listed here is the
 * app's own judgement about which of them are worth interrupting somebody
 * over by default. A property that wants the lot has only to tick them.
 *
 * The bell is not in the list because it is not optional: every notice is
 * recorded, and the list in the bell is the record of what happened.
 */
export const KINDS = [
  // The rota
  {
    key: 'rota.published.mine',
    group: 'rota',
    label: 'Your shifts are out',
    who: 'Each person the rota changed something for',
    when: 'A rota is published',
    ways: ['push', 'email', 'text'],
    note: 'The one notice most people ever act on. Turning the alert off here means '
      + 'somebody finds out about Saturday on Saturday.',
  },
  {
    key: 'rota.published',
    group: 'rota',
    label: 'The rota has been published',
    who: 'Everybody, when the planner chooses "tell everybody"',
    when: 'A rota is published',
    ways: ['email'],
    note: 'The house announcement. It carries no alert of its own: the people it is '
      + 'about have already had one.',
  },

  // The working day
  {
    key: 'attendance.not_clocked_in',
    group: 'day',
    label: 'Your shift has started and nothing was recorded',
    who: 'The person whose shift it is',
    when: 'Every half hour after a shift starts, until they clock in',
    ways: ['push'],
  },
  {
    key: 'attendance.clock_out_due',
    group: 'day',
    label: 'Your shift is ending',
    who: 'The person whose shift it is',
    when: 'A shift they clocked into is about to end',
    ways: ['push'],
  },
  {
    key: 'attendance.running_late',
    group: 'day',
    label: 'Somebody is running late',
    who: 'Whoever watches the day',
    when: 'A member of staff says so from their own screen',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.query',
    group: 'day',
    label: 'A day is being queried',
    who: 'Whoever settles the morning list',
    when: 'Somebody disputes what the app made of a day',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.query_answered',
    group: 'day',
    label: 'A query has been answered',
    who: 'Whoever signs the period off',
    when: 'A query is settled',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.times',
    group: 'day',
    label: 'A clock time was corrected',
    who: 'Whoever asked for the correction',
    when: 'A correction is approved or turned down',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.days_applied',
    group: 'day',
    label: 'A signed period has moved',
    who: 'Whoever reads the reports',
    when: 'Days are given back after a period was signed off',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.terminal_quiet',
    group: 'day',
    label: 'A terminal has gone quiet',
    who: 'Whoever watches the day',
    when: 'A clock stops reporting for long enough to matter',
    ways: ['push', 'email'],
    note: 'Worth leaving on. A quiet terminal is a day of attendance nobody has, and it '
      + 'is only cheap to fix while it is still happening.',
  },
  {
    key: 'attendance.terminal_back',
    group: 'day',
    label: 'A terminal is back',
    who: 'Whoever watches the day',
    when: 'A quiet clock starts reporting again',
    ways: ['push', 'email'],
  },

  // Leave and availability
  {
    key: 'attendance.leave_asked',
    group: 'leave',
    label: 'Somebody has asked for leave',
    who: 'Whoever answers leave',
    when: 'A request is made',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.leave_decided',
    group: 'leave',
    label: 'Your leave was approved or turned down',
    who: 'Whoever asked',
    when: 'A decision is made',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.leave_type',
    group: 'leave',
    label: 'Your leave was recorded as something else',
    who: 'Whoever asked',
    when: 'The kind of leave is changed after the fact',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.availability_asked',
    group: 'leave',
    label: 'Somebody cannot work a day',
    who: 'Whoever plans the rota',
    when: 'A member of staff creates unavailability',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.availability_decided',
    group: 'leave',
    label: 'Your unavailability was answered',
    who: 'Whoever asked',
    when: 'A planner approves or refuses it',
    ways: ['push', 'email'],
  },

  // Money
  {
    key: 'advance.asked',
    group: 'money',
    label: 'Somebody has asked for a salary advance',
    who: 'Whoever runs payroll',
    when: 'A request is made',
    ways: ['push', 'email'],
  },
  {
    key: 'advance.approved',
    group: 'money',
    label: 'Your advance is approved',
    who: 'Whoever asked',
    when: 'A decision is made',
    ways: ['push', 'email'],
  },
  {
    key: 'advance.declined',
    group: 'money',
    label: 'Your advance was turned down',
    who: 'Whoever asked',
    when: 'A decision is made',
    ways: ['push', 'email'],
  },
  {
    key: 'advance.given',
    group: 'money',
    label: 'An advance has been recorded for you',
    who: 'The person it is for',
    when: 'Payroll records one directly',
    ways: ['push', 'email'],
  },
  {
    key: 'advance.settled',
    group: 'money',
    label: 'Your advance is paid off',
    who: 'The person it was for',
    when: 'The last repayment goes through',
    ways: ['push', 'email'],
  },
  {
    key: 'advance.month_end',
    group: 'money',
    label: 'Advances to close off this month',
    who: 'Whoever runs payroll',
    when: 'The month is being closed',
    ways: ['push', 'email'],
  },
  {
    key: 'medical.claimed',
    group: 'money',
    label: 'Somebody has claimed medical bills',
    who: 'Whoever runs payroll',
    when: 'A claim is made',
    ways: ['push', 'email'],
  },
  {
    key: 'medical.approved',
    group: 'money',
    label: 'Your medical claim is approved',
    who: 'Whoever claimed',
    when: 'A decision is made',
    ways: ['push', 'email'],
  },
  {
    key: 'medical.rejected',
    group: 'money',
    label: 'Your medical claim was not approved',
    who: 'Whoever claimed',
    when: 'A decision is made',
    ways: ['push', 'email'],
  },
  {
    key: 'payroll.penalty',
    group: 'money',
    label: 'Something has come off your bonus',
    who: 'The person it comes off',
    when: 'A month is closed with a deduction on it',
    ways: ['push', 'email'],
  },

  // People and hiring
  {
    key: 'recruitment.on_panel',
    group: 'people',
    label: 'You are down to interview',
    who: 'Whoever is on the panel',
    when: 'They are added to one',
    ways: ['push', 'email'],
  },
  {
    key: 'recruitment.off_panel',
    group: 'people',
    label: 'You are no longer interviewing',
    who: 'Whoever was on the panel',
    when: 'They are taken off',
    ways: ['push', 'email'],
  },
  {
    key: 'recruitment.booked',
    group: 'people',
    label: 'An interview is booked',
    who: 'Whoever is interviewing',
    when: 'A candidate takes a slot',
    ways: ['push', 'email'],
  },
  {
    key: 'recruitment.cancelled',
    group: 'people',
    label: 'An interview is off',
    who: 'Whoever was interviewing',
    when: 'A slot is cancelled',
    ways: ['push', 'email'],
  },
  {
    key: 'recruitment.released',
    group: 'people',
    label: 'A candidate has given back their time',
    who: 'Whoever is interviewing',
    when: 'A candidate releases a slot',
    ways: ['push', 'email'],
  },
  {
    key: 'recruitment.hired',
    group: 'people',
    label: 'Somebody has been taken on',
    who: 'Whoever manages records',
    when: 'A candidate is hired',
    ways: ['push', 'email'],
  },

  // The property
  {
    key: 'birthday.today',
    group: 'house',
    label: 'It is somebody’s birthday',
    who: 'Everybody',
    when: 'The morning of the day',
    ways: ['push', 'email'],
    note: 'The one notice that goes to the whole house for something nobody has to do.',
  },
  {
    key: 'birthday.prompt',
    group: 'house',
    label: 'A birthday is coming up',
    who: 'Whoever watches the day',
    when: 'A few days before',
    ways: ['push', 'email'],
  },
  {
    key: 'birthday.wish',
    group: 'house',
    label: 'Somebody has wished you a happy birthday',
    who: 'Whoever the wish is for',
    when: 'A colleague sends one',
    ways: ['push', 'email'],
  },
];

export const BY_KEY = new Map(KINDS.map((k) => [k.key, k]));

/** Where the per-kind switches live. One row rather than forty. */
export const CHANNELS_KEY = 'notice_channels';

/**
 * Read the switches, forgivingly.
 *
 * A missing key, a broken value or a kind nobody has touched all mean the
 * same thing: send it. Notifications default to on because the app already
 * decided a notice was worth raising, and deciding that twice is how the
 * second decision comes to be forgotten.
 */
export function readChannels(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Whether this kind may go out this way. Anything not said is yes. */
export const WAYS = ['push', 'email', 'text'];

/**
 * Whether this kind goes out this way.
 *
 * Three answers rather than two, and the middle one is the point: a kind
 * nobody has touched follows the app's default, a kind somebody has ticked
 * goes out whether or not it ever did before, and a kind somebody has unticked
 * stays quiet whatever the code that raised it wanted.
 *
 * `wanted` is what the raising code asked for, which it sometimes knows better
 * than any setting can: a rota announcement carries no alert because the
 * people it is about have already had one. That judgement holds until somebody
 * overrules it on purpose.
 */
export function goesOut(channels, kind, way, wanted = null) {
  const row = channels?.[kind];
  const said = row && typeof row === 'object' ? row[way] : undefined;

  // What somebody put on the screen wins, in either direction. That is the
  // whole point of the screen.
  if (said === 1 || said === true) return true;
  if (said === 0 || said === false) return false;

  // Nothing said, so the raising code may suppress but never force. Some of it
  // knows things no setting can, and all of those are reasons to stay quiet:
  // this person's phone has already buzzed once about this exact thing. A
  // default in the code that could outvote the screen the other way would make
  // the screen a decoration.
  if (wanted === false) return false;

  // And otherwise the app's default for this kind. A kind the catalogue does
  // not list is something new in the code and not yet on the screen: worth a
  // bell and an alert, and not worth spending money on unasked.
  const known = BY_KEY.get(kind);
  return known ? known.ways.includes(way) : way !== 'text';
}

/**
 * Whether somebody has switched this off, and nothing more.
 *
 * For a caller that means to send: the rota's own texting has already worked
 * out per person that a text is the only way of reaching them, and the only
 * question left for the screen is whether the property wants that at all.
 */
export function notTurnedOff(channels, kind, way) {
  const row = channels?.[kind];
  const said = row && typeof row === 'object' ? row[way] : undefined;
  return said !== 0 && said !== false;
}

/**
 * Who else this kind goes to, beyond whoever it is already addressed to.
 *
 * Permissions rather than names, so a notice added for "whoever signs the
 * period off" keeps reaching somebody promoted tomorrow and stops reaching
 * somebody demoted yesterday. The built-in recipient is never taken away here:
 * turning off "your leave was approved" for the person who asked for it is not
 * a setting anybody wants and is a support call waiting to happen.
 */
export function alsoFor(channels, kind) {
  const row = channels?.[kind];
  const also = row && typeof row === 'object' ? row.also : null;
  return Array.isArray(also) ? also.filter((p) => typeof p === 'string' && p) : [];
}

/**
 * Tidy what a screen sends before it is stored.
 *
 * Only the kinds we know about, only the ways they have, and only the offs:
 * an "on" is the default and writing it down would freeze today's default into
 * every installation that ever pressed Save.
 */
export function tidyChannels(input, permissions = null) {
  const allowed = permissions ? new Set(permissions) : null;
  const out = {};

  for (const kind of KINDS) {
    const row = input?.[kind.key];
    if (!row || typeof row !== 'object') continue;
    const kept = {};

    for (const way of WAYS) {
      const on = row[way] === 1 || row[way] === true;
      const off = row[way] === 0 || row[way] === false;
      const byDefault = kind.ways.includes(way);
      // Only a disagreement with the default is worth writing down. Storing an
      // agreement freezes today's judgement into an installation that pressed
      // Save once, and the whole point of a default is that it moves.
      if (on && !byDefault) kept[way] = 1;
      if (off && byDefault) kept[way] = 0;
    }

    const also = Array.isArray(row.also)
      ? [...new Set(row.also.map(String).filter((p) => !allowed || allowed.has(p)))]
      : [];
    if (also.length) kept.also = also;

    if (Object.keys(kept).length) out[kind.key] = kept;
  }
  return out;
}
