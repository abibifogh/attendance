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

This Contract of Employment (hereinafter referred to as the "Contract") states
the terms and conditions that govern the contractual agreement between
{{company_legal_name}}, a company incorporated under the laws of the Republic of
Ghana and having its principal place of business at {{property_address}}
(hereinafter referred to as the "Company"), and {{name}} of {{address}}, holder
of {{id_type}}, employee number {{employee_no}} (hereinafter referred to as the
"Employee"), who agrees to be bound by this Contract.

WHEREAS, the Company is engaged in the operation of hotel and hostel facilities
and the food and beverage services incidental thereto; and

WHEREAS, the Company desires to employ and retain the services of the Employee,
and the Employee desires to render such services, upon the terms and conditions
hereinafter set forth; and

WHEREAS, this Contract is made pursuant to sections 12 and 13 of the Labour Act,
2003 (Act 651), which require a contract of employment for six months or more to
be in writing and the principal terms thereof to be furnished to the worker in
writing.

NOW, THEREFORE, in consideration of the mutual covenants and promises made by
the parties hereto, the Company and the Employee (individually, each a "Party"
and collectively, the "Parties") covenant and agree as follows:

1. TERM AND COMMENCEMENT

1.1 The term of this Contract shall commence on {{start_date}} (the "Start
    Date") and shall continue for an indefinite duration until terminated in
    accordance with clause 11 hereof.
1.2 The Parties agree and acknowledge that the first {{probation}} of the
    Contract period shall constitute a probationary period, during which either
    Party may terminate this Contract by seven (7) days' written notice to the
    other, or payment in lieu thereof.
1.3 Confirmation of the Employee in the Position following the probationary
    period shall be communicated in writing.
1.4 This Contract shall be subject to annual review and may accordingly be
    maintained, amended by agreement of the Parties, or terminated in
    accordance with clause 11.

2. DUTIES AND PLACE OF WORK

2.1 The Company shall employ the Employee as {{job_title}} in the
    {{department}} department (the "Position").
2.2 The Employee accepts employment with the Company upon the terms and
    conditions set forth in this Contract and agrees to devote their full
    working time and attention (reasonable periods of illness excepted) to the
    performance of their duties hereunder, faithfully and to the best of their
    ability, and to obey the lawful and reasonable instructions of the Company.
2.3 In general, the Employee shall perform all of the duties described in
    Exhibit A attached hereto and the job description furnished to the
    Employee, which shall form part of this Contract.
2.4 Notwithstanding clause 2.3, in addition to the duties which the Position
    normally entails, the Employee may from time to time be required to
    undertake additional or other duties necessary to meet the needs of the
    business and which are within the Employee's skill or competence level.
2.5 The place of work shall be {{workplace}} The Employee may be required to
    work at any other premises of the Company within reasonable travelling
    distance.

3. HOURS OF WORK AND REST PERIODS

3.1 Normal working hours shall not exceed eight (8) hours in a day or forty
    (40) hours in a week, as provided by section 33 of Act 651. Actual hours
    shall be scheduled by the published rota. {{hours}}
3.2 The Employee shall be entitled to a break of not less than one (1) hour in
    a shift, exclusive of the hours referred to in clause 3.1.
3.3 Work performed beyond the hours specified in clause 3.1 shall be by
    agreement and shall be remunerated in accordance with section 35 of Act 651
    and the Company's overtime policy.
3.4 The Employee shall be entitled to a daily rest period and to not less than
    thirty-six (36) consecutive hours of rest in each period of seven (7) days.
3.5 The Company reserves the right to review the Employee's normal hours of
    work should the needs of the business so dictate, upon reasonable notice to
    the Employee.

4. COMPENSATION AND BENEFITS

4.1 In consideration for the performance of the duties hereunder, the Employee
    shall be entitled to the compensation and benefits described in Exhibit B
    attached hereto.
4.2 Compensation shall be paid monthly in arrears, by the last working day of
    each month, into the account nominated by the Employee.
4.3 The Company shall deduct from the Employee's remuneration only such sums as
    are required or permitted by law, namely income tax under the pay-as-you-earn
    system and the Employee's statutory pension contribution, together with any
    sum to which the Employee has consented in writing.

5. PENSION AND SOCIAL SECURITY

5.1 Pursuant to the National Pensions Act, 2008 (Act 766), the Company shall
    contribute thirteen per cent (13%) of the Employee's basic salary and shall
    deduct five and one-half per cent (5.5%) therefrom, making eighteen and
    one-half per cent (18.5%) in aggregate, of which thirteen and one-half per
    cent (13.5%) shall be remitted to the Social Security and National Insurance
    Trust under the first tier and five per cent (5%) to an approved second-tier
    scheme.
5.2 The Company shall register the Employee with the Trust and shall remit all
    contributions within the time prescribed by the said Act.

6. ANNUAL LEAVE AND OTHER ABSENCE

6.1 The Employee shall be entitled to {{leave_days}} of paid annual leave in
    each calendar year of continuous service, being not less than the fifteen
    (15) working days required by section 20 of Act 651, to be taken at such
    time as may be agreed with the Company.
6.2 The Company shall not require the Employee to take annual leave in place of
    a public holiday or during a period of certified sick leave.
6.3 Absence through illness shall be reported to the Employee's supervisor as
    early as practicable on the first day of absence, and a medical certificate
    shall be produced in respect of any absence exceeding two (2) days.
6.4 A female Employee shall be entitled to maternity leave of not less than
    twelve (12) weeks on full pay in addition to annual leave, together with
    such further leave as section 57 of Act 651 allows in the case of a
    caesarean or multiple birth, and to nursing breaks upon her return.
6.5 Public holidays gazetted under the Public Holidays Act shall be paid days
    off. Where the Employee is required to work a public holiday falling on a
    weekday, the Employee shall be granted a paid day off in lieu.

7. CONDUCT, PROPERTY AND GUESTS

7.1 The Employee shall observe the Company's rules relating to attendance,
    uniform, appearance, health and safety, food hygiene, and the handling of
    money and property.
7.2 The property, information and privacy of guests shall be respected
    absolutely.
7.3 Uniform, keys, access cards, tools and equipment shall remain the property
    of the Company and shall be returned upon the termination of employment.
7.4 Tips and gratuities shall be dealt with in accordance with the Company's
    published policy.

8. CONFIDENTIALITY

8.1 During and after the Employment Period, the Employee shall not divulge or
    appropriate to their own use, or to the use of others, any secret or
    confidential information or knowledge pertaining to the business of the
    Company obtained by them in any way while employed by the Company, save
    where disclosure is required by law.
8.2 Confidential information includes, without limitation, guest details and
    bookings, rates, supplier terms, and information concerning colleagues.

9. PERSONAL DATA

9.1 The Company holds and processes the Employee's personal data for the
    purposes of administering the employment, discharging its obligations to
    the Social Security and National Insurance Trust and the Ghana Revenue
    Authority, and maintaining the personnel record required by Act 651.
9.2 Such data is held in accordance with the Data Protection Act, 2012
    (Act 843) and shall not be disclosed outside the Company save where
    required by law. The Employee may request access to it and its correction.

10. EXPENSES

10.1 The Employee shall not be entitled to reimbursement for any expense except
     such as has been approved in writing by the Company in advance.
10.2 Where the Company requires travel by the Employee, the Company shall
     reimburse the Employee for such travel expenses, together with reasonable
     lodging and meal expenses, upon presentation of receipts.

11. TERMINATION

11.1 After the probationary period, either Party may terminate this Contract by
     giving the other written notice in accordance with section 17 of Act 651,
     namely:
       (a) one (1) month, or one month's pay in lieu, where the contract is for
           three (3) years or more;
       (b) two (2) weeks, or two weeks' pay in lieu, where it is for less than
           three (3) years;
       (c) seven (7) days where the engagement is from week to week.
11.2 The Parties have agreed a notice period of {{notice}}, which shall apply
     where it is longer than the statutory minimum prescribed in clause 11.1.
11.3 The Employee agrees and acknowledges that, just as the Employee has the
     right to terminate their employment with the Company at any time on any
     ground not contrary to the provisions of Act 651, the Company has the same
     right and may terminate the employment of the Employee at any time on the
     same grounds.
11.4 The Company may terminate this Contract without notice for gross
     misconduct, which includes theft or dishonesty, wilful damage, violence or
     threats of violence, being unfit for duty through drink or drugs, serious
     breach of health, safety or food hygiene rules, and serious breach of the
     duty owed to guests. Before doing so the Company shall put the allegation
     to the Employee and afford the Employee a fair opportunity to answer it.
11.5 Nothing in this Contract shall derogate from the protection afforded to the
     Employee by section 63 of Act 651. A termination shall be unfair if the
     reason for it is, among others, that the Employee joined or took part in
     the activities of a trade union, sought office as a workers'
     representative, brought a complaint against the Company, was pregnant or
     absent on maternity leave, or is disabled; or where the reason is race,
     colour, ethnic origin, sex, religion, creed, social or economic status or
     political opinion.
11.6 Where the employment of the Employee is terminated by reason of a closure,
     arrangement or amalgamation, the Employee shall be entitled to redundancy
     pay negotiated in accordance with section 65 of Act 651.

12. GRIEVANCES AND DISCIPLINE

12.1 An Employee having a grievance shall raise it with their supervisor and,
     failing settlement, with management in writing.
12.2 The Employee may be accompanied by a colleague or a trade union
     representative at any disciplinary or grievance meeting.
12.3 Nothing herein shall prevent either Party from referring an unsettled
     dispute to the National Labour Commission.

13. EMPLOYEE REPRESENTATIONS AND WARRANTIES

The Employee represents and warrants to the Company as follows:
13.1 There is no employment contract or other contractual obligation to which
     the Employee is subject which prevents the Employee from entering into
     this Contract or from performing fully the Employee's duties hereunder.
13.2 The information furnished by the Employee to the Company in connection
     with this engagement is true and complete.

14. COLLECTIVE AGREEMENT

{{collective_agreement}}

15. ENTIRE AGREEMENT

This Contract, together with the job description, the Exhibits hereto and the
staff handbook, constitutes the entire agreement between the Parties and
supersedes all prior understandings, whether written or oral, relating to the
subject matter hereof.

16. NO MODIFICATION UNLESS IN WRITING

No modification of this Contract shall be valid unless in writing and agreed
upon by both Parties.

17. SEVERABILITY

If any provision of this Contract is held to be invalid or unenforceable, the
remaining provisions shall continue in full force and effect.

18. APPLICABLE LAW

This Contract and the interpretation of its terms shall be governed by and
construed in accordance with the laws of the Republic of Ghana.

19. COUNTERPARTS

This Contract may be executed in two or more counterparts, any one of which
shall be deemed the original without reference to the others.

20. FURTHER PROVISIONS

{{note}}

IN WITNESS WHEREOF, the Employee has hereunto set their hand, and the Company
has caused these presents to be executed in its name and on its behalf, all as
of the day and year first above written.

SIGNED by the Employee:

    ..................................................
    {{name}}
    Date: {{today}}


SIGNED for and on behalf of {{company_legal_name}}:

    ..................................................
    Name:
    Position:
    Date:

EXHIBIT A — EMPLOYEE DUTIES

In general, the duties of the Position to be filled by the Employee shall
encompass the following:

A.1 The duties set out in the job description for {{job_title}} furnished to the
    Employee.
A.2 Any other duties assigned to the Employee to meet the needs of the
    Company's operations. Without limitation, this may include duties in the
    areas of reception, housekeeping, kitchen, food and beverage service,
    maintenance and grounds.

EXHIBIT B — COMPENSATION AND BENEFITS

B.1 REMUNERATION
    {{salary}}
    The said sum has been determined having regard to statutory deductions,
    including the Employee's social security contribution and income tax.

B.2 ANNUAL LEAVE
    {{leave_days}} of paid annual leave in each calendar year of continuous
    service, as provided in clause 6.1.

B.3 STATUTORY BENEFITS
    The Company shall grant the Employee such other statutory benefits as are
    stipulated in the Labour Act, 2003 (Act 651) as and when the need arises.${FOOTER}`,
  },

  {
    code: 'contract_hotel',
    name: 'Contract of employment — hotel and hostel staff',
    kind: 'contract',
    satisfies: 'contract',
    detail: 'The property’s own wording: shifts, weekends, the handbook, and a three-month '
      + 'probation.',
    body: `CONTRACT OF EMPLOYMENT

This Contract of Employment (hereinafter referred to as the "Contract") states
the terms and conditions that govern the contractual agreement between
{{company_legal_name}}, a company incorporated under the laws of the Republic of
Ghana and having its principal place of business at {{property_address}}
(hereinafter referred to as the "Company"), and {{name}} of {{address}}, holder
of {{id_type}}, employee number {{employee_no}} (hereinafter referred to as the
"Employee"), who agrees to be bound by this Contract.

WHEREAS, the Company is engaged in the operation of hotel and hostel facilities;
and

WHEREAS, the Company desires to employ and retain the services of the Employee
according to the terms and conditions herein.

NOW, THEREFORE, in consideration of the mutual covenants and promises made by
the parties hereto, the Company and the Employee (individually, each a "Party"
and collectively, the "Parties") covenant and agree as follows:

1. TERM

1.1 The term of this Contract shall commence on {{start_date}} (the "Start
    Date").
1.2 Both Parties agree and acknowledge that the first {{probation}} of the
    Contract period shall be a probation period, during which period either
    Party may terminate this Contract with seven (7) days' written notice.
1.3 The Contract shall be subject to annual review and may accordingly be
    maintained, amended or abrogated.
1.4 The Employee agrees and acknowledges that, just as the Employee has the
    right to terminate their employment with the Company at any time on any
    ground not contrary to the provisions of the Labour Act, 2003 (Act 651),
    the Company has the same right and may terminate the employment of the
    Employee at any time on the same grounds.
1.5 Either Party may terminate the said employment with {{notice}} written
    notice to the other Party, or payment in lieu thereof.

2. DUTIES

2.1 The Company shall employ the Employee as {{job_title}} in the
    {{department}} department (the "Position").
2.2 The Employee accepts employment with the Company on the terms and
    conditions set forth in this Contract, and agrees to devote their full time
    and attention (reasonable periods of illness excepted) to the performance
    of their duties under this Contract.
2.3 In general, the Employee shall perform all the duties as described in
    Exhibit A attached hereto.
2.4 Notwithstanding clause 2.3, in addition to the duties which the job
    normally entails, the Employee may from time to time be required to
    undertake additional or other duties necessary to meet the needs of the
    business and which are within the Employee's skill or competence level.
2.5 The place of work shall be {{workplace}}

3. HOURS OF WORK

3.1 The Employee shall be scheduled for an eight (8) hour shift each day for a
    minimum of forty (40) hours each week. Scheduling shall be done in a just
    manner, respecting the Employee's needs where possible. {{hours}}
3.2 The Employee is entitled to a break of one (1) hour, exclusive of the
    working hours aforementioned in clause 3.1.
3.3 With respect to the nature of the Company's operations, the Employee may be
    scheduled to work on weekends and public holidays. This shall count towards
    the forty (40) hours that the Employee is required to work each week as
    stipulated in clause 3.1.
3.4 In instances where the Employee is scheduled to work on a public holiday
    that falls on a work weekday, the Employee shall be entitled to a paid leave
    in the future in lieu of the public holiday.
3.5 For the avoidance of doubt, work weekdays used in clause 3.4 shall be
    deemed to mean Monday to Friday.
3.6 There shall be not less than twelve (12) hours between the end of one shift
    and the commencement of the next, and not less than forty-eight (48) hours
    of rest in every period of seven (7) days.
3.7 The Company reserves the right to review the Employee's normal hours of
    work should the needs of the business so dictate.

4. COMPENSATION AND BENEFITS

4.1 In consideration for the performance of the duties hereunder, the Employee
    shall be entitled to compensation and benefits as described in Exhibit B
    attached hereto.
4.2 Compensation shall be paid by the Company monthly, by bank transfer, less
    income tax under the pay-as-you-earn system and the Employee's statutory
    social security contribution. No other deduction shall be made without the
    written consent of the Employee or a requirement of law.

5. THE STAFF HANDBOOK

5.1 The staff handbook sets out the manner in which the Company conducts its
    operations from day to day, including conduct, guest service, health and
    safety, confidentiality, and the grievance and disciplinary procedures.
5.2 The Employee shall read the staff handbook and shall comply with it. The
    Company may amend the handbook and shall notify the Employee upon doing so.
5.3 Where the handbook and this Contract are inconsistent, this Contract shall
    prevail.

6. CONFIDENTIALITY

6.1 During and after the Employment Period, the Employee shall not divulge or
    appropriate to their own use, or to the use of others, any secret or
    confidential information or knowledge pertaining to the business of the
    Company obtained by them in any way while employed by the Company. Such
    information includes, without limitation, guest details and bookings,
    rates, supplier terms, and information concerning colleagues.
6.2 Guest personal data shall be handled in accordance with the Data Protection
    Act, 2012 (Act 843) and the Company's own data protection notice.

7. COMPANY PROPERTY AND EXPENSES

7.1 Uniform, keys, access cards, tools and equipment shall remain the property
    of the Company and shall be returned upon the termination of employment.
7.2 The Employee shall not be entitled to reimbursement for any expense except
    such as has been approved in writing by the Company in advance, upon
    presentation of receipts. Should the Company require travel by the
    Employee, the Company shall reimburse such travel expenses together with
    reasonable lodging and meal expenses.

8. EMPLOYEE REPRESENTATIONS AND WARRANTIES

The Employee represents and warrants to the Company the following:
8.1 There is no employment contract or any other contractual obligation to
    which the Employee is subject which prevents the Employee from entering
    into this Contract or from performing fully the Employee's duties under
    this Contract.
8.2 The information furnished by the Employee to the Company is true and
    complete.

9. STATUTORY PROTECTION

9.1 Nothing in this Contract shall derogate from the protection afforded to the
    Employee by section 63 of Act 651 in respect of unfair termination.
9.2 Nothing herein shall prevent either Party from referring an unsettled
    dispute to the National Labour Commission.

10. COLLECTIVE AGREEMENT

{{collective_agreement}}

11. NO MODIFICATION UNLESS IN WRITING

No modification of this Contract shall be valid unless in writing and agreed
upon by both Parties.

12. APPLICABLE LAW

This Contract and the interpretation of its terms shall be governed by and
construed in accordance with the laws of the Republic of Ghana.

13. COUNTERPARTS

This Contract may be executed in two or more counterparts, any one of which
shall be deemed the original without reference to the others.

14. FURTHER PROVISIONS

{{note}}

IN WITNESS WHEREOF, the Employee has hereunto set their hand, and the Company
has caused these presents to be executed in its name and on its behalf, all as
of the day and year first above written.

SIGNED by the Employee:

    ..................................................
    {{name}}
    Date: {{today}}


SIGNED for and on behalf of {{company_legal_name}}:

    ..................................................
    Name:
    Position:
    Date:

EXHIBIT A — EMPLOYEE DUTIES

In general, the duties of the Position to be filled by the Employee shall
encompass the following:

A.1 The duties set out in the job description for {{job_title}} furnished to the
    Employee.
A.2 Any other duties assigned to the Employee to meet the needs of the
    Company's operations. Without limitation, this may include duties in the
    following areas: reception, housekeeping, kitchen, food and beverage
    service, construction, gardening and maintenance.

EXHIBIT B — COMPENSATION AND BENEFITS

B.1 COMPENSATION
    {{salary}}
    The said sum has been determined having regard to statutory deductions,
    including the Employee's social security contribution and income tax.
    Should the Employee work more shifts than are required, the Company shall
    grant the Employee a paid leave in the future, or cash consideration as
    compensation.

B.2 ANNUAL LEAVE
    The Employee shall be entitled to {{leave_days}} of paid annual leave. This
    entitlement shall be built after the initial twelve (12) months of
    employment and shall be granted by the Company having regard to work
    schedules at the time of applying for the leave.

B.3 STATUTORY BENEFITS
    The Company shall grant the Employee such other statutory benefits as are
    stipulated in the Labour Act, 2003 (Act 651), such as maternity leave, as
    and when the need arises.

B.4 PENSION
    The Company shall register the Employee with the Social Security and
    National Insurance Trust and shall contribute in accordance with the
    National Pensions Act, 2008 (Act 766).${FOOTER}`,
  },

  {
    code: 'contract_fixed',
    name: 'Contract of employment — fixed term',
    kind: 'contract',
    satisfies: 'contract',
    detail: 'For a season, a project or a named period. Ends on its own date.',
    body: `FIXED TERM CONTRACT OF EMPLOYMENT

This Fixed Term Contract of Employment (hereinafter referred to as the
"Contract") states the terms and conditions that govern the contractual
agreement between {{company_legal_name}}, a company incorporated under the laws
of the Republic of Ghana and having its principal place of business at
{{property_address}} (hereinafter referred to as the "Company"), and {{name}} of
{{address}}, holder of {{id_type}}, employee number {{employee_no}} (hereinafter
referred to as the "Employee"), who agrees to be bound by this Contract.

WHEREAS, the Company is engaged in the operation of hotel and hostel facilities;
and

WHEREAS, the Company desires to engage the services of the Employee for a fixed
period, and the Employee desires to render such services, upon the terms and
conditions hereinafter set forth.

NOW, THEREFORE, in consideration of the mutual covenants and promises made by
the parties hereto, the Company and the Employee (individually, each a "Party"
and collectively, the "Parties") covenant and agree as follows:

1. TERM

1.1 The term of this Contract shall commence on {{start_date}} and shall expire
    on {{end_date}}, unless terminated earlier in accordance with clause 8.
1.2 This Contract shall determine upon the said expiry date without further
    notice from either Party.
1.3 This Contract shall not renew automatically. Any continuation of the
    employment beyond the expiry date must be agreed between the Parties in
    writing.

2. DUTIES AND PLACE OF WORK

2.1 The Company shall employ the Employee as {{job_title}} in the
    {{department}} department (the "Position").
2.2 The Employee shall perform the duties of the Position together with such
    other reasonable duties as may be assigned, at {{workplace}}
2.3 The Employee agrees to devote their full working time and attention to the
    performance of their duties hereunder.

3. COMPENSATION

3.1 {{salary}}
3.2 Compensation shall be paid monthly in arrears, less income tax under the
    pay-as-you-earn system and the Employee's statutory pension contribution.

4. PENSION AND SOCIAL SECURITY

The Company shall register the Employee with the Social Security and National
Insurance Trust and shall contribute in accordance with the National Pensions
Act, 2008 (Act 766) for the duration of this Contract.

5. HOURS OF WORK

5.1 Normal working hours shall not exceed eight (8) hours in a day or forty (40)
    hours in a week. Actual hours shall be scheduled by the published rota.
    {{hours}}
5.2 The daily and weekly rest periods prescribed by the Labour Act, 2003
    (Act 651) shall apply to this Contract.

6. ANNUAL LEAVE

The Employee shall be entitled to paid annual leave in proportion to the length
of this Contract, calculated on the basis of {{leave_days}} for a full calendar
year of continuous service. Leave untaken at the expiry of the term shall be
paid.

7. CONDUCT AND CONFIDENTIALITY

7.1 The Employee shall observe the Company's rules relating to attendance,
    uniform, health and safety, food hygiene, and the handling of money,
    property and guests' information.
7.2 The Employee shall not, during the term or after it, divulge any
    confidential information pertaining to guests, colleagues or the business
    of the Company.
7.3 The Company holds the Employee's personal data in accordance with the Data
    Protection Act, 2012 (Act 843) for the purposes of the employment and its
    statutory obligations.

8. EARLY TERMINATION

8.1 Either Party may terminate this Contract before the expiry date by giving
    two (2) weeks' written notice to the other, or two weeks' pay in lieu
    thereof.
8.2 The Company may terminate this Contract without notice for gross
    misconduct, having first put the allegation to the Employee and afforded
    the Employee a fair opportunity to answer it.
8.3 Section 63 of Act 651 applies to this Contract as it does to any other. The
    early termination of a fixed term for a reason named in that section shall
    be unfair notwithstanding anything in this Contract.

9. NO MODIFICATION UNLESS IN WRITING

No modification of this Contract shall be valid unless in writing and agreed
upon by both Parties.

10. APPLICABLE LAW

This Contract and the interpretation of its terms shall be governed by and
construed in accordance with the laws of the Republic of Ghana. Unsettled
disputes may be referred to the National Labour Commission.

11. COUNTERPARTS

This Contract may be executed in two or more counterparts, any one of which
shall be deemed the original without reference to the others.

12. FURTHER PROVISIONS

{{note}}

IN WITNESS WHEREOF, the Employee has hereunto set their hand, and the Company
has caused these presents to be executed in its name and on its behalf, all as
of the day and year first above written.

SIGNED by the Employee:

    ..................................................
    {{name}}
    Date: {{today}}


SIGNED for and on behalf of {{company_legal_name}}:

    ..................................................
    Name:
    Position:
    Date:${FOOTER}`,
  },

  {
    code: 'statement_particulars',
    name: 'Written statement of particulars (section 13)',
    kind: 'contract',
    satisfies: 'contract',
    detail: 'The two-month statement. Use it for somebody already working here who '
      + 'never got a written contract.',
    body: `WRITTEN STATEMENT OF PARTICULARS OF EMPLOYMENT

This Written Statement of Particulars of Employment (hereinafter referred to as
the "Statement") is furnished by {{company_legal_name}}, a company incorporated
under the laws of the Republic of Ghana and having its principal place of
business at {{property_address}} (hereinafter referred to as the "Employer"), to
{{name}} of {{address}}, holder of {{id_type}} (hereinafter referred to as the
"Worker").

WHEREAS, section 13 of the Labour Act, 2003 (Act 651) requires an employer to
furnish a worker with a written statement of the particulars of the contract of
employment within two (2) months of the commencement of the employment; and

WHEREAS, the Employer wishes to record the principal terms upon which the Worker
is and has been employed.

NOW, THEREFORE, the Employer hereby furnishes the following particulars:

1. THE PARTIES

1.1 Employer: {{company_legal_name}}, trading as {{property}}, of
    {{property_address}}.
1.2 Worker: {{name}} of {{address}}, holder of {{id_type}}, employee number
    {{employee_no}}.

2. THE EMPLOYMENT

2.1 Position: {{job_title}}, in the {{department}} department.
2.2 Place of work: {{workplace}}
2.3 Date of engagement: {{start_date}}.
2.4 Nature of the contract: continuous employment of an indefinite duration,
    until terminated in accordance with paragraph 8 hereof.

3. REMUNERATION

3.1 {{salary}}
3.2 Interval of payment: monthly in arrears, by bank transfer or mobile money
    to the account nominated by the Worker, less income tax under the
    pay-as-you-earn system and the Worker's statutory pension contribution.

4. HOURS OF WORK AND REST PERIODS

4.1 {{hours}}
4.2 Normal working hours shall not exceed eight (8) in a day or forty (40) in a
    week, as provided by section 33 of Act 651. Actual hours are scheduled by
    the published rota.
4.3 The Worker is entitled to a daily rest period and to not less than
    thirty-six (36) consecutive hours of rest in each period of seven (7) days.

5. LEAVE

5.1 Annual leave: {{leave_days}} of paid leave in each calendar year of
    continuous service, being not less than the fifteen (15) working days
    required by section 20 of Act 651, to be taken at a time agreed with the
    Employer.
5.2 Sick leave: paid sick leave upon production of a medical certificate, in
    accordance with the Employer's policy and the said Act.
5.3 Maternity leave: not less than twelve (12) weeks on full pay in addition to
    annual leave, under section 57 of Act 651.

6. PENSION AND SOCIAL SECURITY

The Worker is registered with the Social Security and National Insurance Trust
under the National Pensions Act, 2008 (Act 766). The Employer contributes
thirteen per cent (13%) of basic salary and deducts five and one-half per cent
(5.5%).

7. DISCIPLINE, GRIEVANCES AND COLLECTIVE AGREEMENT

7.1 Discipline and grievances are dealt with as set out in the staff handbook, a
    copy of which has been furnished to the Worker. The Worker may be
    accompanied at any disciplinary or grievance meeting, and may refer an
    unsettled dispute to the National Labour Commission.
7.2 Collective agreement: {{collective_agreement}}

8. TERMINATION

8.1 Notice: {{notice}}, and in any event not less than the period required by
    section 17 of Act 651, namely one (1) month where the contract is for three
    (3) years or more, two (2) weeks where it is for less, and seven (7) days
    where the engagement is from week to week.
8.2 Nothing in this Statement derogates from the protection afforded to the
    Worker by section 63 of Act 651 in respect of unfair termination.

9. FURTHER PROVISIONS

{{note}}

The Worker hereby acknowledges receipt of this Statement and of a copy of the
staff handbook, and confirms that the contents hereof have been explained where
explanation was sought.

SIGNED by the Worker:

    ..................................................
    {{name}}
    Date: {{today}}


SIGNED for and on behalf of {{company_legal_name}}:

    ..................................................
    Name:
    Position:
    Date:${FOOTER}`,
  },

  {
    code: 'contract_casual',
    name: 'Terms of engagement — casual or temporary worker',
    kind: 'contract',
    satisfies: 'contract',
    detail: 'For day work and short cover. Sections 74 to 77 of Act 651.',
    body: `TERMS OF ENGAGEMENT — CASUAL OR TEMPORARY WORK

These Terms of Engagement (hereinafter referred to as the "Terms") state the
terms and conditions that govern the contractual agreement between
{{company_legal_name}}, a company incorporated under the laws of the Republic of
Ghana and having its principal place of business at {{property_address}}
(hereinafter referred to as the "Employer"), and {{name}} of {{address}}, holder
of {{id_type}}, employee number {{employee_no}} (hereinafter referred to as the
"Worker"), who agrees to be bound by these Terms.

WHEREAS, the Employer from time to time requires casual or temporary labour in
the operation of its hotel and hostel facilities; and

WHEREAS, these Terms are made having regard to sections 74 to 77 of the Labour
Act, 2003 (Act 651), which provide for the engagement of casual and temporary
workers.

NOW, THEREFORE, the Employer and the Worker (individually, each a "Party" and
collectively, the "Parties") covenant and agree as follows:

1. THE ENGAGEMENT

1.1 The Worker is engaged as {{job_title}} on a casual basis with effect from
    {{start_date}}.
1.2 Work shall be offered as and when the Employer requires it, and the Worker
    shall be free to accept or decline any offer of work.
1.3 There shall be no obligation upon either Party to offer or to accept work on
    any particular day.
1.4 The place of work shall be {{workplace}}

2. ENTITLEMENTS OF A CASUAL WORKER

2.1 Pursuant to Act 651, a casual worker is entitled:
      (a) to be given the same medical facilities as a permanent worker;
      (b) to be paid for overtime work in accordance with section 35;
      (c) to be paid for a public holiday which falls on a day upon which the
          worker has worked;
      (d) to a minimum wage not less than the national daily minimum wage.
2.2 Nothing in these Terms shall operate to reduce any of the entitlements set
    out in clause 2.1.

3. REMUNERATION

3.1 {{salary}}
3.2 Payment shall be made at the conclusion of the engagement or with the
    following payroll, as the Employer shall have notified the Worker, less any
    deduction required by law.

4. HOURS AND REST

Hours shall be those of the shift offered and accepted. The daily and weekly
rest periods prescribed by Act 651 shall apply.

5. CONVERSION TO PERMANENT EMPLOYMENT

Where a worker is employed by the same employer for six (6) months or more, or
for the equivalent number of working days within a year, section 12 of Act 651
requires the employment to be secured by a written contract. The Employer shall
issue such a contract at that point.

6. CONDUCT AND CONFIDENTIALITY

6.1 The Worker shall observe the Employer's rules relating to health, safety and
    food hygiene.
6.2 The Worker shall not divulge any information concerning guests, colleagues
    or the business of the Employer.

7. TERMINATION

Either Party may terminate this engagement at any time. Work already performed
shall be paid for in full.

8. APPLICABLE LAW

These Terms and the interpretation thereof shall be governed by and construed in
accordance with the laws of the Republic of Ghana.

9. FURTHER PROVISIONS

{{note}}

SIGNED by the Worker:

    ..................................................
    {{name}}
    Date: {{today}}


SIGNED for and on behalf of {{company_legal_name}}:

    ..................................................
    Name:
    Position:
    Date:${FOOTER}`,
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

  // -------------------------------------------------------------------------
  // Correspondence. Rendered with the letter register's own bag of values —
  // reference, addressee, subject, signatory — and not the personnel one, so
  // these carry their own template kind and are offered only on that screen.
  // -------------------------------------------------------------------------

  {
    code: 'letter_general',
    name: 'General letter',
    kind: 'correspondence',
    detail: 'The house shape for anything that has no template of its own.',
    body: `{{property}}
{{property_address}}

Our ref: {{reference}}
{{today}}

{{recipient}}
{{organisation}}
{{recipient_address}}

Dear Sir or Madam,

{{subject}}

{{body}}

Yours faithfully,




{{signatory}}
{{signatory_title}}
For and on behalf of {{property}}`,
  },

  {
    code: 'letter_demand',
    name: 'Letter before action — unpaid account',
    kind: 'correspondence',
    detail: 'A first written demand, which is what a court will later ask whether you sent.',
    body: `{{property}}
{{property_address}}

Our ref: {{reference}}
Your ref: {{your_reference}}
{{today}}

{{recipient}}
{{organisation}}
{{recipient_address}}

Dear Sir or Madam,

{{subject}}

We write about the amount outstanding on your account with us.

{{body}}

We should be grateful if the balance were settled within fourteen days of the
date of this letter. If there is a reason for the delay, or if you dispute any
part of the amount, please tell us in writing within that period and we will
look into it.

If we have heard nothing by then we shall have no option but to place the
matter in the hands of our solicitors and to seek recovery of the amount
together with any costs and interest properly due. We would much rather not,
and we hope this letter makes that unnecessary.

Yours faithfully,




{{signatory}}
{{signatory_title}}
For and on behalf of {{property}}`,
  },

  {
    code: 'letter_complaint_reply',
    name: 'Reply to a guest complaint',
    kind: 'correspondence',
    detail: 'Answer it, own what is ours, say what changes. In that order.',
    body: `{{property}}
{{property_address}}

Our ref: {{reference}}
{{today}}

{{recipient}}
{{recipient_address}}

Dear {{recipient_first}},

{{subject}}

Thank you for writing to us, and I am sorry that your stay was not what it
should have been. I have looked into what happened.

{{body}}

You were entitled to expect better of us and on this occasion you did not get
it. I am sorry.

If there is anything further you would like to raise, please write to me
directly and I will deal with it myself.

Yours sincerely,




{{signatory}}
{{signatory_title}}
{{property}}`,
  },

  {
    code: 'letter_authority',
    name: 'Letter to a government department or authority',
    kind: 'correspondence',
    detail: 'Formal, referenced, and saying plainly what is being asked for.',
    body: `{{property}}
{{property_address}}

Our ref: {{reference}}
Your ref: {{your_reference}}
{{today}}

The {{recipient}}
{{organisation}}
{{recipient_address}}

Dear Sir or Madam,

{{subject}}

{{body}}

We should be grateful for your response in due course. Should any further
information or document be required, please contact the undersigned and it
will be provided without delay.

Thank you for your assistance.

Yours faithfully,




{{signatory}}
{{signatory_title}}
For and on behalf of {{property}}`,
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
/**
 * What a personnel file has to contain, and which of it the person themselves
 * can supply.
 *
 * `self` marks a document somebody can photograph and send in from the link on
 * their phone. It is the paper they are already holding: their own card, their
 * own certificate, their own photograph. The ones without it are the property's
 * own documents — a contract, a signed declaration, an acknowledgement of the
 * handbook — which are produced and signed here and would mean nothing arriving
 * as a photograph from the person they are meant to bind.
 */
export const REQUIRED_DOCUMENTS = [
  {
    code: 'ghana_card',
    label: 'Ghana Card or passport',
    detail: 'Proof of identity and the right to work. The number goes on the SSNIT and tax filings.',
    applies: 'all',
    self: true,
  },
  {
    code: 'ssnit',
    label: 'SSNIT card or number',
    detail: 'Needed to register the person and remit contributions under Act 766.',
    applies: 'all',
    self: true,
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
    self: true,
  },
  {
    code: 'education',
    label: 'Certificates',
    detail: 'WASSCE, a diploma, a trade certificate — whatever the post was filled on.',
    applies: 'all',
    self: true,
  },
  {
    code: 'reference',
    label: 'Reference or police clearance',
    detail: 'A written reference from a previous employer, or a police report where the '
      + 'post involves cash, keys or guests’ rooms.',
    applies: 'all',
    self: true,
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
    self: true,
  },
  {
    code: 'work_permit',
    label: 'Work and residence permit',
    detail: 'For a worker who is not a Ghanaian citizen.',
    applies: 'foreign',
    expires: true,
    self: true,
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
