// The contracts of employment, as revised in November 2026.
//
// Held here rather than inline in ghana-templates.js because three templates
// share them and a migration writes them to the templates already on file.
// They follow the Labour Act, 2003 (Act 651) and the other statutes named in
// them. They are not legal advice and no Ghanaian lawyer has settled them; the
// foot of each says so, and they should be read by one before they are relied
// on in a dispute.
//
// How they are made: the contract is issued electronically, the Employee
// accepts it by typing their full name (a signature under the Electronic
// Transactions Act, 2008 (Act 772)), and both Parties then sign two paper
// copies at the property. The contract binds from the electronic acceptance;
// the paper signing confirms it and is not a condition of it.
//
// Clauses are numbered as they are put together, and every cross-reference is
// worked out from the clause it points at, so moving a clause can never leave
// "clause 7" pointing at the wrong thing.

export const CONTRACT_FOOTER = `
────────────────────────────────────────────────────────────
Prepared from the Labour Act, 2003 (Act 651) and the other statutes named in
it. It is a template and not legal advice; it should be read by a lawyer
qualified in Ghana before it is relied on in a dispute. Accepted electronically
under the Electronic Transactions Act, 2008 (Act 772): the record of acceptance
(the name typed, the time, the device and a fingerprint of these exact words)
is kept with it, and the paper copies are signed afterwards.`;

/**
 * Put clauses together: each is [key, (n, ref) => text], numbered in order.
 * `ref('pay')` is the number of the clause keyed 'pay'.
 */
function assemble(head, clauses, tail) {
  const numbers = new Map(clauses.map(([key], i) => [key, i + 1]));
  const ref = (key) => {
    const n = numbers.get(key);
    if (!n) throw new Error(`No clause keyed ${key}`);
    return n;
  };
  return [head, ...clauses.map(([key, text]) => text(ref(key), ref)), tail].join('\n\n') + CONTRACT_FOOTER;
}

const preamble = (title, kind, recital) => `${title}

This ${kind} (hereinafter referred to as the "Contract") is made on {{today}}

BETWEEN

{{company_legal_name}}, a company incorporated under the laws of the Republic
of Ghana, trading as {{property}} and having its principal place of business
at {{company_address}} (hereinafter referred to as the "Employer", which
expression shall where the context so admits include its successors and
assigns) of the one part;

AND

{{name}} of {{address}}, holder of {{id_type}}, employee number {{employee_no}}
(hereinafter referred to as the "Employee") of the other part.

The Employer and the Employee are hereinafter referred to individually as a
"Party" and together as the "Parties".

WHEREAS, the Employer carries on the business of hotel, hostel, food and
beverage, craft and related services;

WHEREAS, ${recital}; and

WHEREAS, this Contract is made pursuant to sections 12 and 13 of the Labour
Act, 2003 (Act 651) (hereinafter referred to as the "Act"), which require a
contract of employment for a period of six months or more to be in writing and
the particulars of employment to be furnished to the worker in writing.

NOW, THEREFORE, in consideration of the mutual covenants and promises herein
contained, the Parties agree as follows:`;

const definitions = (n, ref) => `${n}. DEFINITIONS AND INTERPRETATION

${n}.1 In this Contract, unless the context otherwise requires:
    "Business Day" means a day other than a Saturday, Sunday or public holiday
    in Ghana;
    "Handbook" means the Employer's staff handbook and house rules, as amended
    from time to time in accordance with clause ${ref('entire')}, made available
    to the Employee through the Employer's staff application ("HIVE") or on
    paper;
    "Remuneration" means the basic salary, allowances and any bonus payable
    under clause ${ref('pay')} and Exhibit B; and
    "Rota" means the schedule of shifts published by the Employer.
${n}.2 Headings are for convenience only and shall not affect interpretation.
    Words importing the singular include the plural and vice versa. A
    reference to a statute includes that statute as amended or re-enacted and
    any regulations made under it.
${n}.3 Where this Contract and the Handbook conflict, this Contract shall
    prevail. Where any term of this Contract confers on the Employee less than
    the Act or any other enactment confers, that enactment shall prevail and
    this Contract shall be read as conferring what the enactment confers.`;

const duties = (n) => `${n}. POSITION, DUTIES AND PLACE OF WORK

${n}.1 The Employer hereby employs the Employee, and the Employee agrees to serve
    the Employer, as {{job_title}} in the {{department}} department (the
    "Position").
${n}.2 The Employee shall perform the duties described in Exhibit A attached
    hereto and in any job description furnished to the Employee, which shall
    form part of this Contract.
${n}.3 The Employee shall serve the Employer faithfully and diligently, obey
    the lawful and reasonable instructions of the Employer, and perform such
    other duties within the Employee's skill and competence as the Employer
    may reasonably assign to meet the needs of the business.
${n}.4 The Employee's place of work shall be: {{workplace}} The Employer may
    require the Employee to work at any other premises of the Employer within
    reasonable travelling distance, and shall bear any additional cost of
    travel occasioned thereby.`;

const hours = (n, ref) => `${n}. HOURS OF WORK, REST AND OVERTIME

${n}.1 Normal hours of work shall not exceed eight (8) hours in a day or forty
    (40) hours in a week, in accordance with section 33 of Act 651. The
    Employee shall work the shifts published on the Rota, which the Employer
    shall publish in advance. {{hours}}
${n}.2 The Employee shall be entitled to a break of not less than thirty (30)
    minutes in each continuous shift, and to the daily and weekly rest periods
    provided by the Act. The Rota shall be drawn up so as to afford them.
${n}.3 Work performed in excess of normal hours shall constitute overtime. It
    shall be worked by agreement, or where the Employer reasonably requires it
    to meet an urgent need, and shall be remunerated in accordance with
    section 35 of Act 651, any applicable collective agreement and the rate set
    out in Exhibit B.
${n}.4 The Employee shall record each arrival and departure on the Employer's
    attendance terminal, and shall report any missed or erroneous record to
    the Employee's supervisor on the same day so that it may be corrected.
    Lateness and absence shall be dealt with under the Handbook and clause
    ${ref('pay')}.4(c).`;

const pay = (n, ref) => `${n}. REMUNERATION, BONUS AND DEDUCTIONS

${n}.1 In consideration of the services rendered hereunder, the Employer shall
    pay the Employee the Remuneration described in Exhibit B attached hereto,
    monthly in arrears on or before the last Business Day of each month, into
    a bank or mobile money account nominated by the Employee, together with a
    payslip showing how it is made up.
${n}.2 Any bonus shall be payable on the terms set out in Exhibit B and the
    Handbook. Save as Exhibit B otherwise provides, a bonus depends upon
    performance and the results of the business and does not form part of the
    basic salary.
${n}.3 The Employer shall deduct from the Remuneration income tax in accordance
    with the Income Tax Act, 2015 (Act 896), the Employee's contribution under
    clause ${ref('pension')}, and any other sum the law requires to be deducted.
${n}.4 No other deduction shall be made from the Remuneration save as the law
    permits or the Employee agrees in writing. By accepting this Contract the
    Employee agrees in writing to the following deductions, each of which
    shall be shown on the payslip:
    (a) the repayment of a salary advance or loan, upon the schedule agreed
        when it was made;
    (b) a till or cash shortage for which the Employee is responsible, or the
        cost of the Employer's property not returned upon the termination of
        employment, after the Employee has been informed of it and afforded an
        opportunity to explain;
    (c) the late arrival charge set out in the Handbook (at the date of this
        Contract, GHS 20 for each shift on which the Employee clocks in fifteen
        (15) minutes or more after its scheduled start), which the Employer
        may waive; and
    (d) a bonus deduction for the breach of a house rule, at the fixed amount
        for that rule listed in the Handbook, to be taken from that month's
        bonus or, where there is no bonus from which to take it, from salary.
${n}.5 Before any deduction under clause ${n}.4(b), (c) or (d) is made, the
    Employee shall be informed of it and may reply in writing, and the
    Employer shall consider the reply. No deduction shall reduce the
    Employee's pay for a month below nothing; any balance shall be carried to
    the following month. The Employer shall give not less than one (1) month's
    notice in the Handbook before increasing any amount referred to in clause
    ${n}.4(c) or (d), and the Employee may by notice in writing withdraw consent
    to any such increase.
${n}.6 The Employer shall review the basic salary not less than once in each
    year, and shall confirm any change in writing.`;

const pension = (n) => `${n}. PENSION AND SOCIAL SECURITY

${n}.1 In accordance with the National Pensions Act, 2008 (Act 766), the
    Employer shall register the Employee with the Social Security and National
    Insurance Trust and shall contribute thirteen per cent (13%) of the
    Employee's basic salary and deduct five and one-half per cent (5.5%)
    therefrom, of which thirteen and one-half per cent (13.5%) shall be
    remitted to the first tier and five per cent (5%) to an approved
    second-tier scheme.
${n}.2 The Employer shall remit all contributions within the time prescribed by
    law and shall furnish the Employee with evidence thereof upon request.`;

const leave = (annual) => (n) => `${n}. LEAVE, PUBLIC HOLIDAYS AND SICKNESS

${n}.1 ${annual}
${n}.2 Annual leave shall be requested through HIVE and taken at times agreed
    with the Employer. It shall not be commuted into money save upon the
    termination of employment, when leave earned and not taken shall be paid.
${n}.3 Public holidays declared under the Public Holidays Act, 2001 (Act 601), as
    amended, shall be paid days. Where the Employee is required to work on a
    public holiday, the Employee shall be granted a paid day off in lieu or
    such additional pay as the Handbook provides.
${n}.4 An Employee unable to work through illness shall so inform the
    Employee's supervisor before the start of the shift, or as soon as is
    practicable thereafter. A medical certificate shall be produced for any
    absence of two (2) or more consecutive days. Paid sick leave shall be as
    set out in the Handbook, and absence without notice or certificate may be
    unpaid.
${n}.5 A female Employee shall be entitled to maternity leave of not less than
    twelve (12) weeks on full pay, extended by not less than two (2) weeks in
    the case of an abnormal or multiple birth, to nursing breaks and to
    protection from night work and overtime, all in accordance with section 57
    of Act 651, and shall not be dismissed by reason of pregnancy or absence on
    maternity leave.
${n}.6 Any further leave, including paternity, compassionate and study leave,
    shall be as set out in the Handbook.`;

const conduct = (n, ref) => `${n}. CONDUCT, HEALTH AND SAFETY

${n}.1 The Employee shall comply with the Handbook, including the rules relating
    to attendance, uniform and appearance, guests, cash and stock, the use of
    telephones, and the use of the Employer's property.
${n}.2 The Employer shall provide a safe place of work and such protective
    equipment as the work requires. The Employee shall observe the health,
    safety and food hygiene rules, and an Employee who handles food shall hold
    and renew a valid food handler's health certificate as required by the
    Public Health Act, 2012 (Act 851).
${n}.3 The Employer does not tolerate harassment, discrimination or violence.
    The Employee shall not engage therein, and may report any such conduct
    under clause ${ref('discipline')}.2 without suffering any detriment for so
    doing.
${n}.4 Uniform, keys, cards, equipment and documents shall remain the property
    of the Employer and shall be returned upon the termination of employment.
    The cost of any item not returned may be deducted in accordance with
    clause ${ref('pay')}.4(b).
${n}.5 The Employee shall not, without the written consent of the Employer,
    undertake other work which conflicts with the business of the Employer or
    with the Employee's hours on the Rota.`;

const confidence = (n) => `${n}. CONFIDENTIALITY AND PERSONAL DATA

${n}.1 During and after the employment the Employee shall not use or divulge
    any confidential information of the Employer, its guests or its staff,
    including without limitation the identities, bookings and room numbers of
    guests, rates, supplier terms, and the remuneration and personal details
    of colleagues, save in the proper course of the Employee's duties or where
    required by law.
${n}.2 The Employer processes the Employee's personal data for the purposes of
    administering the employment, paying the Employee, discharging its
    obligations to the Social Security and National Insurance Trust and the
    Ghana Revenue Authority, keeping attendance records (including those of
    the attendance terminal) and maintaining the personnel record required by
    the Act. It shall do so in accordance with the Data Protection Act, 2012
    (Act 843), shall keep such data secure, and shall not disclose it outside
    the Employer save as required by law or with the Employee's consent. The
    Employee may request access to such data and its correction.`;

const discipline = (n) => `${n}. DISCIPLINE AND GRIEVANCES

${n}.1 Disciplinary matters shall be dealt with under the procedure set out in
    the Handbook. Before taking any disciplinary action other than an informal
    warning, the Employer shall inform the Employee in writing of the
    allegation, afford the Employee a fair opportunity to answer it, and
    permit the Employee to be accompanied by a colleague or a trade union
    representative.
${n}.2 A grievance shall be raised first with the Employee's supervisor and, if
    not settled within five (5) Business Days, in writing with management,
    which shall respond in writing within ten (10) Business Days.
${n}.3 Nothing in this Contract shall prevent either Party from referring a
    dispute to the National Labour Commission or from exercising any right
    under the Act.`;

const unfair = `A termination shall be unfair, notwithstanding anything in this Contract,
     where the reason for it is one which section 63 of Act 651 renders unfair,
     including the Employee's membership of or participation in the activities
     of a trade union, seeking office as or acting as a workers'
     representative, the filing of a complaint against the Employer,
     pregnancy or absence on maternity leave, disability, or the Employee's
     gender, race, colour, ethnic origin, religion, creed, social, political
     or economic status.`;

const collective = (n) => `${n}. COLLECTIVE AGREEMENT

{{collective_agreement}}`;

const entire = (n) => `${n}. ENTIRE AGREEMENT

This Contract, together with its Exhibits and the Handbook, constitutes the
entire agreement between the Parties relating to the employment and supersedes
all prior offers, understandings and representations, whether written or oral.
The Employer may amend the Handbook upon reasonable notice to the Employee,
save that any amendment which reduces the Remuneration or the other terms of
this Contract shall require the written agreement of the Employee.`;

const modification = (n) => `${n}. NO MODIFICATION UNLESS IN WRITING

No modification of this Contract shall be valid unless it is in writing and
accepted by both Parties, electronically or on paper.`;

const severability = (n) => `${n}. SEVERABILITY

If any provision of this Contract is held to be invalid or unenforceable, the
remaining provisions shall continue in full force and effect.`;

const notices = (n) => `${n}. NOTICES

Any notice under this Contract shall be in writing and may be delivered by hand,
sent to the address of the Party stated above, or sent electronically through
HIVE or to the email address or telephone number last furnished by that Party.`;

const law = (n) => `${n}. APPLICABLE LAW

This Contract and the interpretation of its terms shall be governed by and
construed in accordance with the laws of the Republic of Ghana.`;

const counterparts = (n, ref) => `${n}. COUNTERPARTS

This Contract may be executed electronically in accordance with clause
${ref('execution')} and in two or more paper counterparts, each of which shall be
deemed an original and all of which together shall constitute one instrument.`;

const further = (n) => `${n}. FURTHER PROVISIONS

{{note}}`;

const execution = (n) => `${n}. ACCEPTANCE AND EXECUTION

${n}.1 The Employee shall accept this Contract by typing the Employee's full
    name where HIVE so requests. The name so typed shall constitute the
    Employee's signature for the purposes of the Electronic Transactions Act,
    2008 (Act 772), and this Contract shall bind both Parties from the moment
    of such acceptance.
${n}.2 The Parties shall thereafter each sign two (2) paper counterparts of this
    same Contract, one to be retained by each Party. The paper signature
    confirms this Contract and is not a condition of its taking effect. In the
    event of any discrepancy between a paper counterpart and the electronic
    copy accepted under clause ${n}.1, identified by its fingerprint, the
    electronic copy shall prevail.

IN WITNESS WHEREOF, the Employee has accepted this Contract electronically and
hereunto set their hand, and the Employer has caused these presents to be
executed in its name and on its behalf, on the dates written below.

ACCEPTED electronically by the Employee by typing their full name:

    Name typed: ........................................   Date: ...............

SIGNED by the Employee:

    ..................................................
    {{name}}
    Date:

SIGNED for and on behalf of {{company_legal_name}}:

    ..................................................
    Name:
    Position:
    Date:

In the presence of:

    ..................................................
    Witness name:
    Address:
    Date:`;

const exhibits = `EXHIBIT A — EMPLOYEE DUTIES

A.1 The duties set out in the job description for {{job_title}} furnished to
    the Employee.
A.2 Such other duties within the Employee's skill and competence as are needed
    for the Employer's operations, which may include reception, housekeeping,
    kitchen, food and beverage service, laundry, maintenance and grounds.

EXHIBIT B — COMPENSATION AND BENEFITS

B.1 REMUNERATION
    {{salary}}
B.2 PAY DAY
    The last Business Day of each month, in arrears.
B.3 ANNUAL LEAVE
    {{leave_days}} in each year of continuous service.
B.4 PENSION
    As provided in the clause on pension and social security.
B.5 STATUTORY BENEFITS
    Such other benefits as are provided by the Labour Act, 2003 (Act 651) and
    any other enactment, as and when they fall due.`;

const tailClauses = [
  ['collective', collective],
  ['entire', entire],
  ['modification', modification],
  ['severability', severability],
  ['notices', notices],
  ['law', law],
  ['counterparts', counterparts],
  ['further', further],
  ['execution', execution],
];

/** The indefinite contract, used for "Contract of employment" and "— permanent". */
export const PERMANENT_CONTRACT = assemble(
  preamble('CONTRACT OF EMPLOYMENT', 'Contract of Employment',
    'the Employer desires to employ the Employee, and the Employee desires to be employed by the Employer, upon the terms and conditions hereinafter set forth'),
  [
    ['definitions', definitions],
    ['term', (n, ref) => `${n}. COMMENCEMENT AND PROBATION

${n}.1 The employment shall commence on {{start_date}} (the "Start Date") and
    shall continue for an indefinite period until terminated in accordance
    with clause ${ref('termination')}. No previous employment with the Employer shall
    count towards the Employee's period of continuous employment unless the
    Employer so confirms in writing.
${n}.2 The first {{probation}} of the employment shall constitute a
    probationary period, during which the Employer shall review the
    Employee's performance and conduct with the Employee at least once, and
    either Party may terminate the employment by seven (7) days' notice in
    writing to the other, or payment in lieu thereof.
${n}.3 The Employer may extend the probationary period once, by not more than
    three (3) months, by notice in writing to the Employee given before it
    ends and stating the reasons. At its end the Employer shall either confirm
    the Employee's appointment in writing or terminate the employment under
    clause ${n}.2.`],
    ['duties', duties],
    ['hours', hours],
    ['pay', pay],
    ['pension', pension],
    ['leave', leave(`The Employee shall be entitled to {{leave_days}} of paid annual leave in
    each year of continuous service, being not less than the fifteen (15)
    working days required by section 20 of Act 651, earned and taken as the
    Handbook provides. Leave in the first year shall be earned in proportion
    to the period worked.`)],
    ['conduct', conduct],
    ['confidence', confidence],
    ['discipline', discipline],
    ['termination', (n, ref) => `${n}. TERMINATION

${n}.1 After the probationary period either Party may terminate the employment
     by notice in writing of not less than {{notice}}, and in any event not
     less than that required by section 17 of Act 651, namely:
       (a) one (1) month, or one month's pay in lieu, where the contract is
           for three (3) years or more; and
       (b) two (2) weeks, or two weeks' pay in lieu, where it is for less than
           three (3) years.
${n}.2 The Employer shall terminate the employment only for a reason which the
     Act recognises as fair, including the Employee's incapacity or
     incompetence for the work, proven misconduct, redundancy, or a legal
     restriction upon the employment, and only after complying with clause
     ${ref('discipline')}.1. The Employer may terminate without notice for gross
     misconduct, which includes theft, fraud or dishonesty, violence or threats
     of violence, harassment, being unfit for duty through alcohol or drugs,
     wilful damage, and serious breach of the privacy of guests or of the
     health, safety or food hygiene rules.
${n}.3 ${unfair}
${n}.4 Nothing in this Contract shall limit the Employee's right under the Act
     to terminate the employment on the grounds of ill-treatment or sexual
     harassment.
${n}.5 Where the employment is terminated by reason of redundancy, the Employer
     shall give such notice and consult as the Act requires, and shall pay
     redundancy pay in accordance with section 65 of Act 651, as agreed with
     the Employee or the Employee's representative or as determined by the
     National Labour Commission.
${n}.6 Upon the termination of employment the Employer shall pay all
     Remuneration earned, pay for leave earned and not taken, and any other
     sum the Act requires, and shall upon request furnish the Employee with a
     certificate of service stating the dates of employment and the Position.
     The Employee shall return the Employer's property in accordance with
     clause ${ref('conduct')}.4.
${n}.7 The normal retirement age shall be sixty (60) years, being the age at
     which a pension becomes payable under the National Pensions Act, 2008
     (Act 766). The employment shall terminate upon the Employee attaining
     that age unless the Parties agree in writing to continue it.`],
    ...tailClauses,
  ],
  exhibits,
);

/** The fixed-term contract. */
export const FIXED_TERM_CONTRACT = assemble(
  preamble('FIXED TERM CONTRACT OF EMPLOYMENT', 'Fixed Term Contract of Employment',
    'the Employer desires to employ the Employee for a fixed period, and the Employee desires to be so employed, upon the terms and conditions hereinafter set forth'),
  [
    ['definitions', definitions],
    ['term', (n, ref) => `${n}. TERM

${n}.1 The employment shall commence on {{start_date}} and shall expire, without
    the need for notice from either Party, on {{end_date}} (the "End Date"),
    unless terminated earlier in accordance with clause ${ref('termination')}.
${n}.2 This Contract shall not renew automatically. Any extension or new term
    shall be agreed in writing before the End Date. Where the Employee
    continues to work after the End Date with the knowledge of the Employer
    and no new contract has been agreed, the employment shall continue upon
    these terms until terminated by notice under clause ${ref('termination')}.1.
${n}.3 The first month of the employment shall constitute a probationary
    period, during which either Party may terminate it by seven (7) days'
    notice in writing, or payment in lieu thereof.`],
    ['duties', duties],
    ['hours', hours],
    ['pay', pay],
    ['pension', pension],
    ['leave', leave(`The Employee shall earn paid annual leave in proportion to the length of
    the term, on the basis of {{leave_days}} for a full year of continuous
    service and in no case less than section 20 of Act 651 requires. Leave
    earned and not taken by the End Date shall be paid.`)],
    ['conduct', conduct],
    ['confidence', confidence],
    ['discipline', discipline],
    ['termination', (n, ref) => `${n}. EARLY TERMINATION

${n}.1 After the probationary period either Party may terminate the employment
     before the End Date by giving the other two (2) weeks' notice in writing,
     or two weeks' pay in lieu, or such longer notice as section 17 of Act 651
     requires.
${n}.2 The Employer shall terminate the employment early only for a reason which
     the Act recognises as fair and after complying with clause
     ${ref('discipline')}.1, and may terminate without notice for gross
     misconduct, including theft, fraud or dishonesty, violence, harassment,
     being unfit for duty through alcohol or drugs, and serious breach of the
     privacy of guests or of the health, safety or food hygiene rules.
${n}.3 ${unfair}
${n}.4 Upon the expiry or earlier termination of the employment the Employer
     shall pay all Remuneration earned and pay for leave earned and not taken,
     and shall upon request furnish a certificate of service. The Employee
     shall return the Employer's property in accordance with clause
     ${ref('conduct')}.4.`],
    ...tailClauses,
  ],
  exhibits,
);
