import { median, sum, groupBy, mad } from '../stats.js';
import { lead, mid, revenueSourceFor } from '../labels.js';

/**
 * Money that was earned and money that arrived.
 *
 * The POS records a till close and what it was out by. The laundry records
 * what was charged and what was collected. Attendance records who was on the
 * premises. Individually each is a note in somebody's app; together they are
 * the only cash control the group has.
 *
 * These rules are written to be slow to accuse. A short till is usually a
 * mistake, and a name printed next to the word "shortage" on a dashboard is a
 * serious thing to do to somebody. So: a minimum number of shifts before a
 * person can be named at all, a comparison against their colleagues rather
 * than against zero, and every finding says in its own text that it is a
 * pattern worth looking into and not a conclusion.
 */

/** Below this many closes, a person's record is not evidence of anything. */
const MIN_SHIFTS = 10;

/** A close inside five cedis either way is a rounding, not a shortfall. */
const MATERIAL = 500;

export const tillVariance = {
  id: 'till-variance',
  title: 'Till closes, and who was on them',
  needs: ['pos', 'attendance'],
  run({ facts, money }) {
    const findings = [];
    const closes = facts.cash.filter((c) => c.expected > 0 || c.counted > 0);
    if (closes.length < 20) return findings;

    // The measure is how *often* a person's till comes up short, not the
    // middle of their variances. A cashier who is exact four closes in five
    // and eighty cedis down on the fifth has a median of zero, and a rule
    // built on medians would never see them. Frequency of a material shortfall
    // is both harder to hide behind and easier to explain to the person.
    const shortRate = (rows) => rows.filter((r) => r.variance < -MATERIAL).length / rows.length;
    const groupShortRate = shortRate(closes);
    const totalShort = Math.abs(sum(closes.filter((c) => c.variance < 0).map((c) => c.variance)));

    // If most tills are short, it is the process, and naming an individual
    // would be both wrong and unkind.
    if (groupShortRate > 0.5) {
      findings.push({
        ruleId: this.id,
        severity: 'warning',
        line: 'restaurant',
        headline: 'More than half of till closes come up short',
        detail: [
          `${Math.round(groupShortRate * 100)}% of ${closes.length} closes were short by more than ${money(MATERIAL)}, together ${money(totalShort)}.`,
          'When it is most of them rather than a few, it is usually the float, the order of the close, or takings recorded after the count — not people.',
        ].join(' '),
        action: 'Watch one close end to end before looking at anybody individually.',
        impactMonthly: Math.round(totalShort / Math.max(1, facts.dayList.length) * 30),
        confidence: 'medium',
        sources: ['pos'],
        evidence: { closes: closes.length, shortRatePct: Math.round(groupShortRate * 100), totalShort },
      });
      return findings;
    }

    const byPerson = groupBy(closes.filter((c) => c.person_id), (c) => c.person_id);
    for (const [personId, rows] of byPerson) {
      if (rows.length < MIN_SHIFTS) continue;
      const rate = shortRate(rows);
      const shortShifts = rows.filter((r) => r.variance < -MATERIAL).length;
      // Three tests, all of which must hold: enough short closes to be a
      // pattern, a rate well clear of everybody else's, and a rate high enough
      // to matter on its own. Any one of them alone would name somebody for
      // having an unlucky fortnight.
      if (shortShifts < 4) continue;
      if (rate < Math.max(0.15, groupShortRate * 2)) continue;

      const name = rows[0].display_name || 'Somebody';
      const short = Math.abs(sum(rows.filter((r) => r.variance < 0).map((r) => r.variance)));
      const typicalShortfall = median(rows.filter((r) => r.variance < -MATERIAL).map((r) => r.variance));

      // Corroboration from attendance: was this person actually clocked in on
      // the days their till was short? A till attributed to somebody who was
      // not on site is a shared login, which is a different and more urgent
      // problem than a shortage — and it is a question no cash report can ask,
      // because no POS knows who was on the premises.
      const shortDays = [...new Set(rows.filter((r) => r.variance < -MATERIAL).map((r) => r.day))];
      const worked = new Set(facts.personDays
        .filter((d) => d.person_id === personId && d.worked_minutes > 0)
        .map((d) => d.day));
      const notClockedIn = shortDays.filter((day) => !worked.has(day));

      // Only claim a shared login when attendance actually covers those days.
      // A day the terminal never saw at all is a gap in the feed, not evidence
      // about a person.
      const covered = new Set(facts.personDays.map((d) => d.day));
      const unexplained = notClockedIn.filter((day) => covered.has(day));

      findings.push({
        ruleId: this.id,
        severity: unexplained.length >= 3 ? 'critical' : 'warning',
        line: 'restaurant',
        personId,
        headline: unexplained.length >= 3
          ? `${name}'s till was closed on ${unexplained.length} days they were not clocked in`
          : `${name}'s till is short ${Math.round(rate * 100)}% of the time, against ${Math.round(groupShortRate * 100)}% for everyone else`,
        detail: [
          `${shortShifts} of ${name}'s ${rows.length} closes were short by more than ${money(MATERIAL)}, typically ${money(Math.abs(typicalShortfall || 0))} each, ${money(short)} in all.`,
          `Across every other close in the window the rate is ${Math.round(groupShortRate * 100)}%.`,
          unexplained.length >= 3
            ? `On ${unexplained.length} of those days the attendance terminal recorded no work for them at all, so somebody else was using the login. No cash report can see this: the POS does not know who was on the premises.`
            : 'This is a pattern worth looking into, not a conclusion. A shared float and a till that is closed by whoever is nearest explain most of these.',
        ].join(' '),
        action: unexplained.length >= 3
          ? 'Check who is closing on those dates. A borrowed till login makes every other cash figure unattributable, including the ones that look fine.'
          : `Sit with ${name} through two closes before drawing any conclusion, and check whether the float is being shared.`,
        impactMonthly: Math.round(short / Math.max(1, facts.dayList.length) * 30),
        // Named by a name match rather than an employee number is weaker
        // evidence, and a finding that names somebody says so.
        confidence: rows[0].confidence === 'exact' ? 'medium' : 'low',
        sources: ['pos', 'attendance'],
        evidence: {
          closes: rows.length,
          shortCloses: shortShifts,
          shortRatePct: Math.round(rate * 100),
          groupShortRatePct: Math.round(groupShortRate * 100),
          typicalShortfall: Math.abs(typicalShortfall || 0),
          totalShort: short,
          daysNotClockedIn: unexplained.length,
          // Listed so somebody can check the claim rather than believe it.
          sampleDays: unexplained.slice(0, 5),
        },
      });
    }

    return findings.sort((a, b) => b.impactMonthly - a.impactMonthly).slice(0, 3);
  },
};

export const uncollectedRevenue = {
  id: 'uncollected-revenue',
  title: 'Charged and never collected',
  needs: ['laundry'],
  run({ facts, money }) {
    const findings = [];
    const byLine = groupBy(facts.lineRows.filter((r) => r.net > 0), (r) => r.line);

    for (const [line, rows] of byLine) {
      const net = sum(rows.map((r) => r.net));
      const outstanding = sum(rows.map((r) => r.outstanding));
      if (outstanding <= 0 || net <= 0) continue;
      const share = Math.round((outstanding / net) * 1000) / 10;
      if (share < 8) continue;

      // Getting worse, or simply the way this line trades? A rising share is
      // a control that has slipped; a steady one is a policy.
      const ordered = rows.slice().sort((a, b) => a.day.localeCompare(b.day));
      const cut = Math.floor(ordered.length / 2);
      const early = shareOf(ordered.slice(0, cut));
      const late = shareOf(ordered.slice(cut));
      const worsening = early != null && late != null && late - early > 5;

      findings.push({
        ruleId: this.id,
        severity: share > 25 || worsening ? 'warning' : 'info',
        line,
        headline: worsening
          ? `${lead(line)} is collecting less of what it charges than it was`
          : `${share}% of what ${mid(line)} charges is never collected`,
        detail: [
          `Over ${rows.length} days ${mid(line)} charged ${money(net)} and took ${money(net - outstanding)}, leaving ${money(outstanding)} outstanding.`,
          worsening
            ? `The uncollected share has gone from ${early}% to ${late}% across the window, so this is getting worse rather than being the way the line trades.`
            : 'That is steady across the window, so it is how the line has always worked rather than something that has slipped.',
          'Guests who leave owing rarely come back to settle.',
        ].join(' '),
        action: worsening
          ? 'Find out what changed. Payment at collection is the usual answer, and it costs nothing to reinstate.'
          : 'Decide whether the outstanding balance is a credit policy or an oversight. If it is a policy, it should have a limit.',
        impactMonthly: Math.round(outstanding / Math.max(1, facts.dayList.length) * 30),
        confidence: rows.length >= 30 ? 'high' : 'medium',
        sources: [revenueSourceFor(line)].filter(Boolean),
        evidence: {
          charged: net, collected: net - outstanding, outstanding,
          outstandingSharePct: share,
          earlySharePct: early, lateSharePct: late,
          days: rows.length,
        },
      });
    }
    return findings;
  },
};

function shareOf(rows) {
  const net = sum(rows.map((r) => r.net));
  if (!net) return null;
  return Math.round((sum(rows.map((r) => r.outstanding)) / net) * 1000) / 10;
}
