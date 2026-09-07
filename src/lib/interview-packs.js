/**
 * Interview questions for a hotel, ready to be edited into the property's own.
 *
 * Data rather than code: a property loads a set, changes the wording, deletes
 * what does not apply, and from that moment the questions are theirs. Nothing
 * here is asked of anybody until somebody has put it on a vacancy.
 *
 * WHY THEY LOOK LIKE THIS
 * -----------------------
 * They are written for the person who will actually sit in the interview, which
 * at a property this size is the head of the department rather than anybody who
 * interviews for a living. So every question comes with what a good answer
 * sounds like. That half is the useful half: what separates a good room
 * attendant from a poor one is not something that comes to mind while a nervous
 * stranger is sitting across the table.
 *
 * They ask about what happened, not about what somebody would do. "Tell me
 * about a guest who was angry" gets an account of something real; "how would
 * you handle an angry guest" gets the answer everybody knows they are supposed
 * to give. Where a question has to be hypothetical it is about a situation the
 * job actually contains, and the listen-for says what a working answer has in
 * it.
 *
 * None of them ask about age, marital status, children, church, home town or
 * politics. Not because the law here is loud about it, but because none of it
 * predicts whether somebody can strip a room in twenty minutes, and asking is
 * how a property ends up with a workforce that all came from the same place.
 */

import { allows } from './permissions.js';

/**
 * The mark on every question is out of five, and the same five everywhere.
 *
 * Named rather than left as bare numbers, because "3" means whatever the
 * person holding the pen thought it meant that afternoon, and comparing six
 * candidates is exactly what the numbers exist for.
 */
export const MARKS = [
  [1, 'Nowhere near', 'Could not answer it, or the answer says they would do the wrong thing'],
  [2, 'Some way off', 'Understands the question but has not done it, or has done it badly'],
  [3, 'Would do', 'A sound answer with nothing special in it. Would cope on an ordinary day'],
  [4, 'Good', 'Has done it, says how, and the answer shows they thought about it'],
  [5, 'Exactly right', 'The answer a person already doing this job well would give'],
];

const q = (text, listenFor) => ({ text, listenFor });

/**
 * The standard sets. A property presses one button and gets all of them, then
 * throws away the departments it does not have.
 */
export const PACKS = [
  {
    name: 'Anybody, whatever the job',
    department: null,
    note: 'The four to ask everyone, on top of whatever the department asks. Short on purpose.',
    questions: [
      q('Tell me what you know about this hotel, and why you came here rather than somewhere else.',
        'Anything specific — the location, somebody who works here, a stay, the kind of guest we '
        + 'take. "I need a job" is honest and tells you nothing; a wrong guess about what we are '
        + 'tells you they did not look.'),
      q('Walk me through your last day at work, from arriving to leaving.',
        'A real shift with real times in it, and the small things nobody invents: the handover, '
        + 'the keys, the break, what they did last. Somebody who has done the work cannot help '
        + 'giving detail. Somebody who has not gives you a job description.'),
      q('Tell me about a time you were asked to do something that was not your job.',
        'They did it, or they said why not and told somebody. What you are listening for is '
        + 'whether the hotel is one thing to them or seven departments, because on a Saturday '
        + 'night it is one thing.'),
      q('How do you get here, and what happens when there is no transport?',
        'The route, the cost, and a plan for the day it fails. This is the single most common '
        + 'reason somebody stops turning up, and the answer is usually honest if you ask it '
        + 'plainly.'),
    ],
  },

  {
    name: 'Front office and reception',
    department: 'Front Office',
    note: 'Reception, reservations and the desk at night.',
    questions: [
      q('A guest arrives at midday and their room is not ready. They are tired and they are '
        + 'not happy about it. What do you say?',
        'They say something in the first sentence that is not "sorry": an actual time, somewhere '
        + 'to sit, luggage taken, a drink. Anybody can apologise; the ones worth hiring buy the '
        + 'housekeeper twenty minutes without the guest feeling parked.'),
      q('Tell me about the angriest guest you have dealt with, and how it ended.',
        'A real story with an ending, and some sense of what they would do differently. Listen '
        + 'for whether they took it personally. Somebody who is still angry about it in the '
        + 'interview will be angry about it on the desk.'),
      q('A guest asks for a discount you are not allowed to give. What happens next?',
        'They hold the line without making the guest feel refused, and they know when to fetch '
        + 'somebody. The wrong answers are both ends: giving it away, and saying no in a way '
        + 'that ends the conversation.'),
      q('What do you do with the cash and the card machine at the end of your shift?',
        'A count, a witness or a signature, a float that is written down, and the takings '
        + 'somewhere that is not a drawer. Vagueness here is worth more attention than a wrong '
        + 'answer: somebody who has handled money says so in the way they describe it.'),
      q('Somebody rings and asks whether a particular guest is staying here. What do you tell them?',
        'Nothing at all, and they offer to take a message. This one is not negotiable and it is '
        + 'the fastest way to find out whether they understand what a guest is owed.'),
      q('Which systems have you used at a desk, and what were you doing in them?',
        'The names, and what they actually did in them — check-in, rates, a night audit, a '
        + 'group. Somebody who names three systems and cannot say what they did in any of them '
        + 'has read the advert.'),
    ],
  },

  {
    name: 'Housekeeping and rooms',
    department: 'Housekeeping',
    note: 'Room attendants, house porters and laundry.',
    questions: [
      q('Take me through cleaning a checkout room, in the order you do it.',
        'An order, and a reason for it: strip first, top down, bathroom last or first but always '
        + 'the same, and the door left as they found it. What matters is that there is a method '
        + 'at all — somebody without one is somebody who misses the same things every time.'),
      q('How long does a room take you, and what makes it take longer?',
        'A number they will stand behind, and honest reasons — a heavy checkout, a guest who '
        + 'stayed a week, a party. Beware anybody who says fifteen minutes for everything.'),
      q('You find money, a phone or jewellery in a room. Walk me through what you do.',
        'Do not move it, tell the supervisor, it is written down, it goes to the office. A '
        + 'property lives or dies on this answer and it is worth asking even of somebody who '
        + 'has never worked in a hotel.'),
      q('A guest is still in the room at three o’clock and it is on your list. What do you do?',
        'They do not knock again and again, and they do not skip it silently. They tell the '
        + 'supervisor or the desk and come back. The failure mode here is a room that never gets '
        + 'done and nobody finds out until the next guest.'),
      q('Which chemicals have you used, and what would you never mix?',
        'Bleach and anything with ammonia in it, gloves, ventilation, and never decanting into '
        + 'an unmarked bottle. If they have used them properly somewhere they will answer this '
        + 'quickly and without being nervous about it.'),
      q('Tell me about a room you were not happy with, and what you did about it.',
        'They noticed, and they said something rather than closing the door on it. This is the '
        + 'question that finds the attendant who takes the floor seriously.'),
    ],
  },

  {
    name: 'Restaurant and bar service',
    department: 'F&B',
    note: 'Waiting staff, bar and breakfast service.',
    questions: [
      q('A guest says the food is not what they ordered, halfway through eating it. What do you do?',
        'They take it seriously without arguing, they tell the kitchen, and something happens for '
        + 'the guest now rather than a promise about the bill. Listen for whether the kitchen is '
        + '"them" or "us".'),
      q('A guest tells you they cannot eat something. What happens between the table and the '
        + 'kitchen?',
        'They write it down, they say it out loud to the kitchen, and they check the plate before '
        + 'it lands. Anybody who treats an allergy as a preference is a serious problem in a '
        + 'small kitchen.'),
      q('It is breakfast, you have eleven tables and three of them want you at once. What do you '
        + 'do first?',
        'Any order, so long as there is one, and they say something to the other two on the way '
        + 'past. What you are listening for is that they keep moving and that nobody is left '
        + 'wondering whether they were seen.'),
      q('Sell me the thing you know best off any menu you have worked.',
        'They can describe food in a way that makes somebody want it, without reading it out. '
        + 'Somebody who cannot do this for food they know will not do it for ours.'),
      q('How do you take payment at a table, and what do you check?',
        'The bill against the order, the amount said out loud, the machine watched, the change '
        + 'counted back. Simple, and the answer is very different from somebody who has done it.'),
      q('Somebody at the bar has had enough. How do you handle it?',
        'They stop serving without a scene, they get somebody senior, and they think about how '
        + 'the person gets home. The wrong answer is either serving on or a confrontation.'),
    ],
  },

  {
    name: 'Kitchen',
    department: 'Kitchen',
    note: 'Cooks, kitchen assistants and stewards.',
    questions: [
      q('Cook me something in words: the dish you are best at, from the fridge to the plate.',
        'Ingredients, order, timing, and how they know it is done. Somebody who cooks talks about '
        + 'heat and time; somebody who has watched talks about ingredients only.'),
      q('Where do you keep raw chicken in a fridge, and why there?',
        'The bottom, below everything else, covered. It is the fastest test there is of whether '
        + 'somebody has been trained or has only worked around food.'),
      q('What do you do with food that came off a plate and food that was never served?',
        'They go different ways and neither goes back into service. Listen for whether they have '
        + 'ever been asked to do otherwise, and what they did about it.'),
      q('How do you know the fridge is cold enough, and what do you do if it is not?',
        'A thermometer or a gauge, a number, a check that happens at a time, and telling somebody '
        + 'rather than hoping. A property with a food handler’s certificate on file needs '
        + 'this answer to be real.'),
      q('It is a Sunday, you are short one person, and the orders are coming. What do you drop?',
        'They prioritise out loud, and they tell the front. Anybody who says they would do '
        + 'everything is telling you they have never had a bad Sunday.'),
      q('Tell me about a chef you learned the most from, and what they taught you.',
        'A person and a specific thing. It is a gentle question and it is the one that shows you '
        + 'whether somebody is still learning.'),
    ],
  },

  {
    name: 'Maintenance',
    department: 'Maintenance',
    note: 'Handyman, plumbing, electrical and pool.',
    questions: [
      q('A guest reports no hot water in one room. Where do you start?',
        'They check the obvious thing first, and they check the rooms either side before they '
        + 'open anything. Somebody who starts by dismantling the heater is expensive.'),
      q('Which of these can you do on your own, and which do you call somebody for: a leaking '
        + 'trap, a tripping breaker, a split AC that is not cooling, a pool that has gone green?',
        'An honest line between the two. Overreach is the dangerous answer here, particularly on '
        + 'anything electrical, and somebody who says "I would call" for the right ones is worth '
        + 'more than somebody who says yes to everything.'),
      q('You have to work in an occupied room. How do you go about it?',
        'Arranged through the desk, announced, sheets down, cleaned up, and out when they said '
        + 'they would be. The guest is the point, not the repair.'),
      q('Tell me about something you fixed that kept coming back, and what you did in the end.',
        'They looked for the cause rather than doing the same repair four times. This is the '
        + 'question that separates a handyman from somebody who patches.'),
      q('What do you do before working on anything electrical?',
        'Isolate it, prove it is dead, and tell somebody it is off. Anybody vague here does not '
        + 'go near a distribution board.'),
    ],
  },

  {
    name: 'Security',
    department: 'Security',
    note: 'Gate, night patrol and the car park.',
    questions: [
      q('Somebody arrives at the gate at two in the morning and says they are meeting a guest. '
        + 'What do you do?',
        'They do not turn them away and they do not wave them in. They ring the desk, and the '
        + 'guest decides. Listen for whether the guest’s privacy survives the conversation.'),
      q('What do you write down on a night shift, and when?',
        'A log with times in it, patrols, anything unusual, and handover. Somebody who has done '
        + 'nights properly will describe the book before you ask about it.'),
      q('You see a member of staff leaving with something that belongs to the hotel. What happens?',
        'They stop it politely, they do not accuse, and they tell somebody senior the same night. '
        + 'The wrong answers are ignoring it and handling it themselves.'),
      q('A guest is drunk and will not go to their room. How do you handle it?',
        'Calm, no hands, get help, and the guest ends up safe. Anybody whose first answer '
        + 'involves force is the wrong person for a small hotel.'),
      q('What do you do about staying awake, honestly?',
        'A real answer — walking the patrol, the time they sleep in the day, coffee. It is a fair '
        + 'question and the honest answers are worth more than the confident ones.'),
    ],
  },
];

/** The set for a department, if one of the standard ones fits it. */
export function packForDepartment(department) {
  if (!department) return null;
  const want = String(department).trim().toLowerCase();
  return PACKS.find((p) => (p.department ?? '').toLowerCase() === want) ?? null;
}

/**
 * What a sheet came out at, from the marks actually given.
 *
 * Unmarked questions are left out rather than counted as nought: an interview
 * that ran short is not an interview that went badly, and averaging in the
 * questions nobody got to would say it was.
 */
/** Somebody who can correct a sheet that is not theirs. */
export const CORRECTS_ANYWAY = 'att_setup';

/**
 * Whether this person may correct that sheet.
 *
 * The person who wrote it, and an administrator. Not everybody who can open
 * recruitment: a mark with somebody else's name on it, moved by a third party,
 * is the one thing that would make the record unanswerable a year later.
 *
 * Sheets written before logins were kept against a sheet have only a name to
 * go on, so the name is matched as a fallback. That is weaker than an id and it
 * is meant to be: it only ever lets somebody edit a sheet that already says
 * they wrote it.
 */
export function mayCorrect(sheet, who = {}) {
  if (!sheet) return false;
  if (allows(CORRECTS_ANYWAY, who.permissions ?? [])) return true;
  const mine = sheet.scored_by_id ?? sheet.scoredById ?? null;
  if (mine != null && who.userId != null) return Number(mine) === Number(who.userId);
  const by = sheet.scored_by ?? sheet.by ?? null;
  return Boolean(by && who.actor && String(by) === String(who.actor));
}

/**
 * What moved, in a line, for the trail.
 *
 * The point of writing it out rather than storing "edited" is the question
 * anybody asks a year later, which is not whether a sheet was touched but
 * whether the mark on it went up after somebody had a word.
 */
export function whatChanged(before = {}, after = {}) {
  const said = [];
  if (before.rating !== after.rating) {
    said.push(`${before.rating ?? 'no mark'} to ${after.rating ?? 'no mark'} out of 5`);
  }
  if (before.recommend !== after.recommend) {
    said.push(`${before.recommend ?? 'not saying'} to ${after.recommend ?? 'not saying'}`);
  }
  const moved = (after.answers ?? []).filter((a, i) => {
    const was = (before.answers ?? [])[i];
    return was && (was.mark !== a.mark || (was.note ?? null) !== (a.note ?? null));
  }).length;
  if (moved) said.push(`${moved} answer${moved === 1 ? '' : 's'}`);
  if ((before.note ?? null) !== (after.note ?? null)) said.push('the note');
  return said.join(', ') || null;
}

export function sheetRating(answers = []) {
  const marks = answers
    .map((a) => Number(a?.mark))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  if (!marks.length) return null;
  return Math.round((marks.reduce((a, b) => a + b, 0) / marks.length) * 10) / 10;
}
