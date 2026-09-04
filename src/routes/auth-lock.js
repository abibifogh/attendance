import { badRequest, json, readJson, str, unauthorized } from '../lib/http.js';
import {
  getPepper, hashPin, isReservedPin, throttleCheck, throttleFail, throttleReset,
  verifyPasswordKey,
} from '../lib/auth.js';

/**
 * The PIN again, to carry on where they left off.
 *
 * Not a sign-in. The session is already theirs and stays theirs; this only
 * answers the question the app cannot answer for itself when it comes back
 * from behind another app: is the hand holding the phone still the same one.
 *
 * WHOSE PIN IS NOT ASKED, IT IS KNOWN. A sign-in looks somebody up by the PIN
 * they typed, which is why PINs have to be unique. This does the opposite: it
 * takes the person the session already names and asks whether these digits are
 * theirs. Typing a colleague's PIN into somebody else's locked phone unlocks
 * nothing.
 *
 * Throttled like a sign-in, because it is the same guessing surface, and by
 * the same counter so a locked phone is not a way round the keypad closing.
 */
export async function unlock(ctx) {
  const { request, env, db, session } = ctx;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const body = await readJson(request);

  const gate = await throttleCheck(db, ip, { pin: !body.passwordKey });
  if (!gate.allowed) {
    const wait = Math.max(1, Math.ceil(gate.retryAfter / 60));
    return json(
      { error: `Too many wrong tries. Try again in ${wait === 1 ? 'a minute' : `${wait} minutes`}.` },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } },
    );
  }

  const wrong = async () => {
    await throttleFail(db, ip);
    // The same uniform delay a sign-in uses, so nothing is learned from how
    // long the answer took.
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest('That is not your PIN.');
  };

  // The break-glass sign-in has no account behind it, so the only thing that
  // can unlock it is the secret it came in on.
  if (session.user.isRecovery) {
    const typed = str(body.pin, 'PIN', { max: 64, fallback: '' });
    if (!typed || !(await isReservedPin(typed, env))) await wrong();
    await throttleReset(db, ip);
    return json({ ok: true });
  }

  const row = await db.prepare(
    'SELECT id, pin_hash, password_hash, active FROM users WHERE id = ?',
  ).bind(Number(session.user.id)).first().catch(() => null);
  if (!row || !row.active) {
    throw unauthorized('This login is no longer active. Sign in again.');
  }

  const pepper = await getPepper(db);

  if (body.passwordKey) {
    if (!row.password_hash) await wrong();
    const ok = await verifyPasswordKey(String(body.passwordKey), row.password_hash, pepper);
    if (!ok) await wrong();
  } else {
    const typed = str(body.pin, 'PIN', { max: 64, fallback: '' });
    if (!typed || !row.pin_hash) await wrong();
    if (await hashPin(typed, pepper) !== row.pin_hash) await wrong();
  }

  await throttleReset(db, ip);
  return json({ ok: true });
}
