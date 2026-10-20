import { emailPersonally, isEmail } from './notify.js';
import { firstUsableNumber, sendTexts } from './sms.js';
import { mapLink } from './places.js';
import { siteOrigin } from './site.js';
import { seal, unseal } from './seal.js';
import { firstName, sayDate, sayShortDate } from './email-design.js';
import { addDays, nowIn } from '../util/dates.js';

/**
 * Telling the person being interviewed.
 *
 * Four moments: the time is booked, it is the day before, the time moves, the
 * time is cancelled. Each goes by email where they gave an address and by
 * text where they gave only a phone number, with the day, the time, where,
 * how to get there and a way to change it. An email carries a calendar entry
 * that later messages update or take away.
 *
 * Whoever caused it is said plainly: a person who changed their own time is
 * thanked; a person whose time the office moved is told it was moved.
 */

export const LINK_PURPOSE = 'rec-invite-link';
export const KINDS = ['booked', 'reminder', 'changed', 'cancelled'];

async function settingsOf(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] }));
  return Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
}

/** Seal a new link's token so a later message can carry the same link. */
export const sealToken = (token, env) => seal(token, env?.SESSION_SECRET, LINK_PURPOSE);

/** The candidate's own link, if one is live and can be read back. */
export async function candidateLink(db, env, candidateId, origin = '') {
  const rows = (await db.prepare(
    `SELECT token_box FROM rec_invite
      WHERE candidate_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
        AND wants_slot = 1 AND token_box IS NOT NULL
      ORDER BY id DESC LIMIT 3`,
  ).bind(candidateId).all().catch(() => ({ results: [] }))).results ?? [];
  for (const row of rows) {
    const token = await unseal(row.token_box, env?.SESSION_SECRET, LINK_PURPOSE);
    if (token) return { url: `${await siteOrigin(db, origin)}/c/${token}`, token };
  }
  return null;
}

const clock = (at) => String(at ?? '').slice(0, 5);
const endOf = (slot) => {
  const [h, m] = clock(slot.starts_at).split(':').map(Number);
  const total = h * 60 + m + (Number(slot.minutes) || 30);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const longWhen = (slot) => `${sayDate(slot.day)}, ${clock(slot.starts_at)}`;
const shortWhen = (slot) => `${sayShortDate(slot.day)}, ${clock(slot.starts_at)}`;

const icsText = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsWhen = (day, at) => `${String(day).replace(/-/g, '')}T${clock(at).replace(':', '')}00`;

/**
 * A calendar entry for the interview. One entry per candidate, so a moved
 * time replaces the one already in their calendar and a cancellation removes
 * it, rather than leaving the old one behind.
 */
export function calendarFor({ slot, candidateId, title, place, notes, timezone = 'UTC', host = 'hive', cancelled = false }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HIVE//Interviews//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:interview-${candidateId}@${host}`,
    `SEQUENCE:${Math.floor(Date.now() / 1000)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${timezone}:${icsWhen(slot.day, slot.starts_at)}`,
    `DTEND;TZID=${timezone}:${icsWhen(slot.day, endOf(slot))}`,
    `SUMMARY:${icsText(title)}`,
    place ? `LOCATION:${icsText(place)}` : null,
    notes ? `DESCRIPTION:${icsText(notes)}` : null,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    ...(cancelled ? [] : ['BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'END:VALARM']),
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

/** Everything a message about this interview needs, in one place. */
async function factsFor(db, env, { candidate, slot, origin, link }) {
  const settings = await settingsOf(db);
  const role = await db.prepare('SELECT title, bring FROM rec_role WHERE id = ?')
    .bind(slot?.role_id ?? candidate.role_id ?? -1).first().catch(() => null);
  const property = settings.property_name || 'Somewhere Nice';
  const address = String(settings.property_address ?? '').trim() || null;
  const site = await siteOrigin(db, origin);
  const own = link ?? (await candidateLink(db, env, candidate.id, origin))?.url ?? null;
  return {
    property,
    address,
    site,
    role: role?.title ?? null,
    bring: String(role?.bring ?? '').trim() || null,
    link: own,
    timezone: settings.timezone || 'UTC',
    directions: slot ? mapLink({ placeId: slot.place_id, lat: slot.place_lat, lng: slot.place_lng, label: slot.place || address }) : null,
  };
}

function wording(kind, { candidate, slot, was, by, f, today }) {
  const first = firstName(candidate.name);
  const where = slot?.place || null;
  if (kind === 'booked') {
    return {
      subject: `Your interview is booked: ${shortWhen(slot)}`,
      status: 'Booked', tone: 'info',
      headline: `Your interview is booked, ${first}`,
      intro: by === 'them'
        ? 'Thank you for choosing a time. Here is everything you need for the day.'
        : `${f.property} has booked your interview. Here is everything you need for the day.`,
      text: `${f.property}: your interview${f.role ? ` for ${f.role}` : ''} is booked for ${shortWhen(slot)}`
        + `${where ? `, ${where}` : ''}.${f.link ? ` Directions, or to change: ${f.link}` : ''}`,
    };
  }
  if (kind === 'reminder') {
    const tomorrow = slot.day === addDays(today, 1);
    const isToday = slot.day === today;
    const lead = isToday ? 'today' : tomorrow ? 'tomorrow' : `on ${sayDate(slot.day)}`;
    return {
      subject: isToday || tomorrow
        ? `${isToday ? 'Today' : 'Tomorrow'} at ${clock(slot.starts_at)}: your interview at ${f.property}`
        : `Your interview at ${f.property}: ${shortWhen(slot)}`,
      status: isToday ? 'Today' : tomorrow ? 'Tomorrow' : 'Reminder', tone: 'warn',
      headline: isToday ? `See you today, ${first}` : tomorrow ? `See you tomorrow, ${first}` : `Your interview is ${lead}`,
      intro: `A reminder of your interview${f.role ? ` for ${f.role}` : ''}.`,
      text: `Reminder from ${f.property}: your interview is ${lead}, ${shortWhen(slot)}`
        + `${where ? `, ${where}` : ''}.${f.bring ? ` Please bring ${f.bring.replace(/\.$/, '')}.` : ''}`
        + `${f.link ? ` Can't make it? Tell us: ${f.link}` : ''}`,
    };
  }
  if (kind === 'changed') {
    return {
      subject: `New time for your interview: ${shortWhen(slot)}`,
      status: 'New time', tone: 'info',
      headline: 'Your interview has a new time',
      intro: by === 'them'
        ? 'You changed your interview from your link. Your earlier time is free again.'
        : `${f.property} has moved your interview.${f.link ? ' If the new time does not suit, choose another from your link.' : ''}`,
      text: `${f.property}: your interview has moved to ${shortWhen(slot)}${where ? `, ${where}` : ''}.`
        + `${f.link ? ` Details: ${f.link}` : ''}`,
    };
  }
  const gone = slot ?? was;
  return {
    subject: 'Your interview time is cancelled',
    status: 'Cancelled', tone: 'neutral',
    headline: 'Your interview time is cancelled',
    intro: (by === 'them'
      ? `You told us you cannot make ${longWhen(gone)}. Thank you for letting us know; the time has gone back on the list.`
      : `${f.property} has had to cancel your interview on ${longWhen(gone)}. We are sorry for the change.`)
      + (f.link ? '\n\nIf another time suits you, choose one from your link while there are still times free.' : ''),
    text: `${f.property}: your interview on ${shortWhen(gone)} is cancelled.`
      + `${f.link ? ` To choose another time: ${f.link}` : ''}`,
  };
}

/**
 * Tell the candidate. Returns how it went, so a screen can say "sent by
 * email" or "they have no email or phone on file".
 *
 * `slot` is the time it is about (for a cancellation, the one that was
 * cancelled); `was` is the earlier time when it moved; `by` is 'them' or
 * 'office'; `link` is their link where the caller already has it.
 */
export async function tellCandidate(ctx, { candidateId, kind, slot = null, was = null, by = 'office', link = null, actor = null }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown interview message: ${kind}`);
  const { db, env } = ctx;
  const candidate = await db.prepare('SELECT * FROM rec_candidate WHERE id = ?').bind(candidateId).first();
  if (!candidate) return { sent: false, reason: 'no such candidate' };
  const time = slot ?? await db.prepare(
    'SELECT * FROM rec_slot WHERE candidate_id = ? AND cancelled_at IS NULL ORDER BY day, starts_at LIMIT 1',
  ).bind(candidate.id).first();
  if (!time) return { sent: false, reason: 'They have no interview time booked.' };

  const f = await factsFor(db, env, { candidate, slot: time, origin: ctx.url?.origin, link });
  const today = nowIn(f.timezone).slice(0, 10);
  const say = wording(kind, { candidate, slot: time, was, by, f, today });
  const { trail } = await import('../routes/recruitment.js');
  const note = async (detail) => trail(db, {
    candidateId: candidate.id, kind: `told_${kind}`, detail, actor: actor ?? (by === 'them' ? candidate.name : 'HIVE'),
  }).catch(() => {});

  const email = String(candidate.email ?? '').trim();
  if (isEmail(email)) {
    const host = (() => { try { return new URL(f.site).host; } catch { return 'hive'; } })();
    const title = `Interview${f.role ? `: ${f.role}` : ''} at ${f.property}`;
    const placeLine = [time.place, f.address].filter(Boolean).join(', ');
    const ics = calendarFor({
      slot: time, candidateId: candidate.id, title, place: placeLine, timezone: f.timezone, host,
      cancelled: kind === 'cancelled',
      notes: [
        'Please come about 10 minutes early.',
        f.bring ? `Please bring ${f.bring.replace(/\.$/, '')}.` : null,
        f.link ? `Directions, or to change or cancel: ${f.link}` : null,
      ].filter(Boolean).join('\n'),
    });
    const facts = kind === 'cancelled'
      ? []
      : [
        kind !== 'reminder' ? ['Role', f.role] : null,
        [kind === 'changed' ? 'New time' : 'When', longWhen(time), { strong: true }],
        kind === 'changed' && was ? ['Was', longWhen(was)] : null,
        ['How long', `About ${Number(time.minutes) || 30} minutes`],
        ['Where', time.place || null],
        kind === 'booked' || kind === 'changed' ? ['Address', f.address] : null,
      ].filter(Boolean);
    const out = await emailPersonally(db, env, {
      kind: 'recruitment.interview',
      level: kind === 'cancelled' ? 'warn' : 'info',
      title: say.subject,
      body: say.intro,
      link: kind === 'cancelled' ? f.link : (f.directions || f.link),
      to: email,
      wanted: true,
      attachments: [{ filename: 'interview.ics', content: btoa(unescape(encodeURIComponent(ics))) }],
      mail: {
        subject: say.subject,
        preheader: kind === 'cancelled' ? say.intro.split('\n')[0] : `${shortWhen(time)}${time.place ? `, ${time.place}` : ''}`,
        status: say.status,
        tone: say.tone,
        eyebrow: 'Interview',
        headline: say.headline,
        intro: say.intro,
        facts,
        button: kind === 'cancelled' ? (f.link ? 'Choose another time' : null) : (f.directions ? 'Get directions' : (f.link ? 'See the details' : null)),
        more: kind === 'cancelled' ? [] : [
          f.link ? ['Add to calendar', `${f.link.replace('/c/', '/api/c/')}/interview.ics`] : null,
          f.link ? ['Change or cancel', f.link] : null,
        ].filter(Boolean),
        panel: kind !== 'cancelled' && f.bring ? { label: 'Please bring', text: f.bring } : null,
        after: kind === 'cancelled' ? null
          : 'Please come about 10 minutes early.'
            + (f.link ? ' If something comes up, use “Change or cancel” so the time can go to someone else.' : ''),
        why: `You get this because you booked an interview time with ${f.property}. If that was not you, ignore this email.`,
        settingsLink: false,
      },
    }).catch((err) => ({ sent: 0, reason: err.message }));
    if (Number(out?.sent ?? 0) > 0) {
      await note(`by email to ${email}`);
      return { sent: true, how: 'email', to: email };
    }
    if (!firstUsableNumber(candidate.phone)) {
      await note(`could not email: ${out?.reason ?? 'not sent'}`);
      return { sent: false, reason: reasonFor(out?.reason, 'email') };
    }
  }

  const phone = firstUsableNumber(candidate.phone);
  if (!phone) return { sent: false, reason: 'They have no email address or mobile number on file.' };
  const out = await sendTexts(db, env, { kind: 'recruitment.interview', messages: [{ to: phone, text: say.text }] })
    .catch((err) => ({ sent: 0, reason: err.message }));
  if (Number(out?.sent ?? 0) > 0) {
    await note(`by text to ${candidate.phone}`);
    return { sent: true, how: 'text', to: candidate.phone };
  }
  await note(`could not text: ${out?.reason ?? 'not sent'}`);
  return { sent: false, reason: reasonFor(out?.reason, 'text') };
}

function reasonFor(reason, how) {
  const r = String(reason ?? '');
  if (/not configured|not set up|switched off$/.test(r)) {
    return how === 'email' ? 'Email is not set up yet, so nothing was sent.' : 'Texts are not set up yet, so nothing was sent.';
  }
  if (/switched off for this kind/.test(r)) return 'These messages are switched off under Notifications.';
  return `It could not be sent (${r || 'no reason given'}).`;
}

/**
 * The afternoon before: everybody with an interview tomorrow is reminded,
 * once. Somebody who only booked since midday the day before has just had
 * the details and is not sent them again.
 */
export async function watchInterviews(db, { timezone = 'UTC', ctx = {}, hour = 15 } = {}) {
  const now = nowIn(timezone);
  const today = now.slice(0, 10);
  if (Number(now.slice(11, 13)) < hour) return { reminded: 0 };
  const tomorrow = addDays(today, 1);
  const due = (await db.prepare(
    `SELECT * FROM rec_slot
      WHERE day = ? AND candidate_id IS NOT NULL AND cancelled_at IS NULL AND reminded_at IS NULL`,
  ).bind(tomorrow).all().catch(() => ({ results: [] }))).results ?? [];
  const sys = { db, env: ctx.env ?? {}, url: null, executionContext: ctx.executionContext ?? null };
  let reminded = 0;
  for (const slot of due) {
    const claim = await db.prepare("UPDATE rec_slot SET reminded_at = datetime('now') WHERE id = ? AND reminded_at IS NULL")
      .bind(slot.id).run();
    if (!Number(claim?.meta?.changes ?? 0)) continue;
    if (slot.taken_at && slot.taken_at >= `${today} 12:00:00`) continue;
    const out = await tellCandidate(sys, { candidateId: slot.candidate_id, kind: 'reminder', slot }).catch(() => ({ sent: false }));
    if (out.sent) reminded += 1;
  }
  return { reminded };
}
