import { all, first, getSettings, run, setSetting } from '../lib/db.js';
import { addDays } from '../lib/dates.js';
import { badRequest, forbidden, notFound, str } from '../lib/http.js';
import { roleOf } from './till.js';

/**
 * The money to-do list.
 *
 * Two checks make it, each re-run whenever Odoo is asked:
 *
 * - `unbilled`: a PO confirmed in Odoo (in the last 90 days, or paid in cash
 *   from the drawer or the safe at any time) still with no posted bill some
 *   days later (7 unless set): from the day the cash left, or the day it was
 *   ordered. It clears itself when the bill is posted;
 * - `differs`: what left the cash is not what the PO says.
 *
 * A third, `nopo` (a bill with no PO), is no longer raised; its old items
 * were closed when it stopped.
 *
 * Each new item is given to the supervisor with the fewest open, so the list
 * shares itself out. A supervisor sees their own; an admin sees everything,
 * can give an item to somebody else, and decides every answer: approved and
 * it is closed, sent back and it is theirs again.
 */

const DEFAULT_DAYS = 7;
/** How far back a confirmed PO with no bill is looked for. */
export const PO_LOOKBACK_DAYS = 90;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const parse = (text) => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

export const KIND_LABEL = {
  unbilled: 'PO with no posted bill in Odoo',
  differs: 'Paid is not what the PO says',
  nopo: 'A bill with no PO',
};

/** Active supervisors, fewest open items first. */
async function supervisors(env) {
  try {
    return await all(env.DB, `SELECT a.id, a.name, a.email,
        (SELECT COUNT(*) FROM money_todo t WHERE t.assignee_id = a.id AND t.state != 'closed') AS load
       FROM accounts a JOIN account_access g ON g.account_id = a.id
      WHERE g.system_id = 'insight' AND g.role = 'supervisor' AND a.active = 1
      ORDER BY load, a.name, a.id`);
  } catch { return []; }
}

/** Raise what the checks find, close what has put itself right, and share out whatever nobody has. */
export async function syncTodos(env, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const settings = await getSettings(env.DB).catch(() => ({}));
  const days = Number.isFinite(Number(settings.todo_unbilled_days)) && settings.todo_unbilled_days !== undefined
    ? Math.max(0, Number(settings.todo_unbilled_days)) : DEFAULT_DAYS;

  const pos = await all(env.DB, 'SELECT * FROM cash_po WHERE in_odoo = 1');
  const wanted = new Map();
  const cutoff = addDays(today, -days);
  for (const p of pos) {
    let bills = [];
    try { bills = JSON.parse(p.bills || '[]'); } catch { bills = []; }
    const drafts = bills.filter((b) => b.state === 'draft').map((b) => b.name);
    const detail = { po: p.po, vendor: p.vendor, paidFrom: p.paid_from, paidDay: p.paid_day, paid: p.paid, poTotal: p.po_total, source: p.source, drafts };
    // A draft bill is not the end of it: the item stays until the bill is posted.
    if (!p.posted && p.paid_day <= cutoff) {
      wanted.set(`unbilled:${p.po}`, { kind: 'unbilled', ref: p.po, day: p.paid_day, amount: p.paid, detail });
    }
    if (p.po_total != null && p.po_total !== p.paid) {
      wanted.set(`differs:${p.po}`, { kind: 'differs', ref: p.po, day: p.paid_day, amount: p.paid - p.po_total, detail });
    }
  }
  // Every other PO confirmed in Odoo lately, however it was paid: no posted
  // bill some days after it was ordered is an item too.
  let recent = [];
  try { recent = await all(env.DB, 'SELECT * FROM odoo_po'); } catch { recent = []; }
  const cashNames = new Set(pos.map((p) => p.po));
  for (const o of recent) {
    if (cashNames.has(o.po) || o.posted || !(o.total > 0) || !o.ordered_on || o.ordered_on > cutoff) continue;
    let drafts = [];
    try { drafts = JSON.parse(o.drafts || '[]'); } catch { drafts = []; }
    wanted.set(`unbilled:${o.po}`, {
      kind: 'unbilled', ref: o.po, day: o.ordered_on, amount: o.total,
      detail: { po: o.po, vendor: o.vendor, poTotal: o.total, orderedOn: o.ordered_on, paidFrom: null, drafts },
    });
  }

  // What has put itself right.
  const pastPo = new Map(pos.map((p) => [p.po, p]));
  const openPo = new Map(recent.map((o) => [o.po, o]));
  const windowStart = addDays(today, -PO_LOOKBACK_DAYS);
  const existing = await all(env.DB, 'SELECT * FROM money_todo');
  let closed = 0;
  let reopened = 0;
  for (const t of existing) {
    if (wanted.has(t.key)) {
      // Closed by itself, and wrong again: open it again. Closed by a person stays closed.
      if (t.state === 'closed' && t.closed_by === 'Insight') {
        await run(env.DB, "UPDATE money_todo SET state = 'open', closed_by = NULL, closed_at = NULL, closed_why = NULL WHERE id = ?1", t.id);
        reopened += 1;
      }
      continue;
    }
    if (t.state === 'closed') continue;
    let why = null;
    if (t.kind === 'unbilled' && (pastPo.get(t.ref)?.posted || openPo.get(t.ref)?.posted)) why = 'The bill is posted in Odoo.';
    else if (t.kind === 'unbilled' && !pastPo.has(t.ref) && !openPo.has(t.ref) && (t.day || '') >= windowStart) why = 'The PO is no longer confirmed in Odoo.';
    else if (t.kind === 'differs' && pastPo.has(t.ref)) why = 'The amounts now agree.';
    else if (t.kind === 'differs' && !pastPo.has(t.ref)) why = 'It is no longer paid from the drawer or the safe.';
    // Bills without a PO are no longer raised: a PO without a bill is.
    else if (t.kind === 'nopo') why = 'Bills without a PO are no longer chased; POs without a bill are.';
    if (!why) continue;
    await run(env.DB, "UPDATE money_todo SET state = 'closed', closed_by = 'Insight', closed_at = ?2, closed_why = ?3 WHERE id = ?1", t.id, now(), why);
    closed += 1;
  }

  const have = new Set(existing.map((t) => t.key));
  let raised = 0;
  for (const [key, t] of wanted) {
    if (have.has(key)) continue;
    await run(env.DB, `INSERT INTO money_todo (key, kind, ref, day, amount, detail, opened_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`, key, t.kind, t.ref, t.day, t.amount, JSON.stringify(t.detail), now());
    raised += 1;
  }
  const assigned = await shareOut(env);
  return { raised, closed, reopened, assigned };
}

/** Give each open item nobody holds to the supervisor with the fewest. */
async function shareOut(env) {
  const loose = await all(env.DB, "SELECT id FROM money_todo WHERE state != 'closed' AND assignee_id IS NULL ORDER BY day, id");
  if (!loose.length) return 0;
  const people = await supervisors(env);
  if (!people.length) return 0;
  const load = new Map(people.map((p) => [p.id, Number(p.load) || 0]));
  for (const t of loose) {
    const pick = people.slice().sort((a, b) => load.get(a.id) - load.get(b.id) || String(a.name).localeCompare(String(b.name)) || a.id - b.id)[0];
    await run(env.DB, 'UPDATE money_todo SET assignee_id = ?2, assignee_name = ?3 WHERE id = ?1', t.id, pick.id, pick.name || pick.email);
    load.set(pick.id, load.get(pick.id) + 1);
  }
  return loose.length;
}

function view(t) {
  return {
    id: t.id, key: t.key, kind: t.kind, kindLabel: KIND_LABEL[t.kind] || t.kind, ref: t.ref, day: t.day, amount: t.amount,
    detail: parse(t.detail), assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name } : null,
    state: t.state, answer: t.answer, answeredBy: t.answered_by, answeredAt: t.answered_at, sentBack: t.sent_back,
    closedBy: t.closed_by, closedAt: t.closed_at, closedWhy: t.closed_why, openedAt: t.opened_at,
  };
}

/** How many are open and waiting, for a badge. */
export async function todoCounts(env, account = null) {
  try {
    const mine = account && roleOf(account) !== 'admin';
    const row = await first(env.DB, `SELECT
        SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN state = 'answered' THEN 1 ELSE 0 END) AS answered,
        SUM(CASE WHEN state != 'closed' AND assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned
      FROM money_todo ${mine ? 'WHERE assignee_id = ?1' : ''}`, ...(mine ? [account.id ?? -1] : []));
    return { open: Number(row?.open) || 0, answered: Number(row?.answered) || 0, unassigned: Number(row?.unassigned) || 0 };
  } catch { return { open: 0, answered: 0, unassigned: 0 }; }
}

/** The list: a supervisor's own, or everybody's for an admin. */
export async function listTodos(env, account, { closed = false } = {}) {
  const role = roleOf(account);
  if (role !== 'admin' && role !== 'supervisor') throw forbidden('The to-do list is for admins and supervisors.');
  const admin = role === 'admin';
  const where = [closed ? "state = 'closed'" : "state != 'closed'"];
  const binds = [];
  if (!admin) { where.push('assignee_id = ?1'); binds.push(account.id ?? -1); }
  const rows = await all(env.DB, `SELECT * FROM money_todo WHERE ${where.join(' AND ')}
    ORDER BY CASE state WHEN 'answered' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, ${closed ? 'closed_at DESC' : 'day'}, id LIMIT 300`, ...binds);
  const settings = await getSettings(env.DB).catch(() => ({}));
  const checked = await first(env.DB, 'SELECT MAX(checked_at) AS at FROM cash_po').catch(() => null);
  return {
    admin,
    checkedAt: checked?.at || null,
    items: rows.map(view),
    counts: await todoCounts(env, account),
    supervisors: admin ? (await supervisors(env)).map((s) => ({ id: s.id, name: s.name || s.email, load: Number(s.load) || 0 })) : [],
    unbilledDays: settings.todo_unbilled_days !== undefined && settings.todo_unbilled_days !== '' ? Number(settings.todo_unbilled_days) : DEFAULT_DAYS,
  };
}

async function item(env, id) {
  const t = await first(env.DB, 'SELECT * FROM money_todo WHERE id = ?1', Number(id));
  if (!t) throw notFound('No such item on the to-do list.');
  return t;
}

/**
 * Somebody says what happened. A supervisor's answer to a payment or a bill
 * waits for an admin; an admin's own closes it. On a cash PO waiting for its
 * bill, an answer is only a note of where it has got to: the bill closes it.
 */
export async function answerTodo(env, id, body, account) {
  const role = roleOf(account);
  const t = await item(env, id);
  if (t.state === 'closed') throw badRequest('That item is closed.');
  if (role !== 'admin' && !(role === 'supervisor' && Number(t.assignee_id) === Number(account.id))) {
    throw forbidden('That item is on somebody else’s list.');
  }
  const answer = str(body?.answer, 'What happened', { required: true, max: 600 });
  if (t.kind === 'unbilled') {
    await run(env.DB, 'UPDATE money_todo SET answer = ?2, answered_by = ?3, answered_at = ?4, sent_back = NULL WHERE id = ?1',
      t.id, answer, who(account), now());
    return { ok: true, state: t.state };
  }
  if (role === 'admin') {
    await run(env.DB, `UPDATE money_todo SET answer = ?2, answered_by = ?3, answered_at = ?4, state = 'closed',
      closed_by = ?3, closed_at = ?4, closed_why = 'Answered by an admin.', sent_back = NULL WHERE id = ?1`, t.id, answer, who(account), now());
    return { ok: true, state: 'closed' };
  }
  await run(env.DB, `UPDATE money_todo SET answer = ?2, answered_by = ?3, answered_at = ?4, state = 'answered', sent_back = NULL
    WHERE id = ?1`, t.id, answer, who(account), now());
  return { ok: true, state: 'answered' };
}

/** An admin approves an answer, or sends it back with a reason. */
export async function decideTodo(env, id, body, account) {
  if (roleOf(account) !== 'admin') throw forbidden('Only an admin can do that.');
  const t = await item(env, id);
  if (t.state !== 'answered') throw badRequest('That item has no answer waiting.');
  if (body?.approve) {
    await run(env.DB, "UPDATE money_todo SET state = 'closed', closed_by = ?2, closed_at = ?3, closed_why = 'Answer approved.' WHERE id = ?1",
      t.id, who(account), now());
    return { ok: true, state: 'closed' };
  }
  const why = str(body?.note, 'Why it goes back', { required: true, max: 400 });
  await run(env.DB, "UPDATE money_todo SET state = 'open', sent_back = ?2 WHERE id = ?1", t.id, why);
  return { ok: true, state: 'open' };
}

/** An admin gives an item to somebody else. */
export async function assignTodo(env, id, body, account) {
  if (roleOf(account) !== 'admin') throw forbidden('Only an admin can do that.');
  const t = await item(env, id);
  const person = (await supervisors(env)).find((s) => Number(s.id) === Number(body?.accountId));
  if (!person) throw badRequest('Choose a supervisor.');
  await run(env.DB, 'UPDATE money_todo SET assignee_id = ?2, assignee_name = ?3 WHERE id = ?1', t.id, person.id, person.name || person.email);
  return { ok: true };
}

/** An admin gives several items to one supervisor at once. Closed items are left where they are. */
export async function assignMany(env, body, account) {
  if (roleOf(account) !== 'admin') throw forbidden('Only an admin can do that.');
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 500);
  if (!ids.length) throw badRequest('Tick the items to give.');
  const person = (await supervisors(env)).find((s) => Number(s.id) === Number(body?.accountId));
  if (!person) throw badRequest('Choose a supervisor.');
  let moved = 0;
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const out = await env.DB.prepare("UPDATE money_todo SET assignee_id = ?2, assignee_name = ?3 WHERE id = ?1 AND state != 'closed'")
      .bind(id, person.id, person.name || person.email).run();
    moved += Number(out?.meta?.changes) || 0;
  }
  return { ok: true, moved, to: person.name || person.email };
}

/** An admin closes an item that needs nothing done, saying why. It does not come back. */
export async function dismissTodo(env, id, body, account) {
  if (roleOf(account) !== 'admin') throw forbidden('Only an admin can do that.');
  const t = await item(env, id);
  const why = str(body?.note, 'Why nothing is needed', { required: true, max: 400 });
  await run(env.DB, "UPDATE money_todo SET state = 'closed', closed_by = ?2, closed_at = ?3, closed_why = ?4 WHERE id = ?1",
    t.id, who(account), now(), `Nothing needed: ${why}`);
  return { ok: true };
}

/** An admin sets how many days a cash PO may wait for its bill before it is raised. */
export async function saveTodoSettings(env, body, account, { today } = {}) {
  if (roleOf(account) !== 'admin') throw forbidden('Only an admin can do that.');
  const days = Math.round(Number(body?.unbilledDays));
  if (!Number.isFinite(days) || days < 0 || days > 90) throw badRequest('Give a number of days from 0 to 90.');
  await setSetting(env.DB, 'todo_unbilled_days', String(days));
  return { ok: true, ...(await syncTodos(env, today ? { today } : {})) };
}
