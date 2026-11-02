import { all, first, getSettings, run } from '../lib/db.js';
import { callLink } from '../lib/link.js';
import { settle, tell } from '../lib/notices.js';
import { breakfastBase } from './mgmt.js';
import { shareOut } from './todo.js';

/**
 * The kitchen asking the store room, from the breakfast app, in Insight.
 *
 * Kitchen staff ask for stock in the breakfast app (its store room: milk,
 * tissue, soap); a storekeeper issues it there. Insight reads those requests
 * straight from the breakfast app's database every 15 minutes. Each one still
 * waiting is a to-do in To sort out (kind "store"), given to the person an
 * admin chose (`store_requests_to`), or shared out like any to-do when nobody
 * is chosen. They are emailed once when it arrives, and pushed to their phone
 * then and every 15 minutes after, until it is issued (all of it, or what
 * there was: what was not issued comes back as a request of its own),
 * declined or cancelled in the breakfast app. Then the to-do closes itself
 * and the pushes stop.
 *
 * Insight only reads the breakfast app: issuing stays there.
 */

const NEEDED = { now: 'now', today: 'today', tomorrow: 'tomorrow morning' };
/** Pushed again once this long has passed since the last: a minute less than the schedule, so a slow run does not skip one. */
const AGAIN_MS = 14 * 60 * 1000;
const STOPPED = { issued: 'Issued in the breakfast app', received: 'Issued and received in the breakfast app', declined: 'Declined in the breakfast app', cancelled: 'Cancelled in the breakfast app' };

const refOf = (id) => `R-${String(id).padStart(4, '0')}`;
const iso = (t) => (t ? `${String(t).replace(' ', 'T').replace(/Z?$/, '')}Z` : null);
const qty = (n) => String(Math.round(Number(n) * 1000) / 1000);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Who store requests go to: the account an admin chose, while it is active. */
async function chosen(env) {
  const s = await getSettings(env.DB).catch(() => ({}));
  const id = Number(s.store_requests_to);
  if (!Number.isInteger(id) || id <= 0) return null;
  return first(env.DB, 'SELECT id, name, email FROM accounts WHERE id = ?1 AND active = 1', id).catch(() => null);
}

/** Requests still waiting in the breakfast app, each with its lines, items named. */
async function waitingThere(db) {
  const rows = await all(db, "SELECT * FROM store_requests WHERE status = 'waiting' ORDER BY id");
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lines = await all(db, `SELECT l.request_id, l.asked, i.name, i.unit FROM store_request_lines l JOIN ingredients i ON i.id = l.ingredient_id
    WHERE l.request_id IN (${ids.map((_, i) => `?${i + 1}`).join(', ')}) ORDER BY l.id`, ...ids);
  return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.request_id === r.id).map((l) => ({ name: l.name, unit: l.unit || '', asked: Number(l.asked) })) }));
}

/** What a request asks for, in a line: "Milk 4 L, Tissue 2 and 3 more". */
const summary = (lines) => lines.slice(0, 4).map((l) => `${l.name} ${qty(l.asked)}${l.unit ? ` ${l.unit}` : ''}`).join(', ') + (lines.length > 4 ? ` and ${lines.length - 4} more` : '');

/**
 * Read the breakfast app's store room and act: new requests become to-dos and
 * are told; ones still waiting are pushed again every 15 minutes; ones no
 * longer waiting close. Returns what it did. The breakfast app not readable
 * (not bound, or its store room not set up): nothing changes.
 */
export async function syncStore(env, { now: at = Date.now(), fetchImpl } = {}) {
  const db = env.BREAKFAST_DB;
  // One clock for the whole run: when it was asked to run.
  const stamp = new Date(at).toISOString().slice(0, 19).replace('T', ' ');
  if (!db) return { skipped: 'The breakfast app’s database is not bound to Insight.' };
  let waiting;
  try { waiting = await waitingThere(db); } catch (err) { return { skipped: `The breakfast app’s store room could not be read: ${String(err?.message || err).slice(0, 200)}` }; }
  const base = await breakfastBase(env).catch(() => null);
  const there = base ? `${base}/#/store` : null;
  const out = { raised: 0, reminded: 0, closed: 0, pushed: 0, emailed: 0 };
  const open = await all(env.DB, 'SELECT * FROM store_request WHERE closed_at IS NULL');
  const known = new Map(open.map((r) => [Number(r.id), r]));
  const still = new Set(waiting.map((r) => Number(r.id)));
  const person = await chosen(env);

  // New: a to-do, given to the person chosen (or shared out), emailed once and pushed.
  for (const r of waiting) {
    if (known.has(Number(r.id)) || await first(env.DB, 'SELECT id FROM store_request WHERE id = ?1', r.id)) continue; // eslint-disable-line no-await-in-loop
    const ref = refOf(r.id);
    const needed = NEEDED[r.needed] || r.needed || 'now';
    const detail = {
      ref, department: r.department, needed: r.needed, neededText: needed, note: r.note || null,
      askedBy: r.requested_by, askedAt: iso(r.created_at), lines: r.lines, url: there, follows: r.follows ? refOf(r.follows) : null,
    };
    const key = `store:${r.id}`;
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, `INSERT INTO money_todo (key, kind, ref, day, amount, detail, opened_at, assignee_id, assignee_name)
      VALUES (?1, 'store', ?2, ?3, 0, ?4, ?5, ?6, ?7) ON CONFLICT (key) DO NOTHING`,
    key, ref, String(r.created_at || '').slice(0, 10) || null, JSON.stringify(detail), stamp, person?.id ?? null, person ? (person.name || person.email) : null);
    if (!person) await shareOut(env); // eslint-disable-line no-await-in-loop
    // eslint-disable-next-line no-await-in-loop
    const todo = await first(env.DB, 'SELECT assignee_id FROM money_todo WHERE key = ?1', key);
    // eslint-disable-next-line no-await-in-loop
    const to = todo?.assignee_id ? await first(env.DB, 'SELECT id, name, email FROM accounts WHERE id = ?1', todo.assignee_id) : null;
    const title = `${ref}: ${r.department || 'The kitchen'} needs stock ${needed}`;
    const body = `${r.requested_by || 'Somebody'} asked for ${summary(r.lines)}.${r.note ? ` “${r.note}”` : ''} Issue it in the breakfast app.`;
    let emailed = null;
    if (to?.email && env.SSO_SECRET_ATTENDANCE) {
      try {
        // Sent without Insight's own notification of it: the one below is kept to one line and told again.
        // eslint-disable-next-line no-await-in-loop
        await callLink({
          binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
          body: {
            to: to.email, kind: 'insight_store', senderName: 'Insight', subject: title,
            text: `${body}\n\n${r.lines.map((l) => `- ${l.name}: ${qty(l.asked)}${l.unit ? ` ${l.unit}` : ''}`).join('\n')}\n\n${there ? `Issue it: ${there}\n\n` : ''}It is in Insight › To sort out › Store requests. You will be reminded on your phone every 15 minutes until it is issued.`,
            html: `<p><b>${esc(r.requested_by || 'Somebody')}</b> asked the store room for, needed ${esc(needed)}:</p><ul>${r.lines.map((l) => `<li>${esc(l.name)}: ${esc(qty(l.asked))}${l.unit ? ` ${esc(l.unit)}` : ''}</li>`).join('')}</ul>${r.note ? `<p>“${esc(r.note)}”</p>` : ''}${there ? `<p><a href="${esc(there)}"><b>Issue it in the breakfast app</b></a></p>` : ''}<p>It is in Insight › To sort out › Store requests. You will be reminded on your phone every 15 minutes until it is issued.</p>`,
          },
        });
        emailed = stamp;
        out.emailed += 1;
      } catch (err) { console.error('Store request email', err); }
    }
    // eslint-disable-next-line no-await-in-loop
    const told = to ? await tell(env, { to: [to.id], kind: 'insight_store', key, title, body, link: '#/inbox', urgent: true, tag: key }, { fetchImpl }) : { pushed: 0 };
    out.pushed += told.pushed;
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, `INSERT INTO store_request (id, ref, department, status, asked_by, asked_at, needed, lines, told_id, emailed_at, last_push_at, pushes, seen_at)
      VALUES (?1, ?2, ?3, 'waiting', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?10)`,
    r.id, ref, r.department, r.requested_by, iso(r.created_at), r.needed, JSON.stringify(r.lines), to?.id ?? null, emailed, stamp, told.pushed ? 1 : 0);
    out.raised += 1;
  }

  // Still waiting: pushed again every 15 minutes, to whoever holds the to-do now.
  for (const s of open) {
    if (!still.has(Number(s.id))) continue;
    const last = Date.parse(iso(s.last_push_at) || 0);
    if (Number.isFinite(last) && at - last < AGAIN_MS) continue;
    // eslint-disable-next-line no-await-in-loop
    const todo = await first(env.DB, "SELECT assignee_id, state FROM money_todo WHERE key = ?1", `store:${s.id}`);
    if (!todo?.assignee_id || todo.state === 'closed') continue;
    const lines = (() => { try { return JSON.parse(s.lines || '[]'); } catch { return []; } })();
    const mins = Math.max(1, Math.round((at - Date.parse(s.asked_at)) / 60000));
    const waited = mins < 60 ? `${mins} minutes` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
    // eslint-disable-next-line no-await-in-loop
    const told = await tell(env, {
      to: [todo.assignee_id], kind: 'insight_store', key: `store:${s.id}`, urgent: true, tag: `store:${s.id}`, link: '#/inbox',
      title: `Still waiting: ${s.ref}, ${s.department || 'the kitchen'} (${waited})`,
      body: `${s.asked_by || 'Somebody'} asked for ${summary(lines)}. Issue it in the breakfast app.`,
    }, { fetchImpl });
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'UPDATE store_request SET last_push_at = ?2, pushes = pushes + ?3, told_id = ?4, seen_at = ?2 WHERE id = ?1', s.id, stamp, told.pushed, todo.assignee_id);
    out.reminded += 1;
    out.pushed += told.pushed;
  }

  // No longer waiting: what became of it, the to-do closed, the reminders stopped.
  for (const s of open) {
    if (still.has(Number(s.id))) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await first(db, 'SELECT status, issued_by, issue_note, closed_by FROM store_requests WHERE id = ?1', s.id).catch(() => null);
    const status = r?.status || 'gone';
    const why = `${STOPPED[status] || 'No longer in the breakfast app'}${r?.issued_by ? ` by ${r.issued_by}` : r?.closed_by ? ` by ${r.closed_by}` : ''}${r?.issue_note ? `: ${r.issue_note}` : ''}.`;
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'UPDATE store_request SET status = ?2, closed_at = ?3, seen_at = ?3 WHERE id = ?1', s.id, status, stamp);
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, "UPDATE money_todo SET state = 'closed', closed_by = 'Insight', closed_at = ?2, closed_why = ?3 WHERE key = ?1 AND state != 'closed'", `store:${s.id}`, stamp, why);
    // eslint-disable-next-line no-await-in-loop
    await settle(env, `store:${s.id}`);
    out.closed += 1;
  }
  return out;
}
