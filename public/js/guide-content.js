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
      { p: 'Open the site, sign in, and you land on the most useful screen you can actually '
        + 'open. What is in the menu is what your permissions reach — if a tab is not there, '
        + 'you do not hold it, and the section list at the bottom of this guide says who does.' },

      { sub: 'Signing in' },
      { p: 'Two ways, and neither needs anything installed. A PIN is for a phone in a corridor; '
        + 'a password is for whoever also opens the reports. Your administrator sets which you '
        + 'have, and you can change it yourself under your name in the top corner.' },
      { warn: 'A PIN is four digits and stops a passer-by, not a determined person. Anybody '
        + 'who can see wages, personnel records or letters should be on a password.' },

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

      { sub: 'Printing' },
      { p: 'Anything with a Save as PDF button prints properly: the buttons, menus and tick '
        + 'boxes come off the page and what is left is something you could hand to somebody. '
        + 'Use the browser’s own print if you want the screen as it stands.' },
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
        'Open the person’s report if you want the day in context.',
        'Approve — or Send back, saying what they should do instead.',
      ] },

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
      { steps: [
        'Rota. You see a fortnight at a time.',
        'Copy a week from the one before — most weeks are last week with two changes.',
        'Fix the two. Grey cells follow the standing pattern; black ones were set by hand.',
        'Save the rota. Nothing is written until you do.',
      ] },

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
    ],
  },

  {
    key: 'reports',
    title: 'Reports and the wages',
    permission: 'att_reports',
    lede: 'Days worked, hours, lateness, leave — per person, in a form you can hand over.',
    blocks: [
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
          + 'heading takes the lot.',
        'Sign off — or Ask an admin.',
      ] },

      { p: 'Nothing arrives ticked on purpose. Signing a period off moves days against '
        + 'somebody’s leave, and a screen that opened with everything selected would ask '
        + 'for one press to do that — including for the days nobody has looked at yet.' },

      { p: 'You do not have to sign a whole week to sign any of it. Sign the eleven clear days '
        + 'and leave the three nobody can explain; they stay on your list and can be dealt with '
        + 'on their own afterwards.' },

      { warn: 'When something looks wrong, ask. An unexplained absence is a question for '
        + 'somebody senior before it becomes a charge against a colleague’s leave. Ask an '
        + 'admin sends the dates, the figures and your question to a queue. It is not a failure '
        + 'to use it — it is what it is there for.' },

      { sub: 'Three things that trip people up' },
      { list: [
        'Today is never on the list. A shift that has not finished cannot be signed off.',
        'No two signed periods may share a day. Sign a week a day short and then the month '
          + 'three days short and four days would come off for three days of absence — the '
          + 'overlapping period is named and the sign-off refused.',
        'Do not sign over a waiting change. A row marked "waiting" still reads what the '
          + 'terminal recorded, so signing it charges the old figure. Untick that day and sign '
          + 'the rest.',
      ] },
    ],
  },

  {
    key: 'questions',
    title: 'The questions queue',
    permission: 'att_manage',
    lede: 'Sign-off → Questions. What somebody asked rather than signed.',
    blocks: [
      { table: {
        head: ['Answer', 'What happens'],
        rows: [
          ['Comment', 'Says something and leaves it open. A question being worked out is not one that has been dealt with.'],
          ['Hand it back', 'Tells them what to do. Returns to their screen and rings their bell.'],
          ['Sign it off', 'Done here, under your name. Closes the question.'],
        ],
      } },
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
    key: 'letters',
    title: 'Letters',
    permission: 'corr_view',
    lede: 'The correspondence register: what went out, to whom, and what came back.',
    blocks: [
      { p: 'Every letter gets a reference the moment it exists — SN/FIN/2026/0041 — and never '
        + 'reuses one. Set a reply-due date and the register chases you about it; that first '
        + 'red tile is the whole reason the register exists.' },
      { sub: 'Sending one out for signature' },
      { steps: [
        'Draft it, or start from a template.',
        'Send for signature, and list the signers in the order they should sign.',
        'Copy each link and send it to that person.',
        'Give each of them their six-character access code separately — on a call, not in the '
          + 'same message.',
      ] },
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
          ['Staff', 'People, and the employee number that must match the terminal exactly'],
          ['Shifts', 'What "late" is measured against. Banded by department'],
          ['Absence reasons', 'What each kind of absence costs'],
          ['Public holidays', 'Generated per year, then edited'],
          ['Terminals', 'The device, its token, and its clock'],
          ['Rules', 'The property’s name and address, leave entitlement, grace, how long links last'],
        ],
      } },
      { warn: 'Set the property’s name and address first. They head every contract and '
        + 'every letter, and until they are set the letters go out with a placeholder where the '
        + 'employer’s name should be.' },
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
