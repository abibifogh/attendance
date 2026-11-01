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

  {
    key: 'swap.offered',
    group: 'rota',
    label: 'A shift is going',
    who: 'The people who could cover it, or the ones it was put to by name',
    when: 'Somebody gives up a shift',
    ways: ['push', 'email'],
    note: 'Only the people who could actually take it. A shift offered to everybody is how '
      + 'a phone gets muted, and the muted phone then misses the rota going out.',
  },
  {
    key: 'swap.taken',
    group: 'rota',
    label: 'Somebody has taken your shift',
    who: 'Whoever gave it up',
    when: 'A colleague takes a shift off the board',
    ways: ['push', 'email'],
  },
  {
    key: 'swap.waiting',
    group: 'rota',
    label: 'A swap is waiting on you',
    who: 'Whoever sets the rota',
    when: 'Somebody takes a shift and it needs approving',
    ways: ['push', 'email'],
  },
  {
    key: 'swap.decided',
    group: 'rota',
    label: 'A swap has been settled',
    who: 'Both people',
    when: 'A swap is approved or turned down',
    ways: ['push', 'email'],
  },

  {
    key: 'hr_faq.changed',
    group: 'people',
    label: 'The HR FAQ has been updated',
    who: 'Everybody, when HR chooses to say so',
    when: 'HR presses "Tell staff" after changing answers',
    ways: ['push', 'email'],
  },
  {
    key: 'hr_faq.asked',
    group: 'people',
    label: 'Somebody has a question for HR',
    who: 'Whoever holds HR',
    when: 'A member of staff asks a question the FAQ did not answer',
    ways: ['push', 'email'],
  },
  {
    key: 'hr_faq.answered',
    group: 'people',
    label: 'HR has answered your question',
    who: 'The person who asked',
    when: 'HR answers',
    ways: ['push', 'email'],
  },
  {
    key: 'handbook.published',
    group: 'rota',
    label: 'A handbook chapter needs reading',
    who: 'Everybody it applies to',
    when: 'A chapter that asks for a tick or a signature is published',
    ways: ['push', 'email'],
    note: 'Only the chapters that ask for something back. A reference page appearing quietly '
      + 'is not news.',
  },

  // The working day
  {
    key: 'attendance.absence_question',
    group: 'day',
    label: 'Off sick, absent, or here?',
    who: 'Planners, supervisors and administrators',
    when: 'Half an hour after a shift starts with no clock-in, and again until somebody answers',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.logged_sick',
    group: 'day',
    label: 'You are down as off sick',
    who: 'The person off sick',
    when: 'A planner, supervisor or administrator answers that they are off sick',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.marked_absent',
    group: 'day',
    label: 'You were marked absent',
    who: 'The person marked absent',
    when: 'A planner, supervisor or administrator answers that they are absent',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.said_sick',
    group: 'day',
    label: 'Somebody says they are off sick',
    who: 'Planners, supervisors and administrators',
    when: 'Somebody taps I am off sick today',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.sick_note_owed',
    group: 'day',
    label: 'Send your medical certificate',
    who: 'Whoever was off sick two days or more',
    when: 'Every morning after the last sick day, until it is sent',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.sick_note_late',
    group: 'day',
    label: 'A medical certificate is late',
    who: 'Supervisors and administrators',
    when: 'The day after a certificate was due',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.not_clocked_in',
    group: 'day',
    label: 'Your shift has started and nothing was recorded',
    who: 'The person whose shift it is',
    when: 'Every half hour after a shift starts, until they clock in',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.clock_out_due',
    group: 'day',
    label: 'Your shift is ending',
    who: 'The person whose shift it is',
    when: 'A shift they clocked into is about to end',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.not_clocked_in_office',
    group: 'day',
    label: 'Somebody has not clocked in for their shift',
    who: 'Administrators',
    when: 'Each time the person is reminded, while their shift runs with nothing recorded',
    ways: ['push'],
  },
  {
    key: 'attendance.clock_out_due_office',
    group: 'day',
    label: 'Somebody has been reminded to clock out',
    who: 'Administrators',
    when: 'When a person still clocked in is reminded their shift is ending',
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
    key: 'attendance.leave_days_asked',
    group: 'day',
    label: 'Somebody asks to move a leave balance',
    who: 'Administrators',
    when: 'A period is signed off with days on or off somebody\u2019s leave, by somebody who '
      + 'cannot move it themselves',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.leave_days_decided',
    group: 'day',
    label: 'A leave-day request was answered',
    who: 'Whoever asked',
    when: 'An administrator approves or sends back a change to a leave balance',
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
    key: 'leave.plan_asked',
    group: 'day',
    label: 'Send your leave plan for the year',
    who: 'Everybody who earns annual leave',
    when: 'Planning opens, then every Monday and every day of the last week until the plan is in',
    ways: ['push', 'email'],
  },
  {
    key: 'leave.holiday_asked',
    group: 'day',
    label: 'Choose your holiday: Christmas or New Year',
    who: 'Everybody on the rota except casual staff',
    when: 'The office asks, then every Monday and each of the last three days until they answer',
    ways: ['push', 'email'],
  },
  {
    key: 'leave.holiday_confirmed',
    group: 'day',
    label: 'Your holiday is confirmed',
    who: 'Everybody who was asked',
    when: 'The office confirms the choices and puts them on the rota',
    ways: ['push', 'email'],
  },
  {
    key: 'leave.plan_reviewed',
    group: 'day',
    label: 'Your leave plan was reviewed',
    who: 'Whoever sent the plan',
    when: 'Nothing in the plan is waiting for a decision any more',
    ways: ['push', 'email'],
  },
  {
    key: 'leave.plan_department_in',
    group: 'day',
    label: 'All of a department’s leave plans are in',
    who: 'Whoever approves leave',
    when: 'The last plan in a department is sent',
    ways: ['push', 'email'],
  },
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
    key: 'attendance.leave_days',
    group: 'leave',
    label: 'Your leave now costs a different number of days',
    who: 'Whoever asked',
    when: 'The days charged for approved leave are changed',
    ways: ['push', 'email'],
  },
  {
    key: 'attendance.availability_asked',
    group: 'leave',
    label: 'Somebody cannot work a day',
    who: 'Supervisors, managers and administrators',
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
    key: 'advance.changed',
    group: 'money',
    label: 'What comes off your pay for an advance has changed',
    who: 'The person it is for',
    when: 'Payroll changes the terms or corrects a payment',
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
    key: 'medical.to_pay',
    group: 'money',
    label: 'An approved medical claim to pay',
    who: 'The address set for paying medical claims',
    when: 'A medical claim is approved, with the payment voucher and receipts as a PDF',
    ways: ['email'],
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
    when: 'Payroll takes money off somebody\u2019s bonus, on screen or from the sheet',
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
    key: 'birthday.card',
    group: 'people',
    label: 'A birthday card, to the person',
    who: 'The member of staff whose birthday it is',
    when: 'Somebody sends them a card',
    ways: ['email', 'text'],
  },
  {
    key: 'recruitment.offer',
    group: 'people',
    label: 'A job offer, to the candidate',
    who: 'The person being offered the job',
    when: 'The offer is sent, two days before it runs out, and their signed copy',
    ways: ['email', 'text'],
  },
  {
    key: 'recruitment.offer_answer',
    group: 'people',
    label: 'A candidate answered an offer',
    who: 'Whoever manages recruitment',
    when: 'They accept and sign, or decline',
    ways: ['push', 'email'],
  },
  {
    key: 'recruitment.interview',
    group: 'people',
    label: 'Interview details, to the candidate',
    who: 'The person being interviewed',
    when: 'Their time is booked, the day before, and when it moves or is cancelled',
    ways: ['email', 'text'],
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
    key: 'recruitment.moved',
    group: 'people',
    label: 'An interview has moved',
    who: 'Whoever is interviewing',
    when: 'A slot is moved to another time',
    ways: ['push', 'email'],
  },
  {
    key: 'recruitment.changed',
    group: 'people',
    label: 'An interview has changed',
    who: 'Whoever is interviewing',
    when: 'A slot\u2019s place or length is changed',
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
    key: 'people.details_sent',
    group: 'people',
    label: 'A new starter sent their details',
    who: 'Whoever manages records',
    when: 'Somebody sends their details from their link',
    ways: ['push', 'email'],
  },
  {
    key: 'people.files_sent',
    group: 'people',
    label: 'A new starter sent documents',
    who: 'Whoever manages records',
    when: 'Somebody sends a document from their link, once a day per person',
    ways: ['push', 'email'],
  },
  {
    key: 'people.contract_signed',
    group: 'people',
    label: 'Somebody signed their contract',
    who: 'Whoever manages records',
    when: 'A contract or form is signed from a link',
    ways: ['push', 'email'],
  },
  {
    key: 'people.declined',
    group: 'people',
    label: 'Somebody declined to sign',
    who: 'Whoever manages records',
    when: 'A contract or form is declined from a link',
    ways: ['push', 'email'],
  },
  {
    key: 'people.sign_code',
    group: 'people',
    label: 'A code to sign a contract',
    who: 'Whoever is signing from their link',
    when: 'They ask for one before signing, where they have no email address',
    ways: ['text'],
  },
  {
    key: 'corr.sign_link',
    group: 'people',
    label: 'A document to sign',
    who: 'Whoever is asked to sign a letter',
    when: 'It is their turn, and as a reminder until they sign',
    ways: ['email'],
  },
  {
    key: 'corr.sign_code',
    group: 'people',
    label: 'A link or code to sign, by text',
    who: 'Whoever is asked to sign a letter',
    when: 'Their link is sent by text, or they ask for a code',
    ways: ['text'],
  },
  {
    key: 'corr.your_turn',
    group: 'people',
    label: 'Your turn to sign a document',
    who: 'The member of staff, or whoever signs for the property',
    when: 'Those before them in the order have signed',
    ways: ['push', 'email'],
  },
  {
    key: 'corr.copy',
    group: 'people',
    label: 'The signed copy',
    who: 'Everybody a document was sent to',
    when: 'The last signature is in',
    ways: ['email'],
  },
  {
    key: 'corr.stopped',
    group: 'people',
    label: 'A document no longer needs signing',
    who: 'Everybody a document was sent to',
    when: 'It is withdrawn, or somebody declines',
    ways: ['email'],
  },
  {
    key: 'corr.signed',
    group: 'people',
    label: 'Somebody signed a letter',
    who: 'Whoever writes letters',
    when: 'A recipient signs',
    ways: ['push', 'email'],
  },
  {
    key: 'corr.declined',
    group: 'people',
    label: 'Somebody declined to sign a letter',
    who: 'Whoever writes letters',
    when: 'A recipient declines',
    ways: ['push', 'email'],
  },
  {
    key: 'corr.complete',
    group: 'people',
    label: 'A letter is fully signed',
    who: 'Whoever writes letters',
    when: 'The last signature is in',
    ways: ['push', 'email'],
  },
  {
    key: 'corr.expiring',
    group: 'people',
    label: 'A letter is about to expire unsigned',
    who: 'Whoever writes letters',
    when: 'Two days before a signing link runs out',
    ways: ['push', 'email'],
  },
  {
    key: 'handbook.reminder',
    group: 'people',
    label: 'Handbook still to read or sign',
    who: 'Anybody with handbook sections outstanding',
    when: 'Every Monday until they are done',
    ways: ['push'],
  },
  {
    key: 'onboarding.overdue_mine',
    group: 'people',
    label: 'Something from your first week is overdue',
    who: 'A new starter',
    when: 'Every other day while a step of theirs is past its day',
    ways: ['push', 'email'],
  },
  {
    key: 'onboarding.overdue',
    group: 'people',
    label: 'A new starter is behind',
    who: 'Whoever manages records',
    when: 'Every other day while somebody\u2019s first-week steps are past their day',
    ways: ['push', 'email'],
  },
  {
    key: 'people.link',
    group: 'people',
    label: 'A link to fill in details or sign',
    who: 'A new starter, or whoever a link is for',
    when: 'The office sends a details or contract link, and as a reminder until it is done',
    ways: ['email', 'text'],
  },
  {
    key: 'recruitment.hired',
    group: 'people',
    label: 'Somebody has been taken on',
    who: 'Whoever manages records',
    when: 'A candidate is hired',
    ways: ['push', 'email'],
  },

  {
    key: 'lunch.what_you_ordered',
    group: 'house',
    label: 'What you are down to eat this week',
    who: 'Everybody who answered the lunch list',
    when: 'The list shuts, or the kitchen sends it',
    ways: ['email'],
    note: 'A receipt rather than an alert. Ordering happens on a link somebody opens once, so '
      + 'without this the only copy of their own answer is on the kitchen\u2019s screen.',
  },
  {
    key: 'lunch.change_asked',
    group: 'house',
    label: 'Somebody wants their lunch changed',
    who: 'Whoever runs the kitchen',
    when: 'The list is shut and a member of staff asks for a day to be changed',
    ways: ['push', 'email'],
  },
  {
    key: 'lunch.change_decided',
    group: 'house',
    label: 'Your lunch change was answered',
    who: 'Whoever asked',
    when: 'The kitchen says yes or no',
    ways: ['push', 'email'],
  },

  // The till: closing a front-desk shift, and settling what did not agree.
  // Who is told is chosen in Insight, person by person, with push and email
  // each ticked or not there; these switches can still silence a kind.
  {
    key: 'till.closed',
    group: 'money',
    label: 'A shift has been closed',
    who: 'Whoever Insight says to tell',
    when: 'The moment somebody signs their closing report',
    ways: ['push', 'email'],
  },
  {
    key: 'till.summary',
    group: 'money',
    label: 'Daily till summary',
    who: 'Whoever Insight says to tell',
    when: 'Every morning: yesterday’s shifts, and what waits for an admin',
    ways: ['push', 'email'],
  },
  {
    key: 'till.close_due',
    group: 'money',
    label: 'Time to close your till',
    who: 'Whoever is on a reception shift',
    when: '20 minutes before a reception shift ends, and again 20 minutes after if the closing report is not in',
    ways: ['push', 'email'],
  },
  {
    key: 'till.close_owed',
    group: 'money',
    label: 'Closing reports still not in',
    who: 'Whoever worked a reception shift and has not closed it',
    when: 'Every morning from 8 o’clock, until every report they owe is in',
    ways: ['push', 'email'],
  },
  {
    key: 'till.chase',
    group: 'money',
    label: 'A closing report asked for',
    who: 'Whoever owes it',
    when: 'A manager presses Chase on Till reports',
    ways: ['push', 'email'],
  },
  {
    key: 'till.expect',
    group: 'money',
    label: 'Expect cash back in the drawer',
    who: 'Whoever is on the next reception shift',
    when: 'A PO advanced from a drawer was bought for less, and the change is coming back',
    ways: ['push', 'email'],
  },
  {
    key: 'till.answer',
    group: 'money',
    label: 'Somebody has answered for their till',
    who: 'Whoever Insight says to tell',
    when: 'A member of staff explains a difference, offers to pay it back, or adds a PO',
    ways: ['push', 'email'],
  },
  {
    key: 'till.approval',
    group: 'money',
    label: 'A supervisor\u2019s correction is waiting',
    who: 'Whoever Insight says approves them',
    when: 'A supervisor corrects a cash movement',
    ways: ['push', 'email'],
  },
  {
    key: 'till.settled',
    group: 'money',
    label: 'Something on your till list was settled or sent back',
    who: 'Whoever it was about',
    when: 'A supervisor or an admin decides',
    ways: ['push', 'email'],
  },
  {
    key: 'till.moved',
    group: 'money',
    label: 'A till difference was put on your account',
    who: 'Whoever it was put on, and the person whose shift it was',
    when: 'An admin puts a drawer short or over on somebody\u2019s account, or undoes it',
    ways: ['push', 'email'],
  },
  {
    key: 'till.owner',
    group: 'money',
    label: 'A shift was said to be yours, or not yours',
    who: 'The person it now belongs to, and the person it no longer does',
    when: 'An admin or a supervisor says whose shift it was, when ASSD and HIVE name different people',
    ways: ['push', 'email'],
  },
  {
    key: 'till.proof',
    group: 'money',
    label: 'Proof was asked for something you answered on your till list',
    who: 'Whoever gave the answer',
    when: 'An admin asks for a picture or a PDF (a MoMo screenshot, a slip, a statement), and each morning after until it is sent, three times at most',
    ways: ['push', 'email'],
  },
  {
    key: 'till.checked',
    group: 'money',
    label: 'A shift of yours was checked: what is on it to sort out is final',
    who: 'Whoever has something on that shift to sort out',
    when: 'Somebody in Insight marks the shift checked, after looking at its report, drawer and payments',
    ways: ['push', 'email'],
  },
  {
    key: 'till.given',
    group: 'money',
    label: 'An advance was given to you to report',
    who: 'Whoever it was given to',
    when: 'An admin or a supervisor gives an advance to one person to report on the expense form, or takes it back',
    ways: ['push', 'email'],
  },
  {
    key: 'till.reopened',
    group: 'money',
    label: 'Your closing report was reopened',
    who: 'Whoever signed it',
    when: 'An admin reopens it so it can be sent again',
    ways: ['push', 'email'],
  },
  {
    key: 'till.recovered',
    group: 'money',
    label: 'A till shortage is coming off somebody\u2019s pay',
    who: 'Whoever runs the payroll, and the person',
    when: 'An admin recovers a shortage from pay',
    ways: ['push', 'email'],
  },
  {
    key: 'payroll.payslip',
    group: 'money',
    label: 'Your payslip, by email',
    who: 'The person whose payslip it is',
    when: 'Payroll emails the payslips for a closed month',
    ways: ['email'],
    note: 'Sent only when payroll presses Email the payslips; the PDF is attached.',
  },
  {
    key: 'till.credited',
    group: 'money',
    label: 'A till surplus is being paid with somebody\u2019s pay',
    who: 'Whoever runs the payroll, and the person',
    when: 'An admin pays a surplus through payroll',
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
