import { s } from './util.js';

/**
 * A mark per system.
 *
 * The hub is five cards of similar text, and text of similar length in similar
 * boxes is read by scanning rather than by reading. A person coming back to
 * this page for the fiftieth time is not reading "Restaurant POS", they are
 * looking for the shape that means the restaurant — so each system gets a shape
 * and keeps it.
 *
 * Drawn rather than set in emoji. An emoji is a different picture on every
 * platform, ignores the theme, and cannot take the colour the rest of the app
 * has already given that part of the business. These are flat, two-tone, and
 * inherit `--surface` for their cut-outs, so they hold up in light and dark
 * without a second set.
 *
 * The colours are not decoration. Each system keeps the categorical slot it is
 * given everywhere else in the app, so the shape on this card and the band in a
 * chart are the same claim about the same thing:
 *
 *   HIVE       series-1, blue
 *   Laundry    series-2, orange
 *   Restaurant series-3, aqua
 *   Breakfast  series-4, yellow
 *   Insight    all four, which is what it is
 *
 * And the four sources that are not somewhere a person signs in, but that
 * Insight reads all the same and the sign-in page now shows:
 *
 *   Accounts (Odoo)        series-5, magenta
 *   Front desk (ASSD)      series-7, violet
 *   Card terminal          ink-2, slate: it is a box, not a part of the business
 *   Bank                   series-6, green
 */

/** 22px of drawing on a 24 box, so the shapes optically match at a glance. */
const BOX = 24;

const svg = (label, colour, ...children) => s('svg', {
  viewBox: `0 0 ${BOX} ${BOX}`,
  class: 'sysmark',
  role: 'img',
  'aria-label': label,
  style: `--mark:${colour}`,
}, ...children);

/**
 * HIVE: a hexagon, the cell of a honeycomb.
 *
 * The app's own mark is a bee. A bee at 24 pixels is a smudge, and the hive is
 * the better half of the metaphor anyway — the thing that holds who is where.
 */
const hive = () => svg('HIVE', 'var(--series-1)',
  s('path', {
    d: 'M12 2.6 20.1 7.3v9.4L12 21.4 3.9 16.7V7.3Z',
    fill: 'var(--mark)', opacity: 0.16,
  }),
  s('path', {
    d: 'M12 2.6 20.1 7.3v9.4L12 21.4 3.9 16.7V7.3Z',
    fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.7, 'stroke-linejoin': 'round',
  }),
  // Small enough that the ring around it survives. A first attempt filled most
  // of the outer shape and the whole mark read as a solid blue badge — a
  // honeycomb cell is the gap as much as the wall.
  s('path', {
    d: 'M12 9.4 14.9 11.1v3.4L12 16.2 9.1 14.5v-3.4Z',
    fill: 'var(--mark)',
  }));

/**
 * Breakfast: a cup with steam.
 *
 * Not a plate or a fork — the restaurant has the cutlery, and two food systems
 * side by side need to be told apart at a glance rather than after a moment.
 */
const breakfast = () => svg('Breakfast and rooms', 'var(--series-4)',
  s('path', {
    d: 'M4.5 10h11v5.5a4 4 0 0 1-4 4h-3a4 4 0 0 1-4-4Z',
    fill: 'var(--mark)', opacity: 0.18,
  }),
  s('path', {
    d: 'M4.5 10h11v5.5a4 4 0 0 1-4 4h-3a4 4 0 0 1-4-4Z',
    fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.7, 'stroke-linejoin': 'round',
  }),
  s('path', {
    d: 'M15.5 11.5h1.8a2.2 2.2 0 0 1 0 4.4h-1.8',
    fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.7, 'stroke-linecap': 'round',
  }),
  s('path', {
    d: 'M8 4.2c0 1.2 1.2 1.6 1.2 2.8M11.4 4.2c0 1.2 1.2 1.6 1.2 2.8',
    fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: 0.75,
  }));

/**
 * Restaurant: a serving dome over a plate.
 *
 * A fork and a knife was the obvious drawing and the wrong one: at this size it
 * is two hairlines with nothing solid in them, so it sat pale and weightless
 * next to four marks that all carry a filled shape. The dome has a body, which
 * is what makes it findable in a hurry during service.
 */
const pos = () => svg('Restaurant POS', 'var(--series-3)',
  s('path', {
    d: 'M4.3 15.4a7.7 7.7 0 0 1 15.4 0Z',
    fill: 'var(--mark)', opacity: 0.18,
  }),
  s('path', {
    d: 'M4.3 15.4a7.7 7.7 0 0 1 15.4 0',
    fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.7, 'stroke-linecap': 'round',
  }),
  // The handle, so the dome is a dome rather than a hill.
  s('circle', { cx: 12, cy: 5.1, r: 1.5, fill: 'var(--mark)' }),
  s('path', {
    d: 'M2.8 18.2h18.4',
    fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.9, 'stroke-linecap': 'round',
  }));

/**
 * Laundry: a shirt.
 *
 * A washing machine is the obvious drawing and the wrong one — it is a drum in
 * a box, which at this size is a circle in a square and reads as a setting.
 */
const laundry = () => svg('Laundry', 'var(--series-2)',
  s('path', {
    d: 'M9.2 3.4 12 5.6l2.8-2.2 4.6 2.3-1.5 4.2-1.9-.7v11.4H7l0-11.4-1.9.7L3.6 5.7Z',
    fill: 'var(--mark)', opacity: 0.16,
  }),
  s('path', {
    d: 'M9.2 3.4 12 5.6l2.8-2.2 4.6 2.3-1.5 4.2-1.9-.7v11.4H7l0-11.4-1.9.7L3.6 5.7Z',
    fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.7, 'stroke-linejoin': 'round',
  }));

/** A tinted body with an outline in the mark's colour: what every mark here is made of. */
const body = (d) => [
  s('path', { d, fill: 'var(--mark)', opacity: 0.16 }),
  s('path', {
    d, fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.7, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }),
];
const line = (d, width = 1.7) => s('path', {
  d, fill: 'none', stroke: 'var(--mark)', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
});

/**
 * Accounts: a receipt with a torn foot.
 *
 * What Odoo holds that nothing else does is the bill somebody approved; a
 * ledger book is the other obvious drawing, and at this size it is a rectangle.
 */
const accounts = () => svg('Accounts (Odoo)', 'var(--series-5)',
  ...body('M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4Z'),
  line('M9 8h6M9 11.5h6M9 15h3.5'));

/** Front desk: a room key, which is the desk's whole job. A bell would be a second dome beside the restaurant's. */
const desk = () => svg('Front desk (ASSD)', 'var(--series-7)',
  ...body('M8.2 4.6a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 1 1 0-9.2Z'),
  s('circle', { cx: 8.2, cy: 9.2, r: 1.3, fill: 'currentColor' }),
  line('M11.5 12.4 19.8 20.6M16.4 17.4l2-2M18.6 19.6l1.6-1.6'));

/** Card terminal: a card, its stripe, and the number. */
const card = () => svg('Card terminal', 'var(--ink-2)',
  ...body('M5 5.5h14a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 16V8A2.5 2.5 0 0 1 5 5.5Z'),
  line('M2.8 10h18.4'),
  line('M6.2 14.6h4'));

/** Bank: a pediment on columns, the drawing every banking app has taught people. */
const bank = () => svg('Bank', 'var(--series-6)',
  ...body('M3.5 9 12 3.8 20.5 9Z'),
  line('M6.5 11.5v5.5M10.2 11.5v5.5M13.8 11.5v5.5M17.5 11.5v5.5'),
  line('M3.5 19.6h17'));

/**
 * Insight: four bars of different heights.
 *
 * The same mark the sign-in page carries, in the same four colours as the four
 * systems above — which is the whole claim of this application in one shape.
 */
const insight = () => s('svg', {
  viewBox: `0 0 ${BOX} ${BOX}`, class: 'sysmark', role: 'img', 'aria-label': 'Insight',
},
s('rect', { x: 2.5, y: 13.5, width: 3.6, height: 8, rx: 1.4, fill: 'var(--series-1)' }),
s('rect', { x: 8.1, y: 9, width: 3.6, height: 12.5, rx: 1.4, fill: 'var(--series-4)' }),
s('rect', { x: 13.7, y: 11.2, width: 3.6, height: 10.3, rx: 1.4, fill: 'var(--series-3)' }),
s('rect', { x: 19.3, y: 4.5, width: 3.6, height: 17, rx: 1.4, fill: 'var(--series-2)' }));

/**
 * Anything not on this list.
 *
 * A sixth system added to the database gets a plain tile rather than nothing:
 * a missing mark where four cards have one reads as a broken image, and a card
 * that is quietly different is a card people mistrust.
 */
const unknown = (label) => svg(label || 'System', 'var(--muted)',
  s('rect', {
    x: 3.6, y: 3.6, width: 16.8, height: 16.8, rx: 4.4,
    fill: 'var(--mark)', opacity: 0.14,
  }),
  s('rect', {
    x: 3.6, y: 3.6, width: 16.8, height: 16.8, rx: 4.4,
    fill: 'none', stroke: 'var(--mark)', 'stroke-width': 1.7,
  }));

const MARKS = {
  insight,
  attendance: hive,
  breakfast,
  housekeeping: breakfast,
  pos,
  laundry,
  odoo: accounts,
  assd: desk,
  card,
  bank,
};

/** The mark for a system id, always a node. */
export function systemMark(id, label) {
  const draw = MARKS[id];
  return draw ? draw() : unknown(label);
}

/** Whether a system has a mark of its own, for anywhere that needs to know. */
export const hasMark = (id) => Object.hasOwn(MARKS, id);
