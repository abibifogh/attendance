import { parseList } from './attendance.js';

/**
 * The staff handbook.
 *
 * Who a chapter is for, what it asks of them, and whether they have done it.
 * Pure, because all three are decisions the property will want to argue with
 * later and every one of them has to be answerable from the record rather than
 * from somebody's memory of the screen.
 */

/** What a chapter can ask of the person reading it. */
export const ASKS = [
  {
    key: 'read',
    label: 'Read it',
    detail: 'A reference page. Nothing is recorded.',
    records: false,
  },
  {
    key: 'ack',
    label: 'Read it and tick it',
    detail: 'A tick against their name, kept with the date and the exact words.',
    records: true,
  },
  {
    key: 'sign',
    label: 'Sign it',
    detail: 'Their name and a drawn mark, the same as a contract.',
    records: true,
  },
];

export const ASK_MAP = new Map(ASKS.map((a) => [a.key, a]));

/** Anything else is a reference page, which is the harmless answer. */
export const asksOf = (chapter) => (ASK_MAP.has(chapter?.asks) ? chapter.asks : 'read');

/** And what the published copy asks, which is what a person is actually held to. */
export const liveAsksOf = (chapter) => (ASK_MAP.has(chapter?.live_asks)
  ? chapter.live_asks
  : asksOf(chapter));

/**
 * Is this chapter for this person?
 *
 * Nothing named means everybody, which is what most of a handbook is. A
 * department, a tag, or both: the kitchen's food safety rules are a
 * department, the charter for team leads is a tag, and somebody who matches
 * either one of them is in.
 */
export function isFor(chapter, staff) {
  const departments = parseList(chapter?.departments);
  const tags = parseList(chapter?.tags);
  if (!departments.length && !tags.length) return true;

  if (departments.includes(staff?.department || '')) return true;
  const theirs = new Set(parseList(staff?.tags));
  return tags.some((tag) => theirs.has(tag));
}

/** Said in words, for the line under a chapter's title. */
export function whoFor(chapter) {
  const departments = parseList(chapter?.departments);
  const tags = parseList(chapter?.tags);
  if (!departments.length && !tags.length) return 'Everybody';
  return [...departments, ...tags].join(', ');
}

/**
 * Whether this person has done what the published chapter asks.
 *
 * Against the version, not against the chapter. Somebody who ticked version 2
 * of the disciplinary procedure has not ticked version 3, and treating those
 * as the same tick is how a property ends up saying "he agreed to this" about
 * words he never saw.
 */
export function hasDone(chapter, acks) {
  if (!needsDoing(chapter)) return true;
  return (acks ?? []).some((a) => Number(a.chapter_id) === Number(chapter.id)
    && Number(a.version) === Number(chapter.version));
}

/** A published chapter that wants something back. */
export const needsDoing = (chapter) => chapter?.status === 'published'
  && liveAsksOf(chapter) !== 'read';

/**
 * What is still waiting on somebody.
 *
 * In the order the handbook is written rather than by how overdue they are: a
 * person working through four of them reads them in the order the chapters
 * make sense in, and a list that reshuffles itself as they go is a list they
 * lose their place in.
 */
export function outstandingFor(chapters, staff, acks) {
  return (chapters ?? [])
    .filter((c) => c.status === 'published')
    .filter((c) => isFor(c, staff))
    .filter((c) => needsDoing(c) && !hasDone(c, acks))
    .sort((a, b) => (a.sort_order - b.sort_order) || String(a.title).localeCompare(String(b.title)));
}

/**
 * Who has not done it, out of who it is for.
 *
 * The denominator is the point. "12 people have acknowledged it" is a number
 * about the app; "12 of the 19 it applies to" is a number about the property,
 * and the seven are the ones somebody has to go and find.
 */
export function whoIsOutstanding(chapter, staff, acks) {
  const done = new Set((acks ?? [])
    .filter((a) => Number(a.chapter_id) === Number(chapter.id)
      && Number(a.version) === Number(chapter.version))
    .map((a) => Number(a.staff_id)));

  const theirs = (staff ?? []).filter((p) => p.active && isFor(chapter, p));
  return {
    of: theirs.length,
    done: theirs.filter((p) => done.has(Number(p.id))).length,
    waiting: theirs.filter((p) => !done.has(Number(p.id))),
  };
}

/**
 * Does publishing this change what people have already agreed to?
 *
 * A wording change is a new version and everybody is asked again. A change to
 * the summary, the order or who it is for is not: nobody acknowledged the
 * summary. Getting this wrong in the generous direction would make the whole
 * mechanism worthless, so the comparison is on the words and the title, both
 * of which appear on the page somebody ticks.
 */
export function wouldBeANewVersion(chapter) {
  if (chapter?.status !== 'published' || !chapter.version) return true;
  return String(chapter.body ?? '') !== String(chapter.live_body ?? '')
    || String(chapter.title ?? '') !== String(chapter.live_title ?? '')
    || asksOf(chapter) !== liveAsksOf(chapter);
}

/** Words are the same, so the draft is only a copy of what is already out. */
export const isUnchanged = (chapter) => chapter?.status === 'published'
  && !wouldBeANewVersion(chapter);
