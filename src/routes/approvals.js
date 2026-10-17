import { badRequest, forbidden, json, str } from '../lib/http.js';
import { allows, effectivePermissions } from '../lib/permissions.js';
import { recordsOn } from '../lib/records-on-a-login.js';
import { purposeOf } from '../lib/advances.js';
import { siteOrigin } from '../lib/site.js';
import { fromInsight } from './till.js';

/**
 * Everything in HIVE waiting for a decision, for Insight's Approvals page, and
 * the decision made from there.
 *
 * Insight names who is asking by email. That person's own HIVE login is found
 * and every list and every decision goes through HIVE's own routes, with
 * HIVE's own permission on each, as that login. So a decision made in Insight
 * is the decision made here: the same checks, the same rota and balance
 * changes, the same notices to whoever asked. Only the name differs, "Michael
 * Test via Insight", so the record says where it was pressed.
 *
 * Each kind says what it is (`list`) and how it is decided (`decide`). The
 * decisions are the choices HIVE's own screen gives, as buttons and fields
 * Insight draws without knowing what any of them mean.
 */

const VIA = ' via Insight';

const when = (at) => (at ? String(at).replace('T', ' ').slice(0, 16) : null);
const days = (n) => `${Number(n)} day${Number(n) === 1 ? '' : 's'}`;
const shortDay = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(day || '')
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
const span = (from, to) => (from === to || !to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`);
const note = (required = false) => (required ? 'required' : 'optional');
const yes = (label = 'Approve', extra = {}) => ({ key: 'approve', label, primary: true, note: 'optional', ...extra });
const no = (label = 'Refuse', extra = {}) => ({ key: 'refuse', label, note: 'optional', ...extra });

const KINDS = {
  leave: {
    label: 'Leave',
    permission: 'att_manage',
    link: '#/att-leave',
    async list(run, db) {
      const { leave } = await run('GET', '/api/att/leave?status=pending');
      const types = await db.prepare(
        "SELECT code, label FROM att_reasons WHERE kind = 'leave' AND active = 1 ORDER BY label",
      ).all().catch(() => ({ results: [] }));
      const options = (types.results ?? []).map((t) => [t.code, t.label]);
      return (leave ?? []).filter((l) => l.status === 'pending').map((l) => ({
        id: l.id,
        title: `Leave · ${l.staff_name}`,
        sub: `${l.reason_label || l.reason_code}, ${days(l.days)}, ${span(l.from_day, l.to_day)}`,
        who: l.staff_name,
        askedAt: l.requested_at,
        details: [
          ['Type asked for', l.reason_label || l.reason_code],
          ['Days', `${span(l.from_day, l.to_day)}: ${days(l.days)}${l.estimated ? ' (a guess: the rota did not reach that far yet)' : ''}`],
          ['Why', l.reason],
          ['Asked by', l.requested_by],
        ],
        decisions: [
          yes('Approve', {
            fields: [
              { name: 'reason', label: 'Recorded as', type: 'select', value: l.reason_code, options },
              { name: 'daysCharged', label: 'Days charged', type: 'number', value: Number(l.days), min: 0, step: 0.5 },
            ],
          }),
          no(),
        ],
      }));
    },
    decide: (run, id, { decision, note: said, fields }) => run('POST', `/api/att/leave/${id}/decide`, {
      decision: decision === 'approve' ? 'approved' : 'rejected',
      note: said,
      ...(decision === 'approve' ? { reason: fields.reason || undefined, daysCharged: fields.daysCharged } : {}),
    }),
  },

  leaveDays: {
    label: 'Leave days changed',
    permission: 'att_setup',
    link: '#/signoff',
    async list(run) {
      const { rows } = await run('GET', '/api/att/leave-changes');
      return (rows ?? []).filter((r) => r.status === 'pending').map((r) => ({
        id: r.id,
        title: `Leave days · ${r.staff.name}`,
        sub: `${span(r.from, r.to)}: ${days(r.was)} → ${days(r.days)}`,
        who: r.staff.name,
        askedAt: r.at,
        details: [
          ['Period', span(r.from, r.to)],
          ['Change', `${days(r.was)} → ${days(r.days)} charged`],
          ['Why', r.reason],
          ['Asked by', r.actor],
        ],
        decisions: [yes(), no('Send back')],
      }));
    },
    decide: (run, id, { decision, note: said }) => run('POST', `/api/att/leave-changes/${id}/decide`, {
      approve: decision === 'approve', note: said,
    }),
  },

  times: {
    label: 'Clock-time correction',
    permission: 'att_setup',
    link: '#/att-setup',
    async list(run) {
      const { pending } = await run('GET', '/api/att/time-edits');
      const pair = (was, now) => (was === now ? (now || '—') : `${was || '—'} → ${now || '—'}`);
      return (pending ?? []).map((e) => {
        const wasIn = e.was_in ?? e.observed_in;
        const wasOut = e.was_out ?? e.observed_out;
        return {
          id: e.id,
          title: `Clock-time correction · ${e.staff_name}`,
          sub: `${shortDay(e.day)} · in ${pair(wasIn, e.now_in)}, out ${pair(wasOut, e.now_out)}`,
          who: e.staff_name,
          askedAt: e.at_utc,
          details: [
            ['Day', shortDay(e.day)],
            ['The terminal saw', `in ${e.observed_in || '—'}, out ${e.observed_out || '—'}`],
            ['Asked for', `in ${e.now_in || '—'}, out ${e.now_out || '—'}`],
            ['Why', e.reason],
            ['Asked by', e.actor],
          ],
          decisions: [yes(), no('Send back', { note: note(true) })],
        };
      });
    },
    decide: (run, id, { decision, note: said }) => run('POST', `/api/att/time-edits/${id}/decide`, {
      decision: decision === 'approve' ? 'approve' : 'reject', note: said,
    }),
  },

  availability: {
    label: 'Availability',
    permission: 'att_rota',
    link: '#/att-rota',
    async list(run) {
      const { waiting } = await run('GET', '/api/att/availability/waiting');
      return (waiting ?? []).map((w) => {
        const sorted = [...w.days].sort();
        const hours = w.fromTime || w.toTime ? ` ${w.fromTime || ''}–${w.toTime || ''}` : '';
        return {
          id: `${w.staffId}:${sorted.join(',')}`,
          title: `Availability · ${w.staff}`,
          sub: `${w.status === 'preferred' ? 'Would like to work' : 'Cannot work'}${hours} · ${sorted.length === 1 ? shortDay(sorted[0]) : `${sorted.length} days from ${shortDay(sorted[0])}`}`,
          who: w.staff,
          askedAt: w.askedAt,
          details: [
            ['Asks', w.status === 'preferred' ? 'To work these days' : `Not to be put on${hours ? ` between${hours}` : ''}`],
            ['Days', sorted.map(shortDay).join(', ')],
            ['Why', w.note],
          ],
          decisions: [yes('Agree'), no('Decline')],
        };
      });
    },
    decide(run, id, { decision, note: said }) {
      const [staffId, list] = String(id).split(':');
      return run('POST', '/api/att/availability/decide', {
        staffId: Number(staffId), days: String(list || '').split(',').filter(Boolean),
        decision: decision === 'approve' ? 'approved' : 'declined', note: said,
      });
    },
  },

  swap: {
    label: 'Shift swap',
    permission: ['att_rota', 'att_manage'],
    link: '#/att-swaps',
    async list(run) {
      const { waiting } = await run('GET', '/api/swaps/queue');
      const shift = (s, day) => (s ? `${s.name} ${shortDay(day)} ${s.starts_at}–${s.ends_at}` : shortDay(day));
      return (waiting ?? []).map((s) => ({
        id: s.id,
        title: `Shift swap · ${s.from?.name || 'Somebody'} → ${s.takenBy?.name || 'somebody'}`,
        sub: `${shift(s.shift, s.day)}${s.back ? ` for ${shift(s.back, s.back.day)}` : ''}`,
        who: s.from?.name || null,
        askedAt: s.createdAt,
        details: [
          ['Gives up', shift(s.shift, s.day)],
          ['Taken by', s.takenBy?.name],
          s.back ? ['In return', shift(s.back, s.back.day)] : null,
          ['Why', s.reason],
        ].filter(Boolean),
        warnings: (s.findings ?? []).filter((f) => f.level === 'high' || f.level === 'warn').map((f) => f.text),
        decisions: [yes(), no('Decline')],
      }));
    },
    decide: (run, id, { decision, note: said }) => run('POST', `/api/swaps/${id}/decide`, {
      approve: decision === 'approve', note: said,
    }),
  },

  advance: {
    label: 'Salary advance',
    permission: 'hr_pay',
    link: '#/att-advances',
    async list(run, db) {
      const rows = await db.prepare(
        `SELECT a.*, s.name FROM hr_advance a JOIN att_staff s ON s.id = a.staff_id
          WHERE a.status = 'requested' ORDER BY a.asked_at`,
      ).all().catch(() => ({ results: [] }));
      return (rows.results ?? []).map((a) => ({
        id: a.id,
        title: `Salary advance · ${a.name}`,
        sub: `${purposeOf(a.purpose)?.label || 'Advance'} · over ${a.months} month${a.months === 1 ? '' : 's'}`,
        who: a.name,
        askedAt: a.asked_at,
        amount: Number(a.amount),
        details: [
          ['For', purposeOf(a.purpose)?.label],
          ['Asked for', `${Number(a.amount).toFixed(2)}, ${Number(a.monthly).toFixed(2)} a month for ${a.months} month${a.months === 1 ? '' : 's'}`],
          ['Why', a.reason],
        ],
        decisions: [
          yes('Approve', {
            fields: [
              { name: 'amount', label: 'Amount', type: 'number', value: Number(a.amount), min: 1, step: 0.01 },
              { name: 'months', label: 'Months', type: 'number', value: Number(a.months), min: 1, max: 60, step: 1 },
            ],
          }),
          no('Decline'),
        ],
      }));
    },
    decide: (run, id, { decision, note: said, fields }) => run('POST', `/api/advances/${id}/decide`, decision === 'approve'
      ? { approve: true, amount: fields.amount, months: fields.months, note: said }
      : { approve: false, note: said }),
  },

  medical: {
    label: 'Medical claim',
    permission: 'hr_pay',
    link: '#/att-medical',
    async list(run, db) {
      const rows = await db.prepare(
        `SELECT c.*, s.name FROM hr_medical_claim c JOIN att_staff s ON s.id = c.staff_id
          WHERE c.status = 'requested' ORDER BY c.asked_at`,
      ).all().catch(() => ({ results: [] }));
      return (rows.results ?? []).map((c) => ({
        id: c.id,
        title: `Medical claim · ${c.name}`,
        sub: c.what || 'Medical costs',
        who: c.name,
        askedAt: c.asked_at,
        amount: Number(c.amount),
        details: [['For', c.what], ['Claimed', Number(c.amount).toFixed(2)], ['Year', c.year]],
        decisions: [
          yes('Approve', {
            fields: [
              { name: 'amount', label: 'Amount approved', type: 'number', value: Number(c.amount), min: 0.01, max: Number(c.amount), step: 0.01 },
              { name: 'over', label: 'Approve even if it is over their allowance', type: 'check', value: false },
            ],
          }),
          no(),
        ],
      }));
    },
    decide: (run, id, { decision, note: said, fields }) => run('POST', `/api/medical/claims/${id}/decide`, decision === 'approve'
      ? { approve: true, amount: fields.amount, over: fields.over === true, note: said }
      : { approve: false, note: said }),
  },

  lunch: {
    label: 'Lunch change',
    permission: 'lunch',
    link: '#/att-lunch',
    async list(run, db) {
      const rows = await db.prepare(
        `SELECT c.*, s.name FROM lunch_change c JOIN att_staff s ON s.id = c.staff_id
          WHERE c.decision = 'waiting' ORDER BY c.day, c.id`,
      ).all().catch(() => ({ results: [] }));
      return (rows.results ?? []).map((c) => ({
        id: c.id,
        title: `Lunch · ${c.name}`,
        sub: `${c.want ? 'Put me down' : 'Take me off'} for ${shortDay(c.day)}`,
        who: c.name,
        askedAt: c.asked_at,
        details: [['Asks', `${c.want ? 'To be put down for lunch' : 'To be taken off lunch'} on ${shortDay(c.day)}`], ['Why', c.note]],
        decisions: [yes(), no('Decline')],
      }));
    },
    decide: (run, id, { decision, note: said }) => run('POST', `/api/lunch/changes/${id}`, {
      decision: decision === 'approve' ? 'approved' : 'declined', note: said,
    }),
  },

  document: {
    label: 'Document',
    permission: 'hr_manage',
    link: '#/people',
    async list(run) {
      const { documents } = await run('GET', '/api/hr/documents');
      return (documents ?? []).map((d) => ({
        id: d.id,
        title: `Document · ${d.staff_name}`,
        sub: `${d.title || d.kind || 'A file'}${d.filename ? ` · ${d.filename}` : ''}`,
        who: d.staff_name,
        askedAt: d.uploaded_at,
        details: [['What', d.title || d.kind], ['File', d.filename], ['Sent by', d.uploaded_by], ['Note', d.note]],
        decisions: [
          yes('Accept', { fields: [{ name: 'expiresOn', label: 'Expires on (if it does)', type: 'date', value: '' }] }),
          no('Send back', { note: note(true) }),
        ],
      }));
    },
    decide: (run, id, { decision, note: said, fields }) => run('POST', `/api/hr/documents/${id}/decide`, {
      decision: decision === 'approve' ? 'accept' : 'reject', note: said, expiresOn: fields.expiresOn || undefined,
    }),
  },

  details: {
    label: 'Personal details',
    permission: 'hr_manage',
    link: '#/people',
    async list(run) {
      const { rows } = await run('GET', '/api/hr/submissions');
      const say = (v) => (Array.isArray(v) ? (v.join('; ') || '—') : (v || '—'));
      return (rows ?? []).map((s) => ({
        id: s.id,
        title: `Personal details · ${s.name}`,
        sub: `${s.changes.length} change${s.changes.length === 1 ? '' : 's'}`,
        who: s.name,
        askedAt: s.submittedAt,
        details: s.changes.map((c) => [c.label, `${say(c.from)} → ${say(c.to)}`]),
        decisions: [
          yes('Accept', {
            fields: [{
              name: 'keys', label: 'Accept these', type: 'checks',
              value: s.changes.map((c) => c.key), options: s.changes.map((c) => [c.key, c.label]),
            }],
          }),
          no('Refuse all'),
        ],
      }));
    },
    decide: (run, id, { decision, note: said, fields }) => (decision === 'approve'
      ? run('POST', `/api/hr/submissions/${id}/accept`, { keys: Array.isArray(fields.keys) ? fields.keys : undefined, note: said })
      : run('POST', `/api/hr/submissions/${id}/reject`, { note: said })),
  },

  query: {
    label: 'Sign-off question',
    permission: 'att_manage',
    choices: ['direction', 'sign', 'close'],
    link: '#/signoff?tab=queries',
    async list(run) {
      const { rows } = await run('GET', '/api/att/queries');
      return (rows ?? []).filter((q) => q.status === 'open').map((q) => ({
        id: q.id,
        title: `Sign-off question · ${q.staff.name}`,
        sub: `${span(q.from, q.to)} · raised by ${String(q.raisedBy || 'somebody').replace(/ \([^)]*\)$/, '')}`,
        who: q.staff.name,
        askedAt: q.raisedAt,
        details: [
          ['Period', span(q.from, q.to)],
          ['Question', q.reason],
          ['Asked of', q.addressedName],
          ...(q.notes ?? []).map((n) => [String(n.author || '').replace(/ \([^)]*\)$/, ''), n.body]),
        ],
        decisions: [
          { key: 'direction', label: 'Answer and hand back', primary: true, note: 'required' },
          { key: 'sign', label: 'Sign the days off', note: 'optional' },
          { key: 'close', label: 'Close, no change', note: 'optional' },
        ],
      }));
    },
    decide: (run, id, { decision, note: said }) => run('POST', `/api/att/queries/${id}/answer`, { action: decision, body: said }),
  },
};

/** The HIVE login for an Insight email, as a session, or a refusal that says why. */
async function sessionFor(db, email) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) throw badRequest('Whose approvals?');
  const user = await db.prepare(
    `SELECT id, name, role, permissions, active, staff_id, email,
            (SELECT group_concat(staff_id) FROM user_staff WHERE user_id = users.id) AS also_staff
       FROM users WHERE LOWER(email) = ?1 AND active = 1 LIMIT 1`,
  ).bind(address).first();
  if (!user) throw forbidden(`No HIVE login has the email ${address}. Put it on your HIVE login (Setup › Users) to decide HIVE's approvals from Insight.`);
  const named = { ...user, name: `${user.name}${VIA}` };
  return { user: named, permissions: effectivePermissions(user), via: 'password', records: recordsOn(user.staff_id, user.also_staff) };
}

const mayDecide = (kind, session) => allows(kind.permission, session.permissions);

/**
 * Insight → HIVE: everything waiting that this person may decide.
 * A kind that fails is said, not hidden, and does not stop the others.
 */
export async function linkList(ctx, runAs) {
  const body = await fromInsight(ctx);
  const session = await sessionFor(ctx.db, body.email);
  const run = (method, path, data) => runAs(session, method, path, data);
  const site = await siteOrigin(ctx.db, '');
  const items = [];
  const failed = [];
  for (const [key, kind] of Object.entries(KINDS)) {
    if (!mayDecide(kind, session)) continue;
    try {
      for (const item of await kind.list(run, ctx.db)) { // eslint-disable-line no-await-in-loop
        items.push({
          ...item, kind: key, kindLabel: kind.label, id: String(item.id),
          askedAt: when(item.askedAt), amount: item.amount ?? null,
          details: (item.details ?? []).filter(([, v]) => v != null && v !== ''),
          warnings: item.warnings ?? [],
          open: site ? `${site}/${kind.link}` : null,
        });
      }
    } catch (err) {
      failed.push({ kind: key, label: kind.label, error: err.message });
    }
  }
  return json({ as: session.user.name.slice(0, -VIA.length), items, failed });
}

/** Insight → HIVE: one decision, through HIVE's own route for it, as this person. */
export async function linkDecide(ctx, runAs) {
  const body = await fromInsight(ctx);
  const kind = KINDS[body.kind];
  if (!kind) throw badRequest('HIVE does not know that kind of approval.');
  const session = await sessionFor(ctx.db, body.email);
  if (!mayDecide(kind, session)) throw forbidden(`Your HIVE login may not decide ${kind.label.toLowerCase()}s.`);
  const id = String(body.id ?? '').trim();
  if (!id || id.length > 2000) throw badRequest('Which one?');
  const decision = String(body.decision || '');
  const said = str(body.note, 'Note', { max: 500 }) || '';
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
  // Never a refusal by default: a decision HIVE does not know is said, not guessed at.
  if (!(kind.choices ?? ['approve', 'refuse']).includes(decision)) throw badRequest('HIVE does not know that decision.');
  const run = (method, path, data) => runAs(session, method, path, data);
  const out = await kind.decide(run, id, { decision, note: said || undefined, fields });
  return json({ ok: true, as: session.user.name, said: out?.status || decision, result: out ?? null });
}

export const APPROVAL_KINDS = Object.keys(KINDS);
