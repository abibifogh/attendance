/**
 * The month's net pays, in the shape a bank will take.
 *
 * WHAT THIS IS FOR. Nobody at a property this size pays forty people by
 * standing at a counter forty times. The bank takes one file, and everything
 * on that file is an account number and an amount. The payroll already knows
 * both, and typing them out again into a spreadsheet once a month is how a
 * digit gets dropped and somebody is paid nine hundred cedis instead of nine
 * thousand.
 *
 * SO IT IS DELIBERATELY THE NARROWEST THING IT COULD BE. No basic, no
 * allowances, no tax, no bonus. What leaves the building goes to a clerk at a
 * bank who has no business knowing what anybody's PAYE came to, and a file
 * with twelve columns on it is a file somebody has to trim before uploading.
 * Net pay and how to reach the account, and nothing else.
 *
 * WHO IS ON IT AND WHO IS NOT. Not everybody is paid into a bank. Somebody on
 * mobile money and somebody paid in cash are both perfectly normal here, and
 * both belong nowhere near a bank upload. But they still have to be paid, so
 * they are not silently dropped either: they come out on their own list, with
 * the reason, so whoever is running the month can see at a glance that four
 * people are being handled by hand and who they are.
 *
 * THE ONE THAT MATTERS MOST is the person the property has set to be paid by
 * bank and whose account number nobody has filled in. That is not somebody
 * paid another way, it is somebody who will simply not be paid, and it is
 * invisible on a payroll screen because every figure against them is right.
 * It gets its own reason and its own line on the screen.
 */

const CLEAN = /\s+/g;

const text = (value) => String(value ?? '').replace(CLEAN, ' ').trim();

/** An account number as a bank reads it: digits and nothing else. */
export function tidyAccount(value) {
  return String(value ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/**
 * How somebody is actually being paid this month.
 *
 * The property's own answer wins, because "pay this one by mobile money" is a
 * decision somebody made and not something to be second-guessed by whatever
 * old account number is still on the record. Where nobody has answered, the
 * presence of an account number is the answer.
 */
export function howPaid(person = {}) {
  const method = text(person.payMethod).toLowerCase();
  const account = tidyAccount(person.accountNumber);

  if (method === 'bank') return account ? 'bank' : 'no-account';
  if (method === 'momo') return 'momo';
  if (method === 'cash') return 'cash';
  return account ? 'bank' : 'not-said';
}

/** Why somebody is not on the bank file, in words somebody can act on. */
export const WHY = {
  momo: 'Paid by mobile money',
  cash: 'Paid in cash',
  'no-account': 'Set to be paid by bank, but no account number',
  'not-said': 'Nobody has said how they are paid',
};

/**
 * What each row on the bank file says.
 *
 * The account comes first because that is the order every bank's own template
 * puts it in, and a file whose columns are already in the right order is one
 * fewer thing to rearrange before it is uploaded.
 */
export const BANK_COLUMNS = [
  { key: 'accountName', label: 'Account name', width: 26 },
  { key: 'accountNumber', label: 'Account number', width: 20, text: true },
  { key: 'bank', label: 'Bank', width: 22 },
  { key: 'branch', label: 'Branch', width: 18 },
  { key: 'amount', label: 'Amount', width: 13, money: true },
  { key: 'reference', label: 'Reference', width: 20 },
  { key: 'employeeNo', label: 'Employee no', width: 13, text: true },
  { key: 'name', label: 'Name', width: 24 },
];

export const BY_HAND_COLUMNS = [
  { key: 'name', label: 'Name', width: 24 },
  { key: 'employeeNo', label: 'Employee no', width: 13, text: true },
  { key: 'department', label: 'Department', width: 18 },
  { key: 'why', label: 'Why not on the bank file', width: 34 },
  { key: 'reach', label: 'Mobile money', width: 22, text: true },
  { key: 'amount', label: 'Amount', width: 13, money: true },
];

/**
 * The narration the money arrives under.
 *
 * Written once for the whole run rather than per person, because that is what
 * shows on a statement and "SALARY AUG 2026" is what somebody looking at their
 * own statement in November wants to see there.
 */
export function referenceFor(month, note = '') {
  const said = text(note);
  if (said) return said.slice(0, 40);
  const [year, mm] = String(month ?? '').split('-');
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const name = names[Number(mm)] ?? '';
  return name ? `Salary ${name} ${year}` : 'Salary';
}

/**
 * The month split into what the bank can take and what it cannot.
 *
 * `lines` is the payroll as it stands; `people` maps a staff id onto whatever
 * the personal record holds about how they are paid. Nobody with nothing to
 * be paid appears at all: a nought on a bank file is a line the bank rejects,
 * and a nought on the by-hand list is somebody being chased for no reason.
 */
export function bankFile(lines = [], people = new Map(), { month, note = '' } = {}) {
  const reference = referenceFor(month, note);
  const rows = [];
  const byHand = [];

  for (const line of lines) {
    const amount = Math.round((Number(line.net) || 0) * 100) / 100;
    if (amount <= 0) continue;

    const staff = line.staff ?? {};
    const person = people.get(staff.id) ?? {};
    const how = howPaid(person);
    const employeeNo = text(staff.employeeNo);

    if (how === 'bank') {
      rows.push({
        staffId: staff.id,
        // The person's own name where nobody has typed the name on the
        // account. It is what a clerk would write, and a blank column is
        // worse: the bank matches on the number anyway and rejects on a name
        // that disagrees, which is a thing somebody can see and fix.
        accountName: text(person.accountName) || text(staff.name),
        accountNumber: tidyAccount(person.accountNumber),
        bank: text(person.bankName),
        branch: text(person.bankBranch),
        amount,
        reference,
        employeeNo,
        name: text(staff.name),
      });
      continue;
    }

    byHand.push({
      staffId: staff.id,
      name: text(staff.name),
      employeeNo,
      department: text(staff.department),
      why: WHY[how] ?? WHY['not-said'],
      how,
      reach: how === 'momo'
        ? [text(person.momoNetwork), text(person.momoNumber)].filter(Boolean).join(' ')
        : '',
      amount,
    });
  }

  // By name, because a bank file is checked against a list somebody is reading
  // down, and the payroll's own order is by name already.
  rows.sort((a, b) => a.name.localeCompare(b.name));
  byHand.sort((a, b) => a.name.localeCompare(b.name));

  const sum = (list) => Math.round(list.reduce((n, r) => n + r.amount, 0) * 100) / 100;

  return {
    reference,
    rows,
    byHand,
    total: sum(rows),
    byHandTotal: sum(byHand),
    // Said separately because it is the one that is a mistake rather than a
    // choice: somebody the property means to pay by bank and cannot.
    missingAccounts: byHand.filter((r) => r.how === 'no-account').length,
  };
}
