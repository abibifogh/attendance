/**
 * Editing wrangler.toml without a TOML parser.
 *
 * Two operations, both finding a block by the *binding name* inside it rather
 * than by line number or document order — so the file can be reordered or have
 * a binding added above these and neither operation quietly rewrites the wrong
 * database id. That is a mistake which surfaces a week later as figures nobody
 * can explain, which is why this is a separate module with its own tests.
 *
 * A real TOML parser is not used because the round trip would drop every
 * comment in that file, and the comments there are half of its value.
 *
 * It is written as a line scan rather than one large regular expression. The
 * regex version of this was three lines shorter and, on a binding name that was
 * not present, took long enough to look like a hang: nested optional
 * quantifiers over a whole file backtrack exponentially when the overall match
 * fails. A scan is linear and can be read.
 */

/** Strip a leading `# ` so a commented line can be examined as if it were live. */
const uncomment = (line) => line.replace(/^\s*#\s?/, '');

const isBlockStart = (line) => uncomment(line).trim() === '[[d1_databases]]';

/** Any other TOML table header — where a d1_databases block must stop. */
const isOtherHeader = (line) => {
  const bare = uncomment(line).trim();
  return bare.startsWith('[') && bare !== '[[d1_databases]]';
};

/**
 * The line range of the block declaring `binding`, or null.
 *
 * Returns a half-open range so the caller can slice it directly.
 */
function locate(lines, binding) {
  const declares = new RegExp(`^binding\\s*=\\s*"${binding}"\\s*$`);

  for (let start = 0; start < lines.length; start += 1) {
    if (!isBlockStart(lines[start])) continue;

    let end = start + 1;
    while (end < lines.length && !isBlockStart(lines[end]) && !isOtherHeader(lines[end])) end += 1;

    const body = lines.slice(start, end);
    if (body.some((line) => declares.test(uncomment(line).trim()))) {
      // Trailing blank lines belong to the gap between blocks, not to this one.
      let last = end;
      while (last > start + 1 && !lines[last - 1].trim()) last -= 1;
      return { start, end: last };
    }
  }
  return null;
}

/** The keys that are TOML rather than prose, and so may be uncommented. */
const IS_SETTING = /^(?:\[\[d1_databases\]\]|binding\s*=|database_name\s*=|database_id\s*=)/;

/**
 * Give a binding a real id, switching the block back on if it was commented out.
 *
 * Only the four lines that are actually TOML get uncommented. A prose comment
 * sitting inside the block stays a comment — uncommenting it would make the
 * file invalid and the deploy would fail on a sentence.
 */
export function setBinding(config, binding, id) {
  const lines = config.split('\n');
  const at = locate(lines, binding);
  if (!at) return { config, changed: false, found: false };

  const rewritten = lines.slice(at.start, at.end).map((line) => {
    const bare = uncomment(line);
    if (!IS_SETTING.test(bare.trim())) return line;
    return /^database_id\s*=/.test(bare.trim())
      ? bare.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`)
      : bare;
  });

  const next = [...lines.slice(0, at.start), ...rewritten, ...lines.slice(at.end)].join('\n');
  return { config: next, changed: next !== config, found: true };
}

/**
 * Comment a binding out entirely.
 *
 * A binding pointing at a database that does not exist fails the whole deploy,
 * and both of the databases this app reads are optional — it copes with either
 * missing and says so on every screen. Switching one off beats refusing to
 * deploy at all.
 */
export function disableBinding(config, binding) {
  const lines = config.split('\n');
  const at = locate(lines, binding);
  if (!at) return { config, changed: false, found: false };

  const rewritten = lines.slice(at.start, at.end).map((line) => (
    line.trim() && !line.trimStart().startsWith('#') ? `# ${line}` : line
  ));

  const next = [...lines.slice(0, at.start), ...rewritten, ...lines.slice(at.end)].join('\n');
  return { config: next, changed: next !== config, found: true };
}

/** Is the binding present and not commented out? */
export function bindingEnabled(config, binding) {
  const lines = config.split('\n');
  const at = locate(lines, binding);
  if (!at) return false;
  return lines.slice(at.start, at.end)
    .some((line) => new RegExp(`^binding\\s*=\\s*"${binding}"`).test(line.trim()));
}

/** The id currently set for a binding, commented out or not. */
export function bindingId(config, binding) {
  const lines = config.split('\n');
  const at = locate(lines, binding);
  if (!at) return null;
  for (const line of lines.slice(at.start, at.end)) {
    const match = uncomment(line).trim().match(/^database_id\s*=\s*"([^"]*)"/);
    if (match) return match[1];
  }
  return null;
}
