/**
 * Checks on a month's payroll that need no screen, so they can be tested.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Everybody whose deductions come to more than their pay: net below zero.
 *
 * Nothing in the sums stops it. Gross less SSNIT, PAYE and whatever advances
 * and till shortages are due is simply subtracted, so a big shortage in a short
 * month leaves somebody owing the property on their own payslip, and a bank
 * file asked to pay them a negative amount. Each comes with what took it there.
 */
export function belowZero(lines = []) {
  return lines
    .filter((line) => round2(line.net) < 0)
    .map((line) => {
      const loans = line.loans ?? [];
      const till = round2(loans.filter((l) => l.what === 'till').reduce((n, l) => n + (Number(l.amount) || 0), 0));
      const advances = round2((Number(line.loanTotal) || 0) - till);
      return {
        staffId: line.staff?.id ?? null,
        name: line.staff?.name ?? 'Somebody',
        net: round2(line.net),
        gross: round2(line.gross),
        ssnit: round2(line.ssnit?.employee),
        paye: round2(line.paye?.total),
        advances,
        till,
      };
    })
    .sort((a, b) => a.net - b.net);
}
