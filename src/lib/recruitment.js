/**
 * Recruitment: the shape of the pipeline, and what may follow what.
 *
 * Kept apart from the routes because the interesting decisions here are not
 * about storage. Which stage may follow which, what a stage means, and when a
 * slot is still worth offering are the things somebody will argue with, and
 * they should be readable in one file rather than spread across a dozen
 * handlers.
 *
 * THE PIPELINE IS DELIBERATELY SHORT. A hotel is not a software company: the
 * distance from a name on a scrap of paper to somebody starting on Monday is
 * usually a week, and a seven-stage pipeline with sub-states is a thing nobody
 * updates, which makes the board a lie within a fortnight. Five live stages
 * and two endings.
 *
 * NOTHING SKIPS BACKWARDS BY ACCIDENT, but everything can be moved back on
 * purpose. Somebody who turned an offer down in March is somebody to ring in
 * June, so an ending is never final and never deletes anything.
 */

/** The stages, in the order they happen. */
export const STAGES = [
  {
    key: 'applied',
    label: 'Applied',
    detail: 'In the pile. Nobody has read it yet.',
    live: true,
  },
  {
    key: 'shortlisted',
    label: 'Shortlisted',
    detail: 'Worth an interview. Somebody has read it and said so.',
    live: true,
  },
  {
    key: 'interview',
    label: 'Interview',
    detail: 'Invited, or booked in. The diary says when.',
    live: true,
  },
  {
    key: 'offer',
    label: 'Offered',
    detail: 'The job is theirs if they want it. Waiting on them.',
    live: true,
  },
  {
    key: 'hired',
    label: 'Taken on',
    detail: 'On the books. They have a record, and the contract goes out from there.',
    live: false,
  },
  {
    key: 'declined',
    label: 'They said no',
    detail: 'Offered and turned down. Worth keeping: circumstances change.',
    live: false,
  },
  {
    key: 'not_taken',
    label: 'Not this time',
    detail: 'Not taken forward. The reason is on the record, and so is who decided.',
    live: false,
  },
];

export const STAGE_KEYS = STAGES.map((s) => s.key);
const STAGE_MAP = new Map(STAGES.map((s) => [s.key, s]));

export const isStage = (key) => STAGE_MAP.has(key);
export const stageLabel = (key) => STAGE_MAP.get(key)?.label ?? key;

/** The stages somebody is still being considered at. */
export const LIVE_STAGES = STAGES.filter((s) => s.live).map((s) => s.key);

/** The endings. Kept, never deleted, and reachable again from anywhere. */
export const CLOSED_STAGES = STAGES.filter((s) => !s.live).map((s) => s.key);

/**
 * Why a move cannot happen, or null where it can.
 *
 * Only three things are actually forbidden, and each of them is forbidden
 * because allowing it would leave the data saying something untrue.
 */
export function whyNot(from, to, { hasStaffRecord = false } = {}) {
  if (!isStage(to)) return 'That is not a stage.';
  if (from === to) return 'They are already there.';

  // Taken on is not a stage somebody is moved into. It is what happens when a
  // staff record is made, which is a separate press with an employee number in
  // it, and setting it by hand would leave a candidate marked as staff with
  // nobody on the books.
  if (to === 'hired' && !hasStaffRecord) {
    return 'Use Take them on. That makes their record and fills this in by itself.';
  }

  // And it does not come off by hand either. Somebody taken on and then let go
  // is a leaver, which is the staff record's business rather than this one's.
  if (from === 'hired') {
    return 'They are on the books now. Anything after that belongs on their record, under People.';
  }

  return null;
}

/**
 * What the screen should offer next, given where somebody is.
 *
 * Forward first, because that is what almost every press is; then the two
 * endings; then anywhere else, which is how a mistake gets undone.
 */
export function movesFrom(stage) {
  const order = LIVE_STAGES;
  const at = order.indexOf(stage);
  const forward = at >= 0 && at < order.length - 1 ? [order[at + 1]] : [];
  const endings = ['not_taken', 'declined'].filter((k) => k !== stage);
  const back = order.filter((k) => k !== stage && !forward.includes(k));

  return [...forward, ...endings, ...back]
    .filter((key) => whyNot(stage, key) == null)
    .map((key) => STAGE_MAP.get(key));
}

/**
 * Where a candidate is, said in one line.
 *
 * Used on the board and in a notice, so the two cannot describe the same
 * person differently.
 */
export function sayStage(candidate) {
  const label = stageLabel(candidate.stage);
  if (candidate.stage === 'hired') return `${label}${candidate.hired_on ? ` on ${candidate.hired_on}` : ''}`;
  if (candidate.outcome && CLOSED_STAGES.includes(candidate.stage)) {
    return `${label}: ${candidate.outcome}`;
  }
  return label;
}

// ---------------------------------------------------------------------------
// The diary
// ---------------------------------------------------------------------------

/** Where somebody found us. Kept short so the answers stay comparable. */
export const SOURCES = [
  ['walk_in', 'Walked in'],
  ['referral', 'Referred by somebody here'],
  ['agency', 'Agency'],
  ['advert', 'Advertised'],
  ['online', 'Online'],
  ['other', 'Somewhere else'],
];

export const EMPLOYMENT = [
  ['permanent', 'Permanent'],
  ['probation', 'Permanent, after probation'],
  ['fixed', 'Fixed term'],
  ['casual', 'Casual'],
  ['temporary', 'Temporary cover'],
];

/**
 * Cut a morning into interview slots.
 *
 * Somebody publishing a diary thinks in "Tuesday, ten till one, half an hour
 * each", not in eleven separate times. So they say that, and this produces the
 * eleven.
 *
 * The last one has to fit. A half-hour interview starting at 12:45 when the
 * morning ends at one o'clock is fifteen minutes, which is not an interview.
 */
export function cutIntoSlots({ day, from, to, minutes = 30 }) {
  const start = toMinutes(from);
  const end = toMinutes(to);
  const length = Math.max(5, Math.min(240, Number(minutes) || 30));

  if (start == null || end == null) return [];
  if (end <= start) return [];

  const out = [];
  for (let at = start; at + length <= end; at += length) {
    out.push({ day, startsAt: fromMinutes(at), minutes: length });
    if (out.length >= 40) break; // A day with forty interviews in it is a typing mistake.
  }
  return out;
}

/**
 * Which slots are still worth offering somebody.
 *
 * Free, not cancelled, and not in the past. The last of those is the one that
 * matters: a link sent on Monday and opened on Friday must not offer Tuesday
 * morning, because somebody will pick it.
 */
export function offerable(slots, { now, forCandidate = null } = {}) {
  return slots.filter((slot) => {
    if (slot.cancelled_at) return false;
    if (slot.candidate_id != null && slot.candidate_id !== forCandidate) return false;
    return `${slot.day}T${slot.starts_at}` > now;
  });
}

/** HH:MM to minutes past midnight, or null where it is not a time. */
export function toMinutes(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** And back, always two digits, because a time is read at a glance. */
export function fromMinutes(total) {
  const n = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** When a slot ends, for the diary and for the candidate's confirmation. */
export function endsAt(slot) {
  const start = toMinutes(slot.starts_at ?? slot.startsAt);
  if (start == null) return null;
  return fromMinutes(start + (Number(slot.minutes) || 30));
}

/**
 * A list of names and numbers, as somebody would actually paste it.
 *
 * The realistic case is a stack of applications typed into a phone, or a list
 * forwarded from an agency: a name, and usually a number, one per line. Commas
 * and tabs both count as the break, because a paste out of a spreadsheet uses
 * one and a paste out of a message uses the other.
 *
 * It reads names. It never creates anybody on the books: a candidate is not a
 * member of staff, and the only door between the two is one deliberate press
 * with an employee number typed into it.
 */
export function readCandidateList(text) {
  const out = [];
  const seen = new Set();

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const parts = line.split(/\t|,|\s{2,}|;/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;

    // A line that is only a number is not a candidate, and a line that begins
    // with one is almost always "1. Ama Mensah" off a numbered list.
    const first = parts[0].replace(/^\d+[.)]\s*/, '').trim();
    if (!first || !/[a-zA-Z]/.test(first)) continue;

    const name = first.slice(0, 120);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const rest = parts.slice(1);
    out.push({
      name,
      phone: rest.find(looksLikePhone)?.slice(0, 40) ?? null,
      email: rest.find((p) => p.includes('@'))?.slice(0, 160) ?? null,
    });
    if (out.length >= 200) break;
  }

  return out;
}

/** Enough digits to ring, in whatever shape somebody wrote it. */
function looksLikePhone(text) {
  return /^[+()\d][\d\s()+-]{6,}$/.test(String(text).trim());
}

/**
 * How a vacancy is doing, as a sentence rather than a set of counters.
 *
 * The question anybody asks of a vacancy is whether it is going to be filled,
 * and four numbers on a card do not answer it. One taken on out of two wanted,
 * with nobody left in the pipeline, is a vacancy in trouble and should read
 * that way.
 */
export function howItIsGoing(role, candidates) {
  const hired = candidates.filter((c) => c.stage === 'hired').length;
  const live = candidates.filter((c) => LIVE_STAGES.includes(c.stage)).length;
  const wanted = Math.max(1, Number(role.headcount) || 1);
  const still = Math.max(0, wanted - hired);

  if (role.status === 'closed') return { tone: 'off', text: 'Closed.' };
  if (hired >= wanted) return { tone: 'good', text: `Filled. ${hired} taken on.` };
  if (role.status === 'on_hold') return { tone: 'warn', text: `On hold. ${live} still in the pipeline.` };

  if (!live && !hired) {
    return { tone: 'bad', text: `Nobody has applied yet. ${wanted} wanted.` };
  }
  if (!live) {
    return {
      tone: 'bad',
      text: `${still} still to find and nobody left in the pipeline.`,
    };
  }
  return {
    tone: still && live < still ? 'warn' : 'ok',
    text: `${still} still to find, ${live} in the pipeline.`,
  };
}
