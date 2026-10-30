import { sum } from '../stats.js';

/**
 * What the group cannot see at all: the lines no connected system reports.
 */
export const coverageGaps = {
  id: 'coverage-gaps',
  title: 'What the group cannot see at all',
  needs: [],
  run({ facts, sourceStatus, money }) {
    const findings = [];

    // Room revenue. Not a bug and not a missing connector: there is no
    // property management system among these four applications at all, so the
    // largest line in a hotel's accounts is absent from every total this tool
    // produces. Saying that plainly, on the same screen as the totals, is the
    // difference between a useful tool and a misleading one.
    const roomsRevenue = sum(facts.forLine('rooms').map((r) => r.net));
    const roomsLabour = sum(facts.forLine('rooms').map((r) => r.labourCost));
    const housekeeping = sum(facts.forLine('housekeeping').map((r) => r.labourCost + r.cost));
    if (roomsRevenue === 0 && (roomsLabour > 0 || housekeeping > 0)) {
      findings.push({
        ruleId: this.id,
        severity: 'warning',
        line: 'rooms',
        headline: 'No system in the group records what the rooms earn',
        detail: [
          `Front office and housekeeping cost ${money(roomsLabour + housekeeping)} over this window, and against that there is no room revenue anywhere in the four systems being read.`,
          'HIVE, breakfast, the POS and the laundry cover people, food, restaurant sales and laundry. None of them is a property management system.',
          'So every group-level margin on this dashboard is understated by the whole of the rooms business, and the rooms themselves cannot be judged at all.',
        ].join(' '),
        action: 'Record nightly room revenue somewhere this tool can read — even a single figure a day in the breakfast app beside the guest count would close the gap.',
        impactMonthly: 0,
        confidence: 'high',
        sources: [],
        evidence: { roomsRevenue, roomsLabour, housekeepingCost: housekeeping },
      });
    }

    for (const source of sourceStatus || []) {
      if (source.status === 'ok' || source.status === 'demo') continue;
      findings.push({
        ruleId: this.id,
        severity: source.status === 'error' ? 'warning' : 'info',
        line: null,
        headline: `${source.label} is not being read`,
        detail: `${source.detail || 'No reason given.'} Every figure on this dashboard is missing whatever ${source.label.toLowerCase()} would have contributed.`,
        action: 'Connect it in Settings › Connections & files, or switch it off so the totals stop pretending it is there.',
        impactMonthly: 0,
        confidence: 'high',
        sources: [source.id],
        evidence: { sourceId: source.id, status: source.status, detail: source.detail },
      });
    }

    return findings;
  },
};
