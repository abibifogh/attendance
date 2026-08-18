import { all, run, writeAll, groupConfig } from '../lib/db.js';
import { loadFacts, totals } from './facts.js';
import { formatMoney } from '../lib/money.js';
import { listSources } from '../connectors/index.js';

import { revenuePerLabourHour, labourShareOfRevenue, overtimeWithoutTrade, staffingAgainstDemand } from './rules/labour.js';
import { guestCapture, foodCostPerGuest, usageOutliers } from './rules/demand.js';
import { tillVariance, uncollectedRevenue } from './rules/cash.js';
import { priceDivergence, supplierConcentration } from './rules/supply.js';
import { absenceToMissedWork, unbilledOccupancy, maintenanceLoad, coverageGaps } from './rules/service.js';

/**
 * The rules, in the order a person would want to hear them.
 *
 * Money that is leaving first, then money that is not arriving, then work that
 * is not getting done, then what the tool cannot see. Ordering here is only a
 * tiebreak — findings are ranked by what they are worth — but a tiebreak that
 * puts a supplier overcharge above a housekeeping note is the right one.
 */
export const RULES = [
  revenuePerLabourHour,
  labourShareOfRevenue,
  priceDivergence,
  foodCostPerGuest,
  tillVariance,
  uncollectedRevenue,
  guestCapture,
  overtimeWithoutTrade,
  usageOutliers,
  staffingAgainstDemand,
  absenceToMissedWork,
  supplierConcentration,
  unbilledOccupancy,
  maintenanceLoad,
  coverageGaps,
];

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2, good: 3 };

/**
 * Run every rule over a window and write what they found.
 *
 * A rule that throws is contained: it costs its own findings and nothing else.
 * One badly-behaved rule taking the whole morning brief down with it would be
 * the fastest way to make somebody stop opening this.
 */
export async function analyse(db, { from, to, persist = true, sourceStatus } = {}) {
  const config = await groupConfig(db);
  const facts = await loadFacts(db, from, to);
  const money = (value) => formatMoney(value, { symbol: config.currencySymbol });
  const sources = sourceStatus || (await sourceHealth(db));

  const ctx = { db, facts, config, money, from, to, sourceStatus: sources };
  const findings = [];
  const errors = [];

  for (const rule of RULES) {
    try {
      const produced = await rule.run(ctx);
      for (const finding of produced || []) {
        findings.push(normalise(finding, rule, { from, to }));
      }
    } catch (err) {
      errors.push({ ruleId: rule.id, error: String(err?.message ?? err) });
    }
  }

  findings.sort(byImportance);
  if (persist) await persistFindings(db, findings);

  return { findings, errors, facts, totals: totals(facts), config };
}

/**
 * Rank: what it is worth first, severity as the tiebreak.
 *
 * Deliberately this way round. A critical-sounding note worth nothing should
 * not sit above a quiet finding worth two thousand cedis a month, because the
 * person reading has ten minutes and will read from the top.
 */
export function byImportance(a, b) {
  if (a.impactMonthly !== b.impactMonthly) return b.impactMonthly - a.impactMonthly;
  const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (rank) return rank;
  return a.headline.localeCompare(b.headline);
}

function normalise(finding, rule, window) {
  const fingerprint = finding.fingerprint || [
    rule.id,
    finding.line || '-',
    finding.personId || '-',
    // The evidence's identifying part, so "tomatoes cost more" and "rice costs
    // more" are two findings and the same one next week is one.
    finding.evidence?.item || finding.evidence?.weekday || finding.evidence?.supplier || '-',
  ].join(':');

  return {
    fingerprint,
    ruleId: rule.id,
    ruleTitle: rule.title,
    severity: finding.severity || 'info',
    headline: finding.headline,
    detail: finding.detail,
    action: finding.action || null,
    line: finding.line || null,
    personId: finding.personId || null,
    impactMonthly: Math.max(0, Math.round(finding.impactMonthly || 0)),
    confidence: finding.confidence || 'medium',
    sources: finding.sources || [],
    evidence: finding.evidence || {},
    fromDay: window.from,
    toDay: window.to,
  };
}

/**
 * Write findings, keeping what a person has already said about them.
 *
 * A finding somebody dismissed last week must not reappear at the top of the
 * brief this morning as though it were new. The fingerprint carries that
 * decision forward; only the numbers are refreshed.
 */
async function persistFindings(db, findings) {
  const statements = findings.map((f) => db.prepare(`
    INSERT INTO findings
      (fingerprint, rule_id, severity, headline, detail, action, line_id, person_id,
       impact_monthly, confidence, sources, evidence, from_day, to_day)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT (fingerprint) DO UPDATE SET
      severity = ?3, headline = ?4, detail = ?5, action = ?6, line_id = ?7, person_id = ?8,
      impact_monthly = ?9, confidence = ?10, sources = ?11, evidence = ?12,
      from_day = ?13, to_day = ?14, last_seen_at = datetime('now'),
      -- A finding that was actioned and has come back is open again; a
      -- dismissal is a judgement about the finding itself and stands.
      state = CASE WHEN findings.state = 'dismissed' THEN 'dismissed' ELSE 'open' END`)
    .bind(f.fingerprint, f.ruleId, f.severity, f.headline, f.detail, f.action, f.line, f.personId,
      f.impactMonthly, f.confidence, JSON.stringify(f.sources), JSON.stringify(f.evidence),
      f.fromDay, f.toDay));

  await writeAll(db, statements);

  // Anything the rules no longer produce has stopped being true. It is not
  // deleted — the record of having found it is worth keeping — but it drops
  // off the brief.
  const live = findings.map((f) => f.fingerprint);
  if (live.length) {
    const placeholders = live.map((_, i) => `?${i + 1}`).join(', ');
    await run(db, `
      UPDATE findings SET state = 'resolved', state_at = datetime('now')
       WHERE state = 'open' AND fingerprint NOT IN (${placeholders})`, ...live);
  } else {
    await run(db, "UPDATE findings SET state = 'resolved', state_at = datetime('now') WHERE state = 'open'");
  }
}

async function sourceHealth(db) {
  const sources = await listSources(db);
  const last = await all(db, `
    SELECT source_id, status, detail FROM etl_source_run
     WHERE run_id = (SELECT MAX(id) FROM etl_run)`);
  const byId = new Map(last.map((r) => [r.source_id, r]));
  return sources.map((s) => ({
    id: s.id,
    label: s.label,
    status: byId.get(s.id)?.status || 'never run',
    detail: byId.get(s.id)?.detail || null,
  }));
}

export { sourceHealth };
