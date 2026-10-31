/**
 * Big figures that fit their tile.
 *
 * A tile's figure is set large, and a real one can be long: GH₵1,234,567.89
 * does not fit a tile a phone shows two across. Wrapping an amount in the
 * middle reads as two numbers, and letting it run out of the tile pushes the
 * page sideways; so a figure too wide for its box is set a little smaller,
 * step by step, until it fits. A short figure keeps its size.
 *
 * It watches the page, so figures that arrive later (a total read after the
 * page) are fitted too, and fits again when the window changes width.
 */
export const FIGURES = [
  '.tile .value', '.sh-kpi .v', '.as-kpi b', '.as-row-r b', '.hero', '.sh-safebal b',
  '.fl-tile > b', '.pu-tile > b', '.pp-tile > b', '.mg-tile > b', '.sv-tile > b', '.sb-tile > b', '.np-tile > b', '.tl-kpi > b',
  '.fl-d4 b', '.sh-tile2 > b',
].join(', ');

const SMALLEST = 11;

/** Set each figure under `root` back to its own size, then smaller until it fits its box. */
export function fitFigures(root = document) {
  for (const el of root.querySelectorAll(FIGURES)) {
    el.style.fontSize = '';
    if (!el.clientWidth) continue;
    let size = parseFloat(getComputedStyle(el).fontSize);
    for (let i = 0; i < 30 && el.scrollWidth > el.clientWidth + 1 && size > SMALLEST; i += 1) {
      size = Math.max(SMALLEST, size * 0.92);
      el.style.fontSize = `${size}px`;
    }
  }
}

/** Fit now, after anything on the page changes, and when the window is resized. */
export function watchFigures(root) {
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fitFigures(root); });
  };
  new MutationObserver(later).observe(root, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', later);
  // The display face arrives after the first paint; its letters are wider than the fallback's.
  document.fonts?.ready.then(later).catch(() => {});
  later();
}
