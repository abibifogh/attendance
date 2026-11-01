/**
 * Putting ASSD's card and MoMo payments against the money that actually
 * arrived, shift by shift, and saying plainly what does not agree.
 *
 * Everything in here is pure: shifts, events and declines in, the same shifts
 * with their matches and a list of exceptions out. The routes load and store;
 * this decides.
 *
 * **Where a shift sits in the day.** ASSD has no clock, only an order, and the
 * hand-over marker's date is unreliable at night (the night's marker is often
 * dated the next morning). So each shift is placed on a slot — morning 06–14,
 * afternoon 14–22, night 22–06, a night belonging to the day it starts — by
 * two kinds of evidence at once: the terminal's clock, for any card payment
 * whose amount is unique enough to identify it, and the marker's date. The
 * slots must follow each other; a skipped slot (one person working a double,
 * or a missing marker) costs something but is allowed. The best-scoring path
 * through all of that is the answer.
 *
 * **Matching**, in the order a person would try it:
 * 1. one ASSD line, one payment, same amount, inside the shift's hours — then
 *    the same with ninety minutes' grace either side, for late hand-overs;
 * 2. two or three ASSD lines paid as one (a guest settling two rooms at once);
 * 3. one ASSD line paid in two to four goes within forty-five minutes (a card
 *    that hit its limit and the rest on MoMo);
 * 4. for days the terminal report does not cover, the bank's settled card
 *    rows, by day and amount.
 *
 * **Exceptions**, for whatever is left, most serious first. The ones a person
 * must chase are the failed-but-paid, the payment not found and the double
 * charge; next the keying slips and the money received that ASSD never heard
 * of; last the ones the matcher could explain by itself, shown so the
 * explanation can be checked rather than taken on trust.
 */

export const SLOTS = ['morning', 'afternoon', 'night'];
const SLOT_START = [6 * 60, 14 * 60, 22 * 60];
const SLOT_MINUTES = 8 * 60;

/** Grace either side of a shift's hours, for hand-overs that run late. */
export const TOLERANCE_MINUTES = 90;
/** How far from the payments around it a larger payment may be and still be the guest's. */
export const PAID_MORE_MINUTES = 30;
/** A paid-more (or paid-less) pair's key: its shift and its ASSD line, so it can be found by day. */
export const paidMoreKey = (s, line, kind = 'paid-more') => `${kind}:${s.day}:${s.slotName}:${line.key}`;
/** How far apart the parts of one split payment can be. */
const SPLIT_MINUTES = 45;
/** How close two charges to the same card have to be to look like one charge twice. */
const DOUBLE_MINUTES = 30;
/** How long a card payment may take to reach the bank before its absence is a finding. */
export const SETTLE_DAYS = 6;
/** How many open lines, and how many payments, are tried in every combination. */
export const COMBINE_LINES = 24;
export const COMBINE_PARTS = 20;

// ------------------------------------------------------------------ time --

const DAY_MS = 86400000;

/** `YYYY-MM-DD` → whole days since 1970. */
export function dayNumber(day) {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

export function dayOf(number) {
  return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD HH:MM:SS` → minutes since 1970. Accra is UTC, so no zone. */
export function minuteOf(at) {
  if (!at) return null;
  const ms = Date.parse(`${String(at).replace(' ', 'T').slice(0, 19)}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 60000) : null;
}

export function clock(minute) {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A slot is a whole number: three per day, morning first. */
export const slotIndex = (day, slot) => dayNumber(day) * 3 + slot;
export const slotDay = (t) => dayOf(Math.floor(t / 3));
export const slotName = (t) => SLOTS[((t % 3) + 3) % 3];

/** The slot a moment falls in. Before 06:00 is the previous day's night. */
export function slotAt(minute) {
  const day = Math.floor(minute / 1440);
  const m = minute - day * 1440;
  if (m < SLOT_START[0]) return (day - 1) * 3 + 2;
  if (m < SLOT_START[1]) return day * 3;
  if (m < SLOT_START[2]) return day * 3 + 1;
  return day * 3 + 2;
}

/** The hours of a run of slots, `[start, end)` in minutes. */
export function hoursOf(first, last = first) {
  const start = Math.floor(first / 3) * 1440 + SLOT_START[first % 3];
  const end = Math.floor(last / 3) * 1440 + SLOT_START[last % 3] + SLOT_MINUTES;
  return { start, end };
}

// ----------------------------------------------------------------- slots --

/** Whether an ASSD login looks like a person's name in HIVE: "AMA" and "Ama Mensah". */
export function sameLogin(assd, name) {
  const a = String(assd || '').trim().toLowerCase();
  const n = String(name || '').trim().toLowerCase();
  return Boolean(a && n && (n === a || n.split(/\s+/).includes(a) || n.startsWith(`${a} `)));
}

/** What a share of one slot costs: only taken when the evidence asks for it. */
const SHARE = -1.5;

/**
 * Put every ASSD session on a slot.
 *
 * `shifts` are the sessions in ASSD order (one per hand-over), each with
 * `markerDate` and `cards`; `events` are payments with an exact time.
 * Returns, per session, `{ slot, last }` — `last` is later than `slot` only
 * when the next session starts more than one slot on, and this one is taken
 * to have covered the gap.
 *
 * Two sessions can share a slot: somebody logging in for a minute in another
 * person's shift, or a hand-over in the middle of a night. It costs a little,
 * so it is only chosen when the evidence asks for it. `signed(session, slot)`
 * weighs that slot's closing report in HIVE against the session: whether the
 * person who signed it is the person on this login, and whether the drawer
 * they counted is what this session closed on.
 */
export function placeShifts(shifts, events, { signed = null, pinned = null } = {}) {
  // The journal alone first. Only where it cannot be placed one session to a
  // slot (a session has to share one, or a marker is days out) are the HIVE
  // reports asked, and their answer is taken only for each run of sessions
  // that moves together with that place: everywhere else, every session stays
  // where the journal alone puts it. A report filed on the wrong shift must
  // not drag a journal that fits on its own, or "filed on the wrong shift"
  // could never be seen.
  const alone = place(shifts, events, null, pinned);
  if (!signed || !alone.trouble.length) return alone.places;
  const asked = place(shifts, events, signed, pinned).places;
  const out = alone.places.map((p) => p.slot);
  for (let i = 0; i < out.length;) {
    if (asked[i].slot === alone.places[i].slot) { i += 1; continue; }
    let j = i;
    while (j + 1 < out.length && asked[j + 1].slot !== alone.places[j + 1].slot) j += 1;
    // Both agree either side of the run, so it slots in between.
    if (alone.trouble.some((k) => k >= i - 1 && k <= j + 1)) for (let k = i; k <= j; k += 1) out[k] = asked[k].slot;
    i = j + 1;
  }
  return out.map((t, i) => ({ slot: t, last: out[i + 1] === t + 2 ? t + 1 : t }));
}

function place(shifts, events, signed, pinned = null) {
  if (!shifts.length) return { places: [], trouble: [] };
  const trouble = [];
  const timed = events.filter((e) => e.minute != null);
  const byAmount = new Map();
  for (const e of timed) {
    if (!byAmount.has(e.amount)) byAmount.set(e.amount, []);
    byAmount.get(e.amount).push(e);
  }

  const options = shifts.map((shift) => {
    // Put on its day and slot by an admin: there, whatever the rest says.
    if (pinned?.has(shift.startSeq)) return [{ t: pinned.get(shift.startSeq), score: 0 }];
    const d = dayNumber(shift.markerDate);
    // A payment that is the only one of its amount within a day of the ASSD
    // line is strong evidence of where the shift sat.
    const votes = new Map();
    for (const line of shift.cards) {
      if (line.amount <= 0) continue;
      const ld = dayNumber(line.date);
      const near = (byAmount.get(line.amount) || []).filter((e) => Math.abs(Math.floor(e.minute / 1440) - ld) <= 1);
      if (near.length === 1) {
        const t = slotAt(near[0].minute);
        votes.set(t, (votes.get(t) || 0) + 1);
      }
    }
    // The marker's date: mornings and afternoons carry their own day; a night
    // usually carries the next morning's, sometimes its own.
    const marker = new Map([[d * 3, 1], [d * 3 + 1, 1], [(d - 1) * 3 + 2, 1], [d * 3 + 2, 0.5]]);
    // The closing report in HIVE, near the marker's date.
    const reported = new Map();
    if (signed) for (let t = d * 3 - 3; t <= d * 3 + 5; t += 1) { const w = signed(shift, t); if (w) reported.set(t, w); }
    const candidates = new Set([...marker.keys(), ...votes.keys(), ...reported.keys()]);
    return [...candidates].map((t) => ({ t, score: 2 * (votes.get(t) || 0) + (marker.get(t) || 0) + (reported.get(t) || 0) }));
  });

  const step = (gap) => {
    if (gap === 0) return SHARE;
    if (gap === 1) return 0;
    if (gap === 2) return -2;
    if (gap === 3) return -3.5;
    if (gap > 3) return -5;
    return -Infinity;
  };

  // Viterbi over the candidates.
  let best = options[0].map((o) => ({ t: o.t, total: o.score, back: null }));
  const trail = [best];
  for (let i = 1; i < options.length; i += 1) {
    const next = options[i].map((o) => {
      let pick = null;
      for (const prev of best) {
        const total = prev.total + step(o.t - prev.t) + o.score;
        if (total > -Infinity && (!pick || total > pick.total)) pick = { t: o.t, total, back: prev };
      }
      return pick || { t: o.t, total: -Infinity, back: null };
    });
    // A shift whose every candidate is behind the previous one (a marker
    // dated days early) is placed straight after the previous shift.
    if (next.every((n) => n.total === -Infinity)) {
      trouble.push(i);
      const prev = best.reduce((a, b) => (b.total > a.total ? b : a));
      next.push({ t: prev.t + 1, total: prev.total - 4, back: prev });
    }
    best = next.filter((n) => n.total > -Infinity);
    trail.push(best);
  }
  let node = best.reduce((a, b) => (b.total > a.total ? b : a));
  const placed = [];
  while (node) { placed.unshift(node.t); node = node.back; }

  placed.forEach((t, i) => { if (i && t === placed[i - 1]) trouble.push(i - 1, i); });
  return {
    trouble,
    places: placed.map((t, i) => {
      const next = placed[i + 1];
      // One missing slot between two shifts is most likely this person working
      // on through it. More than one is a gap in what was loaded.
      const last = next === t + 2 ? t + 1 : t;
      return { slot: t, last };
    }),
  };
}

// -------------------------------------------------------------- matching --

const sum = (list, get = (x) => x.amount) => list.reduce((s, x) => s + get(x), 0);

function* combinations(list, k, start = 0, picked = []) {
  if (picked.length === k) { yield picked; return; }
  for (let i = start; i <= list.length - (k - picked.length); i += 1) {
    yield* combinations(list, k, i + 1, [...picked, list[i]]);
  }
}

/** Two amounts in pesewas, written the way a person would type them. */
const typed = (amount) => (amount % 100 === 0 ? String(Math.abs(amount) / 100) : (Math.abs(amount) / 100).toFixed(2));

/** The same digits in a different order. */
export function isTransposition(a, b) {
  if (a === b || Math.abs(a - b) < 100) return false;
  const x = typed(a).replace('.', '').split('').sort().join('');
  const y = typed(b).replace('.', '').split('').sort().join('');
  return x === y;
}

/** A factor of ten: a decimal point in the wrong place, or a nought too many. */
export function isDecimalSlip(a, b) {
  return a === b * 10 || b === a * 10;
}

/** Exactly one digit different, same length. */
export function isOneDigitOff(a, b) {
  const x = typed(a);
  const y = typed(b);
  if (x.length !== y.length || x === y) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) diff += 1;
  return diff === 1;
}

/**
 * The whole reconciliation.
 *
 * @param shifts   segment(...).shifts, in ASSD order
 * @param events   payments that arrived: `{ id, kind: 'card'|'momo', amount,
 *                 at?: 'YYYY-MM-DD HH:MM:SS', day?, last4?, first6?, source }`
 *                 — a card from the terminal has `at`; a card known only from
 *                 the bank has `day` and no `at`
 * @param declines terminal attempts that were not approved, with `at`
 * @param options  `{ open: true }` when the last shift is cut off by the end
 *                 of the export
 */
export function reconcile(shifts, events, declines = [], options = {}) {
  const tolerance = options.tolerance ?? TOLERANCE_MINUTES;
  // Pairs somebody said are not one payment, by their paid-more key.
  const notSame = new Set(options.notSame || []);
  const evs = events.map((e) => ({ ...e, minute: minuteOf(e.at), by: null }));
  const decl = declines.map((d) => ({ kind: 'card', ...d, minute: minuteOf(d.at) }));
  const timed = evs.filter((e) => e.minute != null);
  const dated = evs.filter((e) => e.minute == null);

  // Placed already (sessions sharing a slot made one), or placed here.
  const places = options.places || placeShifts(shifts, evs, { signed: options.signed, pinned: options.pinned });
  const out = shifts.map((shift, i) => {
    const { slot, last } = places[i];
    const { start, end } = hoursOf(slot, last);
    return {
      ...shift,
      index: i,
      slot,
      day: slotDay(slot),
      slotName: slotName(slot),
      double: last !== slot,
      open: Boolean(options.open) && i === shifts.length - 1,
      window: { start, end, from: start - tolerance, to: end + tolerance },
      lines: shift.cards.map((c, n) => ({ ...c, key: `${c.seq}:${n}`, events: [], how: null, exception: null })),
    };
  });

  const free = (e) => e.by === null;
  const inside = (e, s, core) => (core
    ? e.minute >= s.window.start && e.minute < s.window.end
    : e.minute >= s.window.from && e.minute < s.window.to);
  const claim = (line, list, how) => {
    for (const e of list) e.by = line.key;
    line.events = list;
    line.how = how;
  };

  // 1. One for one: inside the hours first, everywhere, before any grace.
  for (const core of [true, false]) {
    for (const s of out) {
      for (const line of s.lines) {
        if (line.events.length || line.amount <= 0) continue;
        const found = timed.filter((e) => free(e) && e.amount === line.amount && inside(e, s, core));
        if (found.length) claim(line, [found.reduce((a, b) => (b.minute < a.minute ? b : a))], core ? 'exact' : 'late');
      }
    }
  }

  // 2. Several lines, one payment. Only so many can be tried in every
  // combination; a shift with more is said to have been cut short.
  for (const s of out) {
    for (const k of [2, 3]) {
      const all = s.lines.filter((l) => !l.events.length && l.amount > 0);
      if (all.length > COMBINE_LINES) s.searchCut = { ...(s.searchCut || {}), lines: all.length };
      const open = all.slice(0, COMBINE_LINES);
      for (const combo of combinations(open, k)) {
        if (combo.some((l) => l.events.length)) continue;
        const total = sum(combo);
        const e = timed.find((x) => free(x) && x.amount === total && inside(x, s, false));
        if (!e) continue;
        e.by = combo[0].key;
        for (const l of combo) { l.events = [e]; l.how = 'together'; l.together = combo.map((c) => c.key); }
      }
    }
  }

  // 3. One line, several payments close together.
  for (const s of out) {
    for (const line of s.lines) {
      if (line.events.length || line.amount <= 0) continue;
      const near = timed
        .filter((e) => free(e) && e.amount < line.amount && inside(e, s, false))
        .sort((a, b) => a.minute - b.minute);
      if (near.length > COMBINE_PARTS) s.searchCut = { ...(s.searchCut || {}), payments: near.length };
      const parts = near.slice(0, COMBINE_PARTS);
      let done = false;
      for (const k of [2, 3, 4]) {
        for (const combo of combinations(parts, k)) {
          if (combo[combo.length - 1].minute - combo[0].minute > SPLIT_MINUTES) continue;
          if (sum(combo) !== line.amount) continue;
          claim(line, combo, 'parts');
          done = true;
          break;
        }
        if (done) break;
      }
    }
  }

  // 4. Days the terminal does not cover: the bank's card rows, by day.
  for (const s of out) {
    // The bank dates an early-morning card to the day before (a card tapped
    // at 07:43 on the 1st settles as the 31st), and a night runs into the
    // next day.
    const days = new Set([s.day]);
    if (s.slotName === 'morning') days.add(dayOf(dayNumber(s.day) - 1));
    if (s.slotName === 'night' || s.double) days.add(dayOf(dayNumber(s.day) + 1));
    for (const line of s.lines) {
      if (line.events.length || line.amount <= 0) continue;
      const e = dated.find((x) => free(x) && x.amount === line.amount && days.has(x.day));
      if (e) claim(line, [e], 'by-day');
    }
  }

  // ------------------------------------------------------------ exceptions
  const exceptions = [];
  const raise = (kind, s, line, event, extra = {}) => {
    const x = {
      key: line ? `${kind}:${line.key}` : `${kind}:${event?.id}`,
      kind,
      group: GROUP[kind],
      severity: SEVERITY[kind],
      day: s?.day ?? null,
      slot: s?.slotName ?? null,
      user: s?.user ?? null,
      seq: line?.seq ?? null,
      amount: line ? line.amount : event?.amount,
      event: event ? publicEvent(event) : null,
      ...extra,
    };
    exceptions.push(x);
    if (line) line.exception = x.kind;
    return x;
  };
  const unexplained = (s) => s.lines.filter((l) => !l.events.length && !l.exception);

  for (const s of out) {
    // Matched only because the amounts add up (lines paid together, or a line
    // paid in parts): probable, not certain, until somebody confirms it.
    const seen = new Set();
    for (const line of s.lines.filter((l) => ['together', 'parts'].includes(l.how))) {
      const id = line.how === 'together' ? (line.together || []).join('+') : line.key;
      if (seen.has(id)) continue;
      seen.add(id);
      const lines = line.how === 'together' ? s.lines.filter((l) => (line.together || []).includes(l.key)) : [line];
      exceptions.push({
        key: `probable:${line.key}`, kind: 'probable', group: GROUP.probable, severity: SEVERITY.probable,
        day: s.day, slot: s.slotName, user: s.user, seq: line.seq, how: line.how,
        amount: sum(lines), lines: lines.map((l) => l.amount), seqs: lines.map((l) => l.seq), events: line.events.map(publicEvent), event: null,
      });
    }
    // More open lines or payments than every combination could be tried for.
    if (s.searchCut) {
      exceptions.push({
        key: `search-cut:${s.day}:${s.slotName}`, kind: 'search-cut', group: GROUP['search-cut'], severity: SEVERITY['search-cut'],
        day: s.day, slot: s.slotName, user: s.user, amount: null, event: null, ...s.searchCut,
      });
    }
    // Nothing to match, and a refund.
    for (const line of s.lines) {
      if (line.amount === 0) raise('zero', s, line, null);
    }
    for (const line of s.lines.filter((l) => l.amount < 0 && !l.exception)) {
      const twin = s.lines.find((l) => l.amount === -line.amount && !l.events.length && !l.exception);
      if (twin) {
        raise('corrected', s, line, null, { pair: twin.seq });
        twin.exception = 'corrected';
        twin.how = 'corrected';
        continue;
      }
      raise('refund', s, line, null);
    }

    // Declined on the terminal and never approved, yet recorded as paid.
    for (const line of unexplained(s).filter((l) => l.amount > 0)) {
      const tried = decl.filter((d) => d.amount === line.amount && d.minute != null
        && d.minute >= s.window.from - 24 * 60 && d.minute < s.window.to);
      if (!tried.length) continue;
      const first = tried.reduce((a, b) => (b.minute < a.minute ? b : a));
      const approvedAfter = timed.some((e) => e.amount === line.amount && e.minute >= first.minute && e.minute - first.minute <= 120);
      if (!approvedAfter) raise('failed', s, line, first);
    }

    // The same money, cut up differently.
    const lines = unexplained(s).filter((l) => l.amount > 0);
    const left = timed.filter((e) => free(e) && inside(e, s, false));
    if (lines.length && left.length && (lines.length > 1 || left.length > 1) && sum(lines) === sum(left)) {
      for (const e of left) e.by = 'regrouped';
      // One exception for the whole set: it is one explanation, not several.
      raise('regrouped', s, lines[0], null, {
        amount: sum(lines), lines: lines.map((x) => x.amount), seqs: lines.map((x) => x.seq), events: left.map(publicEvent),
      });
      for (const l of lines) { l.how = 'regrouped'; l.events = left; l.exception = 'regrouped'; }
    }
  }

  // Keyed on a different shift from the one that took the money — a guest who
  // paid at check-in and was keyed at check-out, or a hand-over that ran on.
  // Only the same amount, only within a day, and the nearest one.
  for (const s of out) {
    for (const line of unexplained(s).filter((l) => l.amount > 0)) {
      const near = timed.filter((x) => free(x) && x.amount === line.amount && !inside(x, s, false)
        && x.minute >= s.window.from - 24 * 60 && x.minute < s.window.to + 24 * 60);
      // Only when it is the one payment of that amount within a day either
      // side: with two or more, which is the guest's is a guess, and the line
      // stays "not found" and the payments "not recorded" for a person to pair.
      if (near.length !== 1) continue;
      const e = near[0];
      const other = out.find((o) => e.minute >= o.window.start && e.minute < o.window.end) || null;
      e.by = line.key;
      line.events = [e];
      raise('other-shift', s, line, e, {
        otherShift: other ? { day: other.day, slot: other.slotName, user: other.user } : null,
      });
    }
  }

  // A guest who paid more, or less, than ASSD shows: ASSD has a card or MoMo
  // line no payment matched, and a larger or smaller one arrived that ASSD
  // does not show. Less is critical: money ASSD counts as taken never came.
  // A line with a larger and a smaller payment near it is neither. ASSD
  // has no clock and calls card and MoMo alike, so the pair is found by place:
  // the same shift, inside its own hours, within half an hour of the payments
  // matched to the lines keyed just before and after it, and the only such
  // pair either way. A decimal in the wrong place or swapped digits stay
  // keying slips. "Not the same payment" keeps a pair apart.
  for (const s of out) {
    if (s.open) continue;
    const clocked = s.lines.filter((l) => l.events.length === 1 && l.events[0].minute != null);
    const near = (line) => {
      const before = clocked.filter((l) => l.seq < line.seq).sort((a, b) => b.seq - a.seq)[0];
      const after = clocked.filter((l) => l.seq > line.seq).sort((a, b) => a.seq - b.seq)[0];
      const a = before ? before.events[0].minute : s.window.start;
      const b = after ? after.events[0].minute : s.window.end;
      return { from: Math.min(a, b) - PAID_MORE_MINUTES, to: Math.max(a, b) + PAID_MORE_MINUTES };
    };
    const pairs = [];
    const open = unexplained(s).filter((l) => l.amount > 0);
    // Better explained otherwise: a line keyed twice (another of its amount
    // was paid), and a payment that is a slip of any line still open.
    const twice = (line) => s.lines.some((l) => l !== line && l.amount === line.amount && l.events.length);
    const slipOfAny = (e) => open.some((l) => isDecimalSlip(l.amount, e.amount) || isTransposition(l.amount, e.amount));
    for (const line of open.filter((l) => !twice(l))) {
      const w = near(line);
      for (const e of timed) {
        if (!free(e) || !inside(e, s, true) || e.amount <= 0 || e.amount === line.amount || e.minute < w.from || e.minute > w.to) continue;
        if (slipOfAny(e)) continue;
        const kind = e.amount > line.amount ? 'paid-more' : 'paid-less';
        const key = paidMoreKey(s, line, kind);
        if (notSame.has(key)) continue;
        pairs.push({ line, e, key, kind });
      }
    }
    for (const p of pairs) {
      if (pairs.filter((q) => q.line === p.line).length !== 1 || pairs.filter((q) => q.e === p.e).length !== 1) continue;
      p.e.by = p.line.key;
      p.line.events = [p.e];
      p.line.how = p.kind;
      raise(p.kind, s, p.line, p.e, { key: p.key, amount: Math.abs(p.e.amount - p.line.amount), assd: p.line.amount, paid: p.e.amount });
    }
  }

  // Slips of the finger.
  for (const s of out) {
    for (const line of unexplained(s).filter((l) => l.amount > 0)) {
      const near = timed.filter((e) => free(e) && inside(e, s, false));
      const tests = [['transposition', isTransposition], ['decimal', isDecimalSlip], ['keying', isOneDigitOff]];
      for (const [kind, test] of tests) {
        const e = near.find((x) => test(line.amount, x.amount));
        if (!e) continue;
        e.by = line.key;
        line.events = [e];
        raise(kind, s, line, e, { difference: line.amount - e.amount });
        break;
      }
    }
  }

  // What is left on the ASSD side.
  for (const s of out) {
    for (const line of unexplained(s).filter((l) => l.amount > 0)) {
      const again = s.lines.find((l) => l !== line && l.amount === line.amount && l.events.length);
      if (again) raise('duplicate', s, line, null, { pair: again.seq });
      else raise('not-found', s, line, null);
    }
  }

  // What is left on the money side, inside the hours the loaded shifts cover.
  const first = out[0];
  const lastShift = out[out.length - 1];
  // A payment an admin moved to another shift goes there (`options.homes`:
  // event id → { day, slot }), whatever its time says.
  const movedTo = (e) => {
    const m = options.homes?.get(e.id);
    return m ? out.find((s) => s.day === m.day && s.slotName === m.slot) || null : null;
  };
  for (const e of timed.filter(free)) {
    if (!first || e.minute < first.window.start || e.minute >= lastShift.window.end) continue;
    const home = movedTo(e) || out.find((s) => e.minute >= s.window.start && e.minute < s.window.end)
      || out.find((s) => inside(e, s, false)) || null;
    // The journal stops somewhere inside its last shift, so money that shift
    // took after the export ran is not missing from ASSD.
    if (home?.open) continue;
    const twin = e.last4 && timed.find((x) => x !== e && x.kind === 'card' && x.last4 === e.last4
      && x.first6 === e.first6 && x.amount === e.amount && Math.abs(x.minute - e.minute) <= DOUBLE_MINUTES);
    if (twin) raise('double-charge', home, null, e, { twin: publicEvent(twin), minutesApart: Math.abs(twin.minute - e.minute) });
    else raise('not-recorded', home, null, e);
  }
  for (const e of dated.filter(free)) {
    const home = movedTo(e) || out.find((s) => s.day === e.day) || null;
    if (!home || home.open) continue;
    raise('not-recorded', home, null, e);
  }

  // Nothing on the last, cut-off shift is "not found" for certain: say so.
  for (const x of exceptions) {
    const s = out.find((sh) => sh.day === x.day && sh.slotName === x.slot);
    if (s?.open && x.kind === 'not-found') x.severity = 'warning';
  }

  return {
    shifts: out.map(({ cards, ...s }) => ({
      ...s,
      lines: s.lines.map((l) => ({ ...l, events: l.events.map(publicEvent) })),
    })),
    exceptions,
  };
}

function publicEvent(e) {
  if (!e) return null;
  return {
    id: e.id,
    kind: e.kind,
    amount: e.amount,
    at: e.at || null,
    day: e.day || (e.at ? String(e.at).slice(0, 10) : null),
    last4: e.last4 || null,
    approval: e.approval || null,
    status: e.status || null,
    source: e.source || null,
    exact: e.minute != null ? e.exact !== false : false,
  };
}

// ------------------------------------------------------------ settlement --

/**
 * Did each approved card payment reach the bank, and did the bank receive
 * anything the terminal never took?
 *
 * Joined on the approval code and the last four digits, which is the pair
 * both sides print; failing that, on card, amount and day. Checked only where
 * both files cover the ground — a payment from last week cannot be "never
 * settled" on a statement that ends yesterday.
 *
 * @param approved  terminal rows, approved, `{ rrn, at, amount, last4, approval }`
 * @param bankCards bank rows of kind card or card-reversal
 * @param cover     `{ terminal: Set<day>, bankTo: 'YYYY-MM-DD' | null }`
 */
export function settlement(approved, bankCards, cover) {
  const credits = bankCards.filter((b) => b.kind === 'card');
  const taken = new Set();
  const settled = new Map();
  const norm = (v) => String(v || '').trim().toUpperCase();

  for (const t of approved) {
    let hit = credits.find((b) => !taken.has(b.id) && b.last4 === t.last4 && norm(b.approval) === norm(t.approval) && b.amount === t.amount);
    if (!hit) {
      hit = credits.find((b) => !taken.has(b.id) && b.last4 === t.last4 && b.amount === t.amount
        && Math.abs(dayNumber(b.cardDay || b.day) - dayNumber(t.at.slice(0, 10))) <= 1);
    }
    if (hit) { taken.add(hit.id); settled.set(t.rrn, hit); }
  }

  const exceptions = [];
  if (cover.bankTo) {
    for (const t of approved) {
      if (settled.has(t.rrn)) continue;
      const day = t.at.slice(0, 10);
      if (dayNumber(cover.bankTo) - dayNumber(day) < SETTLE_DAYS) continue;
      exceptions.push({
        key: `never-settled:${t.rrn}`,
        kind: 'never-settled', group: GROUP['never-settled'], severity: SEVERITY['never-settled'],
        day, amount: t.amount,
        event: { id: `t:${t.rrn}`, kind: 'card', amount: t.amount, at: t.at, day, last4: t.last4, approval: t.approval, source: 'terminal', exact: true },
      });
    }
  }
  for (const b of credits) {
    if (taken.has(b.id)) continue;
    const day = b.cardDay || b.day;
    if (!cover.terminal.has(day)) continue;
    exceptions.push({
      key: `bank-only:${b.id}`,
      kind: 'bank-only', group: GROUP['bank-only'], severity: SEVERITY['bank-only'],
      day, amount: b.amount,
      event: { id: `b:${b.id}`, kind: 'card', amount: b.amount, at: null, day, last4: b.last4, approval: b.approval, source: 'bank', exact: false },
    });
  }
  for (const b of bankCards.filter((x) => x.kind === 'card-reversal')) {
    exceptions.push({
      key: `reversal:${b.id}`,
      kind: 'reversal', group: GROUP.reversal, severity: SEVERITY.reversal,
      day: b.day, amount: -b.amount,
      event: { id: `b:${b.id}`, kind: 'card', amount: -b.amount, at: null, day: b.cardDay || b.day, last4: b.last4, approval: b.approval, source: 'bank', exact: false },
    });
  }
  return { settled, exceptions };
}

// --------------------------------------------------------------- labels --

/** How the exceptions are grouped on screen, most serious first. */
export const GROUPS = [
  { id: 'failed', title: 'Recorded as paid, but the payment failed', severity: 'critical',
    help: 'The terminal declined these and never approved the same amount afterwards, yet ASSD has them as paid by card. The guest may have left without paying.' },
  { id: 'missing', title: 'Recorded as card or MoMo, no payment found', severity: 'critical',
    help: 'ASSD says card or MoMo; no approved card, no MoMo receipt and no bank credit of that amount anywhere near the shift.' },
  { id: 'paidless', title: 'A guest paid less than ASSD shows', severity: 'critical',
    help: 'A card or MoMo line no payment matched, and a smaller payment on the same shift, near where the line was keyed, that ASSD does not show: one payment, less than ASSD counts as taken. The guest owes the rest, paid it another way, or ASSD was keyed too high.' },
  { id: 'double', title: 'The same card charged twice', severity: 'critical',
    help: 'Two approved charges to one card for the same amount within half an hour, and only one in ASSD. The guest is owed a refund, or ASSD is missing a payment.' },
  { id: 'drawer', title: 'The drawer did not agree with its count', severity: 'critical',
    help: 'Opening count, plus the cash taken, less what was moved out, against the count at the end of the shift — ASSD’s own counts unless somebody typed a recount. Also listed: a hand-over where the next person’s first count differed from the last person’s closing count.' },
  { id: 'unlabelled', title: 'Cash moved out of the drawer with no label', severity: 'warning',
    help: 'A Cash Movement out of the front drawer that no count labelled as expenses or the safe, on a shift with no expense sheet to settle it. Say where each one went.' },
  { id: 'nopo', title: 'Expenses and their POs', severity: 'warning',
    help: 'Cash paid out of the drawer as expenses with no PO (none on the closing report in HIVE, none linked in Insight), or whose POs in Odoo add up to a different amount. Link the right PO on the shift, or answer why.' },
  { id: 'laundry', title: 'The laundry did not agree with the laundry system', severity: 'warning',
    help: 'Every shift, the laundry ASSD has against what the laundry system took in the same hours (06:00–14:00, 14:00–22:00, 22:00–06:00). Compared once the laundry system has been read for the whole shift.' },
  { id: 'keying', title: 'Keying slips: transposed digits, one digit off, a decimal in the wrong place', severity: 'warning',
    help: 'The terminal took one amount and ASSD records a slightly different one. The difference is real money on one side or the other.' },
  { id: 'paidmore', title: 'A guest paid more than ASSD shows', severity: 'warning',
    help: 'A card or MoMo line no payment matched, and a larger payment on the same shift, near where the line was keyed, that ASSD does not show: one payment, more than ASSD has. Owed back, a deposit for later, or keyed short.' },
  { id: 'duplicate', title: 'Keyed twice in ASSD', severity: 'warning',
    help: 'The same amount recorded twice in the shift, paid once.' },
  { id: 'unrecorded', title: 'Money received that ASSD does not show', severity: 'warning',
    help: 'Approved on the terminal or received by MoMo during the shift, and not in ASSD. A deposit for a later stay, a payment keyed as cash, or an omission.' },
  { id: 'settlement', title: 'Did not reach the bank, or went back out', severity: 'warning',
    help: 'Approved card payments with no bank credit after six days, card reversals, and refunds keyed in ASSD.' },
  { id: 'probable', title: 'Matched only because the amounts add up — confirm', severity: 'warning',
    help: 'Lines paid together, or one line paid in parts, matched because their sums agree and nothing else: probable, not certain. Confirm each, or say they are not the same money. Also here: a shift with more open lines or payments than every combination could be tried for, to check by hand.' },
  { id: 'explained', title: 'Explained by the matcher — check the explanation', severity: 'info',
    help: 'Differences the rules could account for: the same money split differently, keyed on the next shift, a mistake and its correction, a cash movement keyed wrong and put back, a card credit from outside the terminal report.' },
];

const GROUP = {
  probable: 'probable', 'search-cut': 'probable',
  failed: 'failed',
  'not-found': 'missing', zero: 'missing',
  'double-charge': 'double',
  transposition: 'keying', decimal: 'keying', keying: 'keying',
  'paid-more': 'paidmore', 'paid-less': 'paidless',
  duplicate: 'duplicate',
  'not-recorded': 'unrecorded',
  'never-settled': 'settlement', reversal: 'settlement', refund: 'settlement',
  regrouped: 'explained', 'other-shift': 'explained', corrected: 'explained', 'bank-only': 'explained',
};

const SEVERITY = {
  failed: 'critical', 'not-found': 'critical', zero: 'warning', 'double-charge': 'critical',
  transposition: 'warning', decimal: 'warning', keying: 'warning', 'paid-more': 'warning', 'paid-less': 'critical', duplicate: 'warning',
  'not-recorded': 'warning', 'never-settled': 'warning', reversal: 'warning', refund: 'info',
  regrouped: 'info', 'other-shift': 'warning', corrected: 'info', 'bank-only': 'info',
  // Matched by sums alone, and searches cut short: to be confirmed by a person.
  probable: 'warning', 'search-cut': 'warning',
};

export { clock as timeOfDay };
