import { CHANNELS_KEY, goesOut, readChannels } from './notice-kinds.js';
import { originOf } from './site.js';
import { firstUsableNumber, sendTexts } from './sms.js';
import { ALERT_TITLE, getVapidKeys, sendPush } from './push.js';
import { isMissingTable } from './http.js';
import { labelFor } from './attendance.js';
import { allows, effectivePermissions } from './permissions.js';

/**
 * What actually gets sent, and to whom.
 *
 * One message a day, and only when there is something a person has to do. That
 * restraint is the whole design. An alert for every late arrival would be a
 * dozen a morning, everybody would learn to swipe them away within a week, and
 * the one that mattered would go with the rest.
 *
 * So exactly two things qualify: days that cannot be settled without somebody
 * deciding, and an absence that has run long enough to stop being an oversight.
 * Everything else is on the report, where it belongs.
 */

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Split a stored recipient list.
 *
 * It is written as JSON — `["a@b.com","c@d.com"]` — and used to be read by
 * splitting on commas, which is a different format that happens to look
 * similar. One address came back as `["a@b.com"]`, brackets and quotes
 * included, and two came back cut in half down the middle of the comma.
 *
 * The provider rejected the lot with a 422 naming the `to` field, which is
 * exactly right and reads like nonsense to whoever pressed Send: the address
 * on the screen was perfectly good, and what left the building was not.
 *
 * So JSON first, and a plain list of addresses after — because somebody typing
 * three addresses separated by commas into a box is a reasonable thing to have
 * happened, and is not worth failing over.
 */
export function parseRecipients(value) {
  if (!value) return [];
  const text = String(value).trim();

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      // Not valid JSON after all. Fall through and treat it as a plain list
      // rather than silently sending to nobody.
    }
  }

  return text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * An address that can actually be sent to.
 *
 * Deliberately refuses the punctuation that carries structure elsewhere —
 * brackets, quotes, angle brackets, commas — because the whole point of this
 * check is to be the thing that notices when a list has been taken apart
 * wrongly. The old pattern only excluded spaces and stray @s, so
 * `["a@b.com"]` sailed through it and straight into the provider.
 */
const NOT_IN_AN_ADDRESS = '\\s@<>,;:"\'\\\\[\\]()';

export function isEmail(value) {
  const pattern = new RegExp(
    `^[^${NOT_IN_AN_ADDRESS}]+@[^${NOT_IN_AN_ADDRESS}]+\\.[^${NOT_IN_AN_ADDRESS}]{2,}$`,
  );
  return pattern.test(String(value || '').trim());
}

/**
 * Send one message through Resend.
 *
 * Chosen for having an HTTP API — a Worker cannot open an SMTP socket, so
 * anything SMTP-shaped is out regardless of preference.
 */
/**
 * The sender, with a name on it.
 *
 * A bare address in the From line is one of the plainer marks of mail nobody
 * bothered to set up: the inbox shows "hive@niceoperation.com" where every
 * other message shows who it is from, and a filter reading the same signal
 * draws the same conclusion. The sender name goes in front of it — unless
 * somebody has already written their own name into the address setting, in
 * which case theirs stands.
 */
/**
 * The name on the outside of the envelope.
 *
 * Not the property's registered company name, which is what it used to be and
 * which nobody at the property calls the place. A property that wants its own
 * name on its mail types it in; the rest get the app's, which is also what
 * their phones say.
 */
export const senderNameOf = (settings = {}) => String(settings.email_sender_name ?? '').trim()
  || 'HIVE';

export function senderWithName(from, senderName) {
  const address = String(from || '').trim();
  if (!address) return '';
  if (address.includes('<')) return address;            // already named
  const name = String(senderName || '').trim();
  if (!name) return address;

  // A quoted display name, so a property called "Somewhere Nice, Accra" cannot
  // put a comma in a header where a comma separates addresses.
  return `"${name.replace(/["\\]/g, '')}" <${address}>`;
}

/**
 * The same message as plain text.
 *
 * Not a nicety. A message with an HTML part and no text part is one of the
 * things spam filters weigh most heavily, because almost nothing legitimate is
 * sent that way and a great deal of junk is. It is also what gets read when
 * somebody's client refuses to load HTML at all.
 */
export function asPlainText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // The preheader is the line the inbox shows beside the subject. It is a
    // copy of what follows, so reading it here would print the whole opening
    // of the message twice.
    .replace(/<div data-preheader[\s\S]*?<\/div>/gi, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = text.replace(/<[^>]*>/g, '').trim();
      return label && !href.startsWith('#') ? `${label}: ${href}` : label;
    })
    .replace(/<\/(p|div|h1|h2|h3|li|tr)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  - ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&rarr;/g, '->')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A whole HTML document rather than a loose fragment.
 *
 * A body with no doctype, no charset and no language is another small mark
 * against a message. None of these is decisive on its own; deliverability is
 * the sum of a dozen such things, and every one of them is free.
 *
 * The preheader is the grey line the inbox shows after the subject. Left out,
 * clients scrape whatever text comes first — usually the property name, twice.
 */
export function emailDocument({ title, preheader, body }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;color:#101418">
${preheader
    ? `<div data-preheader style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>`
    : ''}
${body}
</body></html>`;
}

export async function sendEmail({
  apiKey, from, to, subject, html, text, replyTo = null, headers = null,
}) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      // Both parts, always. See asPlainText above.
      text: text || asPlainText(html),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(headers ? { headers } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Email provider returned ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json().catch(() => ({}));
}

/**
 * How late, in words somebody reads rather than a number they convert.
 *
 * "83 minutes" makes the reader do arithmetic before they can react to it;
 * "1 hr 23 min" does not. Under an hour it stays in plain minutes, which is
 * how anybody on a shift would say it.
 */
export function lateness(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min late`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `${hours} hr${rest ? ` ${rest} min` : ''} late`;
}

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ESCAPE[c]);

/**
 * The morning digest.
 *
 * Written to be usable from a phone's notification shade without opening
 * anything: the names are in the mail, not behind a link. Somebody reading it
 * on the way to work should already know who they are looking for.
 */
export function renderDigest({ day, propertyName, siteUrl, open, absent, escalated, rows }) {
  const link = siteUrl ? `${siteUrl.replace(/\/$/, '')}/#/att-today?day=${day}` : null;

  const list = (title, items) => (items.length
    ? `<h3 style="font:600 14px/1.4 system-ui,sans-serif;color:#101418;margin:18px 0 6px">${esc(title)}</h3>
       <ul style="font:14px/1.6 system-ui,sans-serif;color:#4a535e;margin:0;padding-left:18px">
         ${items.map((i) => `<li>${esc(i)}</li>`).join('')}
       </ul>`
    : '');

  // Named through the app's own labeller. This used to read `r.label`, a
  // column neither the cron nor the test button ever selected — so every line
  // of every digest ever sent said "Kofi Mensah — undefined". Reason codes are
  // not loaded here, so a coded absence reads as "Absent" rather than as the
  // particular reason; the names and the count are what this email is for.
  const needing = rows.filter((r) => r.resolution === 'open')
    .map((r) => `${r.name} — ${r.label ?? labelFor(r, null)}`);
  const away = rows.filter((r) => r.status === 'absent').map((r) => r.name);

  // The rules' own verdict, not the raw minutes. Grace exists precisely so
  // that somebody due at 06:00 who arrives at 06:01 is not late; counting
  // those would put half the property in this list every morning, and a list
  // like that stops being read by the end of the week.
  //
  // The minutes themselves are the whole point of the line — "Kofi was late"
  // is a remark, "Kofi was 47 minutes late" is something a person can act on —
  // so they are counted from the shift's start rather than from the end of
  // grace. Somebody who is twenty minutes late owes twenty minutes, not
  // fifteen.
  const latecomers = rows
    .filter((r) => r.status === 'late' || r.status === 'late_early')
    .map((r) => ({ name: r.name, minutes: Math.max(0, Math.round(Number(r.late_minutes) || 0)) }))
    .sort((a, b) => b.minutes - a.minutes)
    .map((r) => `${r.name} — ${lateness(r.minutes)}`);

  const summary = `${open ? `${open} day${open === 1 ? '' : 's'} waiting on a decision`
    : 'Nothing waiting on a decision'}${absent ? `, ${absent} absent` : ''}`
    + `${latecomers.length ? `, ${latecomers.length} late` : ''}.`;

  return {
    subject: open
      ? `${propertyName}: ${open} attendance day${open === 1 ? '' : 's'} to confirm`
      : `${propertyName}: ${absent} absent on ${day}`,
    html: emailDocument({
      title: `Attendance — ${day}`,
      preheader: summary,
      body: `
      <div style="max-width:560px;margin:0 auto;padding:24px;font-family:system-ui,sans-serif">
        <p style="font:12px/1.4 system-ui,sans-serif;color:#6f7884;margin:0 0 4px">${esc(propertyName)}</p>
        <h1 style="font:700 22px/1.3 system-ui,sans-serif;color:#101418;margin:0 0 4px">Attendance — ${esc(day)}</h1>
        <p style="font:14px/1.6 system-ui,sans-serif;color:#4a535e;margin:0">${esc(summary)}</p>
        ${list('Waiting on you', needing)}
        ${list('Absent', away)}
        ${list('Late', latecomers)}
        ${escalated.length
    ? `<p style="font:600 14px/1.6 system-ui,sans-serif;color:#b02436;margin:18px 0 0">
             On a run of absences: ${esc(escalated.join(', '))}.
           </p>`
    : ''}
        ${link
    ? `<p style="margin:22px 0 0">
             <a href="${esc(link)}" style="font:600 14px/1 system-ui,sans-serif;color:#fff;background:#1f5fd0;padding:11px 16px;border-radius:6px;text-decoration:none">Open the list</a>
           </p>`
    : ''}
        <p style="font:12px/1.5 system-ui,sans-serif;color:#6f7884;margin:22px 0 0;padding-top:12px;border-top:1px solid #d4dae1">
          A day with only one of the two taps is held rather than counted absent, so somebody has to say
          what happened. Until they do, no hours are counted for it.
        </p>
      </div>`,
    }),
  };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * Short enough to read on a lock screen without unlocking it.
 *
 * One word for a title. A phone adds "from HIVE" to it itself, and the
 * property's name in front of that pushed the only part that matters — how
 * many days are waiting — onto a third line.
 */
export function renderPing({ day, open, absent, escalated }) {
  const parts = [];
  if (open) parts.push(`${open} to confirm`);
  if (absent) parts.push(`${absent} absent`);

  return {
    title: ALERT_TITLE,
    body: `${day}: ${parts.join(', ') || 'all settled'}.`
      + (escalated.length ? `\nOn a run of absences: ${escalated.join(', ')}.` : ''),
    day,
  };
}

/**
 * Ping everybody subscribed.
 *
 * Never throws. A failure here must not affect the tick that called it, so
 * every outcome is written to `push_log` instead — which is also the only thing
 * to look at when somebody says they were never told.
 */
export async function pingExceptions(db, { day, open, absent, escalated = [] }) {
  const log = (status, detail, count = 0) => db.prepare(
    'INSERT INTO push_log (day, sent, status, detail) VALUES (?, ?, ?, ?)',
  ).bind(day, count, status, detail ? String(detail).slice(0, 500) : null)
    .run()
    .catch(() => {});

  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
    if (settings.push_on_exception !== '1') return;

    const subs = await db.prepare('SELECT * FROM push_subscriptions').all();
    const list = subs.results ?? [];
    if (!list.length) {
      await log('skipped', 'Nobody has turned on alerts yet');
      return;
    }

    const ping = renderPing({ day, open, absent, escalated });

    const vapid = await getVapidKeys(db);
    const subject = settings.email_from && settings.email_from.includes('@')
      ? `mailto:${settings.email_from.replace(/^.*<|>.*$/g, '').trim()}`
      : (originOf(settings.site_url) || 'https://example.com');

    const message = JSON.stringify({
      ...ping,
      url: `${originOf(settings.site_url)}/#/att-today?day=${day}`,
    });

    let sent = 0;
    const dead = [];
    const failures = [];
    for (const sub of list) {
      try {
        const result = await sendPush(sub, message, vapid, subject);
        if (result.ok) sent += 1;
        else if (result.gone) dead.push(sub.id);
        else failures.push(`${result.status} ${result.detail ?? ''}`.trim());
      } catch (err) {
        failures.push(err.message);
      }
    }

    // Retire endpoints the push service says are finished, so a reset phone
    // does not generate a failure every morning forever.
    if (dead.length) {
      await db.batch(dead.map((id) => db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id)))
        .catch(() => {});
    }

    // "sent" has to mean somebody was actually alerted. A morning where every
    // subscription turned out to be dead delivered nothing, and saying
    // otherwise would hide exactly the problem this log exists to show.
    await log(
      sent ? 'sent' : (failures.length || dead.length) ? 'failed' : 'skipped',
      [
        failures.length ? `${failures.length} failed: ${failures[0]}` : null,
        dead.length ? `${dead.length} expired device(s) removed` : null,
      ].filter(Boolean).join('; ') || null,
      sent,
    );
  } catch (err) {
    await log('failed', err.message);
  }
}

/**
 * Email the digest, if it has been set up and there is anything to say.
 *
 * Silent when unconfigured. An operation that never turned email on should not
 * get an error in its logs every morning about it.
 */
export async function emailExceptions(db, env, { day, open, absent, escalated = [], rows = [] }) {
  const write = (status, recipients, detail) => db.prepare(
    'INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)',
  ).bind('att_digest', day, recipients ?? null, status, detail ? String(detail).slice(0, 500) : null)
    .run()
    .catch(() => {});

  try {
    const settingsRows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((settingsRows.results ?? []).map((r) => [r.key, r.value]));

    const apiKey = env?.RESEND_API_KEY;
    const listed = parseRecipients(settings.att_email_to);
    const to = listed.filter(isEmail);

    // Say why nothing went, rather than returning in silence. The morning
    // cron can afford to be quiet about an operation that never turned email
    // on; the Send-a-test button cannot, because it reports the newest line in
    // this log — and with no new line it cheerfully reports the last one,
    // which may be a success from a fortnight ago.
    const missing = !apiKey ? 'no provider key set on this Worker'
      : !settings.email_from ? 'no "from" address set'
        : !listed.length ? 'nobody to send to'
          : !to.length ? `not a usable address: ${listed[0]}`
            : null;

    if (missing) {
      await write('skipped', to.join(', ') || null, missing);
      return;
    }

    const { subject, html } = renderDigest({
      day,
      propertyName: settings.property_name || 'HIVE',
      siteUrl: originOf(settings.site_url),
      open,
      absent,
      escalated,
      rows,
    });

    await sendEmail({
      apiKey,
      from: senderWithName(settings.email_from, senderNameOf(settings)),
      to,
      subject,
      html,
      replyTo: (settings.email_reply_to || '').trim() || null,
    });
    await write('sent', to.join(', '));
  } catch (err) {
    if (!isMissingTable(err)) await write('failed', null, err.message);
  }
}

// ---------------------------------------------------------------------------
// A notice, by mail as well as by bell
// ---------------------------------------------------------------------------

const NOTICE_COLOUR = { high: '#b02436', warn: '#9a5800', good: '#0f7048', info: '#1f5fd0' };

/**
 * Who a notice is actually addressed to, resolved at the moment of sending.
 *
 * A notice carries either a person or a permission, and never a list of email
 * addresses. That is deliberate: a stored list is a second copy of who works
 * here, and the day somebody is promoted is the day the two stop agreeing.
 * Resolving it here means a notice for administrators reaches whoever holds
 * that permission this morning, and stops reaching whoever lost it yesterday.
 */
export async function noticeRecipients(db, { audience = null, userId = null, also = null }) {
  const rows = await db.prepare(
    'SELECT id, name, email, role, permissions, active FROM users WHERE active = 1 AND email IS NOT NULL',
  ).all().catch(() => ({ results: [] }));

  const people = (rows.results ?? []).filter((u) => isEmail(u.email));
  const extra = Array.isArray(also) ? also.filter(Boolean) : [];

  // A named person is the whole audience the code chose. "Somebody should look
  // at this" is not a plan, and a mail that goes to four people is a mail none
  // of them owns. The permission is the fallback for a notice addressed to a
  // role rather than to a colleague.
  //
  // Anybody the property has added is added to that rather than replacing it.
  // The person a notice is about does not stop being told because somebody
  // asked to be copied in.
  const watching = (u) => extra.some((p) => allows(p, effectivePermissions(u)));

  if (userId != null) {
    const one = people.find((u) => Number(u.id) === Number(userId));
    const others = extra.length
      ? people.filter((u) => Number(u.id) !== Number(userId) && watching(u))
      : [];
    return one ? [one, ...others] : others;
  }

  if (!audience) return people;
  return people.filter((u) => allows(audience, effectivePermissions(u)) || watching(u));
}

/**
 * Send one notice on as a text message.
 *
 * Off for almost everything, and deliberately. A text costs money every time
 * and a property that turns it on for a chatty kind finds out at the end of
 * the month, so nothing texts unless somebody has ticked it against that kind
 * by name.
 *
 * Where it is on, it reaches the same people the bell does, which is the
 * point: half the property is on a handset that will never show a web alert,
 * and for them a text is not a fallback, it is the only way.
 *
 * Never throws. A gateway having a bad afternoon must not fail the round that
 * earned the notice.
 */
export async function textNotice(db, env, notice) {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));

    if (!goesOut(readChannels(settings[CHANNELS_KEY]), notice.kind, 'text', notice.wanted)) {
      return { sent: 0, tried: 0, reason: 'not switched on for this kind' };
    }

    const people = await textRecipients(db, notice);
    if (!people.length) return { sent: 0, tried: 0, reason: 'nobody with a number' };

    const site = originOf(settings.site_url);
    const out = await sendTexts(db, env, {
      messages: people.map((one) => ({
        ref: one.id,
        to: one.phone,
        text: shortEnough(notice, site),
      })),
      kind: notice.kind,
      day: notice.day ?? null,
    });

    return { sent: out.sent ?? 0, tried: people.length };
  } catch (err) {
    return { sent: 0, tried: 1, reason: err.message };
  }
}

/**
 * Whose phone this notice would reach.
 *
 * A number comes off somebody's staff record rather than their login, because
 * that is where the property already keeps it and asking for it twice is how
 * the two copies come to disagree.
 */
async function textRecipients(db, { audience = null, userId = null, also = null }) {
  const rows = await db.prepare(
    `SELECT u.id, u.role, u.permissions, hp.personal_phone, hp.alt_phone
       FROM users u
       LEFT JOIN hr_profile hp ON hp.staff_id = u.staff_id
      WHERE u.active = 1`,
  ).all().catch(() => ({ results: [] }));

  const extra = Array.isArray(also) ? also.filter(Boolean) : [];
  const watching = (u) => extra.some((p) => allows(p, effectivePermissions(u)));

  return (rows.results ?? [])
    .filter((u) => {
      if (userId != null) return Number(u.id) === Number(userId) || watching(u);
      if (!audience) return true;
      return allows(audience, effectivePermissions(u)) || watching(u);
    })
    .map((u) => ({ id: u.id, phone: firstUsableNumber(u.personal_phone, u.alt_phone) }))
    .filter((u) => u.phone);
}

/**
 * The notice in one segment.
 *
 * A gateway charges by the segment and a segment is 160 characters, so the
 * title goes in whole, the body goes in if it fits, and the link is bare
 * because every phone puts the https:// back itself.
 */
function shortEnough(notice, site) {
  const where = String(site ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const head = `HIVE: ${notice.title}`;
  const tail = where ? ` ${where}` : '';
  const room = 160 - head.length - tail.length;
  const body = String(notice.body ?? '').replace(/\s+/g, ' ').trim();
  return `${head}${body && body.length + 1 <= room ? ` ${body}` : ''}${tail}`;
}

/** The body. Plain HTML with inline styles: mail clients strip stylesheets. */
export function renderNotice({ notice, propertyName, siteUrl }) {
  const colour = NOTICE_COLOUR[notice.level] ?? NOTICE_COLOUR.info;
  const link = notice.link && siteUrl
    ? `${siteUrl.replace(/\/$/, '')}/${String(notice.link).replace(/^\/*/, '')}`
    : null;

  return {
    subject: notice.title,
    html: emailDocument({
      title: notice.title,
      preheader: notice.body || notice.title,
      body: `
      <div style="background:#f4f6f8;padding:24px">
        <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:22px 24px">
          <div style="font:600 12px/1.4 system-ui,sans-serif;color:#6f7884;letter-spacing:.06em;text-transform:uppercase">
            ${esc(propertyName)}
          </div>
          <h1 style="font:650 19px/1.35 system-ui,sans-serif;color:#101418;margin:8px 0 0;
                     border-left:3px solid ${colour};padding-left:10px">${esc(notice.title)}</h1>
          ${notice.body
    ? `<p style="font:15px/1.6 system-ui,sans-serif;color:#4a535e;margin:14px 0 0">${esc(notice.body)}</p>`
    : ''}
          ${notice.actor
    ? `<p style="font:13px/1.5 system-ui,sans-serif;color:#6f7884;margin:12px 0 0">From ${esc(notice.actor)}</p>`
    : ''}
          ${link
    ? `<p style="margin:20px 0 0"><a href="${esc(link)}"
         style="font:600 14px/1 system-ui,sans-serif;color:#fff;background:#1f5fd0;
                text-decoration:none;padding:11px 18px;border-radius:8px;display:inline-block">Open it</a></p>`
    : ''}
          <p style="font:12px/1.5 system-ui,sans-serif;color:#8b939d;margin:22px 0 0;
                    border-top:1px solid #e6e9ed;padding-top:12px">
            You are receiving this because it is addressed to you in ${esc(propertyName)}.
            Turn these off under Users &amp; data &rarr; Notifications.
          </p>
        </div>
      </div>`,
    }),
  };
}

/**
 * Push one notice to the phones of whoever it is addressed to.
 *
 * The same audience rule the email uses, so a notice cannot reach one and not
 * the other by accident: a permission, or one named person, resolved at the
 * moment of sending rather than stored as a list.
 *
 * Never throws, and never delays anything. A push is a courtesy — a phone with
 * no signal, a browser that has forgotten its subscription, a push service
 * having an afternoon: none of those may fail the round that earned the notice.
 * Every outcome goes to `push_log`, which is the only thing to look at when
 * somebody says they were never told.
 */
export async function pushNotice(db, notice) {
  const log = (status, detail, count = 0) => db.prepare(
    'INSERT INTO push_log (day, sent, status, detail) VALUES (?, ?, ?, ?)',
  ).bind(notice.day ?? null, count, status, detail ? String(detail).slice(0, 500) : null)
    .run()
    .catch(() => {});

  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));

    // Off for this kind under Notifications, or off by default and never
    // turned on. Not a failure and not worth a line in the log: somebody
    // decided this one should not interrupt anybody, and it doing nothing is
    // it working.
    if (!goesOut(readChannels(settings[CHANNELS_KEY]), notice.kind, 'push', notice.wanted)) {
      return { sent: 0, tried: 0, reason: 'switched off for this kind' };
    }

    const subs = await db.prepare(
      `SELECT p.*, u.role, u.permissions, u.active
         FROM push_subscriptions p JOIN users u ON u.id = p.user_id
        WHERE u.active = 1`,
    ).all().catch(() => ({ results: [] }));

    const extra = Array.isArray(notice.also) ? notice.also.filter(Boolean) : [];
    const watching = (sub) => extra.some((p) => allows(p, effectivePermissions(sub)));

    const wanted = (subs.results ?? []).filter((sub) => {
      // A named person is the whole audience the code chose, exactly as the
      // email reads it, plus anybody the property has asked to be copied in.
      if (notice.userId != null) {
        return Number(sub.user_id) === Number(notice.userId) || watching(sub);
      }
      if (!notice.audience) return true;
      return allows(notice.audience, effectivePermissions(sub)) || watching(sub);
    });

    if (!wanted.length) return { sent: 0, tried: 0, reason: 'nobody subscribed' };

    const vapid = await getVapidKeys(db);
    const subject = settings.email_from && settings.email_from.includes('@')
      ? `mailto:${settings.email_from.replace(/^.*<|>.*$/g, '').trim()}`
      : (originOf(settings.site_url) || 'https://example.com');

    const site = originOf(settings.site_url);
    const message = JSON.stringify({
      title: notice.title,
      body: notice.body ? String(notice.body).slice(0, 200) : '',
      // Where pressing it lands. Without an origin there is nowhere to send
      // them, and a notification that opens the wrong page is worse than one
      // that only says its piece.
      url: site && notice.link ? `${site}/${String(notice.link).replace(/^\/*/, '')}` : site || null,
      // ONE TAG PER NOTICE, NOT PER KIND. A tag is what the phone replaces:
      // two notifications sharing one arrive as one, the second quietly
      // overwriting the first. Tagged by kind, the second person to ask about
      // a day rubbed out the first, and somebody watching three requests come
      // in saw one, which looks exactly like push not working at all.
      //
      // The daily digest still wants the old behaviour, and it has it: it
      // sends its own push, with its own tag, and does not come through here.
      tag: notice.id ? `notice-${notice.id}` : (notice.kind ?? 'hive'),
    });

    let sent = 0;
    const dead = [];
    const failures = [];
    for (const sub of wanted) {
      try {
        const result = await sendPush(sub, message, vapid, subject);
        if (result.ok) sent += 1;
        else if (result.gone) dead.push(sub.id);
        else failures.push(`${result.status} ${result.detail ?? ''}`.trim());
      } catch (err) {
        failures.push(err.message);
      }
    }

    if (dead.length) {
      await db.batch(dead.map((id) => db.prepare(
        'DELETE FROM push_subscriptions WHERE id = ?',
      ).bind(id))).catch(() => {});
    }

    await log(
      sent ? 'sent' : (failures.length || dead.length) ? 'failed' : 'skipped',
      [
        notice.kind,
        failures.length ? `${failures.length} failed: ${failures[0]}` : null,
        dead.length ? `${dead.length} expired device(s) removed` : null,
      ].filter(Boolean).join('; ') || null,
      sent,
    );

    // `tried` separates the two zeroes. Nobody with a device is not a
    // failure, and a caller writing down what happened to one person must not
    // record it as one.
    return { sent, tried: wanted.length };
  } catch (err) {
    await log('failed', `${notice.kind ?? 'notice'}: ${err.message}`);
    return { sent: 0, tried: 1, reason: err.message };
  }
}

/**
 * Send one notice on to whoever it names.
 *
 * Silent and harmless when email is not set up, switched off, or addressed to
 * nobody with an address. Never throws: a notice is a courtesy, and a mail
 * provider having a bad afternoon must not fail the round that earned it.
 */
export async function emailNotice(db, env, notice) {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));

    if (settings.notice_email === '0') return { sent: 0, tried: 0, reason: 'switched off' };
    if (!goesOut(readChannels(settings[CHANNELS_KEY]), notice.kind, 'email', notice.wanted)) {
      return { sent: 0, tried: 0, reason: 'switched off for this kind' };
    }
    const apiKey = env?.RESEND_API_KEY;
    const from = (settings.email_from || '').trim();
    if (!apiKey || !from) return { sent: 0, tried: 0, reason: 'not configured' };

    // A notice may be shown more widely than it is mailed. Where it says so,
    // the narrower audience is the one that gets an inbox.
    const people = await noticeRecipients(db, {
      ...notice,
      audience: notice.emailAudience === undefined ? notice.audience : notice.emailAudience,
    });
    if (!people.length) return { sent: 0, tried: 0, reason: 'nobody to send to' };

    const { subject, html } = renderNotice({
      notice,
      propertyName: settings.property_name || 'HIVE',
      siteUrl: originOf(settings.site_url),
    });

    const to = people.map((p) => p.email);
    await sendEmail({
      apiKey,
      from: senderWithName(from, senderNameOf(settings)),
      to,
      subject,
      html,
      replyTo: (settings.email_reply_to || '').trim() || null,
    });

    await db.prepare(
      'INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)',
    ).bind('notice', null, to.join(', '), 'sent', String(notice.kind).slice(0, 60))
      .run().catch(() => {});

    return { sent: to.length, tried: to.length };
  } catch (err) {
    await db.prepare(
      'INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)',
    ).bind('notice', null, null, 'failed', String(err.message).slice(0, 500))
      .run().catch(() => {});
    return { sent: 0, tried: 1, reason: err.message };
  }
}
