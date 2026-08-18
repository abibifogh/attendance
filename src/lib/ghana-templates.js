// The paperwork a Ghanaian employer is expected to hold, written out.
//
// Two things live here: a set of contract and acknowledgement templates, and
// the list of documents that ought to be in every personnel file. Both are
// data rather than code — a property loads them, edits them, and from that
// moment they are the property's own words, not this file's.
//
// WHAT THIS IS NOT
// ----------------
// It is not legal advice, and nothing in it has been settled by a Ghanaian
// lawyer. It is a starting point built from the statutes named in each
// template, so that a small hotel begins from something with the statutory
// particulars in it rather than from an empty box — which is the realistic
// alternative and a far worse one. Every template says so at the foot, and the
// screen that loads them says so twice.
//
// WHAT IT IS BUILT FROM
// ---------------------
//   Labour Act, 2003 (Act 651) — the written contract (s.12), the written
//   statement of particulars within two months (s.13 and Schedule 1), notice
//   periods (s.17), annual leave of not less than fifteen working days
//   (s.20), hours of work (s.33), rest periods, maternity leave (s.57), and
//   the grounds on which a termination is unfair (s.63).
//
//   National Pensions Act, 2008 (Act 766) — the three-tier scheme: 13% from
//   the employer and 5.5% from the worker, 13.5% of it to SSNIT under tier
//   one and 5% to a tier-two scheme.
//
//   Public Health Act, 2012 (Act 851) — food handlers screened and holding a
//   valid health certificate, renewed yearly. This is a hotel; it applies.
//
//   Data Protection Act, 2012 (Act 843) — a person must be told what is being
//   collected and why, and consent to it, with the right to see it, correct
//   it and withdraw.
//
//   Electronic Transactions Act, 2008 (Act 772) — which is why any of these
//   can be signed on a phone at all.
//
// A new Labour Bill has been through consultation and is expected to replace
// Act 651. Among other things it would take maternity leave to fourteen weeks,
// add paternity and compassionate leave, require notice to end a probation,
// and require a workplace policy on violence and harassment. None of that is
// law yet. When it is, these templates need revisiting — and because issuing a
// contract freezes its words, the ones already signed are unaffected.

const FOOTER = `
────────────────────────────────────────────────────────────
This document was prepared from the Labour Act, 2003 (Act 651) and the other
statutes named in it. It is signed electronically under the Electronic
Transactions Act, 2008 (Act 772). A record of the signature — the time, the
device and a fingerprint of these exact words — is kept with it.`;

/**
 * The standard set.
 *
 * `kind` decides how the app treats it: a `contract` is signed and countersigned,
 * a `policy` is acknowledged, a `letter` is issued and filed. `satisfies` names
 * the file requirement a signed copy ticks off.
 */
export const STANDARD_TEMPLATES = [
  {
    code: 'contract_permanent',
    name: 'Contract of employment — permanent',
    kind: 'contract',
    satisfies: 'contract',
    detail: 'The full agreement, with the particulars section 13 of Act 651 requires.',
    body: `CONTRACT OF EMPLOYMENT

Made under the Labour Act, 2003 (Act 651)

BETWEEN {{property}} ("the Employer")
AND {{name}} of {{address}} ("the Worker"),
holding {{id_type}}, employee number {{employee_no}}.

1. ENGAGEMENT AND DATE OF COMMENCEMENT
   The Employer engages the Worker as {{job_title}} in the {{department}}
   department. Employment begins on {{start_date}} and continues until ended
   by either party in accordance with clause 11.

2. PLACE OF WORK
   {{workplace}} The Worker may be asked to work at any other premises of the
   Employer within reasonable travelling distance.

3. DUTIES
   The Worker shall carry out the duties of the position, together with any
   other reasonable duties assigned, faithfully and to the best of their
   ability, and shall obey the lawful instructions of the Employer.
   The duties of the position are set out in the job description given to the
   Worker, which forms part of this contract.

4. PROBATION
   The first {{probation}} is probationary. During this period either party may
   end the employment on one week's notice, or one week's pay in lieu.
   Confirmation in the post will be given in writing.

5. REMUNERATION
   {{salary}}
   Payment is monthly in arrears, by the last working day of each month, into
   the account the Worker has given to the Employer.
   The Employer deducts from the Worker's pay only what the law requires or
   permits: income tax under the pay-as-you-earn system, the Worker's pension
   contribution, and anything the Worker has agreed to in writing.

6. PENSION AND SOCIAL SECURITY
   Under the National Pensions Act, 2008 (Act 766) the Employer contributes 13%
   of the Worker's basic salary and deducts 5.5% from it, making 18.5%, of
   which 13.5% is paid to the Social Security and National Insurance Trust
   under the first tier and 5% to an approved second-tier scheme.
   The Employer shall register the Worker with SSNIT and remit contributions
   within the time the Act allows.

7. HOURS OF WORK
   {{hours}}
   Hours are set by the published rota. Under section 33 of Act 651 the normal
   working week is forty hours; work beyond that is by agreement and is paid at
   the rate agreed between the parties or set by the Employer's overtime policy.
   The Worker is entitled to a daily rest period and to at least thirty-six
   consecutive hours of rest in each period of seven days.

8. ANNUAL LEAVE
   The Worker is entitled to {{leave_days}} of paid annual leave in each
   calendar year of continuous service, which is not less than the fifteen
   working days required by section 20 of Act 651. Leave is taken at a time
   agreed with the Employer, and the Employer will not require the Worker to
   take leave in place of a public holiday or during a period of sick leave.

9. SICK LEAVE, MATERNITY AND OTHER ABSENCE
   Absence through illness must be reported to the Worker's supervisor as early
   as possible on the first day, and a medical certificate produced for any
   absence of more than two days.
   A female Worker is entitled to maternity leave of not less than twelve weeks
   on full pay in addition to annual leave, with the further leave the law
   allows for a caesarean or multiple birth, and to nursing breaks on return.
   Public holidays gazetted under the Public Holidays Act are paid days off.

10. CONDUCT, PROPERTY AND GUESTS
    The Worker shall observe the Employer's rules on attendance, uniform,
    appearance, health and safety, and the handling of money and property.
    Guests' property, information and privacy are to be respected absolutely.
    Tips and gratuities are dealt with under the Employer's published policy.

11. NOTICE OF TERMINATION
    After probation, either party may end this contract by giving the other
    written notice as required by section 17 of Act 651:
      (a) one month, or one month's pay in lieu, where the contract is for
          three years or more;
      (b) two weeks, or two weeks' pay in lieu, where it is for less than
          three years;
      (c) seven days where the engagement is from week to week.
    The parties have agreed a notice period of {{notice}}, which shall apply
    where it is longer than the statutory minimum.

12. SUMMARY DISMISSAL
    The Employer may end this contract without notice for gross misconduct,
    which includes theft or dishonesty, wilful damage, violence or threats,
    being unfit for duty through drink or drugs, serious breach of health,
    safety or food hygiene rules, and serious breach of the duty owed to
    guests. Before doing so the Employer shall put the allegation to the Worker
    and give the Worker a fair opportunity to answer it.

13. UNFAIR TERMINATION
    Nothing in this contract removes the Worker's protection under section 63
    of Act 651. A termination is unfair if the reason is, among others, that
    the Worker joined or took part in a trade union, sought office as a
    workers' representative, brought a complaint against the Employer, was
    pregnant or absent on maternity leave, or is disabled, or where the reason
    is race, colour, ethnic origin, sex, religion, creed, social or economic
    status or political opinion.

14. REDUNDANCY
    Where the Worker's employment is ended because of a closure, an
    arrangement or an amalgamation, the Worker is entitled to redundancy pay
    negotiated in accordance with section 65 of Act 651.

15. GRIEVANCES AND DISCIPLINE
    A Worker with a grievance should raise it with their supervisor, and if it
    is not settled, with management in writing. A Worker may be accompanied by
    a colleague or a union representative at any disciplinary or grievance
    meeting. Nothing here prevents either party from referring a dispute to the
    National Labour Commission.

16. CONFIDENTIALITY
    The Worker shall not, during employment or after it ends, disclose
    information about guests, colleagues, or the business of the Employer,
    except where the law requires it.

17. PERSONAL DATA
    The Employer holds and uses the Worker's personal data to run the
    employment, meet its obligations to SSNIT and the Ghana Revenue Authority,
    and keep the personnel record the Labour Act requires. It is held in
    accordance with the Data Protection Act, 2012 (Act 843) and is not shared
    outside the property except where the law requires. The Worker may ask to
    see it and to have it corrected.

18. ENTIRE AGREEMENT AND VARIATION
    This contract, with the job description and the staff handbook, is the
    whole of the agreement between the parties. Any change must be in writing
    and agreed by both.

19. GOVERNING LAW
    This contract is governed by the laws of the Republic of Ghana.

The Worker confirms that this contract has been read to and by them, that they
understand it, and that they have been given a copy.

Dated {{today}}.${FOOTER}`,
  },

  {
    code: 'contract_fixed',
    name: 'Contract of employment — fixed term',
    kind: 'contract',
    satisfies: 'contract',
    detail: 'For a season, a project or a named period. Ends on its own date.',
    body: `FIXED TERM CONTRACT OF EMPLOYMENT

Made under the Labour Act, 2003 (Act 651)

BETWEEN {{property}} ("the Employer")
AND {{name}} of {{address}} ("the Worker"),
holding {{id_type}}, employee number {{employee_no}}.

1. ENGAGEMENT AND TERM
   The Employer engages the Worker as {{job_title}} in the {{department}}
   department for a fixed term beginning on {{start_date}} and ending on
   {{end_date}}, unless ended earlier under clause 8.
   This contract ends on that date without further notice from either party.
   It does not renew automatically. Any continuation must be agreed in writing.

2. DUTIES AND PLACE OF WORK
   The Worker shall carry out the duties of the position and any other
   reasonable duties assigned, at {{workplace}}.

3. REMUNERATION
   {{salary}}
   Payment is monthly in arrears, less income tax under the pay-as-you-earn
   system and the Worker's pension contribution.

4. PENSION AND SOCIAL SECURITY
   The Employer shall register the Worker with SSNIT and contribute under the
   National Pensions Act, 2008 (Act 766) for the duration of this contract.

5. HOURS OF WORK
   {{hours}} Hours are set by the published rota and are subject to the daily
   and weekly rest periods required by Act 651.

6. ANNUAL LEAVE
   The Worker is entitled to paid annual leave in proportion to the length of
   this contract, calculated on the basis of {{leave_days}} for a full calendar
   year of continuous service. Untaken leave at the end of the term is paid.

7. CONDUCT
   The Worker shall observe the Employer's rules on attendance, uniform,
   health and safety, food hygiene, and the handling of money, property and
   guests' information.

8. ENDING IT EARLY
   Either party may end this contract before its date by giving two weeks'
   written notice, or two weeks' pay in lieu. The Employer may end it without
   notice for gross misconduct, having first put the allegation to the Worker
   and heard the answer.

9. UNFAIR TERMINATION
   Section 63 of Act 651 applies to this contract as it does to any other.
   Ending a fixed term early for a reason that section names is unfair
   whatever this contract says.

10. CONFIDENTIALITY AND PERSONAL DATA
    The Worker shall not disclose information about guests, colleagues or the
    business of the Employer, during the term or after it. The Employer holds
    the Worker's personal data under the Data Protection Act, 2012 (Act 843)
    for the purposes of the employment and its statutory obligations.

11. GOVERNING LAW
    The laws of the Republic of Ghana.

Dated {{today}}.${FOOTER}`,
  },

  {
    code: 'statement_particulars',
    name: 'Written statement of particulars (section 13)',
    kind: 'contract',
    satisfies: 'contract',
    detail: 'The two-month statement. Use it for somebody already working here who '
      + 'never got a written contract.',
    body: `WRITTEN STATEMENT OF PARTICULARS OF EMPLOYMENT

Given under section 13 of the Labour Act, 2003 (Act 651), which requires an
employer to furnish a worker with a written statement of the main terms of the
contract of employment within two months of the employment beginning.

THE EMPLOYER
   Name:                {{property}}
   Address:             {{property_address}}

THE WORKER
   Name:                {{name}}
   Address:             {{address}}
   Identification:      {{id_type}}
   Employee number:     {{employee_no}}

THE EMPLOYMENT
   Job title:           {{job_title}}
   Department:          {{department}}
   Place of work:       {{workplace}}
   Date of engagement:  {{start_date}}
   Nature:              Continuous employment of an indefinite duration,
                        unless ended in accordance with the notice below.

   Remuneration:        {{salary}}
   Paid:                Monthly in arrears, by bank transfer or mobile money to
                        the account the Worker has given, less pay-as-you-earn
                        income tax and the Worker's pension contribution.

   Hours of work:       {{hours}}
                        Normal working hours do not exceed eight in a day or
                        forty in a week, as provided by section 33 of Act 651.
                        Actual hours are set by the published rota.

   Rest periods:        A daily rest period, and not less than thirty-six
                        consecutive hours of rest in each period of seven days.

   Annual leave:        {{leave_days}} of paid leave in each calendar year of
                        continuous service, being not less than the fifteen
                        working days required by section 20 of Act 651, taken
                        at a time agreed with the Employer.

   Sick leave:          Paid sick leave on production of a medical certificate,
                        in accordance with the Employer's policy and the Act.

   Maternity leave:     Not less than twelve weeks on full pay, in addition to
                        annual leave, under section 57 of Act 651.

   Pension:             Registered with SSNIT under the National Pensions Act,
                        2008 (Act 766). The Employer contributes 13% of basic
                        salary and deducts 5.5%.

   Notice to end it:    {{notice}}, and in any event not less than the period
                        required by section 17 of Act 651 — one month where the
                        contract is for three years or more, two weeks where it
                        is for less, seven days where the engagement is from
                        week to week.

   Discipline and
   grievances:          As set out in the staff handbook, a copy of which has
                        been given to the Worker. A worker may be accompanied
                        at any disciplinary or grievance meeting, and may refer
                        an unsettled dispute to the National Labour Commission.

   Collective
   agreement:           {{collective_agreement}}

The Worker confirms having received this statement and a copy of the staff
handbook, and having had the contents explained where asked.

Dated {{today}}.${FOOTER}`,
  },

  {
    code: 'contract_casual',
    name: 'Terms of engagement — casual or temporary worker',
    kind: 'contract',
    satisfies: 'contract',
    detail: 'For day work and short cover. Sections 74 to 77 of Act 651.',
    body: `TERMS OF ENGAGEMENT — CASUAL OR TEMPORARY WORK

Made under sections 74 to 77 of the Labour Act, 2003 (Act 651)

BETWEEN {{property}} ("the Employer")
AND {{name}} of {{address}} ("the Worker"),
holding {{id_type}}, employee number {{employee_no}}.

1. THE ARRANGEMENT
   The Worker is engaged as {{job_title}} on a casual basis from
   {{start_date}}. Work is offered as and when the Employer needs it and the
   Worker is free to accept or decline. There is no obligation on either side
   to offer or accept work on any particular day.

2. WHAT A CASUAL WORKER IS ENTITLED TO
   Under Act 651 a casual worker is entitled to:
     (a) be given the same medical facilities as a permanent worker;
     (b) be paid for overtime under section 35;
     (c) be paid for a public holiday that falls on a day worked;
     (d) a minimum wage not less than the national daily minimum wage.
   Nothing in this document reduces any of those.

3. PAY
   {{salary}}
   Paid at the end of the engagement or with the following payroll, whichever
   the Employer has told the Worker, less any deduction the law requires.

4. HOURS AND REST
   Hours are those of the shift offered and accepted. The daily and weekly rest
   periods in Act 651 apply.

5. BECOMING A PERMANENT WORKER
   Where a worker is employed by the same employer for six months or more, or
   for the equivalent number of working days within a year, section 12 of Act
   651 requires the employment to be secured by a written contract. The
   Employer will issue one at that point.

6. CONDUCT AND CONFIDENTIALITY
   The Worker shall observe the Employer's rules on health, safety and food
   hygiene, and shall not disclose anything about guests, colleagues or the
   business of the Employer.

7. ENDING IT
   Either party may end this arrangement at any time. Work already done is paid
   for in full.

Dated {{today}}.${FOOTER}`,
  },

  {
    code: 'probation_confirmation',
    name: 'Confirmation of appointment after probation',
    kind: 'letter',
    detail: 'The letter that ends a probation. Worth sending — silence is not confirmation.',
    body: `{{property}}
{{property_address}}

{{today}}

{{name}}
{{address}}

Dear {{first_name}},

CONFIRMATION OF APPOINTMENT

I am pleased to tell you that your probationary period as {{job_title}} in the
{{department}} department has been completed satisfactorily, and that your
appointment is confirmed with effect from {{effective_date}}.

Your terms of employment are unchanged except as follows:

  Notice period:   {{notice}}, replacing the one week that applied during
                   probation.
  Remuneration:    {{salary}}

Everything else in your contract of employment dated {{start_date}} continues
to apply, including your entitlement to {{leave_days}} of paid annual leave in
each calendar year.

Thank you for the work you have put in since you started. {{note}}

Yours sincerely,

For and on behalf of {{property}}${FOOTER}`,
  },

  {
    code: 'handbook_ack',
    name: 'Staff handbook and house rules — acknowledgement',
    kind: 'policy',
    satisfies: 'handbook',
    detail: 'What somebody agrees to abide by. Referred to by the contract.',
    body: `STAFF HANDBOOK AND HOUSE RULES — ACKNOWLEDGEMENT

{{property}}

I, {{name}}, employee number {{employee_no}}, confirm that I have received the
staff handbook and that the following have been explained to me.

ATTENDANCE
  I will work the shifts on the published rota. I will clock in and out at the
  staff entrance terminal at the start and end of every shift, using my own
  face or card and nobody else's. Clocking in for another person, or asking
  somebody to clock in for me, is gross misconduct.
  If I cannot come to work I will tell my supervisor as early as I can on the
  day, and in any event before my shift is due to start.

UNIFORM AND APPEARANCE
  I will come to work in the uniform provided, clean and complete, and will
  keep to the standard of personal presentation the property expects of
  somebody guests can see.

GUESTS
  I will treat guests and their belongings with care and courtesy. I will not
  discuss a guest, photograph a guest, or repeat anything I learn about a
  guest, inside the property or outside it, or on social media.

MONEY AND PROPERTY
  I will follow the property's procedures for handling cash, keys, stock and
  equipment. I will not remove anything from the premises without written
  permission. Lost property will be handed in.

ALCOHOL AND DRUGS
  I will not come to work unfit for duty through drink or drugs, and will not
  drink alcohol on duty except where my job requires me to taste it.

HEALTH AND SAFETY
  I will follow the safety rules, use the equipment provided, and report a
  hazard, an accident or an injury to my supervisor at once.

HARASSMENT AND RESPECT
  I will treat colleagues with respect. Bullying, harassment of any kind, and
  discrimination on grounds of sex, ethnic origin, religion, disability or any
  other ground are not tolerated here, and I understand that I may raise a
  complaint without fear of being penalised for it.

DISCIPLINE
  I understand that a breach of these rules may lead to disciplinary action;
  that I will be told the allegation and given a fair chance to answer it; and
  that I may be accompanied at any disciplinary meeting.

I understand that this handbook forms part of my contract of employment, that
the property may change it from time to time, and that I will be told when it
does.

Dated {{today}}.${FOOTER}`,
  },

  {
    code: 'confidentiality',
    name: 'Confidentiality and guest privacy undertaking',
    kind: 'policy',
    detail: 'Stands on its own so it can be given to anybody, including contractors.',
    body: `CONFIDENTIALITY AND GUEST PRIVACY UNDERTAKING

{{property}}

I, {{name}}, employee number {{employee_no}}, give this undertaking in
consideration of my engagement by {{property}}.

1. WHAT IS CONFIDENTIAL
   Anything I learn in the course of my work that is not already public. It
   includes, without limiting it:
     (a) the identity of a guest, the fact that a guest is or has been here,
         their room, their movements, their companions and their bookings;
     (b) anything a guest tells me or that I see or overhear;
     (c) a guest's payment details, passport or identification;
     (d) the property's prices, suppliers, recipes, procedures, occupancy,
         takings and business plans;
     (e) the personal information of my colleagues.

2. WHAT I UNDERTAKE
   I will not disclose confidential information to anybody outside the property,
   and inside it only to a colleague who needs it to do their job.
   I will not photograph, film or record a guest or a guest area, and I will not
   post anything about a guest, a colleague or the property on social media.
   I will not take, copy or keep any document or data belonging to the property
   except as my work requires.

3. ENQUIRIES ABOUT GUESTS
   If anybody — including somebody claiming to be a relative, an employer, a
   journalist or an officer — asks me whether a person is staying here, I will
   neither confirm nor deny it, and I will refer them to the manager on duty.

4. AFTER I LEAVE
   This undertaking continues after my employment ends. On leaving I will
   return everything belonging to the property, including keys, uniform,
   documents and any data in my possession.

5. WHERE THE LAW REQUIRES DISCLOSURE
   Nothing here prevents me from making a disclosure that the law requires or
   protects, including reporting a crime, giving evidence, or raising a
   complaint with the National Labour Commission or the Data Protection
   Commission.

I understand that a breach of this undertaking is gross misconduct and may
also give rise to a claim against me.

Dated {{today}}.${FOOTER}`,
  },

  {
    code: 'data_consent',
    name: 'Personal data notice and consent (Act 843)',
    kind: 'policy',
    satisfies: 'data_consent',
    detail: 'Required before collecting somebody’s details. The self-service link '
      + 'collects exactly what this describes.',
    body: `PERSONAL DATA — WHAT WE HOLD AND WHY

Given under the Data Protection Act, 2012 (Act 843)

{{property}} ("we") holds personal data about you, {{name}}. This notice says
what we hold, why, who sees it and what you can do about it.

WHAT WE HOLD
  Your name, date of birth, photograph and contact details.
  Your home address and the details of who to contact in an emergency.
  Your identification: Ghana Card or passport, SSNIT number and TIN.
  Your bank or mobile money account, for paying you.
  Your qualifications and previous employment.
  Your attendance record, from the terminal at the staff entrance, which
  records that your face was recognised at a particular time.
  Your rota, your leave, and any record of discipline or grievance.
  Where your work requires it, your food handler health certificate.

WHY WE HOLD IT
  To employ you and pay you.
  To meet obligations the law puts on us: registering you with SSNIT and
  remitting contributions, deducting and paying income tax, and keeping the
  personnel record the Labour Act, 2003 requires.
  To keep you and our guests safe, and to know who to contact if something
  happens to you at work.
  Where your work involves food, to hold the health certificate the Public
  Health Act, 2012 requires.

WHO SEES IT
  Only the people here whose job needs it. Your bank details and your
  identification numbers are seen only by those who manage records and run
  payroll; everybody else sees that they are on file and not what they say.
  We share data outside the property only where the law requires it — with
  SSNIT, the Ghana Revenue Authority, and a public authority acting under a
  power to demand it — or where you have asked us to.
  We do not sell it, and we do not send it out of Ghana except to a service
  provider that keeps it under the same protection.

HOW LONG WE KEEP IT
  For as long as you work here, and afterwards for as long as the law requires
  us to keep employment records, after which it is destroyed.

WHAT YOU CAN DO
  You may ask to see what we hold about you.
  You may ask us to correct anything that is wrong, and we will.
  You may object to a particular use of it, or withdraw this consent, by
  telling the office in writing — though we may still have to keep and use
  what the law requires us to.
  You may complain to the Data Protection Commission.

CONSENT
  I have read this notice. I understand what is held about me and why, and I
  consent to {{property}} collecting and using my personal data for the
  purposes set out above.

Dated {{today}}.${FOOTER}`,
  },

  {
    code: 'health_safety',
    name: 'Health, safety and food hygiene undertaking',
    kind: 'policy',
    detail: 'Act 651 puts the duty on both sides. Act 851 puts the health certificate '
      + 'on anybody near food.',
    body: `HEALTH, SAFETY AND FOOD HYGIENE

{{property}}

The Employer's duty
  Under sections 118 and 119 of the Labour Act, 2003 (Act 651) the Employer
  must ensure, so far as is practicable, that you work in conditions that are
  safe and without risk to health — providing safe equipment, safe systems of
  work, protective clothing where it is needed, and the information, training
  and supervision to work safely.

Your duty
  Under section 118 you must use the safety equipment provided, take reasonable
  care for your own safety and that of others, and report anything unsafe.

I, {{name}}, employee number {{employee_no}}, confirm the following.

1. I have been shown the fire exits, the assembly point, the fire
   extinguishers and the first aid box, and I know who the first aiders are.
2. I have been shown how to use the equipment I need for my work, and I will
   not use equipment I have not been trained on.
3. I will wear the protective clothing provided where it is required.
4. I will report any accident, injury, near miss or unsafe condition to my
   supervisor at once, however small it seems.
5. I will not work in a way that puts a guest, a colleague or myself at risk,
   and I understand that I may stop work and tell my supervisor if I believe a
   situation is unsafe.

FOOD HYGIENE — where my work brings me into contact with food

6. I understand that under the Public Health Act, 2012 (Act 851) every food
   handler must be screened and hold a valid health certificate, and that the
   certificate must be renewed every year. I will keep mine current and give
   the office a copy.
7. I will tell my supervisor at once if I have diarrhoea, vomiting, jaundice,
   a skin infection, a discharging wound, or any illness that could be passed
   on through food, and I will not handle food until I am cleared to.
8. I will wash my hands on starting work, after using the toilet, after
   handling raw food, after touching waste, and whenever else it is needed.
9. I will keep to the property's rules on food storage, temperature, dating
   and cleaning, and will not take shortcuts with them.

Dated {{today}}.${FOOTER}`,
  },

  {
    code: 'next_of_kin',
    name: 'Next of kin and emergency contact declaration',
    kind: 'policy',
    satisfies: 'next_of_kin',
    detail: 'The one piece of paper nobody looks at until the worst day.',
    body: `NEXT OF KIN AND EMERGENCY CONTACT

{{property}}

I, {{name}}, employee number {{employee_no}}, of {{address}}, declare the
following.

IF SOMETHING HAPPENS TO ME AT WORK, PLEASE CONTACT

  First person
    Name:
    Relationship to me:
    Telephone:
    Second telephone:
    Where they live:

  If that person cannot be reached
    Name:
    Relationship to me:
    Telephone:
    Where they live:

MY NEXT OF KIN
  (The person to be treated as my next of kin. This is a statement of my wishes
  to my employer; it is not a will and does not decide who inherits anything.)

    Name:
    Relationship to me:
    Telephone:
    Where they live:

ANYTHING A FIRST AIDER SHOULD KNOW
  (Blood group, allergies, a condition or medication that would matter in an
  emergency. You do not have to give this, and it will be seen only by those
  who need it.)

I confirm that the details above are correct, and I will tell the office if
they change.

Dated {{today}}.${FOOTER}`,
  },
];

/**
 * What ought to be in every personnel file.
 *
 * `applies` decides who it is asked of. Most are asked of everybody; two are
 * not, and getting that wrong in either direction is a real cost — a checklist
 * demanding a work permit from every Ghanaian is a checklist people learn to
 * ignore, and one that never asks for a food handler's certificate leaves a
 * kitchen open to being closed.
 */
export const REQUIRED_DOCUMENTS = [
  {
    code: 'ghana_card',
    label: 'Ghana Card or passport',
    detail: 'Proof of identity and the right to work. The number goes on the SSNIT and tax filings.',
    applies: 'all',
  },
  {
    code: 'ssnit',
    label: 'SSNIT card or number',
    detail: 'Needed to register the person and remit contributions under Act 766.',
    applies: 'all',
  },
  {
    code: 'contract',
    label: 'Signed contract of employment',
    detail: 'Required by section 12 of Act 651 for six months of employment or more. '
      + 'A contract signed here, or a scan of one signed on paper, satisfies this.',
    applies: 'all',
    fromContract: true,
  },
  {
    code: 'photo',
    label: 'Passport photograph',
    detail: 'For the file, the staff card and the terminal.',
    applies: 'all',
  },
  {
    code: 'education',
    label: 'Certificates',
    detail: 'WASSCE, a diploma, a trade certificate — whatever the post was filled on.',
    applies: 'all',
  },
  {
    code: 'reference',
    label: 'Reference or police clearance',
    detail: 'A written reference from a previous employer, or a police report where the '
      + 'post involves cash, keys or guests’ rooms.',
    applies: 'all',
  },
  {
    code: 'next_of_kin',
    label: 'Next of kin declaration',
    detail: 'Who to ring. Signed, so there is no argument about it afterwards.',
    applies: 'all',
    fromContract: true,
  },
  {
    code: 'data_consent',
    label: 'Personal data consent',
    detail: 'Required by the Data Protection Act, 2012 (Act 843) before holding somebody’s details.',
    applies: 'all',
    fromContract: true,
  },
  {
    code: 'handbook',
    label: 'Handbook acknowledgement',
    detail: 'What the contract refers to when it says the house rules form part of it.',
    applies: 'all',
    fromContract: true,
  },
  {
    code: 'food_health',
    label: 'Food handler health certificate',
    detail: 'Public Health Act, 2012 (Act 851): anybody handling food must be screened and hold '
      + 'a valid certificate, renewed every year.',
    applies: 'food',
    expires: true,
  },
  {
    code: 'work_permit',
    label: 'Work and residence permit',
    detail: 'For a worker who is not a Ghanaian citizen.',
    applies: 'foreign',
    expires: true,
  },
];

/** Departments this property treats as food handling, for Act 851 purposes. */
const FOOD_DEPARTMENTS = /bar|kitchen|f&b|food|restaurant|bistro|breakfast|catering/i;

/**
 * Which of the required documents this particular person needs.
 *
 * The two conditional ones are decided from what the record already says:
 * their department for food handling, and their nationality for a permit. Where
 * the record says nothing about nationality, no permit is demanded — assuming
 * somebody is foreign because a field is blank is exactly the wrong default.
 */
export function requiredDocumentsFor(person, profile) {
  const department = String(person?.department ?? '');
  const jobTitle = String(person?.job_title ?? person?.jobTitle ?? '');
  const nationality = String(profile?.nationality ?? '').trim().toLowerCase();

  const handlesFood = FOOD_DEPARTMENTS.test(department) || FOOD_DEPARTMENTS.test(jobTitle);
  const isForeign = nationality !== '' && !/ghana/i.test(nationality);

  return REQUIRED_DOCUMENTS.filter((doc) => {
    if (doc.applies === 'food') return handlesFood;
    if (doc.applies === 'foreign') return isForeign;
    return true;
  });
}

/**
 * The state of somebody's file against what is required of them.
 *
 * A document that has run out counts as missing, because an expired food
 * handler's certificate is worth exactly as much to an inspector as no
 * certificate — and rather less to whoever eats the food.
 */
export function fileStatus(person, profile, { documents = [], contracts = [], today }) {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const signed = new Set(
    contracts.filter((c) => c.status === 'signed').map((c) => c.satisfies).filter(Boolean),
  );

  return requiredDocumentsFor(person, profile).map((doc) => {
    const held = documents.filter((d) => d.kind === doc.code);
    const newest = held.sort((a, b) => String(b.expires_on ?? '').localeCompare(String(a.expires_on ?? '')))[0];
    const expired = Boolean(newest?.expires_on && newest.expires_on < day);
    const soon = Boolean(newest?.expires_on && !expired && newest.expires_on <= addDays(day, 30));

    const satisfied = Boolean(newest && !expired) || (doc.fromContract && signed.has(doc.code));

    return {
      ...doc,
      documentId: newest?.id ?? null,
      expiresOn: newest?.expires_on ?? null,
      state: satisfied ? (soon ? 'expiring' : 'held') : (expired ? 'expired' : 'missing'),
    };
  });
}

function addDays(day, n) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}
