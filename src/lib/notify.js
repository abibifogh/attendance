import { getVapidKeys, sendPush } from './push.js';
import { isMissingTable } from './http.js';

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

/** Split a stored recipient list. Commas, semicolons or newlines. */
export function parseRecipients(value) {
  return String(value || '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

/**
 * Send one message through Resend.
 *
 * Chosen for having an HTTP API — a Worker cannot open an SMTP socket, so
 * anything SMTP-shaped is out regardless of preference.
 */
export async function sendEmail({ apiKey, from, to, subject, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Email provider returned ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json().catch(() => ({}));
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

  const needing = rows.filter((r) => r.resolution === 'open')
    .map((r) => `${r.name} — ${r.label}`);
  const away = rows.filter((r) => r.status === 'absent').map((r) => r.name);

  return {
    subject: open
      ? `${propertyName}: ${open} attendance day${open === 1 ? '' : 's'} to confirm`
      : `${propertyName}: ${absent} absent on ${day}`,
    html: `
      <div style="max-width:560px;margin:0 auto;padding:24px;font-family:system-ui,sans-serif">
        <p style="font:12px/1.4 system-ui,sans-serif;color:#6f7884;margin:0 0 4px">${esc(propertyName)}</p>
        <h1 style="font:700 22px/1.3 system-ui,sans-serif;color:#101418;margin:0 0 4px">Attendance — ${esc(day)}</h1>
        <p style="font:14px/1.6 system-ui,sans-serif;color:#4a535e;margin:0">
          ${open ? `${open} day${open === 1 ? '' : 's'} waiting on a decision` : 'Nothing waiting on a decision'}${absent ? `, ${absent} absent` : ''}.
        </p>
        ${list('Waiting on you', needing)}
        ${list('Absent', away)}
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
  };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/** Short enough to read on a lock screen without unlocking it. */
export function renderPing({ day, propertyName, open, absent, escalated }) {
  const parts = [];
  if (open) parts.push(`${open} to confirm`);
  if (absent) parts.push(`${absent} absent`);

  return {
    title: `${propertyName} — attendance`,
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

    const ping = renderPing({
      day,
      propertyName: settings.property_name || 'Attendance',
      open,
      absent,
      escalated,
    });

    const vapid = await getVapidKeys(db);
    const subject = settings.email_from && settings.email_from.includes('@')
      ? `mailto:${settings.email_from.replace(/^.*<|>.*$/g, '').trim()}`
      : (settings.site_url || 'https://example.com');

    const message = JSON.stringify({
      ...ping,
      url: `${settings.site_url || ''}/#/att-today?day=${day}`,
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
    const to = parseRecipients(settings.att_email_to).filter(isEmail);
    if (!apiKey || !settings.email_from || !to.length) return;

    const { subject, html } = renderDigest({
      day,
      propertyName: settings.property_name || 'Attendance',
      siteUrl: settings.site_url,
      open,
      absent,
      escalated,
      rows,
    });

    await sendEmail({ apiKey, from: settings.email_from, to, subject, html });
    await write('sent', to.join(', '));
  } catch (err) {
    if (!isMissingTable(err)) await write('failed', null, err.message);
  }
}
