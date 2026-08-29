/**
 * The handbook, written down where the work happens.
 *
 * Two decisions shape all of it.
 *
 * It is one document, filtered — not six documents, one per role. A property
 * of twenty-four people has managers who cover a supervisor's morning and
 * administrators who build the rota when the planner is on leave; six separate
 * guides means five of them go stale, and the one somebody reads is whichever
 * they were handed on their first day. Here every section names the permission
 * it belongs to, the screen shows what the reader actually holds, and the rest
 * is listed by name so nobody has to guess whether a thing exists.
 *
 * And it lives in the app rather than in a folder somebody has to be sent. A
 * guide you have to go and find is a guide nobody has read by Thursday.
 *
 * The shape of a block is deliberately small: a paragraph, an ordered list of
 * steps, a plain list, a table, a note, a warning. Anything that needed a
 * seventh kind would be a sign the content was drifting into decoration.
 */

export const GUIDE = [
  // =========================================================================
  {
    key: 'start',
    title: 'Getting started',
    permission: null,
    lede: 'What everybody needs, whatever else they do here.',
    blocks: [

      { sub: 'Putting it on your phone' },
      { p: 'HIVE installs like an app. On Android, open My account and press Install. On an '
        + 'iPhone, press Share — the square with the arrow coming out of the top — then Add to '
        + 'Home Screen; Safari is the only browser on iOS that can do it.' },
      { note: 'Installed, it opens even with no signal — but then it can only show you what it '
        + 'had already. A line across the top says so whenever the server cannot be reached, and '
        + 'nothing you change while it is showing has been saved.' },
      { p: 'Open the site, sign in, and you land on the most useful screen you can actually '
        + 'open. What is in the menu is what your permissions reach — if a tab is not there, '
        + 'you do not hold it, and the section list at the bottom of this guide says who does.' },

      { sub: 'Signing in' },
      { p: 'Two ways, and neither needs anything installed. A PIN is for a phone in a corridor; '
        + 'a password is for whoever also opens the reports. Your administrator sets which you '
        + 'have, and you can change it yourself under your name in the top corner.' },
      { p: 'An administrator has both. The email address and password are the account and cannot '
        + 'be given up; a PIN can be added on top of them, so signing in at the kitchen tablet '
        + 'is a few taps rather than a long password on a wet screen. Either one opens the app. '
        + 'Set or drop it under your name in the top corner, or on somebody else under Users & '
        + 'data.' },
      { warn: 'A PIN is four digits and stops a passer-by, not a determined person. So the '
        + 'password still has work that only it can do: an administrator has to be signed in '
        + 'with it to choose the PIN that guards the payroll, and to set or change their own '
        + 'login PIN. Promoting somebody to administrator also retires the PIN they had, '
        + 'because the digits a supervisor has been using since opening day should not quietly '
        + 'become the keys to the property.' },

      { sub: 'Install it on your phone' },
      { steps: [
        'Open the site in your phone browser.',
        'Share → Add to Home Screen (iPhone), or the menu → Install (Android).',
        'Open it from the icon after that.',
      ] },
      { p: 'It then behaves like an app: full screen, its own icon, and — on iPhone — this is '
        + 'the only way notifications are allowed to work at all.' },

      { sub: 'The bell' },
      { p: 'The count beside the bell is what has happened since you last looked. What you see '
        + 'in it depends on your permissions: an administrator gets clock-time changes waiting '
        + 'for approval, a supervisor gets days that need confirming. Opening the list marks it '
        + 'as read; it does not mark the work as done.' },

      { sub: 'Every screen is live' },
      { p: 'When somebody changes something, every other screen that shows it updates within the '
        + 'second, on every device signed in. Today left open on the office computer is this '
        + 'morning, not the morning it was opened, and a rota two of you are working on is the '
        + 'same rota on both screens. Nothing is on a timer any more, so a page with nothing '
        + 'happening on it sits completely still.' },
      { note: 'It never does it while you are in the middle of something. A box open, a cursor '
        + 'in a field, or a rota with changes you have not saved all hold it off until you are '
        + 'done, and it keeps your place on the page rather than jumping to the top. A phone in '
        + 'a pocket does nothing at all and catches up the moment you look at it.' },

      { sub: 'Printing' },
      { p: 'Anything with a Save as PDF button prints properly: the buttons, menus and tick '
        + 'boxes come off the page and what is left is something you could hand to somebody. '
        + 'Use the browser’s own print if you want the screen as it stands.' },
      { note: 'The lunch sheet prints the count and the names and nothing else. What is being '
        + 'served stays on the screen: the kitchen is cooking it, not reading it off a list, '
        + 'and on paper it pushed the sheet onto a second page.' },
    ],
  },

  // =========================================================================
  {
    key: 'mine',
    title: 'My shifts',
    permission: 'att_me',
    lede: 'Your own week, your own leave, and telling them you are running late.',
    blocks: [

      { sub: 'What you see' },
      { p: 'Your shifts, and only yours. Four weeks at a time, starting on the Monday of '
        + 'whatever week you are looking at, with the arrows to move a month either way and '
        + 'Today to come back.' },
      { p: 'When your next shift is less than a day away, a countdown sits at the top and '
        + 'ticks. Further off than that it is a date rather than a countdown, and the list '
        + 'says it perfectly well.' },

      { sub: 'While you are at work' },
      { p: 'The moment the terminal has you clocked in, the countdown stops and the card turns '
        + 'green: when you clocked in, when you finish, and whether you were early or late. '
        + 'The day itself carries the same banner down the list, so a week with a shift running '
        + 'in it is obvious at a glance.' },
      { note: 'Clocking in twenty minutes before your start time stops the countdown as well. '
        + 'A clock ticking down to a shift you are already standing on is the app arguing with '
        + 'the room.' },
      { p: 'It goes back to a countdown when you clock out, or when the shift finishes.' },
      { note: 'Only shifts that have been published show here. A blank day where you expected '
        + 'something usually means the rota for it is still being worked out — the day says so '
        + 'when that is why.' },

      { sub: 'How the days behind you came out' },
      { p: 'Open "How the days behind me came out" and every past day carries what the app '
        + 'made of it: on time, late by so many minutes, absent, and the clock times it read. '
        + 'This is the place to notice a wrong Tuesday while somebody can still remember it, '
        + 'rather than at the end of the month.' },
      { p: 'If a day is wrong, say so to your supervisor. Clock times are corrected by somebody '
        + 'who can be held to it, and the correction is recorded with their name on it.' },
      { note: 'There is no overtime figure here on purpose. What you are owed is settled when '
        + 'somebody signs the month off, having looked at the whole of it. A running total on a '
        + 'phone would be a number to argue about rather than an answer.' },

      { sub: 'My advance' },
      { p: 'If you have taken a salary advance, My advance shows what is left, what comes off '
        + 'your pay each month, and which payday is the last one. Underneath it is every month '
        + 'so far: what actually came off, and any month where nothing was taken.' },
      { p: 'You can ask for one from the same screen. It is a request and not an agreement — '
        + 'nothing comes off your pay until somebody decides, and you are told either way. '
        + 'While it is still waiting you can take it back.' },
      { p: 'Say what it is for first, because everything else follows from it. School fees and '
        + 'rent go up to 5,000 and are paid back over ten months, and each needs a photograph '
        + 'of the bill or the tenancy agreement attached. Anything else goes up to 1,000 and '
        + 'comes out of your next pay. If you are still paying one back, the small one is the '
        + 'only thing you can ask for.' },
      { note: 'How long you pay it back over is not yours to set — it follows from what the '
        + 'money is for. If you need longer, say so to whoever handles the wages: they can '
        + 'change it, and they are the only ones who can.' },
      { note: 'If a month here does not match your payslip, say so in the same month. The '
        + 'figures are entered by a person, and a mistake is far easier to settle while '
        + 'everybody can still remember the payday it happened on.' },

      { sub: 'My claims' },
      { p: 'If the property gives you a medical allowance, My claims shows how much of this '
        + 'year’s is left and what happened to everything you have sent in.' },
      { p: 'Make a claim takes the bills one at a time: how much, what it was for, when, and a '
        + 'photograph taken on the phone in your hand. The pictures are made smaller before '
        + 'they are sent, so a camera photograph is fine. Ten bills at most on one claim — send '
        + 'the rest as a second one.' },
      { note: 'Nothing comes off your allowance until somebody approves it, and a claim can be '
        + 'approved for less than you asked if part of it is not covered. Either way you are '
        + 'told, with the reason. While it is still waiting you can take it back.' },

      { sub: 'My report' },
      { p: 'Your month, in figures: days worked, hours, how often you were late and by how '
        + 'much, what you were absent for, and what leave it cost you. Pick a different month '
        + 'with the arrows. The day-by-day list underneath is where to look when one of the '
        + 'numbers surprises you.' },
      { note: 'A month nobody has closed off can still change — a corrected clock time moves '
        + 'the figures with it. The screen says which kind of month you are looking at.' },
      { p: 'Whether public holidays are counted is up to the property, and set under Setup, '
        + 'Rules. Left out, they go from the totals and from the day-by-day together.' },

      { sub: 'Asking for leave' },
      { steps: [
        'Press Ask for leave.',
        'Pick the kind, the first day and the last day.',
        'Say why. Your manager reads it.',
      ] },
      { p: 'Only days you are actually rostered on are charged. A request across a weekend you '
        + 'were never working costs you nothing for the weekend. The screen tells you what it '
        + 'came to as soon as you send it.' },
      { p: 'While it is still waiting you can take it back. Once it has been decided you cannot, '
        + 'and the answer shows on the request with whatever your manager wrote.' },

      { sub: 'Days you cannot work' },
      { p: 'This is not leave. Nothing is approved, nothing comes off your balance, and it is '
        + 'not a promise that you will not be put on. It is the fact whoever builds the rota '
        + 'needs in front of them before they choose — and they see it in the cell.' },
      { p: 'A whole day, or a few hours of one. An appointment until nine in the morning and an '
        + 'evening class are different problems, and only the first one clashes with a '
        + 'breakfast shift.' },

      { sub: 'Running late' },
      { p: 'One button. It tells your manager before the shift starts, so somebody can cover '
        + 'you in the meantime, instead of them finding out by looking at an empty station.' },
      { warn: 'It changes nothing on your record. The terminal still decides what time you '
        + 'arrived, and pressing this is a message rather than an excuse note.' },

      { sub: 'Alerts on your phone' },
      { p: 'Turn them on under My account, on each device you want them on: a phone and a '
        + 'computer are two separate permissions, and Apple only allows them at all once the '
        + 'site has been added to your Home Screen.' },
      { note: 'An iPhone older than the XS cannot show them at all \u2014 Apple added alerts '
        + 'for Home Screen apps in iOS 16.4, and those phones stop at 15. My account says so on '
        + 'the phone itself rather than sending you to the Home Screen to find out. Everything '
        + 'still arrives in the bell at the top of the screen.' },
      { p: 'And a published rota reaches those phones another way. If yours cannot show '
        + 'alerts, the same message comes by email where your login has an address on it, '
        + 'and by text to the number on your record. Whoever keeps the records can check '
        + 'the number is right under People.' },
      { table: {
        head: ['What reaches you', 'When'],
        rows: [
          ['Clocked in at 06:20', 'The moment the terminal records your arrival'],
          ['Clocked out at 14:05', 'And your departure, with the hours it recorded'],
          ['Your rota for next week', 'When it is published, rather than on the day'],
          ['Your shift started and nothing is recorded', 'Every half hour until you clock in'],
          ['Your shift ends at 14:00', 'Ten minutes before it does, if you have not clocked out'],
        ],
      } },
      { p: 'The clock-in and clock-out messages say the time that went down and whether it '
        + 'counts as early or late. The terminal beeps and shows your name; it does not tell '
        + 'you any of that, and it does not give you anything to look at three weeks later when '
        + 'a Tuesday is being argued about. This does, on your own phone, at the moment it '
        + 'happens. It goes to you and to nobody else.' },
      { p: 'The two about clocking are the ones worth having. The first waits out whatever '
        + 'grace the shift already allows, stops the moment you clock in, and stops on its own '
        + 'when the shift you were down for has ended.' },
      { p: 'The second arrives ten minutes before your shift finishes, while you are still at '
        + 'work and still walking past the terminal, and only if you clocked in and have '
        + 'not clocked out. Arriving feels like something you do; leaving does not, which is '
        + 'why the tap on the way out is the one that goes missing. A day with only one tap is '
        + 'held back rather than counted, and then somebody has to sit down with you a week '
        + 'later and work out what time you went home.' },
      { note: 'Both are nudges, not marks against you. Nothing about either reaches your '
        + 'record: the terminal decides what happened, as it always does.' },
      { note: 'A tap in the middle of a shift, going for lunch and coming back, does not buzz. '
        + 'Only the first arrival and the last departure of the day do.' },

      { sub: 'Your birthday' },
      { p: 'You will hear from the app on the day. Whether anybody else says anything is up to '
        + 'them, which is how it should be.' },

      { sub: 'How much leave you have left' },
      { p: 'Shown at the top unless the property has turned it off. With it off you can still '
        + 'ask for leave in the ordinary way, and your manager still sees the figures — it '
        + 'simply is not printed on your screen.' },
    ],
  },

  // =========================================================================
  {
    key: 'today',
    title: 'The morning list',
    permission: 'att_view',
    lede: 'Ten minutes with a phone, every day, and the month looks after itself.',
    blocks: [
      { p: 'Today shows everybody who was rostered, what the terminal saw, and what the rules '
        + 'made of it. What needs a decision is at the top; everything else is below it in the '
        + 'order it happened.' },

      { sub: 'The four colours' },
      { table: {
        head: ['Colour', 'Means'],
        rows: [
          ['Green', 'Fine. Nothing to do.'],
          ['Amber', 'Worth a word — late, left a little early.'],
          ['Red', 'Deal with this — absent, or a clock-in or clock-out that never completed.'],
          ['Grey', 'Not yet, or not applicable — a shift that has not started, a rest day.'],
        ],
      } },
      { p: 'Four and not more, on purpose. A colour that has to be explained is not doing its '
        + 'job, and the only three things anybody needs to pick out of a page of names are '
        + '"fine", "worth a word" and "deal with this".' },

      { sub: 'Not due yet, and on shift' },
      { p: 'The night porter due at 22:00 reads Not due yet all day, in grey, and somebody '
        + 'mid-shift reads On shift since 06:02. Neither needs anything from you, and both only '
        + 'ever apply to today — yesterday is judged as it always was.' },
      { note: 'Grace is included. Somebody due at 06:00 with five minutes’ grace is not '
        + 'late at 06:03, and the screen does not say so before 06:05 either.' },

      { sub: 'Taking the list with you' },
      { p: 'Download the ones to deal with gives you the day’s absences, lateness and '
        + 'unfinished days as a spreadsheet — names, departments, shifts, clock times and what '
        + 'each one needs — with the ones waiting on a decision at the top. Last 7 days does '
        + 'the same across the week, for a Monday morning spent on a Friday nobody settled.' },
      { note: 'It is the screen, not the payroll export: no wages, no rates, no leave balances. '
        + 'Which is why anybody who can open this screen can download it.' },

      { sub: 'Birthdays' },
      { p: 'On the day, a line at the top of this screen says whose it is. They have already '
        + 'been wished by the app, quietly and on their own phone; what the line is for is the '
        + 'card.' },
      { steps: [
        'Press Make a card.',
        'Change what it says, if you want to.',
        'Share the card — it goes to your phone\u2019s own share sheet, which is how it reaches '
          + 'a group chat.',
      ] },
      { p: 'Send it through the app is the other half: it tells them and, if you leave the box '
        + 'ticked, everybody else. Once a day per person, whichever way you send it.' },
      { note: 'The picture is drawn on your own device and never leaves it until you send it. '
        + 'Nobody\u2019s age is on it: the record holds a full date because payroll needs one, '
        + 'and a card announcing that somebody is fifty-three is not a kindness.' },
      { p: 'Birthdays only appear for people whose date of birth is on their record, under '
        + 'People. The month ahead is folded under the line, for when a card is being made in '
        + 'advance.' },

      { sub: 'Buttons appear where something is wrong' },
      { p: 'Settle and Times show against days with something wrong with them — absent, late, '
        + 'left early, a punch that never completed, or a day already ruled on. A column of '
        + 'buttons beside twenty-eight ordinary days is a column nobody reads, and the four '
        + 'that matter are lost in it. On a person’s own report, Show buttons on every day '
        + 'reaches the rest.' },
    ],
  },

  {
    key: 'settle',
    title: 'Settling a day',
    permission: 'att_manage',
    lede: 'Deciding what a day was, when the terminal could not.',
    blocks: [
      { steps: [
        'Today, or the person’s own report.',
        'Settle on the row.',
        'Fill in any clock time the terminal missed.',
        'Choose what the day should be recorded as.',
        'Add a note — what they told you, or who confirmed it.',
      ] },
      { p: 'It goes on the record with your name against it, and Undo puts the day back to '
        + 'whatever the rules make of it. The punches themselves are never altered: what the '
        + 'terminal saw stays on the record beside what you decided, and every report shows '
        + 'both.' },

      { note: 'Crediting nothing for a shift somebody worked is the more expensive mistake. If '
        + 'you know they were here until six, say so.' },

      { sub: 'A reason changes the arithmetic' },
      { p: 'Sick leave and absent-without-leave do not count the same way, and what each one '
        + 'costs is set up per property under Setup → Absence reasons. Pick the right one; the '
        + 'reports and the leave balances are built from it.' },

      { warn: 'A ruling survives recomputation. A punch that arrives late updates the times on '
        + 'the record without overturning a decision somebody signed their name to.' },
    ],
  },

  {
    key: 'times',
    title: 'Correcting a clock time',
    permission: 'att_times',
    lede: 'When the person was here and only the minute on the clock is wrong.',
    blocks: [
      { p: 'The correction whoever builds the rota actually needs to make. You are the one who '
        + 'knows the kitchen ran until nine, so you are the one who says so — and it is '
        + 'deliberately smaller than settling a day. It answers one question, when did this '
        + 'person arrive and leave, and nothing else.' },

      { steps: [
        'Today, the person’s own report, or the Sign-off list — whichever you are already on.',
        'Times on the row.',
        'Type what actually happened. Leave alone whichever side the terminal got right.',
        'Say why. It is not optional.',
      ] },

      { warn: 'Unless you also hold Attendance setup, nothing changes until an administrator '
        + 'approves it. The day carries on reading what the terminal recorded and shows '
        + '“change waiting”, so nobody signs the period off without knowing one is '
        + 'coming. Press Times again to replace what you sent.' },

      { p: 'When it is approved, everything else follows on its own — the hours, the lateness, '
        + 'the overtime, what the day is called — and the day is settled there and then. You '
        + 'are never asked to choose any of that. Clearing both boxes asks for the correction '
        + 'to be taken off, which hands the day back to the terminal and reopens it.' },

      { note: 'Every change is recorded with what stood before it, what the terminal itself '
        + 'read, your name, your reason and the time — and it prints at the bottom of that '
        + 'person’s own report, where they can read it. That is not a warning about being '
        + 'watched; it is the reason the permission is safe to hand out. Write a reason '
        + 'somebody could still make sense of in November.' },

      { p: 'Correcting a day inside a period that has already been signed off does not move the '
        + 'figure that was charged. Reopen the period and sign it again if the number should '
        + 'change — the dialog tells you when this applies.' },
    ],
  },

  {
    key: 'times-approve',
    title: 'Approving clock-time changes',
    permission: 'att_setup',
    lede: 'Sign-off → Clock changes. Requests wait at the top.',
    blocks: [
      { p: 'Whoever builds the rota notices the wrong clock time; you decide whether it goes '
        + 'on. Until you answer, the day reads exactly what the terminal recorded.' },

      { steps: [
        'Sign-off → Clock changes.',
        'Read the row: what was asked, what the terminal read, who asked and why.',
        'Record opens that day in full — the shift, the punches, what the rules made of it.',
        'Approve — or Send back, saying what they should do instead.',
      ] },

      { note: 'Look before you approve. The row tells you what somebody typed and what the '
        + 'terminal read, and nothing about whether the shift was even theirs, or whether the '
        + 'same thing happened on the Tuesday. Record is on every waiting row and again inside '
        + 'the approve box, where it opens in its own tab so you do not lose the note you have '
        + 'started typing.' },

      { note: 'A change the planner sends up arrives as a push notification on your phone and '
        + 'not as an email. It is a small decision that wants making today, and a property '
        + 'correcting a dozen clock times a week would be sending a dozen emails into a folder '
        + 'nobody opens. A change an administrator makes themselves is a record rather than a '
        + 'request, so that one still writes.' },

      { note: 'Approving settles the day. The times go on, the day is worked out again from '
        + 'them, and it closes on that verdict under your name. You are not choosing a status: '
        + 'you are approving two clock times, and present, late or absent follows from them. It '
        + 'comes off the sign-off list at the same time.' },

      { p: 'Two things an approval deliberately leaves alone. A ruling somebody else made — a '
        + 'Tuesday a supervisor decided was sick leave — keeps its reason; the times go on and '
        + 'the hours follow, but the verdict stays theirs. And a request with both boxes empty '
        + 'is a correction being taken off: the day goes back to the terminal’s own '
        + 'reading and reopens.' },

      { p: 'Sending it back changes nothing and needs a reason. "No" on its own tells whoever '
        + 'asked nothing about what to do instead, so they will simply ask again.' },

      { p: 'Your own corrections apply straight away. A queue with one name in it teaches '
        + 'everybody to press the button without reading it.' },

      { p: 'Below the queue is everything already applied, with what stood before it, what the '
        + 'terminal read, who asked, who approved and why. Settling a day supplies clock times '
        + 'too and is filed here as well — those apply on the spot, because a supervisor '
        + 'settling a day is already making the decision you would be asked for.' },
    ],
  },

  // =========================================================================
  {
    key: 'rota',
    title: 'The rota',
    permission: 'att_rota',
    lede: 'Who works when. Maintained here, not on the terminal.',
    blocks: [

      { sub: 'Draft, published, past' },
      { p: 'Dashed borders are a draft — you thinking out loud. Press Publish and they turn '
        + 'solid: the version people plan their lives around. Everybody the window changed '
        + 'something for is told on their phone, one message each, saying how many shifts they '
        + 'have and when the first one is. Somebody with nothing that fortnight hears nothing. '
        + 'Change a published day and it goes dashed again; the app offers to '
        + 'republish at once, and asks whether to ring the bell or do it quietly. Quietly is for '
        + 'a typo — a moved shift deserves the bell. Grey days are already behind you.' },
      { p: 'Three ways out, so nobody is missed. An alert where the phone can take one. An '
        + 'email where it cannot, to the address on their login. And a text to anybody the '
        + 'first two miss, which is the only thing that reaches an old iPhone and the only '
        + 'thing that reaches somebody with no login at all. Whoever got the alert does not '
        + 'also get the email; two messages about one rota is how people learn to ignore '
        + 'both. The dialog says afterwards how many were told, how many were texted, and '
        + 'how many could not be reached at all.' },
      { note: 'Texts have to be set up first, under Users & data → Notifications, and they '
        + 'cost money each time. Numbers come from each person’s record under People.' },
      { sub: 'The days stay where you can see them' },
      { p: 'Ask for a fortnight and you get a fortnight on one screen rather than one to scroll '
        + 'sideways through. Past a week the cells give up what the eye can do without: the '
        + 'hours line, the empty name button, most of the padding. Every dropdown still works, '
        + 'and the hours are still on the cell\u2019s own tooltip and in the dialog behind it.' },
      { p: 'The row of days is pinned. Scroll down twenty names and it stays at the top, so the '
        + 'column you are in is still the column you think you are in. On a phone the page '
        + 'scrolls as it always did, a box inside a box being one scroll too many.' },

      { sub: 'Moving a shift' },
      { p: 'Drag a shift out of one box and drop it on another. The drop asks whether you meant '
        + 'to move it or to copy it, because the same gesture means both and guessing would '
        + 'quietly lose one you meant to keep. It works both ways round: across days on one '
        + 'person\u2019s row, or down onto somebody else\u2019s.' },
      { p: 'A day that already has a shift on it keeps it. The one you drop lands beside it and '
        + 'the day is marked as a double. Taking a shift off is its own action, on the card '
        + 'itself, and dropping a shift somebody already has that day changes nothing.' },
      { note: 'It tells you what it is about to do before you choose \u2014 what the shift is, '
        + 'whose day it is landing on, and what it is going to sit beside. Cancel or Escape '
        + 'leaves everything where it was. Answering it saves the change there and then, as does '
        + 'Apply on a shift card: saved is not published, so the week still goes out when you '
        + 'press Publish and not before. Everything else waits for Save. On a phone use the '
        + 'dropdown in the cell; dragging across a grid this wide with a thumb is not worth '
        + 'anybody\u2019s time.' },

      { note: 'On a phone the people view is a list rather than a table: each person gets a '
        + 'line with their name and hours, and their days underneath, seven across. A cell is '
        + 'the start and finish of the shift on its own colour; press one to change it. The '
        + 'whole-period tools \u2014 copy a week, clear a period, import, what changed, suggest '
        + 'a draft, export \u2014 sit behind More, and setting a standing pattern is a desk job '
        + 'that is not offered there. Positions view reads the same way: the position on a line '
        + 'of its own, its days seven across underneath.' },

      { sub: 'Two ways to read it' },
      { p: 'People view is rows of people — where you assign shifts. Positions view turns the '
        + 'same window sideways: rows are shifts, cells are who is on them, which answers "who '
        + 'is opening on Saturday" without reading twenty-four rows. Show a week, a fortnight or '
        + 'four weeks; filter by department or tag; the date box opens a calendar and snaps to '
        + 'the Monday.' },
      { sub: 'The special meal' },
      { p: 'It is the last Friday of every month, and that column is marked on the grid so '
        + 'you know which day you are looking at. On it, anybody who was off last month\u2019s '
        + 'carries a mark of their own, so they go on this one instead of the same people '
        + 'eating together every month.' },
      { note: 'The mark stays after you have put them on. It is a fact about last month '
        + 'rather than a gap \u2014 on a cell with a shift in it, it is the reason they are '
        + 'on it. Leave and a rostered day off both count as having missed it; somebody who '
        + 'was not hired yet has missed nothing.' },

      { sub: 'Choosing who works a shift' },
      { p: 'Open a card and the list of people is grouped by what stands in the way: free '
        + 'that day, already on something, not set up for that department, cannot work it. '
        + 'Each group carries a count, each name carries the hours they are already down for, '
        + 'and the reason sits under the name in the colour that says whether it matters. '
        + 'Type to search once the list is longer than the eye wants to scan.' },
      { note: 'Nobody is hidden. Somebody out of department, or already on a shift that day, '
        + 'is still offered with the reason against them \u2014 covering a gap with whoever is '
        + 'standing there is a real Saturday, and the answer to it is a warning rather than '
        + 'an empty list.' },

      { sub: 'When somebody cannot work' },
      { p: 'The ✕ button on their row marks days they cannot work (or asked to work), with the '
        + 'reason. Not leave — nothing is approved and no entitlement is spent. The mark shows '
        + 'in the cell before you choose, and you can still roster over it: some conflicts are '
        + 'deliberate, and the grid shows them rather than pretending they cannot happen.' },
      { steps: [
        'Rota. You see a fortnight at a time.',
        'Copy a week from the one before — most weeks are last week with two changes.',
        'Shifts nobody is on yet come with it, so the week keeps its shape.',
        'Fix the two. Grey cells follow the standing pattern; black ones were set by hand.',
        'Save the rota. Nothing is written until you do.',
      ] },

      { note: 'Today\u2019s column is marked on both views: a rail down each side and the word '
        + 'in the header. Each Sunday cell carries how many of that month\u2019s Sundays the '
        + 'person is on, counting what they actually worked on the days already gone.' },

      { sub: 'What staff have asked for' },
      { p: 'Availability a member of staff sends from their own screen arrives as a request '
        + 'rather than a fact. Asked for on the toolbar carries the count of what is waiting; '
        + 'open it, and approve or turn down each one. Approving puts the mark in the cell and '
        + 'tells them it was approved. Turning it down tells them that too, with your reason. '
        + 'What you write on somebody\u2019s behalf is already the decision, so it goes in.' },

      { sub: 'Taking the rota out' },
      { p: 'Export writes the period on screen out as a spreadsheet file: a line per shift with '
        + 'the date, the name, the department, the shift, its hours, and whether the row is '
        + 'published, still a draft, a day off, the standing pattern or leave. Drafts come out '
        + 'too, marked as drafts, so nothing has to be published before it can leave the screen.' },

      { note: 'A shift that runs into the night carries a moon beside its time, and a face '
        + 'beside every name that has one. Staff add their own picture from My picture on their '
        + 'screen; anybody without one keeps their initials.' },

      { sub: 'Who changed this shift' },
      { p: 'Every change to the rota is kept: who made it, when, and what the day said before. '
        + 'What changed on the toolbar reads the whole window newest first, and the same trail '
        + 'is at the bottom of any cell or card you open.' },
      { p: 'Copying a week, confirming an import, accepting a draft, publishing and taking '
        + 'somebody off the rota all leave their own entry, so a change nobody remembers making '
        + 'usually turns out to have a name against it. A day following a standing pattern has '
        + 'nothing to show, which is the honest answer: nobody changed it.' },

      { sub: 'Letting it draft one for you' },
      { p: 'Suggest a draft reads the weeks behind this one and fills the days nothing has been '
        + 'said about. It aims at what each shift asks for under Setup → Shifts; where a shift '
        + 'has not said, it copies what the last few weeks actually did, and empty cards already '
        + 'standing on a day are filled rather than doubled. Nothing it proposes is published.' },
      { p: 'Whatever it could not fill is listed before you accept it, shift by shift, with the '
        + 'reason nobody was free. That list is the work left to do by hand.' },

      { sub: 'Two shortcuts worth knowing' },
      { list: [
        '⇢ beside a name puts one shift across the whole fortnight on whichever weekdays you tick.',
        'Pattern sets what somebody normally works. Set it once and it answers for every week, '
          + 'past and future, including rotations of up to twelve weeks.',
      ] },

      { note: 'Every shift shows its hours wherever one is picked. Four shifts called some '
        + 'variation of Housekeeper Helper are told apart by the clock and nothing else. A '
        + 'night shift reads 17:30–06:30 +1 — thirteen hours across two dates.' },

      { sub: 'Importing a week' },
      { p: 'If the rota is built elsewhere, Import a week takes a CSV export or a printed '
        + 'schedule as a PDF. It lands as a draft: nothing is written until you have read what '
        + 'it would do, name by name.' },
      { warn: 'A name the import does not recognise is never created. Add the person under '
        + 'Setup → Staff first. And a PDF printed from a phone usually has no text in it at all '
        + 'and cannot be read — print it from a computer.' },

      { sub: 'Two things that trip people up' },
      { list: [
        'Off is a decision. A day set to Off is a rostered rest day, which is not the same as '
          + 'somebody simply not being on the rota, and the reports treat them differently.',
        'Leave cannot be overwritten. Days on approved leave are locked in the grid — cancel '
          + 'the leave first.',
      ] },

      { sub: 'Two shifts on one day' },
      { p: 'Putting somebody on a second shift no longer takes the first one away. Both are '
        + 'kept and both are marked: a ⚠ on each card in Positions view, and the second shift '
        + 'listed under the dropdown in People view with an ✕ to drop it. The mark stays until '
        + 'one of them goes.' },
      { warn: 'It is almost always a mistake — two people filling the same rota from two ends '
        + 'of the property — so the app keeps both and says so rather than choosing for you. '
        + 'While it stands, the day is worked out against the earlier of the two shifts, which '
        + 'is another reason to settle it.' },
      { note: 'Setting a day to Off still clears the whole day. Somebody given the day off is '
        + 'not also working the evening.' },

      { sub: 'A shift with nobody on it' },
      { p: 'In Positions view, the + on a cell puts a shift on a day whether or not you have '
        + 'anybody for it yet. Choose Nobody and it stands there as an empty card until '
        + 'somebody takes it, which is how "Thursday breakfast still needs covering" gets '
        + 'written down instead of remembered.' },
      { list: [
        'Taking a person off a card leaves the card. Open it, choose Nobody, and the shift '
          + 'stays on the day with nobody in it.',
        'To take the shift off the day altogether, tick "Take this shift off the day" in the '
          + 'same box.',
        'A shift needing two people is two empty cards.',
        'Deleting the shift itself under Setup → Shifts takes its empty cards with it. That is '
          + 'the only thing that removes one without somebody saying so.',
      ] },

      { sub: 'Positions' },
      { p: 'Several shifts that are really one job — three breakfast shifts that differ only '
        + 'in when they finish — can be put under one position, and the rota reads by position '
        + 'as well as by person. Tick them in Setup → Shifts and press "Put under one '
        + 'position".' },
      { p: 'Every position you have named is listed under the shifts, with Edit beside it. '
        + 'That is where a position is renamed, or a shift added to one or taken out of it, '
        + 'without opening each shift in turn. Shifts under a position stack earliest first, '
        + 'so a group reads down the day.' },

      { sub: 'Workload: how the rota is treating people' },
      { p: 'One row per person, all on the same scale, sortable by any column. Ask it for a '
        + 'fortnight while you are building one, a month for the questions that only make sense '
        + 'over a month, or any range you like up to a quarter. Press a row for what is behind '
        + 'the figures.' },
      { p: 'Sundays are counted in the month view: how many of the Sundays that went past were '
        + 'theirs, out of how many there were. A Sunday on leave counts as one they got. The '
        + 'app expects everybody to get at least one a month and says so when somebody has not '
        + 'had theirs, which is the figure that otherwise goes unnoticed until somebody '
        + 'complains. Set the number, or turn it off, under Setup → Workload.' },
    ],
  },

  {
    key: 'leave',
    title: 'Leave',
    permission: 'att_view',
    lede: 'Requests, approvals and what is left.',
    blocks: [
      { p: 'Anybody who can touch the rota can put a request in for somebody. Approving is a '
        + 'separate permission, and so is seeing how much leave anybody has left — a rota built '
        + 'around who is running out of days is a rota built around the wrong thing.' },
      { p: 'Approved leave locks those days on the rota so nobody rosters over them by '
        + 'accident, and shows the shift’s hours rather than nothing, so a fortnight off '
        + 'does not read as a fortnight of zero.' },
      { note: 'Entitlement is set under Setup → Rules and starts at the statutory fifteen '
        + 'working days after a year’s service (Labour Act 2003, s.20).' },

      { sub: 'Asking before the rota reaches that far' },
      { p: 'A rota is built a fortnight out; leave is booked months out. So a request does not '
        + 'need the days to be rostered yet — somebody can ask in August for a week in '
        + 'December, which is when a property most wants to hear about it.' },
      { list: [
        'Where the standing pattern answers, the days are counted from it and the figure is '
          + 'a real one.',
        'Where nobody has a pattern and nothing is rostered, the figure is worked out from the '
          + 'days a week the property expects, and shown as an estimate — "5 est." on the row.',
        'Approving counts it again against the rota as it stands then, offers that number, and '
          + 'lets you charge more than the estimate said if the real week turned out longer. '
          + 'Once decided it is a figure, not an estimate.',
        'A span somebody has already been through by hand is not guessed at: the days they '
          + 'left empty are days off, not gaps.',
      ] },
      { note: 'The one request still refused is a span that is entirely rest days and public '
        + 'holidays for that person — those days are already theirs, so there is nothing to '
        + 'take.' },

      { sub: 'What kind of leave it is, is yours to say' },
      { p: 'Whoever asks picks the option they know the name of, which is usually annual '
        + 'leave. What it actually costs — whether it is paid, and whether it comes off the '
        + 'entitlement — follows from the type, and that is the property’s decision.' },
      { list: [
        'Approving asks for the type as well as the days charged, starting on whatever they '
          + 'asked for.',
        'Press the type on any row to change it afterwards, pending or approved. On an '
          + 'approved one the days are worked out again, so the pay and the balance follow.',
        'The person is told, because it may have changed what they are paid and what they have '
          + 'left.',
        'A rejected request keeps the type it was asked with. Nothing happened, so there is '
          + 'nothing to correct.',
      ] },
      { p: 'The list of types itself is under Setup → Absence reasons, where each one says '
        + 'whether it is paid, whether it counts as a day worked, whether it comes off the '
        + 'annual entitlement and whether it needs a note. Add your own — study leave, '
        + 'quarantine, anything the property actually gives.' },

      { sub: 'What staff see on Ask for leave' },
      { p: 'Not every kind of leave belongs on a dropdown at the end of a shift. Maternity '
        + 'leave is arranged in an office; nobody asks to be suspended; a property that '
        + 'records unpaid leave may not want it offered beside the paid one. Each kind of '
        + 'leave now carries "Staff can ask for this themselves" — set it under Setup → '
        + 'Absence reasons and the ones you say no to come off their list.' },
      { note: 'It changes nothing about what you can record for somebody. Whoever manages '
        + 'leave still has every type, which is the whole point of the difference. Everything '
        + 'is on their list until you take it off.' },

      { sub: 'The month, day for day' },
      { p: 'Five figures per person, and they reconcile: over / under is Worked plus On leave, '
        + 'less Calendar. A row that comes to nothing is somebody who gave the month exactly '
        + 'what it asked for.' },
      { table: {
        head: ['Column', 'What it counts'],
        rows: [
          ['Calendar', 'What the month expected: five days out of every seven, less a whole day for each public holiday.'],
          ['Rostered', 'What the rota actually asked of them. There for comparison; it does not enter the arithmetic.'],
          ['Worked', 'Days clocked in and out of. Whole days only — a tap in with no tap out is not a day worked.'],
          ['On leave', 'Days on approved leave.'],
          ['Over / under', 'Worked plus On leave, less Calendar. This is the figure the sign-off proposes.'],
        ],
      } },
      { p: 'Five out of seven rather than Monday to Friday, because the rota runs across all '
        + 'seven days and a Saturday is an ordinary working day for half the staff. Counting '
        + 'only weekdays would leave the night porter permanently over for doing exactly what '
        + 'was asked of him.' },
      { p: 'Where that is not what a particular month asked of a particular person — somebody '
        + 'covered the season on six days, a kitchen closed for a fortnight, somebody came back '
        + 'part-time for three months — press the Calendar figure on their row and say what the '
        + 'month actually expected. It applies to that month and that person only, and clearing '
        + 'it hands the month back to the ordinary rule.' },
      { p: 'The general shape can also be set: a days-a-week figure per person under '
        + 'Setup → Staff, with a property default under Setup → Rules. Use that for a contract '
        + 'that is simply not five days; use the monthly figure for a month that was unusual.' },
      { note: 'Every figure on a row can be pressed to see the days behind it. An absence '
        + 'counts whether or not anybody has settled it — a working day nobody delivered is a '
        + 'working day nobody delivered — and the count beside the over / under says how many '
        + 'are still waiting on a supervisor to say what happened.' },
      { warn: 'Somebody the rota never asked for anything of — a starter whose first week is '
        + 'next week, somebody who has left — is not shown as owing the month. Days they did '
        + 'work still count in their favour.' },
    ],
  },

  {
    key: 'pay',
    title: 'Pay and labour cost',
    permission: 'hr_pay',
    lede: 'What each person costs, and what the rota costs because of it.',
    blocks: [
      { p: 'Set on a person’s record, under People. Three ways to be paid, because a hotel has '
        + 'three: monthly for salaried staff, daily for casuals engaged under the Labour Act’s '
        + 'sections 74 to 77, and hourly where hours are what is actually being bought.' },

      { sub: 'A rate has a date' },
      { p: 'You give a rate the day it starts, and the old one stays on the record. The cost of '
        + 'a Tuesday in March is worked out at the rate in force on that Tuesday, not at today’s. '
        + 'Without that, a rise in June quietly rewrites what January cost, and the report you '
        + 'printed at the time stops agreeing with the app that produced it.' },
      { note: 'Correcting a mistake is not the same as giving a rise. Re-enter the rate with the '
        + 'same start date and it replaces what was there; enter it with a new start date and the '
        + 'app treats everything before it as having genuinely cost the old amount.' },

      { sub: 'Salary is not an hourly rate in disguise' },
      { p: 'A monthly wage does not go up because somebody worked a sixth day. So cost is shown '
        + 'in two parts: what the period costs whatever the rota says, and what the rota itself '
        + 'adds. The second is the only part you can change by moving shifts around — and burying '
        + 'it inside one total is how a property ends up trying to save money by cutting shifts '
        + 'that cost nothing.' },
      { p: 'A casual is the other way round: nothing on a day nobody called them in, and the full '
        + 'daily rate on a day somebody did. That is where a rota decision shows up in the bank.' },

      { sub: 'Overtime' },
      { p: 'The Labour Act requires this property to have fixed rates for overtime (s.35); it '
        + 'does not fix them for you. The app starts at the customary Ghanaian rates — one and a '
        + 'half ordinarily, double on a public holiday — and they are yours to change under '
        + 'Setup. They are the property’s rates, not the law’s, and the app says so wherever it '
        + 'shows them.' },
      { note: 'A salaried person working a public holiday still costs the property something, '
        + 'even though their salary does not move. That premium is counted.' },

      { sub: 'Who can see any of this' },
      { p: 'Its own permission, held by nobody by default except an administrator — not even a '
        + 'manager, who holds employee records as a matter of course. What a colleague earns is a '
        + 'different order of confidence from where they live. Grant it to whoever does the '
        + 'wages, and to nobody else.' },
    ],
  },

  {
    key: 'advances',
    title: 'Salary advances',
    permission: 'hr_pay',
    lede: 'What was lent, what has come back, and what is still to come off.',
    blocks: [
      { p: 'A hotel lends money whether or not an app knows about it. What goes wrong is never '
        + 'the lending: it is that four months later nobody can say what is left, because the '
        + 'record was a figure in a notebook and two people remembering different Junes.' },

      { sub: 'Giving one' },
      { p: 'Give an advance takes who, how much, and how many months. The monthly deduction is '
        + 'worked out for you and you can change it — it is a term of the agreement, not a sum '
        + 'the app insists on. Money handed over late in a month starts coming back the month '
        + 'after, because that month’s payroll is usually already worked out.' },
      { note: 'The person is told on their phone the moment it is recorded, and it appears on '
        + 'their own screen with the whole schedule. Money coming off a payslip that nobody '
        + 'mentioned is how this arrangement loses people’s trust.' },

      { sub: 'Ones that were already running' },
      { p: 'Bulk upload takes a sheet of advances a property was already running before HIVE '
        + 'saw them. Download template first: what comes down is whatever is on the books '
        + 'already, so a correction is a changed cell rather than a file somebody builds. '
        + 'Employee number and amount are the two columns it needs; months, the monthly '
        + 'deduction, the date it was taken, the month repayment starts, the purpose and what '
        + 'it was for are all optional and worked out where the sheet does not say.' },
      { p: 'Already repaid is the column that matters most. A running advance has had money '
        + 'come off it, and without that figure the app would set about recovering the whole '
        + 'thing again. It goes on as one adjustment rather than as invented monthly '
        + 'repayments: the property knows what it has recovered, it does not necessarily know '
        + 'which months it came out of, and writing months nobody can vouch for puts figures '
        + 'in the ledger that nothing supports.' },
      { note: 'Nobody is told. Recording an advance by hand sends the person a message because '
        + 'money has just been agreed; a sheet of advances running since March is not news to '
        + 'anybody, and eleven of those messages in one afternoon is how people learn to '
        + 'ignore the app.' },
      { note: 'It creates nobody, and it records nothing twice. A staff number the register '
        + 'does not know is skipped and named. One person, one amount and one date is taken to '
        + 'be the same advance, so a sheet run again after a correction adds what is new and '
        + 'leaves the rest alone — without that, a second run of a twelve-line file doubles '
        + 'everybody\u2019s deductions and nobody finds out until payday.' },

      { sub: 'The end of the month' },
      { p: 'On the last day of every month the app asks whether the deductions were actually '
        + 'taken. Everybody is ticked to start with, since that is the ordinary month: untick '
        + 'anyone it did not come off, change the figure where it came off differently, and '
        + 'press once. A month you miss is asked about again on the 7th and the 14th.' },
      { p: 'Answer it honestly rather than tidily. A month marked as taken when payroll never '
        + 'took it is a ledger that disagrees with the payslips, and by the third month nobody '
        + 'believes either of them.' },

      { sub: 'Changing things' },
      { list: [
        'Change the terms: what comes off each month from here on. It does not change what is '
          + 'owed, only how long it takes, and the person is told.',
        'Add a movement: a payment made in cash, a correction, a month deliberately let go, or '
          + 'the rest of it written off.',
        'The ✕ beside a movement takes it back off, and what is owed goes back up. Use it for '
          + 'something entered wrongly rather than for something that did not happen — those '
          + 'are two different records.',
      ] },

      { sub: 'Requests, and what may be asked for' },
      { p: 'Somebody can ask through the app, and it waits at the top of this screen. '
        + 'Approving is also where the terms are settled: what was asked for and what the '
        + 'property can do are often two different numbers, and the answer should be the '
        + 'agreement rather than a refusal and a second conversation.' },
      { list: [
        'School fees and rent go up to 5,000, are paid back over ten months, and will not '
          + 'send without a copy of the bill or the tenancy agreement attached. Open it before '
          + 'you decide.',
        'Anything else goes up to 1,000 and comes back out of the next pay packet. Over 1,000 '
          + 'the app stops offering it, because above that the property wants to know what the '
          + 'money is for.',
        'Somebody already paying one back can only ask for the small one. A second ten-month '
          + 'advance on top of a running one is how a person ends up with no pay packet at all.',
      ] },
      { note: 'The repayment period is nobody’s to set but yours. It follows from what the '
        + 'money is for, and the box for it is on the approval — change it there, or later '
        + 'with Change the terms.' },
      { p: 'None of this binds you when you are recording one you have already handed over. '
        + 'The caps and the paperwork are rules about what staff may ask for; writing down '
        + 'what has happened is a different thing.' },

      { note: 'Nothing here charges interest and there is nowhere to set any. What was lent is '
        + 'what comes back.' },

      { warn: 'The app does not touch the payroll. It records what somebody says happened, and '
        + 'whoever runs the wages still has to take the deduction. The two are kept apart on '
        + 'purpose: an app that assumed the money moved would be writing fiction into a ledger '
        + 'people are held to.' },
    ],
  },

  {
    key: 'medical',
    title: 'Medical claims',
    permission: 'hr_pay',
    lede: 'The year’s allowance for each person, and the bills claimed against it.',
    blocks: [
      { sub: 'Setting the year' },
      { p: 'Set the year’s allowances opens one form with everybody on it. Tick who qualifies, '
        + 'type what they get, and there is a box at the top to give everybody ticked the same '
        + 'figure at once. Press it once and the year is set.' },
      { p: 'The starting balance is what somebody actually has to spend: this year’s allowance '
        + 'plus anything carried forward from the previous period. Leave it blank where there '
        + 'is nothing to carry. Fill it in where there is — or where part of the year has '
        + 'already been claimed on paper, in which case it is less than the allowance.' },
      { note: 'Unticking somebody takes the year off them and leaves their claims alone. What '
        + 'was paid does not stop being true because the arrangement ended.' },

      { sub: 'Deciding a claim' },
      { p: 'A claim arrives with its bills — up to ten of them, each with an amount, what it '
        + 'was for and usually a photograph you can open. The person’s remaining balance is '
        + 'shown beside it, because a claim on its own is a number to say yes to and a claim '
        + 'beside a balance is a decision.' },
      { list: [
        'Approve the whole thing, or type a smaller figure where part of it is not covered. '
          + 'Both numbers are kept and the person is told which is which.',
        'Approving more than is left in somebody’s allowance takes a deliberate tick. The '
          + 'property can decide to cover it; the app will not do it quietly.',
        'Turning one down asks for a line saying why, and they get it.',
      ] },
      { warn: 'A bill with no picture is marked as such. It can still be approved — somebody '
        + 'may have brought the paper one to the office — but you are taking it on trust and '
        + 'the screen says so rather than letting it look like evidence.' },

      { note: 'Nothing here pays anybody. It records what was agreed and what is left; the '
        + 'money still goes out the way it always did.' },
    ],
  },

  {
    key: 'payroll',
    title: 'Payroll',
    permission: 'hr_pay',
    lede: 'The month worked out under Ghana’s tax law, and a payslip for each person.',
    blocks: [
      { sub: 'Getting in' },
      { p: 'What people are paid is the one thing in here that cannot be un-seen, so it is not '
        + 'opened by a tick on a login. There are four locks and all four have to be open.' },
      { list: [
        '"Pay and labour cost" on the login. That says somebody is the kind of person who '
          + 'might, and nothing more.',
        'A grant, made under Users & data, "Who may open the payroll". That says they may at '
          + 'the moment, and it has an end date on it.',
        'A code, which the app shows you once when you grant it. They type it the first time '
          + 'and choose a payroll PIN with it.',
        'That PIN, every single time the Payroll tab is opened. It is their own, it is not the '
          + 'PIN they sign in with, and clicking away from the tab shuts the payroll behind '
          + 'them.',
      ] },
      { p: 'Administrators are granted nothing, because they are the ones who grant. They do '
        + 'set a payroll PIN like everybody else, and they are asked for it just as often: an '
        + 'office machine left signed in is exactly what the PIN is for.' },
      { list: [
        'The first time an administrator opens Payroll it asks them to choose a PIN. No code, '
          + 'but they do have to be signed in with their email address and password: a login '
          + 'PIN is not enough to set the one that guards the payroll.',
        'Change your own from the Payroll screen: the PIN button beside the month. You need '
          + 'the one you are using now.',
        'Forgotten it? An administrator resets it under Users & data and the person chooses '
          + 'another. Staff need their code again to do that, so hand it over with the reset.',
        'Five wrong tries shuts it for half an hour, so guessing is not free.',
        'Grant it again to change somebody\u2019s end date or to replace a code they have lost. '
          + 'Their PIN is their own and survives it.',
        'Take it away and it stops the moment you press it, even if they are looking at the '
          + 'payroll as you do.',
      ] },
      { warn: 'Only fingerprints are kept, never a code or a PIN. A lost one is replaced rather '
        + 'than looked up, which is why nobody can read one out of a backup. If the only '
        + 'administrator forgets theirs, the recovery login in the worker\u2019s secrets is the '
        + 'way back in.' },

      { p: 'Everything the app already knows — what somebody is paid, what they scored on '
        + 'their bonus schemes, what came off for misconduct, what they are repaying — comes '
        + 'together once a month and turns into a payslip.' },

      { sub: 'Setting it up, once' },
      { steps: [
        'Set pay and allowances: tick everybody the payroll covers, give their monthly basic, '
          + 'and untick SSNIT for anybody the scheme does not cover.',
        'Allowances are a line each, because a payslip has to say what the money was for. '
          + 'Untick "taxable" for a genuine reimbursement.',
        'New scheme: what a bonus scheme is worth at a hundred per cent, and who is under it. '
          + 'Somebody can be under several or under none.',
        'Tick every department the scheme covers, and more than one is fine: the kitchen '
          + 'and the bistro can share one service bonus. The list groups on what a scheme '
          + 'covers, and every group starts folded so scoring one is not a scroll past the '
          + 'other five.',
      ] },
      { note: 'Tick a department and only its people are offered when you say who is under '
        + 'the scheme; tick two and you get both. Anybody already ticked from somewhere else '
        + 'stays on the list, marked, so moving a scheme never quietly takes somebody\u2019s '
        + 'bonus away.' },
      { note: 'A scheme with no department at all covers the whole property and sits under General. '
        + 'Those are scored once: whether the year was a good one is the same answer for '
        + 'everybody it covers, so it is asked once and everybody under it gets it. A scheme '
        + 'that belongs to a department is still scored person by person, because different '
        + 'people did different amounts of the thing it is about.' },
      { note: 'What a scheme is worth is a net figure — what the person actually receives. The '
        + 'tax on it is worked out at payroll and carried by the property, which is what '
        + '"grossing up" on the payslip means.' },

      { sub: 'Every month' },
      { steps: [
        'Score each person on each scheme. Half the score is half the money.',
        'Take money off a bonus where there has been misconduct, with the reason. It is a net '
          + 'figure, it comes off the bonus and never off the salary, and the person is told '
          + 'the day it is entered rather than on payday.',
        'Read the month down the table. Press any row for the payslip behind it.',
        'Close the month. Every payslip is written down as it stands and the advance '
          + 'deductions are recorded against the balances they came off.',
      ] },
      { warn: 'A closed month does not recompute. Give somebody a rise in November and '
        + 'October’s payslip is untouched, which is the point — a payroll that rewrites '
        + 'history is one nobody can be held to. Reopening a month takes back the payslips and '
        + 'exactly the advance deductions the payroll recorded, and nothing else.' },

      { sub: 'Starting a month from the one before' },
      { p: 'Most of a month\u2019s scoring is last month\u2019s scoring with two or three lines '
        + 'changed, and typing thirty scores again to change two is how a wrong one gets typed. '
        + 'Start from last month brings the scores across and you touch only what moved.' },
      { list: [
        'Salaries, allowances and who is under which scheme are standing things, not monthly '
          + 'ones. There was never anything to copy there and there still is not.',
        'Money taken off for misconduct does not come across unless you tick for it. It belongs '
          + 'to the month it happened in, and carrying it forward would dock somebody twice.',
        'Anybody taken off a scheme since, or who has left, is left out. Scores already typed '
          + 'into the month are replaced rather than added to.',
      ] },

      { sub: 'Whose pay moved, and by how much' },
      { p: 'Beside every net figure is what that person was paid in another month and the per '
        + 'cent between the two. Last month unless you pick a different one with the box above '
        + 'the table \u2014 the same month last year, or the month before a pay review. A '
        + 'column of net figures says what everybody is being paid and nothing about which of '
        + 'them is worth a second look; the per cent is what finds those lines before the '
        + 'month is closed.' },
      { p: 'The bottom row does the same for the whole month, over the people who were on '
        + 'both. A property that took on four people would otherwise read as a rise in '
        + 'everybody\u2019s pay.' },
      { note: 'A closed month is compared on what it actually paid. A month still open is '
        + 'compared on what it comes to today, marked with a star, because those figures can '
        + 'still move. A month nobody ever ran has nothing to compare against and says so, '
        + 'rather than answering "nothing has changed" about a month nobody was paid in.' },

      { sub: 'From a spreadsheet' },
      { p: 'A month\u2019s figures can come in from a sheet instead of being typed. Bulk '
        + 'upload \u2192 Download template gives you this month as it stands, not a blank '
        + 'form: a row per person, and a column for the basic, each allowance the property '
        + 'uses, and a score against each scheme somebody is under. Change what changed and '
        + 'send it back with Upload a file.' },
      { p: 'What it would do sits on the screen until you agree to it, person by person and '
        + 'figure by figure. Nothing is written before you press the button.' },
      { list: [
        'Rows are matched on employee number, or on the name where there is no number. A name '
          + 'the register does not know is skipped and listed; nobody is created from a sheet.',
        'A scheme column has to be one of your own. Anything else is named back and left '
          + 'alone rather than making a new one.',
        'An allowance column can introduce one the property has not used before, as long as '
          + 'the heading says what it is: "Allowance: Transport", or "Allowance: Transport '
          + '(not taxable)" for a reimbursement. A bare heading is never turned into money on '
          + 'a payslip \u2014 it is named back like any other column nobody recognised.',
        'An allowance for somebody who is not on the payroll yet is reported rather than set. '
          + 'It would never reach a payslip, so setting it would look like it worked and do '
          + 'nothing.',
        'A blank cell leaves a figure alone. A nought is a nought, so a nought against an '
          + 'allowance takes it away.',
        'A score against a scheme somebody is not under is refused, and so is one outside 0 to '
          + '100.',
      ] },
      { warn: 'The advance column is read and checked, never written. An advance is an '
        + 'agreement with a balance behind it and the payroll takes the instalment that '
        + 'agreement says. Where the sheet disagrees with the books it says so, and the books '
        + 'win. Advances are still granted and settled under Advances.' },

      { sub: 'The journal and the PAYE schedule' },
      { p: 'Journal and PAYE, on the month, opens the two returns the month has to produce. '
        + 'Nothing here posts to a ledger or files anything: it is a sheet to type from and a '
        + 'sheet to file from, and it prints or saves as PDF from the bar at the top.' },
      { list: [
        'The journal is the month\u2019s entry, balanced, with the debits above the credits the '
          + 'way it is written.',
        'Social security is shown as it is actually paid. The 18.5% of basic is one deduction '
          + 'and two payments: 13.5% to SSNIT as the first tier and 5% to your second-tier '
          + 'trustee, on separate forms to separate people.',
        'The PAYE schedule is the GRA\u2019s own columns in the GRA\u2019s own order, so it '
          + 'reads straight across into the return.',
        'A bonus is split on it. The part inside the 15% ceiling sits under Bonus at 5% with '
          + 'its own tax beside it; anything past the ceiling is the excess bonus, which is '
          + 'income rather than a separate tax and is already inside the chargeable income '
          + 'next to it.',
      ] },
      { note: 'The row reconciles across: total cash emoluments, less the bonus taxed at 5%, '
        + 'less the SSF contribution and any relief, is the chargeable income. Tax on that '
        + 'plus the tax on the bonus is the total PAYE.' },
      { warn: 'The schedule lists anybody whose TIN or SSNIT number is missing from their '
        + 'record, by name, because the return cannot be filed without them and a count does '
        + 'not tell you whose record to open. Tax relief is left empty: it is claimed on a '
        + 'certificate the GRA issues to the person, and a payroll that guessed at it would '
        + 'be filing a claim nobody made.' },

      { sub: 'The payslip' },
      { warn: 'Somebody else\u2019s payslip is an administrator\u2019s to open, whatever else '
        + 'they hold. Running the payroll means seeing what the month comes to for each person, '
        + 'and there is no way round that. Reading their slip is a different thing: the '
        + 'allowances named one by one, which schemes they scored on, which tax band each part '
        + 'of their pay fell in. Anybody but an administrator is not shown it, and is not sent '
        + 'it either.' },
      { p: 'One page, always. It is drawn at A4 and everything on it shrinks together until it '
        + 'fits, so somebody with a dozen allowances and two advances running gets smaller type '
        + 'rather than a second sheet that will be separated from the first and lost.' },
      { steps: [
        'Press any row in the month for that person\u2019s payslip.',
        'Print or save as PDF from the bar at the top.',
        'Or press "All N payslips" on the month itself, which lays out everybody, one page each, '
          + 'ready for the printer.',
      ] },
      { p: 'It is headed by the company: the logo, the name, the registered name if it differs, '
        + 'the address, a telephone number, the TIN and the employer\u2019s SSNIT number. Set '
        + 'those under Setup, then Company. Anything left blank there is simply left off the '
        + 'page rather than printed as an empty label.' },
      { note: 'Earnings on the left, deductions on the right, the net in the band between them, '
        + 'and the working underneath: how the bonus came out and which tax band each part of '
        + 'the pay fell in. Somebody who wants to check the figure can.' },

      { sub: 'What the app works out' },
      { list: [
        'SSNIT: 5.5% from the worker and 13% from the property, on basic salary, and the '
          + 'worker’s half comes off before tax.',
        'PAYE on the GRA’s graduated monthly bands, on gross pay less that contribution. The '
          + 'payslip shows how much fell in each band.',
        'Bonus at 5% as a final tax up to 15% of annual basic salary, with anything above that '
          + 'added to income at the graduated rates. The 15% is annual, so earlier months this '
          + 'year are counted first.',
        'Salary advances come off after tax — it is the person’s own money going back, so it '
          + 'changes nothing about the tax or what they cost.',
        'Cost to the property: gross pay plus the employer’s SSNIT.',
      ] },
      { p: 'All of those figures are under Setup → Tax and SSNIT, including the band table '
        + 'itself. They change with the budget, and the table used is printed on every payslip '
        + 'so a slip can be checked against the figures it was worked out on.' },
      { sub: 'When the figures change' },
      { p: 'A tax table is a fact about a period, not about the property: the bands that '
        + 'applied in January are the January bands however many budgets have happened since. '
        + 'So a change is saved with the month it starts in, and everything behind that month '
        + 'keeps whatever was in force then. Tables by date, at the bottom of the same screen, '
        + 'lists every set of figures the property has used.' },
      { p: 'A closed month never moves whatever you change: closing writes every payslip out '
        + 'in full and the screen, the payslip, the journal and the GRA schedule all read '
        + 'those afterwards. A month still open, and one reopened to correct something, uses '
        + 'the table that was in force for that month rather than today\u2019s — so reopening '
        + 'January in July gives it January\u2019s figures back.' },
      { warn: 'What is not in here: the overtime tax for qualifying junior staff, personal '
        + 'reliefs claimed on a tax credit certificate, and tier-three voluntary contributions. '
        + 'Each is a rule about one person’s circumstances, and guessing at them would put a '
        + 'wrong figure on a payslip somebody is held to.' },
    ],
  },

  {
    key: 'rota-read',
    title: 'Reading the rota',
    permission: 'att_rota_view',
    lede: 'Who is on, week by week, for everybody. Nothing on it can be changed.',
    blocks: [
      { p: 'The Rota tab shows the same grid the planner builds on: people down the side, days '
        + 'across, and a shift in each cell with its hours. Switch to Positions to read it the '
        + 'other way round \u2014 rows are shifts, and each cell says who is on. A week, a '
        + 'fortnight or four weeks at a time, and the department box narrows it to one section.' },
      { steps: [
        'Rota. It opens on this week.',
        'Step with the arrows, or pick any Monday from the date box.',
        'People or Positions, whichever question you are asking.',
        'Save as PDF under More to pin it up.',
      ] },
      { note: 'A dashed shift is still a draft \u2014 the planner is thinking, and it may '
        + 'change. A solid one has been published and is the version to plan around.' },
      { p: 'It is read only, and deliberately the whole of what somebody can be given. There is '
        + 'nothing on the screen to press: no dropdowns, no dragging a shift across, no publish, '
        + 'no copying a week. It carries no clock times, no lateness, no leave balances and '
        + 'nothing anybody has asked for. An administrator hands it out under Users & data, '
        + 'either as the "Rota, read only" role or by ticking "See the rota".' },
    ],
  },
  {
    key: 'reports',
    title: 'Reports and the wages',
    permission: ['att_reports', 'att_rota'],
    lede: 'Days worked, hours, lateness, leave — per person, in a form you can hand over.',
    blocks: [
      { note: 'If you build the rota, the Month tab is open to you — you need to know who was '
        + 'absent and who is over their hours before you build the next one — but the Leave '
        + 'left column is not there, and the export is not offered. A rota built around who is '
        + 'running out of days is a rota built around the wrong thing.' },

      { steps: [
        'Month. Choose the month that has just ended.',
        'Check the "to confirm" count is zero. If it is not, the figures are provisional — tell '
          + 'a supervisor.',
        'Export CSV: days worked, hours, absences, leave taken and leave left, per person.',
        'For a query about one person, click their name for the day by day.',
      ] },

      { warn: 'An unsigned month is not a finished month. Sign-off is what moves days against '
        + 'somebody’s leave, so if a month has not been signed, the balances in your '
        + 'export have not had that month’s over- or under-time applied yet.' },

      { sub: 'A person’s slip' },
      { p: 'A plain-English line at the top saying what happened, the clock times under it as '
        + 'evidence, and the balance beside it. Where a signed month has added or taken days, '
        + 'that is its own tile with the months it came from. Any clock time somebody changed '
        + 'prints at the bottom, with who and why.' },
      { note: 'The leave figure comes off the printout by default. A slip handed to one person '
        + 'is read by whoever is standing next to them. One tick box puts it back on.' },

      { sub: 'Correcting September fixes June' },
      { p: 'Every figure is worked out again from the punches whenever anything changes. There '
        + 'is no second version of the truth to reconcile, and no report that has to be '
        + 'regenerated — including the ones already printed, next time they are printed.' },
    ],
  },

  {
    key: 'signoff',
    title: 'Sign-off',
    permission: 'att_signoff',
    lede: 'Settling up as you go — a day at a time, not a month at a time.',
    blocks: [
      { steps: [
        'Sign-off. Pick a window: yesterday, last 7 days, a fortnight, a month, or dates by hand.',
        'Everybody with unsigned days appears, worst first.',
        'Tick the days you have looked at. Nothing is ticked to start with — the tick in the '
          + 'heading takes every day that can be signed.',
        'Sign off — or Ask an admin.',
      ] },

      { note: 'Every notice also goes out by email, to whoever it names — the person it is '
        + 'addressed to, or whoever holds the permission it is for. So a question raised while '
        + 'you are away from your desk reaches you anyway. Users & data → Notifications turns it '
        + 'off.' },

      { note: 'Whoever you last acted on is held at the top until you do something else, '
        + 'with a line saying what just happened to them and how many of their days are '
        + 'still outstanding. The list is ordered worst first, so signing somebody’s two '
        + 'worst days would otherwise drop them into the middle of twenty cards — and the '
        + 'person you were halfway through would simply be gone from the screen.' },

      { sub: 'Putting a person’s days in the order you want them' },
      { p: 'Press any heading on somebody’s table — Day, Clocked, What happened, Flags — and '
        + 'their days sort by it. Press the same one again to turn it round. It sorts that '
        + 'person only, because the table is that person only: the two lates together, or the '
        + 'flagged days at the top, is a question about their week and nobody else’s.' },
      { note: 'Flags sorts by how much is wrong rather than alphabetically, so pressing it '
        + 'twice brings the worst days to the top. Clocked puts days nobody clocked at all at '
        + 'the end — an absence is not "earliest". Ticks you have already made survive the '
        + 'sort.' },

      { p: 'Nothing arrives ticked on purpose. Signing a period off moves days against '
        + 'somebody’s leave, and a screen that opened with everything selected would ask '
        + 'for one press to do that — including for the days nobody has looked at yet.' },

      { sub: 'Clearing the easy ones in one press' },
      { p: 'The filter above the list has three settings — all, with issues, clean — and it '
        + 'narrows by day rather than by person: somebody with four good days and one '
        + 'unexplained Thursday shows their four under "clean" and the Thursday under "with '
        + 'issues". Above the list sits a count of every clean day and one button that signs '
        + 'all of them.' },
      { p: 'It shows you the list first. Every person, every day, each one tickable, so '
        + 'anything you would rather look at yourself comes back out before anything is '
        + 'signed — a button that signs ninety-six days on one press has to be able to say '
        + 'which ninety-six.' },
      { p: 'It signs clean days wherever they are, so a person with one unexplained Thursday '
        + 'still has their other four days cleared and the Thursday stays on the list on its '
        + 'own. Nothing flagged goes through it, nothing with a clock-time change waiting goes '
        + 'through it, and nothing is charged against anybody’s leave — a clean day is by '
        + 'definition neither an extra day nor a missed one. Every one can be reopened.' },

      { p: 'You do not have to sign a whole week to sign any of it. Sign the eleven clear days '
        + 'and leave the three nobody can explain; they stay on your list and can be dealt with '
        + 'on their own afterwards.' },

      { warn: 'When something looks wrong, ask. An unexplained absence is a question for '
        + 'somebody senior before it becomes a charge against a colleague’s leave. Ask an '
        + 'admin sends the dates, the figures and your question. It is not a failure to use it '
        + '— it is what it is there for.' },

      { sub: 'What the list is grouped into' },
      { p: 'Three: what has been answered and is back with you, what there is to do, and — '
        + 'collapsed at the bottom — what is waiting on somebody else. The count at the top is '
        + 'the middle one, because a number that includes six days waiting on another person’s '
        + 'answer is not a number you can plan a morning around.' },
      { note: 'Grouping is by day, not by person. Asking about a Thursday nobody can explain '
        + 'does not put that person’s other four days beyond reach — they stay on the working '
        + 'list and only the Thursday is parked.' },

      { sub: 'Who you are asking, and who can read it' },
      { p: 'Name the person you are asking. Their bell rings for it and the row carries their '
        + 'name, so a queue of six is six questions with owners rather than six nobody has '
        + 'picked up. Leave it as “anybody who can answer” if it genuinely does not matter.' },
      { note: 'What you write is read by whoever can answer a question, and by nobody else — '
        + 'not by other supervisors, not by whoever else builds the rota. You see your own '
        + 'questions and the answers to them, and none of anybody else’s. It is a sentence '
        + 'about a colleague, so write it as one.' },

      { sub: 'Undoing one' },
      { p: 'Open “already signed” under the person on the sign-off list and press Reopen. The '
        + 'days go back on the list and whatever the sign-off charged against their leave stops '
        + 'counting. It does not undo anything decided about the days themselves — a Tuesday '
        + 'ruled sick leave stays sick leave; only the closing of the period is removed. The '
        + 'same button is on the person’s own record and on the Leave screen.' },

      { sub: 'Three things that trip people up' },
      { list: [
        'Today is never on the list. A shift that has not finished cannot be signed off.',
        'No two signed periods may share a day. Sign a week a day short and then the month '
          + 'three days short and four days would come off for three days of absence — the '
          + 'overlapping period is named and the sign-off refused.',
        'A day with a clock-time change waiting on an administrator cannot be ticked. It '
          + 'still reads what the terminal recorded, and the change is about to move it — so '
          + 'the tick comes back once the change has been approved or turned down.',
        'A day you have asked about cannot be signed until the answer comes. That is the '
          + 'point of asking. Withdraw the question if you have worked it out yourself, and '
          + 'the day is yours again.',
      ] },
    ],
  },

  {
    key: 'questions',
    title: 'The questions queue',
    permission: 'att_manage',
    lede: 'Sign-off → Questions. What somebody asked rather than signed.',
    blocks: [
      { p: 'You see every question, whether or not it names you — somebody on leave must not '
        + 'take theirs with them — and the row says who was asked. Whoever raised it sees their '
        + 'own and nobody else’s.' },
      { table: {
        head: ['Answer', 'What happens'],
        rows: [
          ['Comment', 'Says something and leaves it open. A question being worked out is not one that has been dealt with.'],
          ['Hand it back', 'Tells them what to do. Returns to their screen and rings their bell.'],
          ['Sign it off', 'Done here, under your name. Closes the question.'],
        ],
      } },
      { p: 'Open their record on the question — and again inside the answer box, where it '
        + 'opens in its own tab so you do not lose what you have typed — shows the days the '
        + 'question is about in full: the shifts, the clock times, what the rules made of each '
        + 'one. A question cannot honestly be answered from a sentence and a chip reading '
        + '"1 absent".' },
      { p: 'Whichever of the four you press, the bell rings for the person who asked — them '
        + 'and not every colleague who happens to be able to sign a period off. They are the '
        + 'one waiting on it.' },
      { note: 'Until you answer, the days the question is about cannot be signed off by '
        + 'anybody — including whoever raised it. Signing it off from here is the exception, '
        + 'because signing it is the answer.' },
      { p: 'The conversation on a question is append-only. An answer that can be edited '
        + 'afterwards is not an answer anybody can rely on having been given.' },
    ],
  },

  // =========================================================================
  {
    key: 'people',
    title: 'People — the records',
    permission: 'hr_view',
    lede: 'Personal details, emergency contacts, documents and contracts.',
    blocks: [
      { p: 'Each person’s file, with a short list of what is still missing. Not a '
        + 'completeness percentage: a bar reading 78% is a number nobody can act on, and "no '
        + 'emergency contact, no ID" is a list somebody can walk round the building with on a '
        + 'Tuesday and finish.' },

      { sub: 'What is masked, and why' },
      { p: 'Private numbers — bank account, mobile money, Ghana Card, SSNIT, TIN — read as '
        + '•••• 4321 unless you hold Manage employee records. Masked rather than hidden, so you '
        + 'can see a bank account is on file without reading it; an empty space would have you '
        + 'chasing a number that is already there.' },
      { warn: 'Opening a scan of a Ghana Card is reading the number on it, so the documents '
        + 'themselves need the permission that unmasks the number, not the one that hides it.' },

      { sub: 'What a file must contain' },
      { p: 'The checklist is worked out per person against Ghanaian law: a Ghana Card or '
        + 'passport, SSNIT, a signed contract, a photograph, certificates, a reference. A food '
        + 'handler’s certificate is added for anybody in a food department and expires '
        + 'yearly (Public Health Act 2012, Act 851); a work and residence permit is added only '
        + 'where the record positively says somebody is not Ghanaian.' },
      { note: 'An expired certificate counts as missing. An out-of-date food handler’s '
        + 'certificate is worth exactly as much to an inspector as no certificate, and rather '
        + 'less to whoever eats the food.' },
    ],
  },

  {
    key: 'people-manage',
    title: 'Running the records',
    permission: 'hr_manage',
    lede: 'A new starter, a link, and what comes back.',
    blocks: [
      { sub: 'A new starter, start to finish' },
      { steps: [
        'Setup → Staff: add them, with the employee number exactly as the terminal has it.',
        'People → open them → Issue a contract from a template.',
        'Send them a link. One link carries their details form and the contract together.',
        'They fill it in on their phone. It comes back as a proposal.',
        'Review it, accept what is right, and countersign the contract once they have signed.',
      ] },

      { warn: 'A link is shown once. Only a fingerprint of it is stored, so a copy of the '
        + 'database opens nothing — and a lost link is replaced rather than recovered, which '
        + 'takes ten seconds. Add a four-digit code for a contract; tell it to them out loud, '
        + 'not in the same message.' },

      { sub: 'Blank is never a delete' },
      { p: 'A question somebody skipped is not a request to erase the answer on file, so blanks '
        + 'never appear in the review at all. This is the single most destructive thing a '
        + 'self-service form can do, and it is the one rule in the system with its own '
        + 'permanent test.' },

      { sub: 'Choosing what to ask for' },
      { p: 'People → What to ask for. Every field, every list and every document gets one of '
        + 'three answers: ask for it, insist on it, or do not ask at all. A property that pays '
        + 'everybody by mobile money has no use for a bank branch; one that has been caught out '
        + 'by an emergency contact nobody filled in wants that one refused rather than skipped.' },
      { note: 'Only what you change is stored. That way a question added to the system next '
        + 'year is asked for by default rather than silently missing from every form because a '
        + 'plan written this year had never heard of it.' },
      { p: 'Insisting is enforced when the form is sent, not only while it is filled in — and '
        + 'it counts what the office already holds as answered, so somebody on their second '
        + 'link is not made to retype an address you have had since their first week.' },

      { sub: 'Paper they photograph themselves' },
      { p: 'The same link now asks for the ID, the certificates and the passport photograph, '
        + 'taken with the camera in the device that is asking. Which ones depends on what you '
        + 'set above and on who they are.' },
      { warn: 'Nothing goes on the file until you have looked at it. It waits under "Sent in '
        + 'from their phone" on the person’s own screen: open it, check it is what it says '
        + 'it is and that it is theirs, then accept it or send it back with a reason. A '
        + 'photograph of the wrong side of a card — or of somebody else’s — is exactly '
        + 'what a review catches and a direct upload would not.' },
      { p: 'A contract is deliberately not on that list. It is the property’s own '
        + 'document, signed through the same link, and would mean nothing arriving as a '
        + 'photograph from the person it binds.' },
    ],
  },

  {
    key: 'contracts',
    title: 'Contracts',
    permission: 'hr_view',
    lede: 'Issued from a template, signed on a phone, and frozen the moment they go out.',
    blocks: [
      { p: 'The standard set covers a contract of employment, a probation letter, a casual '
        + 'engagement and a fixed-term contract, written against the Labour Act 2003 (Act 651) '
        + 'and the National Pensions Act 2008 (Act 766) — hours, overtime, rest, leave, notice, '
        + 'termination, SSNIT at 13% and 5.5%.' },
      { warn: 'Issuing a contract freezes its words. Editing the template afterwards cannot '
        + 'change what somebody was asked to sign, which is exactly what makes templates safe '
        + 'to edit.' },
      { p: 'A contract signed on paper still belongs here: File a signed paper contract puts '
        + 'the scan where a contract belongs rather than in the general documents pile, and it '
        + 'satisfies the same requirement on the checklist.' },
      { note: 'Every contract carries a fingerprint of its exact words and a certificate of '
        + 'what happened to it — issued, opened, read, signed, from which address. That is what '
        + 'makes an electronic signature worth anything under the Electronic Transactions Act '
        + '2008 (Act 772).' },
    ],
  },

  // =========================================================================
  {
    key: 'lunch',
    title: 'Lunch',
    permission: 'lunch',
    lede: 'One link, one meal a day, and the head count the order goes in on.',
    blocks: [
      { p: 'The property feeds whoever is on duty, and the kitchen has to order before the week '
        + 'starts. This replaces the sheet on the noticeboard and somebody counting names on a '
        + 'Sunday night, which fails the same two ways every week: food cooked for people who '
        + 'were not in, and people in with no food.' },

      { sub: 'How the week runs' },
      { steps: [
        'Set the menu once. One meal a day, the same for everybody, and it repeats: Monday is '
          + 'that every Monday until you change it.',
        'Staff open the link while it is taking answers, find their name, and tick the days '
          + 'they are eating.',
        'Read the count under each day and place the order.',
        'Print the week for the kitchen.',
      ] },
      { note: 'Everybody putting their name down inside one window is ordering for the same '
        + 'week: the one beginning the first Monday after the window shuts. That is what makes '
        + '"next week" mean one thing to everybody rather than shifting on Sunday night.' },

      { sub: 'When it opens and shuts' },
      { p: 'Two moments, each a day and a time, and they come round every week on their own. '
        + 'Nobody has to press anything. Thursday 00:00 to Monday 00:00 is the usual '
        + 'arrangement: the order goes in over the weekend for the week that starts on the '
        + 'Monday. Change it under "When it opens".' },
      { note: 'Times, not just days. "Open on Thursday" leaves the kitchen and everybody else '
        + 'disagreeing about Thursday evening, and the disagreement only ever shows up as a '
        + 'plate too few.' },
      { list: [
        'Outside the window the link still opens and says the day and the hour it will start '
          + 'taking answers, and which week that will be for.',
        '"Turn it off" stops it whatever the times say, for as long as you leave it off. The '
          + 'link keeps working and tells people it has been turned off.',
      ] },

      { sub: 'The menu repeats' },
      { p: 'Set the seven days once. They come back the same every week, so nobody types the '
        + 'same meals in again each Thursday and a week nobody got round to is never blank. '
        + 'Change a day and it changes from the next list onwards.' },

      { sub: 'The link' },
      { p: 'One address for the whole property, not one per person. Put it on the noticeboard '
        + 'and in the group chat. Whoever opens it finds their own name, sees the days the rota '
        + 'says they are in next week, and ticks the ones they are eating.' },
      { p: 'It shows first names, rostered days and the menu. Nothing else about anybody is '
        + 'behind it: no pay, no records, no contact details. That is what makes it safe to '
        + 'pin to a wall.' },
      { p: 'It does not change from week to week. Pin it up once and leave it there: turning '
        + 'the list off and on again, and the window opening and shutting, do not touch the '
        + 'address.' },
      { warn: 'The link is shown once and only a fingerprint is kept, so it cannot be shown '
        + 'again. "Replace the address" retires the old one the moment it is made and everybody '
        + 'has to be given the new one, so it is for a link that has gone somewhere it should '
        + 'not have, and nothing else.' },

      { sub: 'Only days they are down to work' },
      { p: 'Somebody is offered the days the published rota has them in, and nothing else. '
        + 'Asking people which days they want lunch invites an answer about days they are at '
        + 'home, and the kitchen then cooks for them.' },
      { note: 'A day pencilled in and not published is not offered either. Publish the rota '
        + 'before the list opens and it has something to ask about.' },
      { p: 'That is the rule for the link, where somebody is answering on their own. It is not '
        + 'the rule for you. "Put somebody down" on the week takes anybody, on any day, whether '
        + 'the rota has them in or not: a manager in on a day off, somebody covering at the '
        + 'last minute, a person on leave who is in for a meeting. Days the rota does not '
        + 'expect them on are marked rather than hidden.' },
      { note: 'Somebody you have put down for a day sees it on their own page when they open '
        + 'the link, and can change it, so nobody is stuck with an answer given for them.' },

      { sub: 'Reading the week' },
      { p: 'Seven columns, Monday to Sunday. The big number under each day is the head count, '
        + 'which is what the order is placed on; the meal is under it, and the first names of '
        + 'everybody eating are under that so the count can be checked rather than trusted.' },
      { p: '"of 9 in" beside a count says how many are rostered that day, so eight out of nine '
        + 'reads differently from eight out of twenty.' },
      { p: '"Still to say" is everybody on the rota who has answered nothing. Saying no counts '
        + 'as answering; these are the ones the kitchen would be guessing about. Put somebody '
        + 'down from there when they tell you in person rather than sending them to the link.' },
      { note: 'Print the week gives the kitchen a sheet, and your print dialog will save it as '
        + 'a PDF if you choose that as the destination.' },
    ],
  },

  // =========================================================================
  {
    key: 'letters',
    title: 'Letters',
    permission: 'corr_view',
    lede: 'The correspondence register: what went out, to whom, and what came back.',
    blocks: [
      { p: 'Every letter gets a reference the moment it exists, SN/FIN/2026/0041, and never '
        + 'reuses one. Set a reply-due date and the register chases you about it; that first '
        + 'red tile is the whole reason the register exists.' },

      { sub: 'Your letterhead' },
      { p: 'Upload the same headed paper you already print on. A photograph of a printed sheet '
        + 'works, though a scan or the artwork itself looks better. The page is A4 and the '
        + 'image is stretched to fill it, so give it a full page rather than a cropped strip.' },
      { steps: [
        'Open any letter and press Choose a letterhead.',
        'Upload one, name it, and say whether new letters should start on it.',
        'Press Set the safe area and drag the four edges in until the dashed rectangle clears '
          + 'your logo and your footer.',
      ] },
      { p: 'That dashed rectangle is the safe area, and it shows while you write. Nothing '
        + 'outside it is meant to carry words, so a block dragged out there will print over the '
        + 'letterhead itself. If your headed paper is only used for the first page, leave '
        + '"Use the same paper for second and later pages" unticked and page two comes out '
        + 'plain.' },

      { sub: 'Writing one' },
      { p: 'Open the page and the letter appears on the letterhead exactly as it will print. '
        + 'Reference, date, address, subject, body and the sign-off each sit in their own block, '
        + 'so you can move any of them without disturbing the rest.' },
      { table: {
        head: ['To do this', 'How'],
        rows: [
          ['Type', 'Click into a block and write. It saves itself every few seconds'],
          ['Move a block', 'Drag the small handle at its top left corner'],
          ['Make it wider or narrower', 'Drag the handle at its bottom right corner'],
          ['Change the typeface or size', 'Select the block, then use the toolbar'],
          ['Bold, italic, underline, bullets', 'Select the words first, then the toolbar'],
          ['Line spacing and alignment', 'Applies to the whole selected block'],
          ['Add somewhere else to write', '+ Text puts a new block on the page'],
          ['A second page', '+ Page, then drag blocks onto it'],
        ],
      } },
      { note: 'Preview shows the finished pages at their real proportions with nothing to drag. '
        + 'Print or save as PDF from there gives you the same thing on paper.' },

      { sub: 'Where they sign' },
      { p: 'Press "+ Sign here" and a box lands on the page. Say whose it is and what goes in '
        + 'it, then drag it where the signature belongs. Two parties to an agreement get a box '
        + 'each, side by side over their own names, instead of a stack of signatures at the '
        + 'foot in whatever order they happened to arrive.' },
      { table: {
        head: ['Setting', 'What it means'],
        rows: [
          ['The property', 'Your own signature, put there when you sign it'],
          ['Signer 1, 2, 3…', 'The person in that position when you send it out'],
          ['Signature', 'Their ink, over a rule, with their name and the date under it'],
          ['Initials', 'The same, smaller, for initialling a page'],
          ['Date signed', 'Just the date, filled in when they sign'],
        ],
      } },
      { p: 'Whoever opens the link sees every box on the page. Theirs is highlighted and says '
        + '"Sign here"; everybody else\u2019s shows whose it is, filled or waiting. A letter '
        + 'with boxes on it does not stack signatures underneath as well.' },
      { note: 'A box is filled by whoever is in that position on the envelope. Signer 1 is the '
        + 'first person listed when you send it out, so list them in the order the boxes expect.' },

      { sub: 'Who signs it' },
      { p: 'Done asks one question, and the answer decides what happens next.' },
      { table: {
        head: ['Answer', 'What follows'],
        rows: [
          ['I sign it for the property', 'Your own signature, after you confirm it is you'],
          ['Send it out for signature', 'A link for each person who has to sign it back'],
          ['Both', 'You sign first, and it goes out only if you did'],
          ['Neither yet', 'It stays a draft and nothing is sent'],
        ],
      } },
      { sub: 'Sending it out' },
      { steps: [
        'Send for signature, and list everybody: what each is asked to do, and whether they '
          + 'need an access code.',
        'Choose whether they sign in the order listed or all at once.',
        'Copy each link and send it to that person.',
        'Give each of them their access code separately, on a call rather than in the same '
          + 'message.',
      ] },
      { table: {
        head: ['Choice', 'When to use it'],
        rows: [
          ['In the order listed', 'An approval chain. The second link stays shut until the '
            + 'first person is done'],
          ['All at once', 'A two-party agreement. Every link is live, and waiting for the '
            + 'other side to go first is a week nobody has'],
          ['Access code on', 'The default. A six-character secret told to them another way, so '
            + 'a forwarded email on its own opens nothing'],
          ['Access code off', 'A routine acknowledgement where the code is more friction than '
            + 'the letter is worth. Whoever holds the link can sign'],
        ],
      } },
      { warn: 'With the code off, the link is the whole of the security. Anybody it is '
        + 'forwarded to can open and sign the letter, so use it where that does not matter.' },
      { p: 'Whoever opens the link sees the letter on your letterhead, laid out the way you '
        + 'left it, not a bare wall of text.' },
      { warn: 'Once a letter leaves draft the layout is fixed. Signatures are counted against '
        + 'the words that were on the page at the time, so a page that could still be rearranged '
        + 'afterwards would make the signature worthless.' },
      { note: 'Every letter carries a hash-linked record of everything that happened to it, so '
        + 'a page altered after the fact breaks the chain and the register says where.' },
    ],
  },

  {
    key: 'signing',
    title: 'Signing for the property',
    permission: 'corr_sign',
    lede: 'Your signature and the company stamp — stored in completely different ways.',
    blocks: [
      { p: 'A stamp belongs to the property. Anybody who may sign can apply it, and what it '
        + 'looks like is not a secret — it is printed on paper that leaves the building every '
        + 'week.' },
      { p: 'A signature belongs to a person. Nobody else can see it, nobody else can apply it, '
        + 'and saving or using it costs you your own password or PIN at the moment you do. '
        + 'Anything less and a stored signature is a forgery machine sitting on an unlocked '
        + 'phone in a hotel office.' },
      { sub: 'Using the signature you already have' },
      { p: 'Draw it with a finger, or press Upload an image and choose a photograph or scan of '
        + 'your usual signature. The picture does not go on whole: anything light enough to be '
        + 'the paper is made transparent and the result is cropped to the ink, so it sits on a '
        + 'letter rather than covering it with a grey rectangle.' },
      { warn: 'If your login has no password or PIN there is nothing to confirm with, and '
        + 'signing will refuse. Set one under your account first.' },
    ],
  },

  // =========================================================================
  {
    key: 'setup',
    title: 'Setup',
    permission: 'att_setup',
    lede: 'Opened twice a year, and everything downstream depends on it.',
    blocks: [
      { table: {
        head: ['Tab', 'What lives there'],
        rows: [
          ['Company', 'Who the employer is: name, logo, address, telephone, TIN, SSNIT number'],
          ['Staff', 'People, and the employee number that must match the terminal exactly'],
          ['Shifts', 'What "late" is measured against. Banded by department'],
          ['Absence reasons', 'What each kind of absence costs'],
          ['Public holidays', 'Generated per year, then edited'],
          ['Terminals', 'The device, its token, and its clock'],
          ['Rules', 'Leave entitlement, grace, chasing, and what the terminal tells staff'],
          ['Workload', 'What counts as too much here — four from the law, four your own'],
        ],
      } },

      { sub: 'Who the employer is' },
      { p: 'The first tab, and the one everything printed depends on. The name and address head '
        + 'every contract and letter; the logo, the registered name, the telephone number, the '
        + 'TIN and the SSNIT employer number head every payslip.' },
      { p: 'Both numbers earn their place. Somebody querying a deduction at a SSNIT branch is '
        + 'asked for the employer number, and the answer should be on the paper in their hand '
        + 'rather than a telephone call away.' },
      { note: 'The logo is best as a PNG with a transparent background. It is shrunk to about '
        + '600 pixels across on the way in, which is more than a payslip can show. Without one '
        + 'a payslip is headed by the name alone.' },

      { sub: 'The most days a week' },
      { p: 'Days a week is both things at once: what their month is measured against, and the '
        + 'ceiling the rota works to. Blank uses the property default, five days here, so the '
        + 'ordinary answer needs nothing typed. Fill it in for the people the property works '
        + 'differently: Dorcas Sarpei and Henry Aryee are on six.' },
      { warn: 'One figure, so raising somebody to six days to let the rota use them also '
        + 'changes what a day of theirs is worth. It is the divisor behind their day rate on a '
        + 'payslip. Worth a look at the payroll before you move it.' },
      { note: 'Two things the draft will not do at any price: put somebody on two shifts in '
        + 'one day, or past their days a week. Not to cover a gap, not as a last resort. A '
        + 'shift nobody is left for is reported empty instead. You can still put either on by '
        + 'hand where you mean to, and the grid marks it as it always has.' },

      { sub: 'Weekdays somebody never works' },
      { p: 'Never works, on the staff form, is the standing version of the ✕ on the rota. '
        + 'Somebody at church every Sunday is not going to be told a fortnight at a time, and '
        + 'was being asked to be. Tick the day once and the draft leaves it alone for good.' },
      { note: 'For one date only, keep using Days they cannot work on the rota. That is a fact '
        + 'about one week; this is a fact about them.' },

      { sub: 'The register, out of a spreadsheet' },
      { p: 'Setup → Staff → Bulk upload, for a property whose staff list already exists '
        + 'somewhere else. The button opens a small menu: take Download template first, '
        + 'because what comes down is your own people with their own figures in it rather '
        + 'than a blank form. Change the lines that changed and send it back with Upload a '
        + 'file. The same button is on Payroll for a month\u2019s figures and on the rota '
        + 'for a week.' },
      { p: 'This is the only import in the app that adds people, and it is the only one '
        + 'where adding them is the point. So everything the file would do is on the screen '
        + 'before anything is written: who is being added, who is changing and what about '
        + 'them, every line that could not be read, and every column nobody recognised. '
        + 'The new people are listed on their own, because a staff number that matches '
        + 'nobody is read as somebody new and one typo therefore makes a duplicate.' },
      { p: 'Employee number and name are the two columns it needs. Everything else is '
        + 'optional and matched on the words a staff list actually uses, so a column moved '
        + 'or missing changes nothing: department, job title, started, left, leave days, '
        + 'days a week, what they are here for, phone, email, basic salary, SSNIT, note. '
        + 'A basic salary here is what puts somebody on the payroll.' },
      { p: 'Allowances get a column each, headed "Allowance: Transport", with "(not taxable)" '
        + 'on the end for a genuine reimbursement. So a property can arrive with its people, '
        + 'their salaries and their allowances in one sheet rather than typing twenty '
        + 'allowances into a dialog one person at a time.' },
      { note: 'A blank cell leaves what is there alone, and people are matched on the '
        + 'employee number rather than the name — two people called Kwame Mensah are two '
        + 'people, and the number is the only thing that is theirs.' },

      { sub: 'Somebody who is never rostered' },
      { p: 'A director, a consultant, an owner: on the payroll, with a record and a payslip and '
        + 'a leave balance, and no business taking up a column on the grid. Setup → Staff, '
        + 'edit them, and set What they are here for to Attendance, but never rostered.' },
      { p: 'They come off the grid, out of the workload list and out of the draft. Anything '
        + 'already rostered for them from today onwards is taken off, and their standing pattern '
        + 'goes with it, or it would put them straight back. What is already behind you is left '
        + 'alone, because it happened.' },

      { sub: 'Somebody who is only ever paid' },
      { p: 'The third answer on that same question is Payroll only, and it goes further. Some '
        + 'people never touch the terminal at all, so working out a day for them produces an '
        + 'absence and nothing else: they were on Today every morning, on the sign-off list '
        + 'every week, and in the year as somebody who had not worked a day.' },
      { p: 'Payroll only takes them out of attendance altogether. No day is worked out for '
        + 'them, no screen counts them, nothing chases them, and they are off the rota as well. '
        + 'Their record, their payslip, their allowances, their advances, their letters and '
        + 'their birthday carry on exactly as before, because none of that was ever about who '
        + 'came in this morning.' },
      { note: 'They still need an employee number, and for them it is only a staff number for '
        + 'the payslip, so invent one. It is kept out of the terminal\u2019s matching on '
        + 'purpose: a number made up for a director can never claim the punches of whoever '
        + 'really holds that card.' },

      { sub: 'Where somebody may be put on' },
      { p: 'Department says where a person sits. They can work in says where they may be '
        + 'rostered, and until you tick anything their own department answers for them. That is '
        + 'right for most of the staff and saves ticking one box twenty-four times.' },
      { p: 'Tick more for the people it is not true of, and at whichever size fits. A whole '
        + 'department is a standing answer: anything in it, including the shift added next '
        + 'month, which is what a supervisor covering the bar means. Single shifts within a '
        + 'department are the narrow one: a porter who does one named night on security is not '
        + 'Security, and should not be in the running for the other two.' },
      { p: 'The draft never puts anybody on a shift outside these, and where it cannot fill one '
        + 'it says nobody is set up for that work rather than leaving you to guess.' },
      { warn: 'Naming shifts on their own is the whole answer, not an addition. Somebody with '
        + 'one F&B shift ticked and nothing else has that shift and no more, their own '
        + 'department included. The form says so underneath while it is true. Tick their '
        + 'department as well to mean "their usual work, and also this".' },
      { note: 'You can still put somebody on by hand wherever you like. Covering a gap with '
        + 'whoever is standing there is a real Saturday, so the person is offered under a '
        + '"Not set up for" heading rather than hidden. A shift belonging to no department is '
        + 'anybody\u2019s.' },

      { sub: 'How many a shift needs' },
      { p: 'Under Setup → Shifts, People needed is what the draft aims at: three on '
        + 'reception means three, whether or not the last few weeks managed it. Left blank the '
        + 'draft copies what those weeks actually did, which is right for a shift that has been '
        + 'running and no use at all for one you added yesterday.' },

      { sub: 'When a shift is wanted, and when it is not' },
      { p: 'Every shift on the rota is wanted, every day it is allowed to run. That is the '
        + 'starting point, and the rest of this is how you narrow it. A shift you added last '
        + 'week has no history to copy and nobody has typed a number against it, and it still '
        + 'reaches the draft, because being on the rota is itself the instruction.' },
      { p: 'Six things a shift can say, all on the same form, all of them things somebody used '
        + 'to have to remember.' },
      { table: {
        head: ['Says', 'What the draft does'],
        rows: [
          ['It runs on', 'Untick Sunday and the craft shop is not wanted on a Sunday. Not '
            + 'proposed, and not counted as a gap either'],
          ['One of these runs a day', 'Give the five breakfasts the same group name. Once the '
            + 'day has settled on one, the rest are left alone'],
          ['Whose shift it is', 'Named people only, first choice first. Nii and then Dorcas '
            + 'means Nii while Nii can and Dorcas when he cannot, and nobody else ever'],
          ['Only if somebody is spare', 'Filled last, from whoever is left over, and never at '
            + 'the cost of a shift that has to be covered'],
          ['Days in between', 'Every other day, say. The deep clean is wanted often and not two '
            + 'days running, because the point of it is the day in between'],
          ['And they clash', 'Whether a group rules itself out for the day or for the whole '
            + 'week. Two breakfasts clash for the morning; two shifts that each run once a '
            + 'week clash for the week, whichever day either lands on'],
        ],
      } },
      { note: 'Once a week is Days in between set to seven. There is no separate weekly '
        + 'setting: a shift that is wanted, may run any day, and cannot run twice within seven '
        + 'days runs once a week by itself.' },
      { sub: 'It will fill everything, and tell you what that cost' },
      { p: 'Aside from what you have marked optional, the draft tries every way it has of '
        + 'covering a shift. First the people who are free. Then, where nobody is, it looks '
        + 'for somebody already down for something else that day whose shift another person '
        + 'could take instead, and swaps the two: a greedy pass gives the first shift of the '
        + 'day its best person and leaves the last with nobody, and that is the order of the '
        + 'asking rather than the property being short.' },
      { p: 'The rules that hold absolutely are asked before any that can be stretched, which '
        + 'sounds like housekeeping and is not. Checked the other way round, a sixth day that '
        + 'was also the forty-first hour came back as an hours refusal, hours may be gone past '
        + 'to cover a shift, and somebody ended the fortnight on seven days nobody agreed to.' },
      { p: 'When even that leaves a shift empty, it goes past a limit rather than leave it. '
        + 'Your own practice first, then the Labour Act, and never quietly. Every one of those '
        + 'arrives marked in red on the draft, named on the person\u2019s line, and counted in '
        + 'a block at the bottom saying which section it goes against.' },
      { p: 'One shift often goes past more than one rule at once: a sixth day in a row is '
        + 'usually a sixth day in the week too, and may be the forty-first hour as well. All '
        + 'of them are named rather than whichever the app happened to check first, so the '
        + 'counts in that block add up to more than the number of shifts.' },
      { warn: 'Read that block before you accept a draft. A rota where most of the shifts are '
        + 'marked is not a rota to publish: it is the app showing you that the shift list is '
        + 'asking for more work than the property has people to do. Nobody can work two shifts '
        + 'a day for a fortnight, whatever the arithmetic says.' },
      { note: 'What it will never do, whatever it costs: put somebody on two shifts in one '
        + 'day, past their days a week, or on leave, a date they said they cannot work, a '
        + 'weekday they never work, or a department they are not set up for. Those are not '
        + 'limits to be stretched. Some are facts, and going past them would be writing down '
        + 'something untrue; the other two are where the property has drawn the line.' },

      { warn: 'A draft that comes back with dozens of shifts it could not fill is usually the '
        + 'shift list claiming more than the property runs. Twenty-two shifts wanted every day '
        + 'is three hundred shift-days a fortnight, and no property that size has the people '
        + 'for it. Group the alternatives, close the days that are shut, and mark what is only '
        + 'wanted if somebody is spare.' },
      { note: 'A shift that names its people is settled for the whole fortnight before any '
        + 'shift that does not, which reserves them. Housekeeping main is Linda and then Atsu; '
        + 'asked a day at a time it takes Linda for her five and by Saturday Atsu has spent his '
        + 'week on the laundry, so a shift with two people named for it ends up with neither.' },
      { p: 'The draft splits what it could not do into two lists. Shifts that had to be covered '
        + 'and were not are the work; a shut day, a covered alternative, an optional shift '
        + 'nobody was spare for and a one-person shift on their day off are all reported '
        + 'separately, under a heading saying there is nothing to fix.' },

      { sub: 'Several shifts, one job' },
      { p: 'A shift is what lateness is measured against, so a breakfast that finishes at two, '
        + 'at half past two and at three is three shifts. It is one job, and the rota\u2019s '
        + 'position view reads as a list of near duplicates until somebody says so.' },
      { steps: [
        'Setup → Shifts.',
        'Tick the shifts that are really the same job.',
        'Put under one position, and name it.',
      ] },
      { p: 'Nothing about the shifts themselves changes: the hours, the grace and every day '
        + 'already recorded against them stay exactly as they were. Only the rota groups them. '
        + 'Ticking them again and choosing "Its own position" undoes it.' },
      { warn: 'Set the company\u2019s name and address first, under Company. They head every '
        + 'contract, letter and payslip, and until they are set those go out with a placeholder '
        + 'where the employer\u2019s name should be.' },
      { sub: 'The terminal’s clock' },
      { p: 'Checked on every tap. A device running eleven minutes fast turns an on-time arrival '
        + 'into lateness for everybody, every day, and nobody notices for a month — so the '
        + 'drift is measured and reported rather than assumed away.' },
      { sub: 'Shifts found rather than typed' },
      { p: 'The terminal already knows what shifts it enforces. Rather than retyping them, the '
        + 'setup reads them off the device and offers them, so what "late" means here and what '
        + 'it means on the door are the same thing.' },
    ],
  },

  {
    key: 'users',
    title: 'Users, permissions and data',
    permission: 'users',
    lede: 'Who can reach what, and what happens when somebody leaves.',
    blocks: [
      { p: 'Thirteen permissions and five roles built from them. Any individual can be adjusted '
        + 'off their role’s defaults, and the route table is tested against every role — a '
        + 'permission granted by accident does not throw, does not log, and is noticed only '
        + 'once somebody has seen something they should not have.' },

      { sub: 'The splits worth knowing about' },
      { list: [
        'Correct clock times is in the rota planner’s defaults and is much smaller than '
          + 'settling a day. Everybody who holds it without Attendance setup is raising a '
          + 'request, not making a change.',
        'Sign off attendance is not in their defaults. Tick it and they can settle periods '
          + 'while still never seeing anybody’s leave balance.',
        'Manage employee records is what unmasks bank accounts and ID numbers, and the only '
          + 'thing that can open a scanned Ghana Card.',
        'Sign for the property is separate from writing letters, because whoever drafts is not '
          + 'necessarily whoever signs.',
      ] },

      { note: 'Holding a larger permission carries the smaller one, so a manager keeps the rota '
        + 'and the sign-off without anybody ticking three boxes. And an administrator always '
        + 'keeps Users — otherwise the last one could edit themselves out of the only screen '
        + 'that could undo it.' },

      { sub: 'A login and a member of staff are different things' },
      { p: 'Almost nobody who clocks in has a login. A room attendant has a face on a terminal '
        + 'and no reason ever to open this. The two are linked where the same person is both.' },
      { p: 'So the form asks, whatever role you give them: are they a member of staff? Answer '
        + 'yes and choose their record, and My shifts, My report, My advance and My claims open '
        + 'to them on top of everything the role already gives. The head of housekeeping who '
        + 'builds the rota and works shifts on it needs both, and before this she could only '
        + 'have one.' },
      { note: 'It grants nothing about anybody else. Those four screens read the staff record '
        + 'off the session and nothing else, which is what makes them safe to hand to anybody.' },
      { p: 'Answer no and those screens are not in their menu at all, because there would be '
        + 'nothing behind them. The Member of staff role does not ask the question: the answer '
        + 'is yes, and the only thing left to say is which record.' },

      { sub: 'What the mail says it is from' },
      { p: 'Notifications tab, Email card. Sender name is what a recipient reads before they '
        + 'read anything else, and it is not the company name on the certificate unless you '
        + 'want it to be. HIVE unless you type something else, and the phone alerts already '
        + 'say the same.' },
      { list: [
        'Sender name is the name. From address is the address, and it has to be at a domain '
          + 'your email provider has verified.',
        'A name written into the From address itself wins — "The Front Desk '
          + '<hive@example.com>" is used exactly as typed.',
        'Reply to is where a reply lands. Staff do reply to these, and a reply that vanishes '
          + 'into an unread mailbox teaches them the mail is not worth reading.',
      ] },
    ],
  },

  // =========================================================================
  {
    key: 'staff-link',
    title: 'For somebody with no login',
    permission: ['hr_manage', 'corr_write'],
    lede: 'What the person on the other end of a link actually sees — worth knowing so you can explain it.',
    blocks: [
      { p: 'They get one message with one link. No account, no password: the link is the key, '
        + 'and it is private to them and stops working after a few weeks.' },
      { p: 'It opens as a list of what is left to do — their details, their documents, anything '
        + 'to sign — and they can stop and come back to it. Whatever they send is a proposal '
        + 'until somebody here accepts it, and nothing they leave blank deletes anything.' },
      { warn: 'The page never shows what the property already holds. A link that could display '
        + 'somebody’s record would be a link that leaks it to whoever the phone was handed '
        + 'to, so the form always starts empty.' },
      { sub: 'If they say the link will not open' },
      { list: [
        'Ask them to tap the link in the message rather than retype it, and to send you the '
          + 'whole line from their address bar if it still fails. The page distinguishes an '
          + 'address that lost its code from a link that has genuinely run out.',
        'A link that has expired or been cancelled is replaced, not recovered. Making another '
          + 'takes ten seconds.',
      ] },
    ],
  },
];
