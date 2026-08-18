/**
 * What this app calls itself.
 *
 * A constant rather than a hostname check: unlike the operation's other sites,
 * this one is served by a single Worker on a single address, so there is
 * nothing to decide at runtime. It stays in its own module because
 * `index.html` settles the same three values inline — before any module
 * loads — and the two have to agree.
 *
 * It began as an attendance app and is not one any more: it runs the rota,
 * leave, the sign-off, the personnel records, contracts and the letter
 * register. `app` is left as `attendance` on purpose — it is the Worker's own
 * name and the repository's, and renaming those buys nothing a person can see
 * while costing a re-attached custom domain and a broken deploy.
 */
export const BRAND = {
  app: 'attendance',
  mark: '\u{1F41D}',
  name: 'HIVE',
  full: 'Human Information & Verification Engine',
};
