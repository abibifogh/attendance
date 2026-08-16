/**
 * What this app calls itself.
 *
 * A constant rather than a hostname check: unlike the operation's other sites,
 * this one is served by a single Worker on a single address, so there is
 * nothing to decide at runtime. It stays in its own module because `index.html`
 * settles the same three values inline — before any module loads — and the two
 * have to agree.
 */
export const BRAND = { app: 'attendance', mark: '🕘', name: 'Staff Attendance' };
