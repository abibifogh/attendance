import { HttpError } from '../lib/http.js';

/**
 * A GET against a source system, with the failure modes named.
 *
 * A connector that throws "fetch failed" leaves somebody guessing between a
 * typo in a URL, an expired key and a business that genuinely had no sales.
 * These are three completely different mornings and the message says which.
 */
export async function getJson(url, { token, timeoutMs = 20000, tokenScheme = 'Bearer' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `${tokenScheme} ${token}` } : {}),
      },
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new HttpError(504, `${hostOf(url)} did not answer within ${timeoutMs / 1000}s`);
    throw new HttpError(502, `${hostOf(url)} could not be reached`, String(err?.message ?? err));
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, `${hostOf(url)} refused the key`);
  }
  if (response.status === 503) {
    throw new HttpError(503, `${hostOf(url)} has its reporting API switched off`);
  }
  if (!response.ok) {
    throw new HttpError(502, `${hostOf(url)} answered ${response.status}`, (await response.text()).slice(0, 300));
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // Almost always an HTML sign-in page served with a 200, which is a
    // configuration mistake that reads as corrupt data unless it is named.
    throw new HttpError(502, `${hostOf(url)} answered with something that is not JSON`, text.slice(0, 200));
  }
}

/**
 * Walk a cursor-paged resource to the end.
 *
 * The POS documentation is explicit about the trap and it is worth honouring
 * carefully: a filtered page can come back short while there is still more to
 * come, so the loop stops when the cursor is null and never because a page
 * looked small. `maxPages` is only a runaway guard.
 */
export async function getPaged(base, path, params, { token, maxPages = 60, timeoutMs } = {}) {
  const rows = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(params || {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    if (cursor) url.searchParams.set('cursor', cursor);
    const body = await getJson(url.toString(), { token, timeoutMs });
    if (Array.isArray(body?.data)) rows.push(...body.data);
    cursor = body?.next_cursor || '';
    if (!cursor) return rows;
  }
  return rows;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'The source'; }
}
