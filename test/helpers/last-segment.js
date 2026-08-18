// The token-reading rule from the two public pages, kept where a test can
// reach it. Those pages are plain browser modules with no imports of their
// own by design — they are loaded by people with no account, and the less
// they pull in the better — so this is a copy rather than a shared module,
// and the test below is what stops the copy drifting.
export function lastSegment(pathname, prefix) {
  const parts = pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  const raw = last === prefix ? '' : last;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
