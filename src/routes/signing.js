import { json } from '../lib/http.js';
import { allows } from '../lib/permissions.js';
import { liveTurn } from '../lib/correspondence.js';

/**
 * Everything sent to be signed, in one place.
 *
 * Contracts and letters used to be tracked on two different screens, and
 * what was waiting on the property itself was on neither. This puts them
 * together the way somebody chasing signatures thinks about them: waiting for
 * us, waiting for others, completed, stopped, and drafts. Each row carries a
 * segment per signer so progress reads at a glance.
 */
export async function signingBoard(ctx) {
  const may = (p) => allows(p, ctx.session.permissions);
  const me = Number(ctx.session.user.id);
  const waitingOnUs = [];
  const withOthers = [];
  const completed = [];
  const stopped = [];
  const drafts = [];
  const property = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'property_name'").first()
    .catch(() => null))?.value || 'Somewhere Nice';

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
        reference: `HR-C-${String(c.id).padStart(5, '0')}`,
        link: `#/contract?id=${c.id}`,
        sentAt: c.sent_at ?? c.issued_at, remindedAt: c.reminded_at, expiresAt: c.expires_at,
        segments: [c.status === 'signed', Boolean(c.employer_at)],
      };
      if (c.status === 'signed' && !c.employer_at && c.origin !== 'paper') {
        waitingOnUs.push({ ...row, status: 'Your turn to countersign', tone: 'blue', since: c.signed_at, meta: `signed by ${c.name}` });
      } else if (c.status === 'signed') {
        completed.push({ ...row, status: 'Completed', tone: 'good', since: c.employer_at ?? c.signed_at, segments: [true, true] });
      } else if (['sent', 'opened'].includes(c.status)) {
        withOthers.push({
          ...row, status: c.status === 'opened' ? 'Opened, not signed' : 'Out for signature', tone: 'blue',
          waitingOn: c.name, since: row.sentAt,
        });
      } else if (c.status === 'draft') {
        waitingOnUs.push({ ...row, status: 'Not sent yet', tone: 'warn', since: c.issued_at });
      } else if (['declined', 'void'].includes(c.status)) {
        stopped.push({ ...row, status: c.status === 'declined' ? 'Declined' : 'Withdrawn', tone: c.status === 'declined' ? 'bad' : '', note: c.decline_note, since: c.signed_at ?? c.issued_at });
      }
    }
  }

  if (may('corr_view')) {
    const letters = (await ctx.db.prepare(
      `SELECT * FROM corr_letter
        WHERE status IN ('awaiting_signature', 'signed', 'void')
           OR (status = 'draft' AND (flow = 'v2' OR updated_at >= datetime('now', '-90 days')))
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
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    for (const l of letters) {
      const rs = byLetter.get(l.id) ?? [];
      const signers = rs.filter((r) => r.role !== 'copy' && r.status !== 'revoked');
      const v2 = l.flow === 'v2';
      const order = [
        ...signers.map((r) => ({ step: Number(r.step ?? r.seq), signed: r.status === 'signed' })),
        ...(l.property_step != null ? [{ step: Number(l.property_step), signed: Boolean(l.signed_at) }] : []),
      ].sort((a, b) => a.step - b.step);
      const turn = liveTurn(rs, l.routing ?? 'order', l);
      const declined = signers.find((r) => r.status === 'declined');
      const live = turn.signers;
      const expired = live.find((r) => r.expires_at && r.expires_at < now);
      const row = {
        kind: 'letter', id: l.id, title: l.subject, reference: l.reference,
        who: l.addressed_to || signers.find((r) => r.organisation)?.organisation || signers[0]?.name || null,
        link: v2 ? `#/sign-doc?id=${l.id}` : `#/letter?id=${l.id}`,
        segments: order.map((o) => o.signed),
        since: l.updated_at ?? l.created_at,
      };
      const mineAsStaff = live.some((r) => r.reach === 'staff' && Number(r.user_id) === me);
      const mineAsProperty = turn.property && may('corr_sign') && (!l.property_user_id || Number(l.property_user_id) === me);

      if (l.status === 'void') stopped.push({ ...row, status: 'Withdrawn', tone: '', note: l.closed_note });
      else if (declined) stopped.push({ ...row, status: 'Declined', tone: 'bad', note: declined.decline_note, waitingOn: declined.name });
      else if (l.status === 'signed') {
        completed.push({ ...row, status: 'Completed', tone: 'good', since: [l.signed_at, ...signers.map((r) => r.signed_at)].filter(Boolean).sort().pop() ?? row.since });
      } else if (l.status === 'awaiting_signature') {
        if (expired) {
          stopped.push({ ...row, status: 'Expired', tone: '', waitingOn: expired.name, expiresAt: expired.expires_at });
        } else if (mineAsStaff || mineAsProperty) {
          waitingOnUs.push({ ...row, status: 'Your turn to sign', tone: 'blue', yourTurn: true, link: `#/sign-in?id=${l.id}`, track: row.link });
        } else {
          const names = [...live.map((r) => r.name), ...(turn.property ? [property] : [])];
          withOthers.push({
            ...row,
            status: live.some((r) => r.status === 'opened') ? 'Opened, not signed' : 'Out for signature',
            tone: 'blue',
            waitingOn: names.join(', ') || null,
            sentAt: live.map((r) => r.turn_told_at).filter(Boolean).sort().pop() ?? l.updated_at,
            remindedAt: live.map((r) => r.reminded_at).filter(Boolean).sort().pop() ?? null,
            expiresAt: live.map((r) => r.expires_at).filter(Boolean).sort()[0] ?? null,
          });
        }
      } else if (l.status === 'draft') {
        drafts.push({ ...row, status: 'Draft', tone: '', preparedBy: String(l.created_by ?? '').replace(/\s*\([^)]*\)$/, '') });
      }
    }
  }

  const bySince = (a, b) => String(b.since ?? '').localeCompare(String(a.since ?? ''));
  const oldestFirst = (a, b) => String(a.since ?? '').localeCompare(String(b.since ?? ''));
  return json({
    waitingOnUs: waitingOnUs.sort(oldestFirst),
    withOthers: withOthers.sort(oldestFirst),
    completed: completed.sort(bySince).slice(0, 100),
    stopped: stopped.sort(bySince).slice(0, 100),
    drafts: drafts.sort(bySince),
    canWrite: may('corr_write'),
  });
}
