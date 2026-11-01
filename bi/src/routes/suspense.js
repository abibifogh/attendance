import { all, first, run } from '../lib/db.js';
import { badRequest, str } from '../lib/http.js';
import { isDay, todayIn } from '../lib/dates.js';
import { saveAnswer, netOf } from './shifts.js';
import { logEvent } from './notes.js';

/**
 * The suspense account: a difference an admin cannot settle yet, parked to
 * look at later. A difference put there counts as answered ("In suspense");
 * what is left when differences reconciled together do not net to nothing
 * can go there too. Later it is cleared: matched with others in the account
 * (netting to nothing, or saying why), or moved to the safe, where it is a
 * line in (plus) or out (minus) until the safe is next counted.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const SLOTS = ['morning', 'afternoon', 'night'];
export const IN_SUSPENSE = 'In suspense';

const view = (r) => {
  let keys = [];
  try { keys = JSON.parse(r.keys || '[]'); } catch { keys = []; }
  return {
    id: r.id, ref: `S${r.id}`, keys, day: r.day, slot: r.slot, what: r.what, amount: r.amount, note: r.note, by: r.by_name, at: r.at,
    status: r.status, group: r.group_id, clearedNote: r.cleared_note, clearedBy: r.cleared_by, clearedAt: r.cleared_at,
    safeDay: r.safe_day, counted: r.closure_id != null,
  };
};

/** Put in suspense: one difference (answered "In suspense"), or the net of some reconciled together. */
export async function addSuspense(env, body, account, { amount: worked = null } = {}) {
  const keys = (Array.isArray(body?.keys) ? body.keys : [body?.key]).map((k) => String(k || '').trim()).filter(Boolean);
  if (!keys.length) throw badRequest('Which difference?');
  // The amount is the differences' own, worked out here: what the browser
  // says is only checked against it, never taken.
  let amount = worked;
  if (amount == null) {
    if (body?.reconciled) throw badRequest('What is left after reconciling goes in suspense with the reconciliation itself.');
    const { chosen, net, known } = await netOf(env, keys);
    if (chosen.some((x) => !x)) throw badRequest('One of those is not there any more: the shift may agree now. Reload and try again.');
    amount = known ? net : (keys.length === 1 ? chosen[0].amount : null);
    if (amount == null) throw badRequest('Not all of these have a direction of their own: put them in suspense one by one.');
    if (body?.amount != null && Math.round(Number(body.amount)) !== amount) throw badRequest(`It comes to ${amount < 0 ? '−' : '+'}GH₵${(Math.abs(amount) / 100).toFixed(2)} now. Reload and try again.`);
  }
  if (!Number.isFinite(amount) || amount === 0) throw badRequest('Put in suspense: an amount other than nothing.');
  const what = str(body?.what, 'What it is', { max: 200 }) || 'A difference';
  const note = str(body?.note, 'Note', { max: 600 }) || null;
  const day = isDay(String(body?.day || '')) ? body.day : null;
  const slot = SLOTS.includes(body?.slot) ? body.slot : null;
  const answered = body?.reconciled ? 0 : 1;
  const made = await first(env.DB, `INSERT INTO suspense (keys, day, slot, what, amount, note, answered, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING *`,
    JSON.stringify(keys), day, slot, what, amount, note, answered, who(account), now());
  // Each difference put there is answered by it; reconciled together, they are answered already.
  if (answered) {
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await saveAnswer(env, { key, answer: IN_SUSPENSE, note: `S${made.id}${note ? `: ${note}` : ''}` }, account);
    }
  } else {
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await logEvent(env, key, `Reconciled together; the net went to suspense as S${made.id}`, who(account));
    }
  }
  return { ok: true, entry: view(made) };
}

/** The account: what is open, with its total, and what was cleared lately. */
export async function suspenseView(env) {
  const open = (await all(env.DB, "SELECT * FROM suspense WHERE status = 'open' ORDER BY day, id")).map(view);
  const cleared = (await all(env.DB, "SELECT * FROM suspense WHERE status <> 'open' ORDER BY cleared_at DESC, id DESC LIMIT 60")).map(view);
  return { open, cleared, total: open.reduce((t, e) => t + e.amount, 0) };
}

/** Matched together: two or more open entries that net to nothing, or saying why they do not. */
export async function matchSuspense(env, body, account) {
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(Number).filter(Number.isInteger))];
  if (ids.length < 2) throw badRequest('Tick at least two to match.');
  const rows = await all(env.DB, `SELECT * FROM suspense WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(', ')})`, ...ids);
  if (rows.length !== ids.length || rows.some((r) => r.status !== 'open')) throw badRequest('Only entries still open can be matched.');
  const net = rows.reduce((t, r) => t + r.amount, 0);
  const note = str(body?.note, 'What happened', { max: 600 }) || null;
  if (net !== 0 && !note) throw badRequest('They do not net to nothing: say why they are matched.');
  const group = Math.min(...ids);
  await env.DB.batch(ids.map((id) => env.DB.prepare("UPDATE suspense SET status = 'matched', group_id = ?2, cleared_note = ?3, cleared_by = ?4, cleared_at = ?5 WHERE id = ?1")
    .bind(id, group, note, who(account), now())));
  // Agreed means it nets: what the match leaves stays in the account, open,
  // as an entry of its own, so it is never cleared by being matched.
  let left = null;
  if (net !== 0) {
    const keys = [...new Set(rows.flatMap((r) => { try { return JSON.parse(r.keys || '[]'); } catch { return []; } }))];
    left = await first(env.DB, `INSERT INTO suspense (keys, day, slot, what, amount, note, answered, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8) RETURNING *`,
      JSON.stringify(keys), rows[0].day, rows[0].slot, `Left after matching ${ids.map((id) => `S${id}`).join(', ')}`, net, note, who(account), now());
  }
  return { ok: true, net, left: left ? view(left) : null };
}

/** Moved to the safe: a line in (plus) or out (minus) on the day given, until the safe is next counted. */
export async function suspenseToSafe(env, body, account) {
  const r = await first(env.DB, 'SELECT * FROM suspense WHERE id = ?1', Number(body?.id));
  if (!r || r.status !== 'open') throw badRequest('Only an entry still open can be moved to the safe.');
  const day = isDay(String(body?.day || '')) ? body.day : todayIn('UTC');
  if (day > todayIn('UTC')) throw badRequest('Not a day still to come.');
  const note = str(body?.note, 'Note', { max: 600 }) || null;
  await run(env.DB, "UPDATE suspense SET status = 'safe', safe_day = ?2, cleared_note = ?3, cleared_by = ?4, cleared_at = ?5 WHERE id = ?1", r.id, day, note, who(account), now());
  return { ok: true };
}

/**
 * Undone: an open entry taken out of the account (its differences open
 * again); a match opened again, all of it; a move to the safe taken back,
 * unless a count has taken it in.
 */
export async function undoSuspense(env, body, account) {
  const r = await first(env.DB, 'SELECT * FROM suspense WHERE id = ?1', Number(body?.id));
  if (!r) throw badRequest('No such entry.');
  if (r.status === 'open') {
    if (r.answered) {
      let keys = [];
      try { keys = JSON.parse(r.keys || '[]'); } catch { keys = []; }
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        const a = await first(env.DB, 'SELECT answer, note FROM shift_answer WHERE key = ?1', key);
        // eslint-disable-next-line no-await-in-loop
        if (a?.answer === IN_SUSPENSE && String(a.note || '').startsWith(`S${r.id}`)) await saveAnswer(env, { key, answer: '' }, account);
      }
    }
    // What was left after reconciling: taken out, the reconciliation it came
    // from is undone too, so each difference is open again at its full size.
    let unlinked = false;
    if (!r.answered) {
      let own = [];
      try { own = JSON.parse(r.keys || '[]').map(String); } catch { own = []; }
      const want = JSON.stringify(own.sort());
      for (const l of await all(env.DB, "SELECT id, keys FROM shift_link WHERE COALESCE(status, 'applied') = 'applied'").catch(() => [])) {
        let keys = [];
        try { keys = JSON.parse(l.keys).map(String); } catch { keys = []; }
        if (JSON.stringify([...keys].sort()) !== want) continue;
        // eslint-disable-next-line no-await-in-loop
        await run(env.DB, 'DELETE FROM shift_link WHERE id = ?1', l.id);
        for (const k of keys) {
          // eslint-disable-next-line no-await-in-loop
          await logEvent(env, k, `S${r.id} taken out of suspense; no longer reconciled together`, who(account)).catch(() => {});
        }
        unlinked = true;
      }
    }
    await run(env.DB, 'DELETE FROM suspense WHERE id = ?1', r.id);
    return { ok: true, removed: true, unlinked };
  }
  if (r.closure_id != null) throw badRequest('A safe count has taken it in: undo that count first.');
  if (r.status === 'matched') {
    await run(env.DB, "UPDATE suspense SET status = 'open', group_id = NULL, cleared_note = NULL, cleared_by = NULL, cleared_at = NULL WHERE group_id = ?1", r.group_id);
  } else {
    await run(env.DB, "UPDATE suspense SET status = 'open', safe_day = NULL, cleared_note = NULL, cleared_by = NULL, cleared_at = NULL WHERE id = ?1", r.id);
  }
  return { ok: true };
}

/** For the safe book: moved to the safe, not yet taken in by a count. */
export async function suspenseSafeLines(env) {
  return (await all(env.DB, "SELECT * FROM suspense WHERE status = 'safe' AND closure_id IS NULL ORDER BY safe_day, id").catch(() => [])).map(view);
}

/** A safe count takes them in. */
export async function closeSuspense(env, ids, closureId) {
  if (!ids.length) return;
  await env.DB.batch(ids.map((id) => env.DB.prepare('UPDATE suspense SET closure_id = ?2 WHERE id = ?1').bind(id, closureId)));
}
