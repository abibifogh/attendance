import { isMissingTable } from './http.js';
import { emailNotice, pushNotice, textNotice } from './notify.js';
import { CHANNELS_KEY, alsoFor, readChannels } from './notice-kinds.js';

/**
 * In-app notifications.
 *
 * The same events the emails carry, kept where the app can show them: a bell
 * with a count, and a list of what has happened since you last looked. Two
 * reasons it exists alongside the mail rather than instead of it — somebody who
 * lives in the app should not have to open an inbox to find out that four days
 * are waiting on them, and when the mail fails, this is what still says so.
 *
 * Nothing here ever throws at its caller. A notice is a courtesy; failing to
 * record one must not fail the round that earned it.
 */

const LEVELS = new Set(['info', 'warn', 'high']);

/**
 * Record a notice, and send it on by email.
 *
 * The third argument is how the mail gets out: `{ env, executionContext }`,
 * which every route already has as `ctx`. Optional, because a notice recorded
 * from somewhere with no `env` — a test, a script — should still ring the bell
 * rather than fail.
 *
 * The mail is fired through `waitUntil` where there is one, so it happens
 * after the response has gone. Somebody signing a day off must not wait on an
 * email provider, and must certainly not be refused by one.
 */
export async function createNotice(db, {
  kind, level = 'info', title, body, link, day, slot, actor, audience = null, userId = null,
  emailAudience = undefined, email = true, push = true, text = null, report = false,
}, ctx = null) {
  if (!kind || !title) return report ? { id: null, buzzed: 0, emailed: 0 } : null;

  // Filled in the moment the row is written, and handed on to the push so a
  // notification carries a tag of its own rather than its family's.
  let noticeId = null;

  // What each way out came back with, for the one caller that has to say. A
  // rota going out is the only notice somebody is later asked to account for
  // person by person, and "we sent it" is not an answer to "Doreen never got
  // hers" unless the app wrote down what happened to Doreen's.
  const outcome = { buzzed: 0, emailed: 0, texted: 0 };

  // Who else the property has asked to be copied on this kind. Read once and
  // written onto the row, so the bell shows it to them as well and a notice
  // always reaches whoever it reached when it was raised, whatever somebody
  // changes afterwards.
  let also = [];

  const post = async () => {
    const jobs = [];

    // Some events are worth a bell and not worth an inbox. Approving a clock
    // correction is the clearest case: the person who asked for it is sitting
    // in the app watching for it, and a property with twenty corrections a
    // week would be sending twenty emails nobody reads.
    if (ctx?.env) {
      jobs.push(emailNotice(db, ctx.env, {
        kind, level, title, body, link, actor, audience, userId, also,
        // What the raising code asked for, which a setting overrules only when
        // somebody has said so on purpose. Some callers know something no
        // setting can: that this person's phone has already buzzed once.
        wanted: email,
        // Who gets it in an inbox, where that is a narrower set than who sees
        // it on screen. A request waiting on a decision is worth a bell to
        // everybody it affects and an email only to whoever can answer it: a
        // planner needs to know somebody cannot work Tuesday while they are
        // building the week, and does not need it in their inbox on Sunday
        // night about a decision that is not theirs to take.
        emailAudience,
      })
        .then((out) => { outcome.emailed = out?.sent ? 1 : out?.tried ? -1 : 0; })
        .catch((err) => { outcome.emailed = -1; console.error('notice email failed', err); }));
    }

    // And it goes to the phone in somebody's pocket.
    //
    // THIS USED TO BE OPT IN, and the fear behind that was a phone lighting up
    // for every clock correction until its owner switched notifications off.
    // What actually happened was the other failure: eighteen kinds of notice
    // never asked, so somebody taking an interview slot or saying they cannot
    // work Thursday rang a bell nobody was looking at. A notice is already the
    // app's judgement that this is worth telling somebody about; making the
    // telling opt in meant deciding that twice, and the second decision kept
    // being forgotten.
    //
    // So it is on unless a caller says otherwise, and the callers that say
    // otherwise are the two that would arrive daily whether or not anything
    // had happened. It needs no `env`, since the push keys live in the
    // database, so it works from the cron as well as from a request.
    jobs.push(pushNotice(db, {
      id: noticeId, kind, title, body, link, day, audience, userId, also, wanted: push,
    })
      .then((out) => { outcome.buzzed = out?.sent ? 1 : out?.tried ? -1 : 0; })
      .catch((err) => { outcome.buzzed = -1; console.error('notice push failed', err); }));

    // And by text, where somebody has ticked it for this kind. Off for almost
    // everything, because every one of them costs money.
    //
    // `text: false` is not a preference and no setting overrules it. It is a
    // caller saying it is doing its own texting, which the rota does: it works
    // out per person whether a text is the only way of reaching them, and a
    // second one from here would be the same message twice at twice the price.
    if (text !== false) {
      jobs.push(textNotice(db, ctx?.env ?? null, {
        kind, title, body, day, audience, userId, also, wanted: text,
      })
        .then((out) => { outcome.texted = out?.sent ? 1 : out?.tried ? -1 : 0; })
        .catch((err) => { outcome.texted = -1; console.error('notice text failed', err); }));
    }

    if (!jobs.length) return;
    const sending = Promise.all(jobs);

    // Handed to the runtime where there is one, so the response goes back
    // first and the sending happens after. Where there is not, a cron, a
    // script, a test, it has to be awaited, because nothing else is going to
    // keep the isolate alive long enough for it to finish.
    //
    // A caller asking to be told what happened is asking to wait for it. There
    // is no honest way to report on a send that has not finished, and the one
    // caller that asks is already waiting on the round anyway.
    if (report || !ctx?.executionContext?.waitUntil) await sending;
    else ctx.executionContext.waitUntil(sending);
  };

  try {
    const settings = await db.prepare(
      "SELECT value FROM settings WHERE key = 'notice_channels'",
    ).first().catch(() => null);
    also = alsoFor(readChannels(settings?.value), kind);

    const row = await db.prepare(
      `INSERT INTO app_notices (kind, level, title, body, link, day, slot, actor, audience,
                                user_id, also)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`,
    ).bind(
      String(kind).slice(0, 40),
      LEVELS.has(level) ? level : 'info',
      String(title).slice(0, 300),
      body == null ? null : String(body).slice(0, 1000),
      link == null ? null : String(link).slice(0, 300),
      day ?? null,
      slot ?? null,
      actor == null ? null : String(actor).slice(0, 120),
      // A permission, or null for everybody. Held rather than resolved to a
      // list of people, so a notice addressed to administrators still reaches
      // somebody promoted tomorrow and stops reaching somebody demoted
      // yesterday.
      audience == null ? null : String(audience).slice(0, 40),
      // A notice can name a person as well as a permission. Naming one narrows
      // it to them: "somebody should look at this" is not a plan, and a bell
      // that rings for three people is a bell none of them owns.
      userId == null ? null : Number(userId),
      also.length ? JSON.stringify(also) : null,
    ).first();
    noticeId = row?.id ?? null;
    await post();
    return report ? { id: noticeId, ...outcome } : noticeId;
  } catch (err) {
    // A site whose database has not been upgraded yet simply has no bell. That
    // is a missing nicety, not a reason to fail a submitted check.
    if (!isMissingTable(err)) console.error('notice not recorded', err);
    return report ? { id: null, buzzed: 0, emailed: 0 } : null;
  }
}

/**
 * What one person should see, and how much of it is new to them.
 *
 * "New" is everything above the last id they acknowledged, which is one integer
 * per person rather than a row per person per notice — the only question ever
 * asked is "anything since I last looked".
 */
export async function listNotices(db, userId, limit = 20, permissions = null) {
  try {
    const [rows, seen] = await Promise.all([
      db.prepare('SELECT * FROM app_notices ORDER BY id DESC LIMIT ?').bind(Math.min(limit, 100)).all(),
      db.prepare('SELECT last_id FROM app_notice_reads WHERE user_id = ?').bind(userId ?? 0).first(),
    ]);

    const lastSeen = Number(seen?.last_id ?? 0);
    // Filtered here rather than in SQL: `audience` may not exist yet on a
    // database that has not run the upgrade, and a query naming a missing
    // column fails outright where a missing property simply reads undefined.
    // An unaddressed notice is for everybody, which is what every row written
    // before this existed is.
    // Who else the property asked to be copied in, as it stood when the notice
    // was raised. Held on the row rather than looked up now, so what somebody
    // was told about does not quietly change under them.
    const alsoOn = (n) => {
      if (!n.also || !permissions) return false;
      try {
        const list = JSON.parse(n.also);
        return Array.isArray(list) && list.some((p) => permissions.includes(p));
      } catch { return false; }
    };

    const notices = (rows.results ?? []).filter((n) => {
      // Addressed to one person: theirs, and anybody watching that kind.
      if (n.user_id != null) return Number(n.user_id) === Number(userId) || alsoOn(n);
      return !n.audience || !permissions || permissions.includes(n.audience) || alsoOn(n);
    });

    return {
      notices: notices.map((n) => ({ ...n, unread: n.id > lastSeen })),
      unread: notices.filter((n) => n.id > lastSeen).length,
      // The newest id on the list, so marking read cannot acknowledge something
      // that arrived after the page was drawn.
      latestId: notices[0]?.id ?? lastSeen,
      lastSeen,
    };
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return { notices: [], unread: 0, latestId: 0, lastSeen: 0, unavailable: true };
  }
}

/** Acknowledge up to a given notice. Never moves backwards. */
export async function markSeen(db, userId, lastId) {
  const id = Number(lastId);
  if (!Number.isFinite(id) || id < 0) return;
  try {
    await db.prepare(
      `INSERT INTO app_notice_reads (user_id, last_id, at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         last_id = MAX(app_notice_reads.last_id, ?2),
         at = datetime('now')`,
    ).bind(userId ?? 0, id).run();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}
