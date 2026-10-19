import { badRequest, bool, json, notFound, readJson } from '../lib/http.js';
import { allows } from '../lib/permissions.js';
import { firstUsableEmail } from '../lib/notify.js';
import { beginFor } from './onboarding.js';
import { deliverInvite, issueContractFor, makeInvite } from './people.js';
import { inviteLoginFor } from './joining.js';

/**
 * A new starter's welcome, in one go.
 *
 * Taking somebody on used to leave three separate jobs behind it: start their
 * first week, send a link for their details and contract, and give them a
 * login. Each lived on a different screen, and the one that was forgotten was
 * whichever the person pressing Hire did not know about. This does all three,
 * and says what it could not do and why, so nothing is quietly left undone.
 *
 * Each part is optional, and each part that cannot be done (no email address,
 * no permission to make logins, email not set up) is reported rather than
 * failing the rest.
 */
export async function welcomeNewStarter(ctx, staffId, {
  start = true, sendLink = true, contractTemplateId = null, values = {}, login = true,
} = {}) {
  const person = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(Number(staffId)).first();
  if (!person) throw notFound('No such member of staff.');
  const out = { started: false, contractId: null, link: null, login: null, notDone: [] };

  if (start) {
    await beginFor(ctx.db, person.id, `${ctx.session.user.name} (welcome)`);
    const row = await ctx.db.prepare('SELECT 1 FROM ob_state WHERE staff_id = ?').bind(person.id).first().catch(() => null);
    out.started = Boolean(row);
    if (!row) out.notDone.push('First week not started: onboarding is switched off in Settings');
  }

  if (contractTemplateId) {
    try {
      const issued = await issueContractFor(ctx, person, { templateId: contractTemplateId, values });
      out.contractId = issued.id;
    } catch (err) {
      out.notDone.push(`Contract not issued: ${err.message}`);
    }
  }

  if (sendLink) {
    const invite = await makeInvite(ctx, person, {
      wantsDetails: true,
      contractIds: out.contractId ? [out.contractId] : [],
    });
    const delivered = await deliverInvite(ctx, person, invite, { email: true, text: true });
    out.link = {
      id: invite.id, url: invite.url, message: invite.message, delivered,
    };
    if (!delivered.emailed && !delivered.texted) {
      out.notDone.push(`Details link not sent (${delivered.whyNot.join('; ') || 'no way to reach them'}). `
        + 'Copy it and send it yourself.');
    }
  }

  if (login) {
    out.login = await loginFor(ctx, person);
    if (!out.login.sent) out.notDone.push(`Login: ${out.login.whyNot}`);
  }

  await ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
    .bind(`${ctx.session.user.name} (${ctx.session.user.role})`, 'people.welcome', String(person.id), JSON.stringify({
      started: out.started, contract: out.contractId, link: Boolean(out.link), login: out.login?.sent ?? null,
    })).run().catch(() => {});
  return out;
}

/** A staff login for them, and an invitation to it, where both are possible. */
async function loginFor(ctx, person) {
  if (!allows('users', ctx.session.permissions)) {
    return { sent: false, whyNot: 'not made, because making logins needs the Users permission' };
  }
  const profile = await ctx.db.prepare('SELECT personal_email FROM hr_profile WHERE staff_id = ?')
    .bind(person.id).first().catch(() => null);
  let user = await ctx.db.prepare('SELECT * FROM users WHERE staff_id = ? ORDER BY active DESC, id LIMIT 1')
    .bind(person.id).first().catch(() => null);
  const email = firstUsableEmail(profile?.personal_email, user?.email);
  if (!email) return { sent: false, whyNot: 'not invited, because there is no email address on their record' };

  if (!user) {
    user = await ctx.db.prepare(
      "INSERT INTO users (name, role, staff_id, active, note) VALUES (?1, 'staff', ?2, 1, ?3) RETURNING *",
    ).bind(person.name, person.id, 'Made when they were welcomed').first();
  }
  if (!user.active) return { sent: false, whyNot: 'their login is switched off' };

  const made = await inviteLoginFor(ctx, user, { email });
  return {
    sent: made.sent === true,
    url: made.url,
    email,
    whyNot: made.sent === true ? null : made.sent,
  };
}

/** The same, from a person's record, for somebody added by hand. */
export async function welcome(ctx, id) {
  const body = await readJson(ctx.request);
  const out = await welcomeNewStarter(ctx, id, {
    start: bool(body.start, true),
    sendLink: bool(body.sendLink, true),
    contractTemplateId: body.contractTemplateId ? Number(body.contractTemplateId) : null,
    values: body.values && typeof body.values === 'object' ? body.values : {},
    login: bool(body.login, true),
  });
  if (!out.started && !out.link && !out.login && !out.contractId) throw badRequest('Nothing was asked for.');
  return json({ ok: true, ...out });
}
