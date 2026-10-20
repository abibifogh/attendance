/**
 * Sealing a short secret with the server's own secret.
 *
 * For a value HIVE has to be able to read back later but that a copy of the
 * database should not give away: AES-GCM, with a key derived from the Worker
 * secret and a purpose, so one sealed value cannot be opened as another.
 */
const encoder = new TextEncoder();

async function keyFor(secret, purpose) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${purpose}:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The value sealed, as text to store; null where there is no secret to seal with. */
export async function seal(value, secret, purpose) {
  if (!secret || value == null) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await keyFor(secret, purpose), encoder.encode(String(value)),
  ));
  return `${toB64(iv)}.${toB64(box)}`;
}

/** The value back, or null if it cannot be opened with this secret. */
export async function unseal(text, secret, purpose) {
  if (!secret || !text) return null;
  try {
    const [iv, box] = String(text).split('.');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(iv) }, await keyFor(secret, purpose), fromB64(box),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
