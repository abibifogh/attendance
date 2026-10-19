import { json } from '../lib/http.js';
import { allows } from '../lib/permissions.js';
import { currentSigner } from '../lib/correspondence.js';

/**
 * Everything out for signature, in one place.
 *
 * Contracts and letters used to be tracked on two different screens, and
 * what was waiting on the property itself was on neither. This puts them
 * together the way somebody chasing signatures thinks about them: waiting on
 * us, with somebody else, done, and stopped.
 */
export async function signingBoard(ctx) {
  const may = (p) => allows(p, ctx.session.permissions);
  const waitingOnUs = [];
  const withOthers = [];
  const completed = [];
  const stopped = [];

  if (may('hr_view')) {
    const contracts = (await ctx.db.prepare(
      `SELECT c.id, c.title, c.status, c.issued_at, c.signed_at, c.employer_at, c.decline_note, c.origin,
              p.name, p.id AS staff_id,
              (SELECT MAX(i.sent_at) FROM hr_invite i JOIN hr_invite_contract ic ON ic.invite_id = i.id
                WHERE ic.contract_id = c.id) AS sent_at,
              (SELECT MAX(i.reminded_at) FROM hr_invite i JOIN hr_invite_contract ic ON ic.invite_id = i.id
                WHERE ic.contract_id = c.id) AS reminded_at,
              (SELECT MAX(i.expires_at) FROM hr_invite i JOIN hr_invite_contract ic ON ic.invite_id = i.id
                WHERE ic.contract_id = c.id AND i.revoked_at IS NULL) AS expires_at
         FROM hr_contract c JOIN att_staff p ON p.id = c.staff_id
        WHERE c.status <> 'draft' OR c.issued_at >= datetime('now', '-90 days')
        ORDER BY COALESCE(c.signed_at, c.issued_at) DESC
        LIMIT 400`,
    ).all().catch(() => ({ results: [] }))).results ?? [];

    for (const c of contracts) {
      const row = {
        kind: 'contract', id: c.id, title: c.title, who: c.name,
        link: `#/contract?id=${c.id}`,
        sentAt: c.sent_at ?? c.issued_at, remindedAt: c.reminded_at, expiresAt: c.expires_at,
      };
      if (c.status === 'signed' && !c.employer_at && c.origin !== 'paper') {
        waitingOnUs.push({ ...row, status: 'To countersign', since: c.signed_at });
      } else if (c.status === 'signed') {
        completed.push({ ...row, status: 'Signed by both', since: c.employer_at ?? c.signed_at });
      } else if (['sent', 'opened'].includes(c.status)) {
        withOthers.push({ ...row, status: c.status === 'opened' ? 'Opened, not signed' : 'Sent', waitingOn: c.name, since: row.sentAt });
      } else if (c.status === 'draft') {
        waitingOnUs.push({ ...row, status: 'Not sent yet', since: c.issued_at });
      } else if (['declined', 'void'].includes(c.status)) {
        stopped.push({ ...row, status: c.status === 'declined' ? 'Declined' : 'Withdrawn', note: c.decline_note, since: c.signed_at ?? c.issued_at });
      }
    }
  }

  if (may('corr_view')) {
    const letters = (await ctx.db.prepare(
      `SELECT * FROM corr_letter
        WHERE status IN ('awaiting_signature', 'signed', 'void')
           OR (status = 'draft' AND updated_at >= datetime('now', '-90 days'))
        ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 400`,
    ).all().catch(() => ({ results: [] }))).results ?? [];
    const recipients = letters.length
      ? (await ctx.db.prepare(
        `SELECT * FROM corr_recipient WHERE letter_id IN (${letters.map(() => '?').join(',')}) ORDER BY seq, id`,
      ).bind(...letters.map((l) => l.id)).all().catch(() => ({ results: [] }))).results ?? []
      : [];
    const byLetter = new Map();
    for (const r of recipients) {
      if (!byLetter.has(r.letter_id)) byLetter.set(r.letter_id, []);
      byLetter.get(r.letter_id).push(r);
    }

    for (const l of letters) {
      const rs = byLetter.get(l.id) ?? [];
      const signers = rs.filter((r) => r.role !== 'copy' && r.status !== 'revoked');
      const signed = signers.filter((r) => r.status === 'signed').length;
      const declined = signers.find((r) => r.status === 'declined');
      const current = currentSigner(rs);
      const row = {
        kind: 'letter', id: l.id, title: l.subject, reference: l.reference, who: l.addressed_to,
        link: `#/letter?id=${l.id}`,
        progress: signers.length ? `${signed} of ${signers.length} signed` : null,
        since: l.updated_at ?? l.created_at,
      };
      if (l.status === 'void') stopped.push({ ...row, status: 'Withdrawn' });
      else if (declined) stopped.push({ ...row, status: 'Declined', note: declined.decline_note, waitingOn: declined.name });
      else if (l.status === 'signed') completed.push({ ...row, status: 'Fully signed' });
      else if (l.status === 'awaiting_signature' && current) {
        const expired = current.expires_at && current.expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19);
        (expired ? stopped : withOthers).push({
          ...row,
          status: expired ? 'Link ran out' : current.status === 'opened' ? 'Opened, not signed' : 'Sent',
          waitingOn: current.name,
          sentAt: current.turn_told_at ?? l.updated_at,
          remindedAt: current.reminded_at,
          expiresAt: current.expires_at,
        });
      } else if (l.status === 'draft') {
        waitingOnUs.push({ ...row, status: 'Not sent yet' });
      }
    }
  }

  const bySince = (a, b) => String(b.since ?? '').localeCompare(String(a.since ?? ''));
  return json({
    waitingOnUs: waitingOnUs.sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? ''))),
    withOthers: withOthers.sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? ''))),
    completed: completed.sort(bySince).slice(0, 100),
    stopped: stopped.sort(bySince).slice(0, 100),
  });
}
