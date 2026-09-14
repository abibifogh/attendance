/**
 * The first week, as this property actually runs one.
 *
 * Written for a hotel rather than adapted from an office: the tour is of the
 * back corridors and the fire exits, the introduction is to whoever runs the
 * department on the floor, and the certificate is the one the Public Health
 * Act asks of anybody who touches food.
 *
 * They install as ordinary steps and are the property's own from that moment.
 * Edit one, and loading the set again never touches it: only what is missing
 * is added, matched on the code it came in under.
 */
export const DEFAULT_STEPS = [
  // ------------------------------------------------------------ before day one
  {
    code: 'details',
    title: 'Send us your details',
    detail: 'Your full name as it appears on your ID, your address, your phone number, '
      + 'your next of kin, and the bank or mobile money account your pay goes to. '
      + 'The office sends you a link and the form fills itself in from there.',
    source: 'details',
    owner: 'staff',
    sort_order: 10,
  },
  {
    code: 'documents',
    title: 'Get your documents on file',
    detail: 'Your Ghana Card or passport, your SSNIT number, a passport photograph, and '
      + 'anything else your job needs. Photographs of them taken on a phone are fine, '
      + 'so long as every corner is in the frame and the writing can be read.',
    source: 'documents',
    owner: 'staff',
    sort_order: 20,
  },
  {
    code: 'contract',
    title: 'Read and sign your contract',
    detail: 'The office issues it and you sign it on your phone. Read it before you do, '
      + 'and ask about anything in it you are not sure of. Nobody here would rather '
      + 'you signed something you did not understand.',
    source: 'contract',
    owner: 'staff',
    sort_order: 30,
  },

  // -------------------------------------------------------------- the first day
  {
    code: 'welcome_meeting',
    title: 'Sit down with your manager',
    detail: 'What the job is, who you report to, what a good shift looks like, and what '
      + 'the property expects of you in your first month.',
    source: 'manual',
    owner: 'office',
    sort_order: 40,
  },
  {
    code: 'tour',
    title: 'Walk the property',
    detail: 'Front and back of house, the staff entrance, where to change, the lockers, '
      + 'where breaks are taken, and the departments you will be working alongside.',
    source: 'manual',
    owner: 'office',
    sort_order: 50,
  },
  {
    code: 'fire_safety',
    title: 'Fire exits, extinguishers and the assembly point',
    detail: 'Where the exits are from every floor you will work on, where the '
      + 'extinguishers and the alarm points are, what the alarm sounds like, and where '
      + 'to gather outside. Shown on the first day, not the first drill.',
    source: 'manual',
    owner: 'office',
    sort_order: 60,
  },
  {
    code: 'team',
    title: 'Meet the department',
    detail: 'Introduced by name to the people on shift, and to whoever runs the '
      + 'department on the floor rather than only to whoever hired you.',
    source: 'manual',
    owner: 'office',
    sort_order: 70,
  },

  // ------------------------------------------------------------- the equipment
  {
    code: 'terminal',
    title: 'Get your face on the clocking terminal',
    detail: 'Enrolled on the terminal at the staff entrance, and shown how to clock in '
      + 'and out. Until this is done nothing records your hours, so it is done on the '
      + 'first day and not the first payday.',
    source: 'manual',
    owner: 'office',
    sort_order: 80,
  },
  {
    code: 'app',
    title: 'Put HIVE on your phone',
    detail: 'Your rota, your hours, your payslips and your leave, on the phone in your '
      + 'pocket. Add it to your home screen and turn notifications on, so a change to '
      + 'next week reaches you the day it happens.',
    source: 'manual',
    owner: 'staff',
    sort_order: 90,
  },
  {
    code: 'uniform',
    title: 'Collect your uniform and name badge',
    detail: 'Issued, fitted and signed for. What you are given, and what condition it is '
      + 'to come back in when you leave, is written on your record.',
    source: 'manual',
    owner: 'office',
    sort_order: 100,
  },
  {
    code: 'keys',
    title: 'Keys, locker and access',
    detail: 'Whatever your job needs you to be able to open, and the rule that goes with '
      + 'it: keys stay on the property and are handed back at the end of every shift.',
    source: 'manual',
    owner: 'office',
    sort_order: 110,
  },

  // -------------------------------------------------------------- the first week
  {
    code: 'handbook',
    title: 'Read the handbook and sign what it asks',
    detail: 'How we look after guests, what we expect of each other, what happens when '
      + 'something goes wrong, and how to raise a problem. Some chapters ask you to tick '
      + 'them and a few ask for your signature. Take the time.',
    source: 'handbook',
    owner: 'staff',
    sort_order: 120,
  },
  {
    code: 'food_hygiene',
    title: 'Food hygiene and your health certificate',
    detail: 'The Public Health Act, 2012 (Act 851) requires a valid health certificate '
      + 'from anybody who handles food, renewed every year. The property arranges the '
      + 'screening; the certificate goes on your file.',
    source: 'manual',
    owner: 'office',
    departments: ['Kitchen', 'F&B', 'Restaurant', 'Bar'],
    sort_order: 130,
  },
  {
    code: 'shadow',
    title: 'Work a shift alongside somebody who knows it',
    detail: 'A whole shift with an experienced colleague before you are rostered on your '
      + 'own. What the job is really like at half past seven on a Saturday is not '
      + 'something anybody learns from a handbook.',
    source: 'manual',
    owner: 'office',
    sort_order: 140,
  },
  {
    code: 'pay_explained',
    title: 'How your pay works',
    detail: 'When it is paid, what comes off it and why: income tax under the '
      + 'pay-as-you-earn system and your SSNIT contribution. Where to find your payslip '
      + 'in this app, and who to ask if a figure looks wrong.',
    source: 'manual',
    owner: 'office',
    sort_order: 150,
  },

  // -------------------------------------------------------------- and afterwards
  {
    code: 'first_month',
    title: 'Sit down again after a month',
    detail: 'How it is going, from both sides. What is working, what is not, and what '
      + 'either of you would change. Held before the probation review rather than '
      + 'instead of it.',
    source: 'manual',
    owner: 'office',
    sort_order: 160,
  },
];

export const STEP_CODES = DEFAULT_STEPS.map((s) => s.code);
