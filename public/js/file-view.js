import { h } from './util.js';

/**
 * Opening a file without leaving the app.
 *
 * Every file in here used to be a plain link with target="_blank", which is
 * right at a desk and a trap on a phone. Installed on an iPhone there is no
 * browser chrome at all: the standalone window keeps the link, the CV fills the
 * screen, and there is no back button, no tab strip and no ✕ anywhere. The app
 * is simply gone until somebody force-quits it. On Android the system back
 * gesture gets you out, which is survivable and still not something anybody
 * should have to know.
 *
 * So on a phone the file opens inside the app instead, over the screen it was
 * opened from, with a ✕ that is always there. A photograph — which most of
 * these are, being pictures of Ghana Cards and receipts taken on a phone —
 * shows as a picture. A PDF is handed to whatever the browser has, which an
 * iPhone will show and Chrome on Android will not.
 *
 * Which is why the other button saves rather than opens. "Open it outside"
 * would be the same trap all over again on the phone that has the trap: a
 * same-origin link out of a standalone window on iOS is kept by that window.
 * Saving never navigates anywhere. The file lands in the phone's downloads,
 * whatever reads PDFs opens it from there, and the app is still sitting behind
 * it untouched.
 *
 * At a desk nothing changes. A new tab is the right answer where there is a tab
 * strip to come back through.
 */

export function looksLikeImage(name = '', mime = '') {
  if (String(mime).startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(String(name));
}

export function looksLikePdf(name = '', mime = '') {
  if (String(mime).toLowerCase().includes('pdf')) return true;
  return /\.pdf$/i.test(String(name));
}

/**
 * Whether opening a file here would strand somebody.
 *
 * A narrow screen or a window with no chrome on it: both are cases where the
 * way back is not on the screen. Written as a rule with its inputs handed in so
 * it can be read, and tested, without a browser.
 */
export function noWayBack({ narrow = false, standalone = false } = {}) {
  return Boolean(narrow || standalone);
}

function onAPhone() {
  try {
    return noWayBack({
      narrow: window.matchMedia('(max-width: 900px)').matches,
      standalone: window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true,
    });
  } catch {
    return false;
  }
}

/** The file, over the screen it was opened from, with a way out. */
export function openFile({ href, name = 'File', mime = '' }) {
  const body = looksLikeImage(name, mime)
    ? h('img.file-view-image', { src: href, alt: name })
    : h('iframe.file-view-frame', { src: href, title: name });

  const sheet = h('dialog.app-dialog.file-view',
    h('div.dialog-head',
      h('h2', name),
      // Saves rather than opens, on purpose. See the note at the top.
      h('a.btn-sm', { href, download: name || '' }, 'Save it'),
      h('button.dialog-close', { 'aria-label': 'Close', onclick: () => sheet.close() }, '✕'),
    ),
    h('div.file-view-body', body),
    looksLikePdf(name, mime)
      ? h('p.muted.file-view-note',
        'If nothing appears above, this phone will not show a PDF inside an app. Save it puts '
        + 'the file in your downloads and whatever reads PDFs opens it from there, with this '
        + 'still behind it.')
      : null,
  );

  document.body.append(sheet);
  sheet.addEventListener('close', () => sheet.remove());
  sheet.showModal();
  return sheet;
}

/**
 * A link to a file, which behaves itself on a phone.
 *
 * Still an ordinary anchor: it has a real href, so long-press to copy, open in
 * a new tab and everything else a link does all still work. Only the plain tap
 * is intercepted, and only where the tap would otherwise strand somebody.
 */
export function fileLink({ href, name, mime = '', label = null, className = '' }) {
  return h(`a${className ? `.${className}` : ''}`, {
    href,
    target: '_blank',
    rel: 'noopener',
    onclick: (event) => {
      // Let anything but a plain tap through: a middle click, a modified click
      // and a long-press menu are all somebody deliberately asking for a tab.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey
        || event.altKey || event.button !== 0) return;
      if (!onAPhone()) return;
      event.preventDefault();
      openFile({ href, name: name || label || 'File', mime });
    },
  }, label ?? name ?? 'Open');
}
