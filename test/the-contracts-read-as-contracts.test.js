import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STANDARD_TEMPLATES } from '../src/lib/ghana-templates.js';
import { PLACEHOLDERS, renderTemplate } from '../src/lib/people.js';

/**
 * The contracts have to read like contracts.
 *
 * They were written in plain sentences, on the reasoning that a housekeeper
 * signing one should be able to read it. That reasoning is right about the
 * handbook and wrong about this: a contract is the document produced when
 * somebody disputes what was agreed, and one drafted like a leaflet invites
 * the argument that the parties never intended to be bound.
 *
 * So the register is the property's own: parties defined in a preamble,
 * recitals, decimal clause numbering, an execution block, and the boilerplate
 * that makes a written agreement hold together — entire agreement, no
 * modification unless in writing, governing law, counterparts.
 *
 * What did NOT change is the statutory substance underneath. Every reference
 * to Act 651, Act 766 and Act 843 that was there before is still there, and
 * the protections in section 63 are still spelled out rather than left to be
 * looked up.
 */

const CONTRACTS = STANDARD_TEMPLATES.filter((t) => t.kind === 'contract');
const bodyOf = (code) => STANDARD_TEMPLATES.find((t) => t.code === code).body;

/**
 * The words with the line breaks taken out.
 *
 * These are hard-wrapped for paper, so any phrase longer than a few words may
 * break across a line, and where it breaks moves the moment a clause is
 * reworded. Matching a phrase against the raw body tests the wrapping rather
 * than the drafting, which is a test that fails for the wrong reason and gets
 * deleted. Line-anchored checks below still read the raw body, because there
 * the layout is the point.
 */
const flat = (body) => String(body).replace(/\s+/g, ' ');

test('there are five of them, and each is a contract that satisfies the file', () => {
  assert.deepEqual(CONTRACTS.map((t) => t.code).sort(), [
    'contract_casual', 'contract_fixed', 'contract_hotel', 'contract_permanent',
    'statement_particulars',
  ]);
  for (const t of CONTRACTS) assert.equal(t.satisfies, 'contract');
});

test('each names its parties in a preamble and defines them', () => {
  for (const t of CONTRACTS) {
    // Hard-wrapped for paper, so a phrase may break across a line. Every
    // assertion in this file is whitespace-tolerant for that reason.
    assert.match(flat(t.body), /hereinafter referred to as the "(Company|Employer)"/, t.code);
    assert.match(flat(t.body), /hereinafter referred to as the "(Employee|Worker)"/, t.code);
    // The party is the registered company, not the trading name. A contract
    // made in a name that is not at the Registrar is one somebody can argue
    // about, and the two are rarely the same.
    assert.ok(t.body.includes('{{company_legal_name}}'), `${t.code} does not name the company`);
    assert.match(flat(t.body),
      /incorporated under the laws of the Republic of Ghana|furnished by/, t.code);
  }
});

test('each recites why it is being made, and what it is made under', () => {
  for (const t of CONTRACTS) {
    assert.match(t.body, /^WHEREAS,/m, `${t.code} has no recitals`);
    assert.match(t.body, /NOW, THEREFORE,/, `${t.code} has no operative words`);
  }
});

test('each is numbered as a legal instrument, not as a leaflet', () => {
  for (const t of CONTRACTS) {
    // Decimal sub-clauses, which is what makes a cross-reference possible.
    assert.match(t.body, /^\d+\.\d+ /m, `${t.code} has no numbered sub-clauses`);
    // And at least one clause that refers to another by number, which is the
    // point of numbering them.
    // Whole clause or sub-clause: "in accordance with clause 8" is ordinary
    // drafting and does not need a decimal.
    assert.match(t.body, /clause \d+|paragraph \d+/, `${t.code} cross-references nothing`);
  }
});

test('each ends with an execution block that can actually be signed', () => {
  for (const t of CONTRACTS) {
    assert.match(t.body, /^SIGNED by the (Employee|Worker):$/m, t.code);
    assert.match(t.body, /^SIGNED for and on behalf of \{\{company_legal_name\}\}:$/m, t.code);
    // Stacked, never two columns held apart by spaces: a contract renders in a
    // proportional serif and a space-aligned column comes out ragged.
    assert.equal(/\{\{name\}\} {6,}\{\{company_legal_name\}\}/.test(t.body), false,
      `${t.code} lines two signatures up with spaces`);
  }
});

test('the boilerplate that makes an agreement hold together is in the long ones', () => {
  for (const code of ['contract_permanent', 'contract_hotel', 'contract_fixed']) {
    const body = bodyOf(code);
    assert.match(body, /^\d+\. NO MODIFICATION UNLESS IN WRITING$/m, code);
    assert.match(body, /^\d+\. APPLICABLE LAW$/m, code);
    assert.match(body, /^\d+\. COUNTERPARTS$/m, code);
    assert.match(flat(body), /laws of the Republic of Ghana/, code);
  }
  assert.match(bodyOf('contract_permanent'), /^\d+\. ENTIRE AGREEMENT$/m);
  assert.match(bodyOf('contract_permanent'), /^\d+\. SEVERABILITY$/m);
});

test('the two full contracts carry their duties and pay in exhibits', () => {
  for (const code of ['contract_permanent', 'contract_hotel']) {
    const body = bodyOf(code);
    assert.match(body, /EXHIBIT A — EMPLOYEE DUTIES/, code);
    assert.match(body, /EXHIBIT B — COMPENSATION AND BENEFITS/, code);
    // Referred to from the operative part, or an exhibit is just an appendix
    // nobody is bound by.
    assert.match(flat(body), /described in Exhibit A attached hereto/, code);
    assert.match(flat(body), /described in Exhibit B attached hereto/, code);
  }
});

test('the statute did not get lost in the dressing up', () => {
  // The whole point of these over a downloaded template. Every one of these
  // was in the plain-English version and every one has to survive.
  for (const t of CONTRACTS) {
    assert.match(flat(t.body), /Labour Act, 2003 \(Act 651\)/, `${t.code} does not name the Act`);
  }
  const permanent = flat(bodyOf('contract_permanent'));
  for (const cite of [
    /section 33 of Act 651/,          // hours
    /section 20 of Act 651/,          // fifteen days' leave
    /section 17 of Act 651/,          // notice
    /section 57 of Act 651/,          // maternity
    /section 63 of Act 651/,          // unfair termination
    /section 65 of Act 651/,          // redundancy
    /National Pensions Act, 2008 \(Act 766\)/,
    /Data Protection Act, 2012 \(Act 843\)/,
    /National Labour Commission/,
  ]) assert.match(permanent, cite, `the permanent contract lost ${cite}`);

  // The tiers, which are the numbers somebody checks a payslip against.
  assert.match(permanent, /thirteen per cent \(13%\)/);
  assert.match(permanent, /five and one-half per cent \(5\.5%\)/);
  assert.match(permanent, /thirteen and one-half per cent \(13\.5%\)/);

  // And the protection that cannot be contracted out of, said in every one of
  // the four that ends an engagement.
  for (const code of ['contract_permanent', 'contract_hotel', 'contract_fixed']) {
    // Case-insensitive: a citation opening a clause is capitalised.
    assert.match(flat(bodyOf(code)), /section 63 of Act 651/i, code);
  }
  assert.match(flat(bodyOf('contract_casual')), /sections 74 to 77|section 12 of Act 651/);
});

test('every placeholder in every contract is one the app can fill', () => {
  const known = new Set(PLACEHOLDERS.map((p) => p.key));
  for (const t of STANDARD_TEMPLATES) {
    for (const [, key] of t.body.matchAll(/\{\{(\w+)\}\}/g)) {
      if (t.kind === 'correspondence') continue;
      assert.ok(known.has(key), `${t.code} asks for {{${key}}}, which nothing fills`);
    }
  }
});

test('a rendered contract has nothing left in braces and nothing left of the source', () => {
  const values = Object.fromEntries(PLACEHOLDERS.map((p) => [p.key, `«${p.key}»`]));
  for (const t of CONTRACTS) {
    const out = renderTemplate(t.body, values);
    assert.equal(/\{\{/.test(out), false, `${t.code} has an unrendered placeholder`);
    // The template literal is built with ${FOOTER}. One escaped dollar and the
    // whole footer prints as source, which happened once already.
    assert.equal(/\$\{/.test(out), false, `${t.code} prints its own source`);
    assert.match(flat(out), /Electronic Transactions Act, 2008 \(Act 772\)/,
      `${t.code} lost the footer`);
  }
});

test('each says who it is for, so the office can tell them apart', () => {
  for (const t of CONTRACTS) {
    assert.ok(t.detail && t.detail.length > 20, `${t.code} has no description`);
    assert.ok(t.name && t.name.length > 8, `${t.code} has no name`);
  }
});
