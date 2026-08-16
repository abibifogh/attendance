import { toClock, toMinutes } from './attendance.js';

/**
 * Working out the shifts instead of asking somebody to type them again.
 *
 * Two sources, neither of which is authoritative on its own, and both of which
 * are better than an empty form.
 *
 * **What the terminal holds.** A device in automatic attendance mode carries a
 * set of status rules — the time bands that decide whether a tap is a check-in,
 * a check-out or a break. Those bands come down from wherever the shifts were
 * configured, so they are a genuine echo of them. What they are *not* is the
 * shift: a morning shift starting at 06:00 typically has a check-in band from
 * 05:00, because that is the earliest somebody may clock in, not the hour they
 * are due. Reading a start time straight off the band would be wrong by an hour
 * and wrong in the direction that hides lateness.
 *
 * **What the punches say.** Hundreds of people have already clocked in for these
 * shifts. The time they actually arrive, clustered, is a far better estimate of
 * when a shift starts than any band — and it is available with no API, no key
 * and no permission from anybody.
 *
 * So: the bands say how many shifts there are and roughly when, the punches say
 * precisely when, and a person confirms with one press. Nothing here writes a
 * shift on its own. A shift decides whether somebody is recorded as late, and
 * inventing one silently is not a thing to do to a payroll.
 */

// ---------------------------------------------------------------------------
// What the terminal reported
// ---------------------------------------------------------------------------

const STATUS_KEYS = new Set([
  'attendancestatus', 'status', 'attendancetype', 'type',
]);
const BEGIN_KEYS = /^(begin|start)(time)?$/i;
const END_KEYS = /^(end|stop)(time)?$/i;

/**
 * Pull every status-tagged time band out of whatever the device sent.
 *
 * Written as a walk of the whole tree rather than against a fixed schema on
 * purpose. Hikvision's ISAPI shapes vary between models and firmware — some
 * return one object, some a list, some wrap it another level down — and this
 * has to survive a firmware update it has never seen. Anything with a
 * recognisable status and a recognisable pair of times counts; everything else
 * is ignored rather than fatal.
 */
export function parseStatusRules(raw) {
  const found = [];

  const visit = (node, inheritedStatus) => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item, inheritedStatus);
      return;
    }

    let status = inheritedStatus;
    let begin = null;
    let end = null;

    for (const [key, value] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (STATUS_KEYS.has(lower) && typeof value === 'string') status = value;
      else if (BEGIN_KEYS.test(key) && typeof value === 'string') begin = value;
      else if (END_KEYS.test(key) && typeof value === 'string') end = value;
    }

    if (status && begin && end && toMinutes(begin) != null && toMinutes(end) != null) {
      found.push({ status: normaliseStatus(status), from: begin.slice(0, 5), to: end.slice(0, 5) });
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, status);
    }
  };

  visit(raw, null);
  // The same band can appear twice when the device nests it under a wrapper the
  // walk also matched.
  const seen = new Set();
  return found.filter((rule) => {
    const key = `${rule.status}|${rule.from}|${rule.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normaliseStatus(value) {
  const key = String(value).toLowerCase().replace(/[^a-z]/g, '');
  if (key.includes('checkin') || key === 'in') return 'in';
  if (key.includes('checkout') || key === 'out') return 'out';
  if (key.includes('breakoff') || key.includes('breakout')) return 'breakOut';
  if (key.includes('breakin')) return 'breakIn';
  if (key.includes('overtimein')) return 'overtimeIn';
  if (key.includes('overtimeout')) return 'overtimeOut';
  return key || 'unknown';
}

/**
 * Pair the check-in bands with the check-out bands into candidate shifts.
 *
 * A shift lies between the two: it cannot start before the earliest anybody may
 * clock in, and cannot end after the last moment they may clock out. That gives
 * an outer bound and a first guess, both flagged as such — `confidence: 'bands'`
 * means "the terminal implies roughly this", and the times still want a human,
 * or better, the punch evidence below.
 */
export function shiftsFromRules(rules) {
  const ins = rules.filter((r) => r.status === 'in').sort((a, b) => a.from.localeCompare(b.from));
  const outs = rules.filter((r) => r.status === 'out').sort((a, b) => a.from.localeCompare(b.from));
  if (!ins.length || !outs.length) return [];

  return ins.map((inBand, index) => {
    // The check-out band that follows this check-in band, wrapping round for a
    // night shift whose clock-out band sits early the next morning.
    const outBand = outs[index] ?? outs[outs.length - 1];
    return {
      source: 'device',
      confidence: 'bands',
      name: nameForStart(inBand.from, index),
      // The earliest clock-in is the outer bound, not the start. Said plainly
      // in `note`, because a number offered without its caveat gets accepted.
      starts_at: inBand.from,
      ends_at: outBand.to,
      window: { in: inBand, out: outBand },
      note: 'From the terminal\'s attendance bands. These are the times a tap is '
        + 'accepted between, so the real shift usually starts a little later and '
        + 'ends a little earlier.',
    };
  });
}

// ---------------------------------------------------------------------------
// What people actually do
// ---------------------------------------------------------------------------

const BUCKET = 30;   // minutes a cluster is keyed on
const ROUND = 5;     // minutes the final suggestion is rounded to

/**
 * Work the shifts out from the punches themselves.
 *
 * No API, no key, no permission from anybody — just the times a few hundred
 * people have already clocked in and out at. For any property that has been
 * running the terminal for a fortnight this is the most accurate source
 * available, and it is the only one that keeps working when a firmware update
 * moves an endpoint.
 *
 * Each person-day contributes one arrival and one departure. Those are bucketed
 * to the half hour, the buckets with real support become candidates, and the
 * suggested times are the median of each cluster rather than the bucket edge —
 * a shift that starts at 06:00 shows people arriving at 05:52, and the median
 * says 05:52 while the bucket says 05:30.
 */
export function inferShifts(pairs, { minSupport = 5, maxShifts = 6 } = {}) {
  const clusters = new Map();

  for (const pair of pairs) {
    const start = toMinutes(pair.in);
    let end = toMinutes(pair.out);
    if (start == null || end == null) continue;
    // A departure before the arrival crossed midnight.
    if (end <= start) end += 1440;
    const length = end - start;
    // Guard against a pairing that is obviously not one shift.
    if (length < 60 || length > 16 * 60) continue;

    const key = `${Math.round(start / BUCKET)}|${Math.round(end / BUCKET)}`;
    if (!clusters.has(key)) clusters.set(key, { starts: [], ends: [] });
    clusters.get(key).starts.push(start);
    clusters.get(key).ends.push(end);
  }

  const candidates = [];
  for (const cluster of clusters.values()) {
    if (cluster.starts.length < minSupport) continue;
    const start = round(median(cluster.starts), ROUND);
    const end = round(median(cluster.ends), ROUND);
    candidates.push({
      source: 'punches',
      confidence: 'observed',
      support: cluster.starts.length,
      starts_at: toClock(start),
      ends_at: toClock(end),
      // The median length, less nothing — a break is a policy, not something
      // the punches can see, so it is left at zero for a person to set.
      lengthMinutes: end - start,
    });
  }

  candidates.sort((a, b) => b.support - a.support);
  return candidates.slice(0, maxShifts)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .map((c, index) => ({
      ...c,
      name: nameForStart(c.starts_at, index),
      note: `${c.support} day${c.support === 1 ? '' : 's'} of punches fall in this pattern.`,
    }));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function round(minutes, to) {
  return Math.round(minutes / to) * to;
}

/** A name somebody will recognise, rather than "Shift 1". */
function nameForStart(time, index) {
  const start = toMinutes(time) ?? 0;
  if (start >= 20 * 60 || start < 4 * 60) return 'Night';
  if (start < 11 * 60) return 'Morning';
  if (start < 16 * 60) return 'Afternoon';
  return 'Evening';
}

// ---------------------------------------------------------------------------
// Putting the two together
// ---------------------------------------------------------------------------

/**
 * One list of suggestions, best evidence first.
 *
 * Where the terminal's bands and the observed punches describe the same shift,
 * they are merged: the observed times win, because they are what actually
 * happens, and the band is kept alongside as corroboration. A band with no
 * punches behind it is still offered — it is how a shift nobody has worked yet
 * gets set up — and a punch cluster with no band is offered too, which is the
 * normal case for a terminal that was never put into attendance mode.
 */
export function mergeCandidates({ fromDevice = [], fromPunches = [] } = {}) {
  const out = [];
  const claimed = new Set();

  for (const observed of fromPunches) {
    const start = toMinutes(observed.starts_at);
    const band = fromDevice.find((d, i) => {
      if (claimed.has(i)) return false;
      const bandStart = toMinutes(d.window?.in?.from ?? d.starts_at);
      const bandEnd = toMinutes(d.window?.in?.to ?? d.ends_at);
      if (bandStart == null || bandEnd == null) return false;
      // Sits inside the band the device would have labelled it with.
      return bandEnd >= bandStart
        ? start >= bandStart && start <= bandEnd
        : start >= bandStart || start <= bandEnd;
    });

    if (band) claimed.add(fromDevice.indexOf(band));
    out.push({
      ...observed,
      name: band?.name ?? observed.name,
      confirmedByDevice: Boolean(band),
      deviceWindow: band?.window ?? null,
      note: band
        ? `${observed.note} The terminal accepts clock-ins for this shift between `
          + `${band.window.in.from} and ${band.window.in.to}.`
        : observed.note,
    });
  }

  fromDevice.forEach((band, index) => {
    if (claimed.has(index)) return;
    out.push({ ...band, support: 0, confirmedByDevice: true, deviceWindow: band.window });
  });

  return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/**
 * The shift row a suggestion becomes, with everything the terminal cannot know
 * left at a sensible default for a person to change.
 *
 * Grace, breaks and what counts as a full day are policy. No device holds them
 * and no punch reveals them, so they arrive as defaults and are the one part of
 * the form still worth reading.
 */
export function toShiftRow(candidate) {
  const start = toMinutes(candidate.starts_at) ?? 0;
  let end = toMinutes(candidate.ends_at) ?? 0;
  if (end <= start) end += 1440;
  const length = end - start;

  return {
    name: candidate.name,
    startsAt: candidate.starts_at,
    endsAt: candidate.ends_at,
    breakMinutes: 0,
    graceIn: 5,
    graceOut: 5,
    overtimeAfter: 0,
    // Half the rostered length, and most of it, rounded to the half hour. A
    // property that pays differently changes them; a property that has never
    // thought about it gets an answer that is not absurd.
    halfDayMinutes: round(length / 2, 30),
    fullDayMinutes: round(length * 0.9, 30),
    active: true,
  };
}
