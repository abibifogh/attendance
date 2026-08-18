// The token-reading rule from the two public pages, kept where a test can
// reach it. Those pages are plain browser modules with no imports of their own
// by design — they are loaded by people with no account, and the less they
// pull in the better — so this is a copy rather than a shared module, and the
// test beside it is what stops the copy drifting.
export function tokenFrom(pathname, prefix) {
  const parts = pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf(prefix);
  if (at === -1 || at === parts.length - 1) return '';
  try {
    return decodeURIComponent(parts[at + 1]);
  } catch {
    return parts[at + 1];
  }
}
