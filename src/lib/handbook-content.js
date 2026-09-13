/**
 * The handbook the property starts from.
 *
 * Eighteen chapters, written for a hotel rather than adapted from an office.
 * They arrive as DRAFTS and nothing reaches a member of staff until somebody
 * has read them and pressed Publish: a handbook is the property's word, not
 * the app's, and a page of rules nobody in the building has approved is worse
 * than an empty screen.
 *
 * HOW THEY ARE WRITTEN. Short sentences. Second person. What to do rather than
 * what is prohibited, wherever that is possible, because "hand lost property
 * in at reception" is followed and "employees shall not misappropriate items"
 * is not. Where the law sets the floor it is named, so an administrator
 * changing the words can see which sentence they are arguing with.
 *
 * Nothing here is legal advice, and the sections that quote Ghanaian statute
 * quote the position at the time of writing. The Labour Bill before Parliament
 * would change several of them.
 */

/** The lines that close a chapter somebody signs. */
const SIGNED = `
If you are unsure about anything in this chapter, ask your supervisor or the
office before you sign it. Signing says you have read it and understood it, not
that you agree with every word of it.`;

export const DEFAULT_CHAPTERS = [
  // -------------------------------------------------------------- the basics
  {
    code: 'welcome',
    title: 'Welcome, and how this handbook works',
    summary: 'What is in here, who it applies to, and what we will ask you to do with it.',
    asks: 'read',
    sort_order: 10,
    body: `Welcome to the property.

This handbook is how we write down the way we work. It is here so that nobody
has to guess, and so that two people asking the same question get the same
answer.

WHAT IS IN IT
Each chapter covers one thing: how we look after guests, how the rota works,
how to raise a problem, what happens if something goes wrong. Read the ones
that apply to you. They are short on purpose.

WHAT WE WILL ASK OF YOU
Some chapters are here to be read. Some ask you to tick to say you have read
them. A few ask for your signature, because they form part of your contract or
because the law expects a record. The screen tells you which is which, and
anything still waiting on you sits at the top of the page.

WHEN IT CHANGES
We will change it from time to time. When a chapter changes in a way that
matters, you will be asked to read it again. What you ticked before stays on
record against the words you actually saw.

IT IS NOT YOUR WHOLE CONTRACT
Your contract of employment is a separate document and it comes first. This
handbook sits underneath it and explains how we run the place day to day.

IF SOMETHING HERE IS WRONG
Tell us. A handbook that nobody corrects stops being read.`,
  },

  // ------------------------------------------------------------ the big ones
  {
    code: 'conduct',
    title: 'Code of conduct and ethics',
    summary: 'What we expect of everybody, every shift: honesty, care and good judgement.',
    asks: 'sign',
    sort_order: 20,
    body: `We are a small property and our reputation is made one guest at a time. This
chapter is the short version of what that asks of you.

TURN UP
Be at your post, in uniform, ready to work at the start of your shift. Clock in
and out yourself at the terminal, using your own face or card. Clocking in for
somebody else, or asking somebody to clock in for you, is gross misconduct and
we will treat it as such.
If you cannot come in, tell your supervisor as early as you can that day, and
before your shift starts.

BE HONEST WITH MONEY AND PROPERTY
Ring every sale through the till. Never take stock, food, drink, linen or
equipment off the premises without written permission. Hand lost property in at
reception the moment you find it, whatever it is worth.

TIPS AND GIFTS
Tips left for you are yours, and tips left for a team are shared the way that
team has agreed. Do not ask a guest for a tip.
A small gift from a grateful guest may be accepted graciously. Anything beyond
that, and anything at all from a supplier, must be declared to your manager
before you accept it. Cash from a supplier is never acceptable.

CONFLICTS OF INTEREST
Tell your manager if you have an interest that could pull against the
property's: a second job with a competitor, a family member bidding for our
business, a relationship with somebody you supervise. Declaring it is almost
never a problem. Being found out later always is.

DRINK AND DRUGS
Do not come to work unfit through drink or drugs. Do not drink on duty, except
where your job requires you to taste. If you are on medication that affects how
you work, tell your supervisor.

LOOK THE PART
Clean, complete uniform. Name badge on. Hair, nails and shoes to the standard
your department sets. If a guest can see you, you are representing the property.

USE YOUR JUDGEMENT
No handbook covers everything. When something is not covered, ask: would I be
comfortable if the owner, the guest and my colleagues all saw what I am about
to do? If the answer is no, do not do it, and ask somebody.

WHAT WE DO IF THIS IS BROKEN
Anything here can lead to disciplinary action. Serious matters, including theft,
violence, clocking fraud and putting somebody in danger, can lead to dismissal
without notice. You will always be told what is alleged and given a fair chance
to answer it.${SIGNED}`,
  },

  {
    code: 'service',
    title: 'How we look after guests',
    summary: 'Reception, bar and cafe, housekeeping: the standard on every shift.',
    asks: 'ack',
    sort_order: 30,
    body: `Guests are the reason the property exists. Everything below is one idea in
different clothes: notice the person in front of you, and take care of them.

ON STAGE AND OFF STAGE
On stage is anywhere a guest can see or hear you: the lobby, the corridor, the
bar, the stairs, the car park. Off stage is the back office and the staff room.
On stage, you are the property. Personal conversations, complaints about work
and telephone calls wait until you are off it.

AT RECEPTION
Stand up, smile, look at the guest, and speak first. Greet them with a full
sentence rather than a word.
Say your name at some point while you check them in, so they know who to come
back to.
Offer what is useful: how to reach us, where to eat, how to get about. Read the
person in front of you and tell them what they will actually use.
If people are waiting, acknowledge everybody in the queue with a look or a
word. Being seen is most of it.
When a guest passes reception, look up and greet them.

AT THE BAR AND IN THE CAFE
The same welcome, and one more thing: keep it clean as you go. A wiped counter
and clean glassware are the guest's evidence that the kitchen is clean too.
If we do not have what they want, offer the nearest good thing rather than only
saying no.

IN THE ROOMS
You are in somebody's private space. Knock, announce yourself, and wait. Leave
the room the way you would want to find it. Do not move a guest's belongings
more than the work requires, do not read what is on the desk, and never take a
photograph in a guest's room.

WHEN SOMETHING HAS GONE WRONG
Listen to the whole complaint without defending anything.
Say you are sorry it happened and that you will deal with it.
Fix what you can fix yourself, now. If you cannot, get a manager rather than
passing the guest around.
Go back to the guest later and check they are satisfied. The recovery is
remembered longer than the mistake.

ON THE WAY OUT
Thank them, and ask how their stay was. If they are happy, ask if they would
kindly leave us a review. If they are not, thank them for telling you, and pass
it to a manager so it is not the last we hear of it.
Offer the practical help: luggage, a taxi, directions.

WHAT GOOD SERVICE IS MADE OF
Respect, patience, listening, anticipation, generosity and honesty. In that
order, on a bad day.`,
  },

  {
    code: 'equal',
    title: 'Equal opportunity',
    summary: 'How we recruit, promote and treat people, and what to do if that slips.',
    asks: 'ack',
    sort_order: 40,
    body: `We employ, train, pay and promote people on what they can do and how they do
it. Nothing else.

WHAT WE DO NOT TAKE INTO ACCOUNT
Sex, ethnic origin, place of origin, religion, creed, social or economic status,
disability, health status, pregnancy, marital status, age, or politics. Article
17 of the Constitution and section 14 of the Labour Act, 2003 (Act 651) put
this beyond argument, and it is also simply how we want to work.

WHAT THAT MEANS IN PRACTICE
Vacancies are open to everybody who can do the job, and are filled on evidence.
Training and the better shifts are offered on the same basis.
Two people doing the same work are paid on the same scale.
If you have a disability or a health condition, tell us what would help. We will
make the adjustments we reasonably can, and we would rather be asked than guess.
Pregnancy is never a reason to be treated worse, moved off a role or dismissed.

IF YOU THINK THIS HAS NOT HAPPENED
Say so. Use the grievance chapter, or speak to any manager you trust. A
complaint made honestly will not be held against you, whatever the outcome.

RECRUITING AND SUPERVISING
If you have any say in who is hired, trained or promoted, this chapter is part
of your job. Write down why you chose somebody. A decision you can explain is a
decision that is fair.`,
  },

  {
    code: 'dignity',
    title: 'Dignity at work: harassment and bullying',
    summary: 'What is not acceptable here, and exactly how to report it.',
    asks: 'sign',
    sort_order: 50,
    body: `Everybody here is entitled to work without being frightened, humiliated or
touched.

WHAT COUNTS AS HARASSMENT
Anything unwanted, aimed at a person, that makes their work degrading or
intimidating. It does not matter whether it was meant as a joke. What matters is
the effect on the person it landed on.
It includes: comments about somebody's body, sex, tribe, religion or accent;
sexual advances, requests for sexual favours, and touching that is not welcome;
sending or showing sexual images; following somebody, or waiting for them after
a shift; and repeated criticism, shouting, exclusion or setting somebody up to
fail.

FROM ANYONE
Harassment by a colleague, a supervisor, a guest, a supplier or a contractor is
all the same to us. You are entitled to be protected from a guest as well. If a
guest behaves this way towards you, remove yourself and get a manager. We will
ask the guest to leave rather than ask you to put up with it.

WHERE THE RULES APPLY
Everywhere the work reaches: the property, the staff room, a work trip, a
supplier's premises, a work group on a phone, and a work message sent at
midnight.

SEX FOR A JOB, A SHIFT OR A PROMOTION
Asking for or hinting at anything of that kind, from anybody with power over
somebody else's work, is gross misconduct. There is no version of it that ends
in a warning.

HOW TO REPORT IT
Tell any manager, or the office, in person or in writing. You may report on
behalf of somebody else.
If the person you would normally tell is the problem, go to any other manager.
Nobody is required to raise it with the person who did it first.
We will keep it as private as dealing with it allows, take it seriously, and
tell you what happened.

RETALIATION
Punishing somebody for reporting, or for supporting a report, is itself gross
misconduct. That includes cutting their shifts, moving them to worse work, and
freezing them out.

IF YOU ARE ACCUSED
You will be told what is alleged, given the evidence and given a proper chance
to answer before anything is decided.${SIGNED}`,
  },

  {
    code: 'grievance',
    title: 'Raising a problem: the grievance procedure',
    summary: 'Three steps, with a time limit on each, and who to go to when.',
    asks: 'ack',
    sort_order: 60,
    body: `If something at work is wrong, tell us. This is how, and how long it should
take.

FIRST, TRY THE QUICK WAY
Most things are settled by saying them to your supervisor. If it is a small
misunderstanding, that is usually the end of it. Nothing below stops you doing
that first.

STEP ONE: IN WRITING
If it is not settled, or you would rather not raise it informally, put it in
writing to your manager. A few sentences is enough: what happened, when, who
was there, and what you would like done.
You will be invited to a meeting, normally within five working days.
You may bring a colleague with you.

STEP TWO: THE MEETING AND THE ANSWER
At the meeting you say your side and we ask questions. If we need to check
things, we will say so and come back to you.
You will get the decision in writing, normally within five working days of the
meeting.

STEP THREE: APPEAL
If you are not satisfied, say so in writing within five working days. The appeal
is heard by somebody who was not involved in the first decision, and their
answer is final inside the property.

IF THE PROBLEM IS YOUR MANAGER
Go to any other manager, or to the office. You are never obliged to complain to
the person you are complaining about.

HARASSMENT, DISCRIMINATION AND SAFETY
These go straight to Step One and can go to any manager. See the dignity at work
chapter.

OUTSIDE THE PROPERTY
None of this takes away your right to go to the Labour Commission or to seek
advice elsewhere. We would rather you gave us the chance to put it right first.

WHAT WE WILL NOT DO
Hold it against you. Raising a grievance honestly is not a mark against anybody,
and treating it as one is a disciplinary matter in itself.`,
  },

  {
    code: 'discipline',
    title: 'When something goes wrong: the disciplinary procedure',
    summary: 'What we do before deciding anything, the steps, and what counts as serious.',
    asks: 'ack',
    sort_order: 70,
    body: `This is how we deal with conduct or performance that falls short. It is written
down so that it is the same for everybody.

BEFORE ANYTHING IS DECIDED
We find out what happened. You will be told what is alleged, in writing where it
is serious, and given the evidence.
You will be invited to a meeting and given time to prepare.
You may be accompanied by a colleague.
You will be given a real chance to answer before any decision is taken.
The person who decides will not be the person who complained.

THE STEPS
1. A quiet word. Most things stop here and nothing goes on file.
2. A verbal warning, recorded, normally live for six months.
3. A written warning, normally live for twelve months.
4. A final written warning.
5. Dismissal, with notice or with pay in lieu.
We can start further down the list where the matter is serious enough, and we
will say why.

SUSPENSION
We may suspend you on full pay while something serious is investigated. That is
not a punishment and it is not a decision about you. It is us keeping the
investigation clean.

GROSS MISCONDUCT
This can mean dismissal without notice, after the same fair process. It
includes: theft or fraud, including clocking for somebody else; violence or
threats; harassment; being unfit for duty through drink or drugs; serious breach
of guest privacy; deliberate damage; taking or offering a bribe; serious
breaches of health, fire or food safety; and walking off a shift and leaving the
property uncovered.

APPEAL
You may appeal any disciplinary decision in writing within five working days. It
is heard by somebody who was not part of the original decision.

PERFORMANCE
Where the issue is that somebody cannot yet do the job rather than will not, we
deal with it as training and support first, with a plan and a date to review it.

WHAT THE LAW REQUIRES
Fair process and a fair reason. Unfair termination is dealt with in sections 62
to 64 of the Labour Act, 2003 (Act 651), and nothing in this chapter takes away
your right to go to the Labour Commission.`,
  },

  // ------------------------------------------------------- the working week
  {
    code: 'hours',
    title: 'Hours, the rota and clocking in',
    summary: 'How the rota is made, how to clock, breaks, rest and swapping a shift.',
    asks: 'ack',
    sort_order: 80,
    body: `THE ROTA
The rota is published in HIVE. You can see your own shifts under My shifts, and
your department's under the same screen. Once a week is published, that is the
week. If it changes afterwards you will be told.
Tell us about days you cannot work before the rota is built, not after. There is
a place to record it in the app.

CLOCKING IN AND OUT
Clock in at the terminal at the staff entrance at the start of your shift and
out at the end of it, every time, with your own face or card.
If the terminal misses you, or you forget, tell your supervisor the same day so
it can be corrected. A correction is a normal thing; a month of missing taps
reconstructed from memory is not.
Clocking in for somebody else is gross misconduct for both people.

HOURS AND BREAKS
A normal shift is eight hours, and a normal week is forty, in line with sections
33 and 34 of the Labour Act, 2003 (Act 651).
You are entitled to a break of at least half an hour in a shift of more than
five hours. Take it. Your supervisor will tell you when it fits the service.
There should be at least twelve hours between the end of one shift and the start
of the next, and at least forty-eight hours off in every seven days.

WEEKENDS, NIGHTS AND PUBLIC HOLIDAYS
This is a hotel. Weekends and public holidays are ordinary working days here,
and the rota shares them out. Where you work a public holiday that falls on a
working weekday, you get a paid day off in lieu.

OVERTIME
Extra hours are agreed in advance with your supervisor. Do not start a shift you
have not been asked to work.

IF YOU WILL BE LATE
Tell your supervisor as soon as you know, not when you arrive. Somebody is
holding your section until you get there.

SWAPPING A SHIFT
If swaps are turned on, you can offer a shift you cannot work to the colleagues
who could cover it, from the Swaps screen. Nothing changes on the rota until a
manager approves it, so keep working to the rota until you see that it has.`,
  },

  {
    code: 'leave',
    title: 'Leave and absence',
    summary: 'Annual leave, sickness, maternity, compassionate leave, and being absent.',
    asks: 'ack',
    sort_order: 90,
    body: `ANNUAL LEAVE
After twelve months of continuous service you are entitled to at least fifteen
working days of paid leave a year, under section 20 of the Labour Act, 2003
(Act 651). Your contract may give you more.
Ask for leave in HIVE, under My shifts. Give as much notice as you can: a month
for anything longer than a few days. We will answer in the app, and the days
come off your balance when it is approved.
Leave is easier to grant when the department is not already short. We try to
spread the popular weeks fairly rather than first come, first served.
Your leave year and your balance are shown on your own screen.

SICKNESS
If you are ill and cannot work, telephone your supervisor as early as you can on
the day, and before your shift starts. A message to a colleague is not telling
us.
Keep us up to date each day unless we agree otherwise.
For an absence of more than three days, bring a medical certificate.
Do not come in with vomiting, diarrhoea, a fever or a skin infection if you work
with food. Tell us and stay away for 48 hours after it stops. This is not
optional and it is not held against you.

MATERNITY, AND TIME OFF FOR A NEW BABY
Twelve weeks of paid maternity leave, extended where a doctor certifies it or
where there is more than one baby, under section 57 of Act 651. Nursing mothers
are entitled to time during the day to feed. Tell us early so we can plan the
rota around you, and so we can look at your duties if any of them are unsuitable.

COMPASSIONATE AND FAMILY LEAVE
A death or a serious illness in the family is dealt with case by case, quickly
and generously. Speak to your manager. Do not wait for a form.

TIME OFF FOR OTHER THINGS
Court attendance, a national duty, a medical appointment you cannot move: tell
us in advance and we will work around it.

UNAUTHORISED ABSENCE
Not turning up, and not telling anybody, is a disciplinary matter. Three days of
it without contact will be treated as you having left, after we have tried to
reach you and the person you gave us as your emergency contact.`,
  },

  {
    code: 'pay',
    title: 'Pay, payslips and deductions',
    summary: 'When you are paid, what comes off, and what to do if it looks wrong.',
    asks: 'read',
    sort_order: 100,
    body: `WHEN YOU ARE PAID
Monthly, into the bank account on your record. Tell the office at once if your
account details change.

YOUR PAYSLIP
Every payslip is in HIVE under My pay. It shows your gross pay, what has been
deducted and why, and what reached your account. You can put a four-digit code
on that screen so that handing somebody your unlocked phone does not hand them
your pay.

WHAT COMES OFF
PAYE income tax, at the rates the Ghana Revenue Authority sets.
Your SSNIT contribution of 5.5 per cent, with the property paying 13 per cent on
top of your salary.
Anything you have agreed to in writing: a salary advance being repaid, a loan.
Nothing else is deducted without your written agreement, except where the law
requires it. Section 70 of the Labour Act, 2003 (Act 651) is the rule here.

ADVANCES
There is a way to ask for an advance in HIVE under My pay. It is not a right and
it is not always possible, and it is repaid from your salary over agreed months.

MEDICAL CLAIMS
Where the property runs a medical allowance, claims go in through the same
screen with the receipt attached.

IF IT LOOKS WRONG
Tell the office within the month if you can. Bring your payslip and say which
figure you are querying. Genuine mistakes are corrected in the next run or
sooner where the amount is large.

WHAT YOU EARN IS YOUR BUSINESS
We do not discuss one person's pay with another, and we ask you to use the same
discretion. That is not a rule against you discussing your own pay; it is a rule
against speculating about somebody else's.`,
  },

  // ------------------------------------------------------ guests and secrets
  {
    code: 'privacy',
    title: 'Guest confidentiality and data protection',
    summary: 'What you may say, to whom, and what happens to the data we hold.',
    asks: 'sign',
    sort_order: 110,
    body: `Guests hand us their name, their passport, their card and their movements. They
are entitled to expect that none of it goes any further.

THE RULE
Do not discuss a guest with anybody who does not need to know for their work.
Not with another guest, not with a friend, not at home, not on a phone group,
and never online.
That includes the fact that somebody is staying here at all. If a caller asks
whether a person is a guest, do not confirm it. Take a message and pass it to
reception.

PARTICULARLY
Never give out a room number. Walk the person to reception instead.
Never let anybody into a room who is not the guest, without a manager.
Never photograph or film a guest, a guest's room, or anything a guest has left
out.
Do not look up a guest's record, or a colleague's, out of curiosity. The systems
keep a record of who looked at what.
Police and other authorities are answered by a manager, not at the desk.

WHAT WE HOLD, AND WHY
We keep guest details to run the booking, to meet the law, and to answer a
dispute. We keep staff details to employ you, pay you and keep you safe. That is
all it is used for.
The Data Protection Act, 2012 (Act 843) is the rule, and the property is the
data controller.

YOUR OWN DETAILS
You can see what we hold about you, ask for a mistake to be corrected, and ask
why we hold something. Ask the office.

CARDS AND DOCUMENTS
Never write a card number down. Never photograph a passport on your own phone.
Documents we copy are kept in the system, not in a drawer.

IF SOMETHING GETS OUT
Tell a manager immediately: a lost phone with the booking system on it, an email
to the wrong person, a screen left open, a stolen list. Hours matter. Telling us
straight away is treated far better than a delay, and the law expects us to
report some of these.

AFTER YOU LEAVE
This chapter still applies. What you learned here stops being yours to repeat
the day you started, not the day you leave.${SIGNED}`,
  },

  {
    code: 'it',
    title: 'IT security and using our systems',
    summary: 'Passwords, phones, what the systems are for, and what to do if you slip.',
    asks: 'sign',
    sort_order: 120,
    body: `The property runs on a handful of systems: the booking system, HIVE, the tills,
the door locks and the cameras. Between them they hold everything about our
guests and our staff.

YOUR ACCOUNT IS YOURS
Do not share your PIN or password with anybody, including a manager. Nobody here
will ever ask you for it.
Do not use somebody else's account, even with permission, and even to help.
Lock the screen or sign out when you walk away from a desk. HIVE locks itself
after a few minutes, which is not a substitute for locking it yourself.

PASSWORDS
Use a different one here from the one on your personal accounts. Change it at
once if you think somebody has seen it.

EMAIL AND MESSAGES
Look at the address before you reply, and again before you attach anything. Most
of what goes wrong is an email to the right name at the wrong address.
Do not open an attachment or a link you were not expecting, however plausible
the message. Ask the sender by another route.
Nobody from a bank, a supplier or the property will ask you by email to change
bank details. Treat any such request as false until a manager has confirmed it
by telephone.

YOUR OWN PHONE
Keep it out of sight while you are on stage. Use it on your break, off the floor.
If you use your phone for work, put a lock on it. Do not keep guest details,
photographs of documents, or lists of staff on it.
Do not install anything on a property device without asking.

WHAT OUR SYSTEMS ARE FOR
Work. A small amount of personal use is fine if it does not get in the way and
does not embarrass anybody. Nothing illegal, nothing sexual, nothing you would
not want a colleague to see over your shoulder.

WE CAN LOOK
The property may look at accounts, devices and logs where it has a reason to,
such as an investigation or a fault. We do not read people's messages for
entertainment, and we do not do it without a reason.

CAMERAS
The cameras are there for safety and security. They are not there to watch
individual people work, and the recordings are looked at when there is a reason
to look at them.

IF YOU SLIP
Clicked the link, sent the file to the wrong person, lost the phone: tell a
manager immediately. Every one of those is fixable in the first hour and much
harder later. Nobody has ever been disciplined here for reporting their own
mistake quickly.${SIGNED}`,
  },

  // ----------------------------------------------------- the physical place
  {
    code: 'safety',
    title: 'Health, safety and fire',
    summary: 'Keeping yourself and everybody else in one piece, and what to do in a fire.',
    asks: 'ack',
    sort_order: 130,
    body: `WHAT WE OWE EACH OTHER
The property provides safe equipment, training and the things you need to work
safely. You use them, follow the rules, and speak up about anything that looks
wrong. Both halves are in the Labour Act, 2003 (Act 651), sections 118 to 120.

THE ORDINARY THINGS THAT HURT PEOPLE HERE
Wet floors. Put the sign out, and put it away when the floor is dry.
Lifting. Get help or get a trolley. Nothing is worth your back.
Knives, slicers and hot oil. Only use what you have been shown how to use.
Chemicals. Right product, right dilution, gloves on, never mixed. Bleach and
acidic cleaners together make a gas that has killed housekeepers.
Ladders. Two feet on, somebody at the bottom, never on a chair.

REPORT IT
Tell your supervisor about any accident, injury, near miss or hazard, the same
day, however small it looks. A near miss reported is the cheapest lesson the
property will ever get.
Every injury goes in the accident book, including your own.

FIRE
Know, today, where the nearest two exits are from wherever you work, and where
the assembly point is.
If you find a fire: raise the alarm first, get people out, and only fight it if
it is small, you have been trained, and your way out is behind you.
Never wedge a fire door open. Never block an exit, a corridor or an extinguisher,
not even for five minutes.
On the alarm: guests first, calmly, out and to the assembly point. Do not go back
in for anything.

FIRST AID
The kits are at reception and in the kitchen. Ask now who the trained first
aiders are, rather than when you need one.

IF YOU ARE ASKED TO DO SOMETHING UNSAFE
Say no, and say why. You will not be penalised for refusing work that is
genuinely dangerous, and a supervisor who insists is the one with the problem.`,
  },

  {
    code: 'food',
    title: 'Food and drink safety',
    summary: 'For the kitchen, the bar and anybody who touches food: the non-negotiables.',
    asks: 'ack',
    sort_order: 140,
    departments: ['Kitchen', 'F&B', 'Restaurant', 'Bar'],
    body: `Somebody can be made seriously ill by a shortcut that saves two minutes. These
are the rules that do not bend.

YOURSELF
Wash your hands: coming into the kitchen, between raw and cooked, after the
bins, after the toilet, after your phone, after a break. Soap, warm water,
twenty seconds, dry properly.
Clean uniform and apron, hair covered, nails short and unvarnished, no watch or
rings other than a plain band.
Cover every cut with a blue waterproof plaster.
Do not work with food if you have had vomiting or diarrhoea in the last 48
hours. Tell your supervisor. You will not lose out for staying away.

TEMPERATURES
Fridges at or below 5 degrees, freezers at or below minus 18. Check and write it
down twice a day.
Cook through: 75 degrees in the centre, or hotter for longer where the recipe
says.
Hot holding above 63 degrees. Cool leftovers fast, within ninety minutes, and
get them in the fridge.
Reheat once, all the way through, and never a second time.

KEEPING THINGS APART
Raw meat below and away from everything ready to eat, always.
Separate boards and knives for raw and ready to eat. Never the same cloth.

STOCK
First in, first out. Label everything with the date it was opened or made.
If it is past its date, out of temperature or you are not sure, throw it away and
tell your supervisor. Nobody here is ever in trouble for binning doubtful food.

ALLERGENS
Fourteen ingredients cause almost all serious reactions. Know which of our
dishes contain them, and where the allergen list is kept.
If a guest asks, get the list. Never guess, and never say "it should be fine".
If a guest tells you they have an allergy, tell the kitchen directly and watch
the plate leave. A guest with a serious allergy is trusting you with their life,
which is not an exaggeration.

CLEANING
Clean as you go. The kitchen is left clean at the end of every shift, not at the
end of the week. Sign the cleaning schedule for what you actually did.

PESTS
Report a sighting or a droppings trail the same hour, to a manager. Do not deal
with it yourself and do not hope.`,
  },

  {
    code: 'security',
    title: 'Keys, cash, stock and lost property',
    summary: 'Looking after the things that go missing, and what to do when they do.',
    asks: 'ack',
    sort_order: 150,
    body: `KEYS AND ACCESS CARDS
Signed out to you, and back in at the end of your shift. Never lend one, never
leave one on a trolley or a counter, never take one home.
Report a lost key immediately. A lost master is a locks-changed evening, and it
is far cheaper the hour it happens than the morning after.

CASH
Count your float at the start and the end, in front of somebody, and write it
down.
Every sale through the till, every time, including a staff purchase and a
manager's coffee.
No IOUs, no borrowing from the till, no keeping change "to settle later".
A shortage happens. Report it rather than making it up out of your pocket, which
looks far worse afterwards.

STOCK AND DELIVERIES
Check the delivery against the note before you sign it, and write down what is
short or damaged.
Store it away straight away.
Anything that leaves the property leaves with paperwork.

GUEST BELONGINGS AND LOST PROPERTY
Anything left behind goes to reception the same shift, with where and when you
found it. It is logged.
Never take an item home to "keep it safe".
Unclaimed items are dealt with by the office after the period the property has
set. That is not for you to decide, however small the item.

VISITORS AND CONTRACTORS
Everybody who is not a guest or on shift signs in at reception. Do not let
somebody through a staff door because they look like they belong.

AT NIGHT
Doors that should be locked are locked. Do the walk. If somebody is in the
building who should not be, do not confront them alone: get to a safe place, use
the phone, and call for help.

WHEN SOMETHING IS MISSING
Tell a manager as soon as you know. An investigation that starts the same day
usually finds the thing. One that starts a week later usually finds a person to
blame.`,
  },

  {
    code: 'social',
    title: 'Social media and talking about the property',
    summary: 'What you can post, what you cannot, and who speaks for us.',
    asks: 'ack',
    sort_order: 160,
    body: `Your own accounts are your own. This chapter is about the small part of them
that touches the property.

NEVER
Post a photograph or video of a guest, or anything that lets somebody work out
who was staying here, including a booking screen or a registration card.
Post from a guest area in a way that shows guests.
Say a guest was here, or what they did.
Post anything that identifies a colleague without asking them.

WHILE YOU ARE ON SHIFT
Your phone stays off the floor. Post on your break, off stage.

TALKING ABOUT WORK
You can say where you work and you can enjoy it out loud. If you say something
about the property, make it clear it is your own view, not ours.
Do not run down the property, a colleague, a guest or a supplier online. If
something is wrong, use the grievance chapter; it works better and it does not
follow you around for years.
Do not post about an incident, a complaint or anything that is being
investigated.

WHO SPEAKS FOR US
The official accounts are run by the people the property has asked to run them.
If a journalist, a reviewer or anybody official asks you for a comment, be
polite, take a name and a number, and pass it to a manager.

REVIEWS
Do not reply to a review as yourself. Do not write a review of us, or ask a
friend to. It is dishonest and every platform can spot it.

IF SOMETHING IS ALREADY UP
Take it down and tell a manager. That is almost always the end of it. Leaving it
up because you hope nobody noticed is what turns a mistake into a disciplinary
matter.`,
  },

  {
    code: 'leaving',
    title: 'Leaving',
    summary: 'Notice, your last pay, references, and what comes back to us.',
    asks: 'read',
    sort_order: 170,
    body: `NOTICE
Give the notice your contract says: normally a month once you are past
probation, and seven days during it. In writing, to your manager.
We give you the same. Section 17 of the Labour Act, 2003 (Act 651) sets the
floor.
We would rather you told us early and honestly. A good leaver is a person we
would take back.

YOUR LAST WEEKS
Work them properly. Hand over what you know: the supplier who is difficult, the
lock that sticks, the regular who likes the corner table. Write it down for
whoever comes next.

WHAT COMES BACK
Uniform, name badge, keys, access card, phone, tools, anything with our name on
it. On your last shift.

YOUR LAST PAY
Everything you have earned, plus any leave you have not taken, less anything you
have agreed in writing to repay. Normally in the next payroll run after you
leave.
Your payslips stay available to you for as long as we hold them; ask the office
if you need one after your login has been closed.

YOUR REFERENCE
We give factual references: your job, your dates, and whether we would re-employ
you. Ask the office rather than a colleague, and give them the address to send
it to.

WHAT STAYS
Confidentiality does. What you learned about guests, colleagues and the business
is not yours to repeat after you leave.

THE CONVERSATION
We will ask you what we could have done better. Please be honest. It is the
cheapest way for a small property to learn anything, and it will not affect your
reference.`,
  },

  // -------------------------------------------------------- for supervisors
  {
    code: 'leads',
    title: 'Team leadership charter',
    summary: 'For supervisors and team leads: the standard you are held to.',
    asks: 'sign',
    sort_order: 180,
    tags: ['Team lead', 'Supervisor'],
    body: `This chapter applies to everybody who supervises anybody. You are judged on how
you get results as well as on the results.

RESPECT IS NOT OPTIONAL
Treat colleagues, staff, guests and suppliers with respect, on your worst day as
well as your best.
Shouting, insults, humiliation and threats are misconduct, not a management
style.
So is the quiet version: favourites, freezing somebody out, running a team on
fear, or handing the bad shifts to people who annoyed you.

WHAT YOU DO WITH WHAT YOU KNOW
You will hear things about people. Performance, discipline, health, money,
family. None of it is conversation.
Do not repeat a rumour, and do not speculate about a colleague in front of
anybody.
Discuss a person's performance or conduct through the proper channel and nowhere
else.

FEEDBACK, FOUR RULES
Direct: say it to the person, not about them.
Factual: what you saw, not what you assume.
Job related: the work, not the person.
Private: correction happens behind a closed door.

NEVER IN PUBLIC
Never criticise somebody in front of a guest. Not once, not briefly.
In front of the team, teaching is fine and correction is not. If it is about one
person's mistake, take them aside.
No sarcasm. It reads as contempt to everybody except the person using it.
No triangulation: do not complain about a member of your team to another member
of your team.

KEEP YOURSELF IN ORDER
Service is stressful and the point of a supervisor is to absorb some of it. If
you are about to lose your temper, step off the floor for two minutes.
Deal with small problems while they are small. Most of what ends in a
disciplinary meeting was a five-minute conversation somebody avoided a month
earlier.

WHEN YOU DISAGREE
Speak to the person directly first.
If it is not resolved, take it to management formally. Do not take it sideways
to the team.

HOW YOU ARE MEASURED
Your conduct under this charter is part of your review, alongside what your
department delivers, and it is assessed on evidence: records, incidents, and
what your team says.

THE FOUR THAT END IT
Whatever else is going well, these trigger an immediate review and disciplinary
action:
Spreading rumours about a colleague, proven.
Intimidating a member of staff.
Retaliating against somebody who raised a concern.
Driving somebody to resign through your own conduct.

YOUR TEAM CAN REPORT YOU
Confidentially, to any manager, and nothing may happen to them for it.
Protecting the dignity of the people who work for you is the job. Everything
else is arrangements.${SIGNED}`,
  },
];

/** Handy for the tests and for the screen that lists what is on offer. */
export const CHAPTER_CODES = DEFAULT_CHAPTERS.map((c) => c.code);
