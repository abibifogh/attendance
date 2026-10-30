import { json, HttpError, readJson, isMissingTable, csvResponse, str, badRequest } from './lib/http.js';
import {
  accountForCredentials, checkBootstrapPassword, clearCookie, clearViewAsCookie, createToken, currentAccount, mayViewAs,
  requireInsight, requireOwner, requireSession, saltForEmail, sessionCookie,
} from './lib/auth.js';
import { issueCode, redeemCode, systemsFor } from './lib/sso.js';
import * as panels from './routes/panels.js';
import * as admin from './routes/admin.js';
import * as accounts from './routes/accounts.js';
import * as viewAs from './routes/viewas.js';
import * as floats from './routes/floats.js';
import * as reports from './routes/reports.js';
import * as shiftRoutes from './routes/shifts.js';
import * as till from './routes/till.js';
import * as invitations from './routes/invitations.js';
import * as safe from './routes/safe.js';
import * as safebook from './routes/safebook.js';
import * as envelopes from './routes/envelopes.js';
import * as notes from './routes/notes.js';
import * as tasks from './routes/tasks.js';
import * as stays from './routes/stays.js';
import * as revenue from './routes/revenue.js';
import * as cashpo from './routes/cashpo.js';
import * as prepaid from './routes/prepaid.js';
import * as mgmt from './routes/mgmt.js';
import * as reportAccess from './routes/reportaccess.js';
import * as supplierBook from './routes/supplierbook.js';
import * as todo from './routes/todo.js';
import * as advances from './routes/advances.js';
import * as formmatch from './routes/formmatch.js';
import * as np from './routes/niceplace.js';
import * as lock from './routes/lock.js';
import * as odooact from './routes/odooact.js';
import * as newpo from './routes/newpo.js';
import * as proof from './routes/proof.js';
import * as approvals from './routes/approvals.js';
import * as receipts from './routes/receipts.js';
import { sendDailySummary } from './routes/summary.js';
import { verifyForm, verifyLink } from './lib/link.js';
import { first } from './lib/db.js';
import { loadFacts } from './insight/facts.js';
import { reloadLaundry } from './warehouse/etl.js';
import { groupConfig } from './lib/db.js';
import { resolveRange } from './lib/dates.js';

/** The days asked for, thirty to yesterday unless said. Accra keeps UTC. */
const rangeOf = (query) => { const { from, to } = resolveRange(query, 'UTC', { days: 30 }); return { from, to }; };

/**
 * The route table.
 *
 * `public` means no session is required. Everything else needs one, because
 * everything else is either the group's takings or somebody's name against a
 * cash shortage. There is no middle tier and no per-user permission: the
 * people who hold this password are the people who already see all of it.
 */
const ROUTES = [
  ['POST', '/api/auth/salt', 'public', passwordSalt],
  ['POST', '/api/auth/login', 'public', login],
  ['POST', '/api/auth/logout', 'public', logout],
  ['GET', '/api/auth/me', 'public', me],

  // View as: an admin sees Insight as somebody else does, look only. These
  // read who is really signed in themselves; stopping always works.
  ['GET', '/api/view-as', 'public', viewAs.choices],
  ['POST', '/api/view-as', 'public', viewAs.start],
  ['POST', '/api/view-as/stop', 'public', viewAs.stop],
  ['GET', '/api/view-as/log', 'owner', (env) => viewAs.log(env)],

  // The back channel. No session reaches it: the caller is another system's
  // server, and it proves what it is with its own shared secret. This is the
  // only endpoint in the app that hands out an identity, and it hands out
  // exactly one, once, to the system a code was minted for.
  ['POST', '/api/sso/redeem', 'public', ssoRedeem],

  // An invitation's link. The token in the body is the only credential, and
  // each one works for one person, once, for a week.
  ['POST', '/api/invite/look', 'public', (env, ctx) => invitations.look(env, ctx.body)],
  ['POST', '/api/invite/accept', 'public', (env, ctx) => invitations.accept(env, ctx.body)],
  ['POST', '/api/invite/ask', 'public', (env, ctx) => invitations.ask(env, ctx.body, { origin: ctx.url.origin })],

  // The hub. Everybody who can sign in can see it, whatever else they can
  // reach — it is the reason most people will open this at all.
  ['GET', '/api/hub', 'session', hub],
  ['POST', '/api/sso/start', 'session', ssoStart],
  ['POST', '/api/auth/change-password', 'session', changeOwnPassword],

  // The numbers. A separate permission from being able to sign in, because
  // somebody who needs the till does not necessarily get the wage bill.
  ['GET', '/api/bootstrap', 'shifts', (env) => panels.bootstrap(env)],
  ['GET', '/api/brief', 'insight', (env, ctx) => panels.brief(env, ctx.query)],
  ['GET', '/api/pnl', 'insight', (env, ctx) => panels.pnl(env, ctx.query)],
  // Money, from the shifts: the rooms' revenue out of the ASSD journal, and spending paid in cash.
  ['GET', '/api/money/cash', 'insight', (env, ctx) => cashpo.cashView(env, rangeOf(ctx.query))],
  ['POST', '/api/money/cash/refresh', 'insight', (env, ctx) => cashpo.refreshNow(env, ctx.account)],
  ['GET', '/api/money/prepaid', 'insight', (env, ctx) => prepaid.prepaidView(env, ctx.query)],
  ['GET', '/api/money/prepaid.csv', 'insight', async (env, ctx) => {
    const { month, csv } = await prepaid.prepaidCsv(env, ctx.query);
    return new Response(`\ufeff${csv}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="prepaid-stays-${month}.csv"`, 'Cache-Control': 'no-store' } });
  }],
  // Who gets the summary on the 5th, for Settings › Notifications.
  ['GET', '/api/money/prepaid/mail', 'insight', async (env, ctx) => {
    await till.requireAdmin(ctx.account);
    return prepaid.mailSettings(env);
  }],
  ['POST', '/api/money/prepaid/mail', 'insight', async (env, ctx) => {
    await till.requireAdmin(ctx.account);
    return prepaid.saveMailSettings(env, ctx.body, { origin: ctx.url.origin });
  }],
  ['POST', '/api/money/prepaid/send', 'insight', async (env, ctx) => {
    await till.requireAdmin(ctx.account);
    // To everyone chosen, or to the admin pressing it, to see it first.
    if (ctx.body?.everyone) {
      return prepaid.sendSummary(env, { month: ctx.body?.month, anyway: Boolean(ctx.body?.anyway), origin: ctx.url.origin });
    }
    if (!ctx.account?.email) throw badRequest('Your account has no email address to send it to.');
    return prepaid.sendSummary(env, { month: ctx.body?.month, to: ctx.account.email, origin: ctx.url.origin });
  }],
  // The management report: a week or a month of breakfast and maintenance, from each app.
  // Who sees which reports: an admin shares report pages with people who are not admins.
  ['GET', '/api/report-access', 'session', adminOnly((env) => reportAccess.list(env))],
  ['POST', '/api/report-access', 'session', adminOnly((env, ctx) => reportAccess.save(env, ctx.body, ctx.account))],
  ['GET', '/api/reports/management', 'insight', (env, ctx) => mgmt.managementReport(env, ctx.query)],
  ['GET', '/api/reports/management/mail', 'insight', async (env, ctx) => {
    await till.requireAdmin(ctx.account);
    return { ...(await mgmt.mailSettings(env)), sections: mgmt.SECTIONS, adminEmails: await prepaid.adminEmails(env) };
  }],
  ['POST', '/api/reports/management/mail', 'insight', async (env, ctx) => {
    await till.requireAdmin(ctx.account);
    return mgmt.saveMailSettings(env, ctx.body, { origin: ctx.url.origin });
  }],
  ['POST', '/api/reports/management/send', 'insight', async (env, ctx) => {
    // To everybody it goes to (an admin), or to whoever presses it.
    // The sections chosen on the page ride along: a section left out there is left out of the email.
    const { period, at, skip } = ctx.body || {};
    if (ctx.body?.everyone) {
      await till.requireAdmin(ctx.account);
      return mgmt.sendReport(env, { period, at, skip, origin: ctx.url.origin });
    }
    if (!ctx.account?.email) throw badRequest('Your account has no email address to send it to.');
    return mgmt.sendReport(env, { period, at, skip, to: ctx.account.email, origin: ctx.url.origin });
  }],
  ['GET', '/api/money/articles', 'insight', (env, ctx) => revenue.articlesView(env, rangeOf(ctx.query))],
  ['POST', '/api/money/articles', 'insight', (env, ctx) => revenue.saveArticle(env, ctx.body, ctx.account)],
  // The money to-do list: a supervisor's own, everything for an admin.
  ['GET', '/api/todo', 'shifts', (env, ctx) => todo.listTodos(env, ctx.account, { closed: ctx.query.closed === '1' })],
  // Read the laundry system now, the admin's number of days up to today, for everybody with a to-do list.
  ['POST', '/api/todo/laundry', 'shifts', async (env, ctx) => {
    const role = till.roleOf(ctx.account);
    if (role !== 'admin' && role !== 'supervisor') throw new HttpError(403, 'Only admins and supervisors can do that.');
    const out = await reloadLaundry(env, { days: await todo.laundryDaysOf(env) });
    if (!out.ok) throw new HttpError(409, out.error);
    return out;
  }],
  ['POST', '/api/todo/check', 'shifts', (env, ctx) => cashpo.refreshNow(env, ctx.account, { fromTodo: true })],
  ['POST', '/api/todo/assign', 'shifts', (env, ctx) => todo.assignMany(env, ctx.body, ctx.account)],
  // A longer or shorter look-back is a different set of POs: Odoo is asked again.
  ['POST', '/api/todo/settings', 'shifts', async (env, ctx) => {
    const saved = await todo.saveTodoSettings(env, ctx.body, ctx.account);
    if (!saved.lookbackChanged) return saved;
    const checked = await cashpo.refreshCashPos(env).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    return { ...saved, checked };
  }],
  // Advances in the Inbox: an admin, or whoever an admin gave "Advances".
  ['GET', '/api/advances', 'shifts', (env, ctx) => advances.advancesView(env, ctx.account)],
  ['POST', '/api/advances/decide', 'shifts', (env, ctx) => advances.decide(env, ctx.body, ctx.account)],
  ['POST', '/api/advances/clear', 'shifts', (env, ctx) => advances.clearElsewhere(env, ctx.body, ctx.account)],
  ['POST', '/api/todo/:id/answer', 'shifts', (env, ctx) => todo.answerTodo(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/todo/:id/decide', 'shifts', (env, ctx) => todo.decideTodo(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/todo/:id/assign', 'shifts', (env, ctx) => todo.assignTodo(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/todo/:id/dismiss', 'shifts', (env, ctx) => todo.dismissTodo(env, ctx.params.id, ctx.body, ctx.account)],
  ['GET', '/api/financials', 'insight', (env, ctx) => panels.financials(env, ctx.query)],
  ['GET', '/api/labour', 'insight', (env, ctx) => panels.labour(env, ctx.query)],
  ['GET', '/api/demand', 'insight', (env, ctx) => panels.demand(env, ctx.query)],
  ['GET', '/api/cash', 'insight', (env, ctx) => panels.cash(env, ctx.query)],
  ['GET', '/api/suppliers', 'insight', (env, ctx) => panels.suppliers(env, ctx.query)],
  // Buying › Suppliers: Odoo's vendors, with key suppliers in groups, other spellings and how each is paid.
  // Seen by whoever has Buying; changed (and payment details seen) by admins and supervisors only.
  ['GET', '/api/suppliers/book', 'insight', (env, ctx) => supplierBook.book(env, ctx.query, ctx.account)],
  ['GET', '/api/suppliers/one', 'insight', (env, ctx) => supplierBook.one(env, ctx.query, ctx.account)],
  ['POST', '/api/suppliers/refresh', 'insight', (env, ctx) => supplierBook.refresh(env, ctx.account)],
  ['POST', '/api/suppliers/save', 'insight', (env, ctx) => supplierBook.save(env, ctx.body, ctx.account)],
  ['POST', '/api/suppliers/link', 'insight', (env, ctx) => supplierBook.link(env, ctx.body, ctx.account)],
  ['GET', '/api/findings', 'insight', (env, ctx) => panels.findings(env, ctx.query)],
  ['POST', '/api/findings/:id', 'insight', (env, ctx) => admin.decideFinding(env, ctx.params.id, ctx.body)],
  ['GET', '/api/export', 'insight', exportCsv],

  // Shift reconciliation. An admin does all of it; a supervisor gets the
  // parts an admin chose (see routes/till.js), and nothing else in the app.
  // `shifts` lets both in, and each handler checks what this one may do.
  ['GET', '/api/shifts', 'shifts', shiftsRead],
  // Locked dates: anybody on Shifts may see where the lock stands; an admin sets it.
  ['GET', '/api/shifts/lock', 'shifts', (env) => lock.lockOf(env)],
  ['POST', '/api/shifts/lock', 'shifts', adminOnly(async (env, ctx) => lock.setLock(env, ctx.body, ctx.account, {
    seqThrough: ctx.body?.through ? await lock.lastSeqOf(env, String(ctx.body.through), shiftRoutes.shifts) : null,
  }))],
  ['POST', '/api/shifts/count', 'shifts', adminOnly((env, ctx) => shiftRoutes.saveCount(env, ctx.body, ctx.account))],
  // A PO a shift reported as paid from the drawer, paid (whole or part) from the big safe.
  ['POST', '/api/shifts/po-safe', 'shifts', adminOnly((env, ctx) => shiftRoutes.poFromSafe(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/expense', 'shifts', adminOnly((env, ctx) => shiftRoutes.saveExpense(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/expense/pull', 'shifts', adminOnly((env, ctx) => shiftRoutes.pullOrders(env, ctx.body))],
  ['POST', '/api/shifts/expense/link', 'shifts', linkPos],
  // A month of backlog: POs on the expense form that clearly belong to a shift.
  ['GET', '/api/shifts/form-match', 'shifts', adminOnly((env, ctx) => formmatch.formMatches(env, ctx.query, ctx.account))],
  ['POST', '/api/shifts/form-match/apply', 'shifts', adminOnly((env, ctx) => formmatch.applyMatches(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/receipts', 'shifts', receiptsSwap],
  ['POST', '/api/shifts/receipts-read', 'shifts', async (env, ctx) => {
    if (till.roleOf(ctx.account) !== 'admin') await till.requireArea(env, ctx.account, 'moves', 2);
    return shiftRoutes.saveReceiptsRead(env, ctx.body, ctx.account);
  }],
  ['POST', '/api/shifts/answer', 'shifts', async (env, ctx) => {
    // An unpaid stay is answered by whoever may act on Unpaid stays; anything else by whoever may act on the exceptions.
    const stay = String(ctx.body?.key || '').startsWith('stay:');
    if (stay) await till.requireArea(env, ctx.account, 'unpaid', 2);
    else await mayActOn(env, ctx.account, [String(ctx.body?.key || '')]);
    return waitsForAdmin(env, ctx, shiftRoutes.saveAnswer(env, ctx.body, ctx.account, { pending: isSupervisor(ctx) }),
      // Which one, so two emails do not read alike: "The drawer count, Sat 3 Oct night".
      `${ctx.account?.name || 'A supervisor'} answered “${ctx.body?.answer || ''}” for ${approvals.keyWords(String(ctx.body?.key || '')).replace(/^A /, 'a ').replace(/^An /, 'an ').replace(/^The /, 'the ')}.`);
  }],
  ['POST', '/api/shifts/answer-many', 'shifts', answerMany],
  // Notes and history on a difference: admins and supervisors.
  ['GET', '/api/shifts/notes', 'shifts', (env, ctx) => notes.history(env, ctx.query, ctx.account)],
  ['POST', '/api/shifts/notes', 'shifts', (env, ctx) => notes.addNote(env, ctx.body, ctx.account, { origin: ctx.url.origin })],
  ['POST', '/api/shifts/notes/counts', 'shifts', (env, ctx) => notes.counts(env, ctx.body, ctx.account)],
  ['GET', '/api/shifts/notes/people', 'shifts', (env, ctx) => notes.people(env, ctx.account)],
  // To-dos made from a difference, for an Insight user; reminded each morning until done.
  ['GET', '/api/shifts/tasks', 'shifts', (env, ctx) => tasks.list(env, ctx.query, ctx.account)],
  ['POST', '/api/shifts/tasks', 'shifts', (env, ctx) => tasks.make(env, ctx.body, ctx.account, { origin: ctx.url.origin })],
  ['POST', '/api/shifts/tasks/for-keys', 'shifts', (env, ctx) => tasks.forKeys(env, ctx.body, ctx.account)],
  ['POST', '/api/shifts/tasks/:id/done', 'shifts', (env, ctx) => tasks.done(env, ctx.params.id, ctx.account)],
  ['POST', '/api/shifts/tasks/:id', 'shifts', (env, ctx) => tasks.change(env, ctx.params.id, ctx.body, ctx.account, { origin: ctx.url.origin })],
  // A payment ASSD does not show, moved to the shift it belongs to. Admins.
  ['POST', '/api/shifts/payment-home', 'shifts', adminOnly((env, ctx) => shiftRoutes.movePayment(env, ctx.body, ctx.account))],
  // Which day an ASSD line is on, so an approval can open its shift.
  ['GET', '/api/shifts/where', 'shifts', adminOnly((env, ctx) => shiftRoutes.whereIs(env, ctx.query))],
  // Refunds owed to guests who paid more by card or MoMo than ASSD shows.
  ['GET', '/api/shifts/refunds', 'shifts', area('bank', 1, (env) => shiftRoutes.refundsOwed(env))],
  ['POST', '/api/shifts/refunds/paid', 'shifts', area('bank', 2, (env, ctx) => shiftRoutes.refundPaid(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/movement', 'shifts', movement],
  ['POST', '/api/shifts/link', 'shifts', onKeys((env, ctx) => waitsForAdmin(env, ctx, shiftRoutes.saveLink(env, ctx.body, ctx.account, { pending: isSupervisor(ctx) }), `${ctx.account?.name || 'A supervisor'} reconciled ${(ctx.body?.keys || []).length} exceptions together.`))],
  ['POST', '/api/shifts/unlink', 'shifts', anyOf(['bank', 'moves'], 2, (env, ctx) => shiftRoutes.removeLink(env, ctx.body, ctx.account, { pending: isSupervisor(ctx) }))],
  ['GET', '/api/shifts/files', 'shifts', area('files', 1, (env) => shiftRoutes.filesStatus(env))],
  ['POST', '/api/shifts/journal', 'shifts', area('files', 2, (env, ctx) => shiftRoutes.uploadJournal(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/bank', 'shifts', area('files', 2, (env, ctx) => shiftRoutes.uploadBank(env, ctx.body, ctx.account))],
  ['POST', '/api/shifts/terminal', 'shifts', area('files', 2, (env, ctx) => shiftRoutes.uploadTerminal(env, ctx.body, ctx.account))],

  // Stays not fully paid: leaving in the next 24 hours, or already left.
  // Answers to them go through /api/shifts/answer, like any exception.
  ['GET', '/api/stays', 'shifts', area('unpaid', 1, (env, ctx) => stays.unpaidStays(env, ctx.account))],

  // Envelopes moved to the safe, and which have been received. Admins only.
  // Before the routes below, which would read "envelopes" as an id.
  ['GET', '/api/safe/envelopes', 'shifts', (env, ctx) => envelopes.envelopesView(env, ctx.query, ctx.account)],
  ['GET', '/api/safe/envelopes.csv', 'shifts', (env, ctx) => envelopes.envelopesCsv(env, ctx.query, ctx.account)],
  ['POST', '/api/safe/envelopes/receive', 'shifts', (env, ctx) => envelopes.receive(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/envelopes/undo', 'shifts', (env, ctx) => envelopes.undo(env, ctx.body, ctx.account)],
  // The safe: what each shift moved into it, and the closures. Admins only.
  ['GET', '/api/safe', 'shifts', (env, ctx) => safe.safeView(env, ctx.query, ctx.account)],
  // The safe book: in from the shifts, out as written, a count to close a page.
  ['GET', '/api/safe/book', 'shifts', (env, ctx) => safebook.bookView(env, ctx.account, { counted: ctx.query.counted ? Math.round(Number(ctx.query.counted) * 100) : null, from: ctx.query.from, to: ctx.query.to })],
  ['POST', '/api/safe/entry', 'shifts', (env, ctx) => safebook.addEntry(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/entry/:id/po', 'shifts', (env, ctx) => safebook.settleEntry(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/safe/entry/:id/remove', 'shifts', (env, ctx) => safebook.removeEntry(env, ctx.params.id, ctx.account)],
  ['POST', '/api/safe/dismiss', 'shifts', (env, ctx) => safebook.dismissPo(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/count', 'shifts', (env, ctx) => safebook.countSafe(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/close', 'shifts', (env, ctx) => safe.closeSafe(env, ctx.body, ctx.account)],
  ['POST', '/api/safe/:id/taken', 'shifts', (env, ctx) => safe.saveTaken(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/safe/:id/undo', 'shifts', (env, ctx) => safe.undoClosure(env, ctx.params.id, ctx.account)],

  // Closing reports from HIVE, what staff answered, and the settings.
  ['GET', '/api/till', 'shifts', (env, ctx) => till.overview(env, ctx.query, ctx.account)],
  ['POST', '/api/till/resolve', 'shifts', (env, ctx) => till.resolve(env, ctx.body, ctx.account)],
  ['POST', '/api/till/reopen', 'shifts', (env, ctx) => till.reopen(env, ctx.body, ctx.account)],
  ['POST', '/api/till/move', 'shifts', (env, ctx) => till.moveReport(env, ctx.body, ctx.account)],
  ['GET', '/api/till/slots', 'shifts', (env, ctx) => till.slotsFor(env, ctx.query, ctx.account)],
  // Whose shift it was, when ASSD and HIVE name different people.
  ['GET', '/api/till/owner', 'shifts', (env, ctx) => till.ownerChoices(env, ctx.query, ctx.account)],
  ['POST', '/api/till/owner', 'shifts', (env, ctx) => till.setOwner(env, ctx.body, ctx.account)],
  ['POST', '/api/till/approve', 'shifts', (env, ctx) => till.approve(env, ctx.body, ctx.account)],
  // A difference put on staff accounts, and taken back off.
  ['GET', '/api/till/staff', 'shifts', (env, ctx) => till.staffList(env, ctx.account)],
  // Odoo activities, read only: what waits for whom, and who is who in Odoo.
  ['GET', '/api/odoo/activities', 'shifts', (env, ctx) => odooact.activitiesView(env, ctx.query, ctx.account)],
  ['GET', '/api/odoo/links', 'owner', (env, ctx) => odooact.linksView(env, ctx.account)],
  ['POST', '/api/odoo/links', 'owner', (env, ctx) => odooact.saveLink(env, ctx.body, ctx.account)],
  ['POST', '/api/till/charge', 'shifts', (env, ctx) => till.moveToStaff(env, ctx.body, ctx.account)],
  ['POST', '/api/till/charge/undo', 'shifts', (env, ctx) => till.undoMove(env, ctx.body, ctx.account)],
  // A shift checked: its differences are confirmed to its people (or taken back).
  ['POST', '/api/till/check', 'shifts', (env, ctx) => till.checkShift(env, ctx.body, ctx.account)],
  ['POST', '/api/till/check/undo', 'shifts', (env, ctx) => till.uncheckShift(env, ctx.body, ctx.account)],
  ['POST', '/api/till/settings', 'shifts', (env, ctx) => till.saveSettings(env, ctx.body, ctx.account)],

  // The till link: HIVE asking, server to server, signed with the secret the
  // two already share for the sign-in hand-off. No session reaches these.
  ['POST', '/api/link/till/setup', 'link', (env) => till.linkSetup(env)],
  ['POST', '/api/link/till/po', 'link', (env, ctx) => till.linkPo(env, ctx.body)],
  ['POST', '/api/link/till/issues', 'link', (env, ctx) => till.linkIssues(env, ctx.body)],
  ['POST', '/api/link/till/lock', 'link', (env) => lock.linkLock(env)],
  ['POST', '/api/link/till/recipients', 'link', (env, ctx) => till.linkRecipients(env, ctx.body)],
  // A staff member sending the proof an admin asked for, from HIVE's To sort out.
  ['POST', '/api/link/till/proof', 'link', (env, ctx) => proof.linkSend(env, ctx.body)],
  // Staff put a PO made in Insight on a shift: the admins are asked to allow it.
  ['POST', '/api/link/till/po-ask', 'link', (env, ctx) => newpo.askForDrawer(env, ctx.body)],

  // Proof for an answer: asked by admins (and whoever an admin allows), sent by whoever gave the answer.
  ['GET', '/api/proof', 'shifts', (env, ctx) => proof.forTargets(env, ctx.query, ctx.account)],
  ['GET', '/api/proof/mine', 'shifts', (env, ctx) => proof.mine(env, ctx.account)],
  ['GET', '/api/proof/file/:id', 'shifts', (env, ctx) => proof.file(env, ctx.params.id, ctx.account)],
  ['POST', '/api/proof/ask', 'shifts', (env, ctx) => proof.ask(env, ctx.body, ctx.account)],
  ['POST', '/api/proof/remind', 'shifts', (env, ctx) => proof.remind(env, ctx.body, ctx.account)],
  ['POST', '/api/proof/cancel', 'shifts', (env, ctx) => proof.cancel(env, ctx.body, ctx.account)],
  ['POST', '/api/proof/send', 'shifts', (env, ctx) => proof.send(env, ctx.body, ctx.account)],

  // Nice Place: the open link staff send the counters from (its own token
  // in the address, no account), and the page that holds them to the money.
  ['GET', '/api/np/form', 'public', (env, ctx) => np.linkForm(env, ctx.query)],
  ['POST', '/api/np/send', 'public', (env, ctx) => np.sendReading(env, ctx.body)],
  // The counters read off the picture, so the numbers fill in by themselves.
  ['POST', '/api/np/read', 'public', (env, ctx) => np.readCounters(env, ctx.body)],
  // An admin tries the reader on a picture, to see what it reads or why it cannot.
  ['POST', '/api/np/read-test', 'insight', adminOnly((env, ctx) => np.readTest(env, ctx.body))],

  // Create PO: a draft purchase order in Odoo, typed, or read off a sentence or a receipt. Admins only.
  ['GET', '/api/po/new', 'insight', adminOnly((env) => newpo.poForm(env))],
  ['POST', '/api/po/read', 'insight', adminOnly((env, ctx) => newpo.readPo(env, ctx.body))],
  ['POST', '/api/po/check', 'insight', adminOnly((env, ctx) => newpo.checkPo(env, ctx.body))],
  ['POST', '/api/po/create', 'insight', adminOnly(async (env, ctx) => {
    // A float's receipt filled in by hand carries its reference, as one read would.
    const mark = ctx.body?.receiptId ? await receipts.floatMark(env, ctx.body.receiptId) : null;
    const out = await newpo.createPo(env, ctx.body, ctx.account, { mark });
    // A receipt that could not be read, filled in by hand: it is this PO now.
    if (out.ok && ctx.body?.receiptId) await receipts.filled(env, ctx.body.receiptId, out.po, ctx.account);
    return out;
  })],
  // Floats: money given to people to spend; their receipts become POs with their reference.
  ['GET', '/api/floats', 'insight', adminOnly((env) => floats.list(env))],
  ['GET', '/api/floats/:id', 'insight', adminOnly((env, ctx) => floats.detail(env, ctx.params.id))],
  ['GET', '/api/floats/:id/statement', 'insight', adminOnly((env, ctx) => floats.statement(env, ctx.params.id, ctx.query))],
  ['POST', '/api/floats/give', 'insight', adminOnly((env, ctx) => floats.give(env, ctx.body, ctx.account))],
  ['POST', '/api/floats/back', 'insight', adminOnly((env, ctx) => floats.giveBack(env, ctx.body, ctx.account))],
  ['POST', '/api/floats/undo', 'insight', adminOnly((env, ctx) => floats.undoMove(env, ctx.body))],
  ['POST', '/api/floats/note', 'insight', adminOnly((env, ctx) => floats.noteMove(env, ctx.body, ctx.account))],
  ['POST', '/api/floats/decide', 'insight', adminOnly((env, ctx) => floats.decide(env, ctx.body, ctx.account))],
  ['POST', '/api/floats/link', 'insight', adminOnly((env, ctx) => floats.setLink(env, ctx.body))],
  ['POST', '/api/floats/add', 'insight', adminOnly((env, ctx) => floats.adminAdd(env, ctx.body, ctx.account))],
  // Their own link: no sign-in, the token in it is the only key, and it opens one person's float.
  ['GET', '/api/float/me', 'public', (env, ctx) => floats.linkView(env, ctx.query)],
  ['POST', '/api/float/send', 'public', (env, ctx) => floats.linkSend(env, ctx.body)],
  // Receipts made into draft POs: several chosen at once, or emailed in (the email handler below).
  ['GET', '/api/receipts', 'insight', adminOnly((env) => receipts.list(env))],
  ['GET', '/api/receipts/choices', 'insight', adminOnly((env) => receipts.settingsChoices(env))],
  ['POST', '/api/receipts/settings', 'insight', adminOnly((env, ctx) => receipts.saveSettings(env, ctx.body))],
  ['POST', '/api/receipts/upload', 'insight', adminOnly((env, ctx) => receipts.upload(env, ctx.body, ctx.account))],
  ['GET', '/api/receipts/:id/file', 'insight', adminOnly((env, ctx) => receipts.receiptFile(env, ctx.params.id))],
  ['POST', '/api/receipts/dismiss', 'insight', adminOnly((env, ctx) => receipts.dismiss(env, ctx.body, ctx.account))],
  ['POST', '/api/receipts/retry', 'insight', adminOnly((env, ctx) => receipts.retry(env, ctx.body, ctx.account))],
  ['GET', '/api/po/recent', 'insight', adminOnly((env) => newpo.recentPos(env))],
  // Contacts and products by name, for ones made in Odoo just now.
  ['GET', '/api/po/find', 'insight', adminOnly((env, ctx) => newpo.findPo(env, ctx.query))],
  // Approvals: everything waiting for an admin in every system, decided here as them.
  ['GET', '/api/approvals', 'session', adminOnly((env, ctx) => approvals.list(env, ctx.account))],
  ['POST', '/api/approvals/decide', 'session', adminOnly((env, ctx) => approvals.decide(env, ctx.body, ctx.account))],
  // A PO made here, paid from a shift's drawer: only once an admin allows it.
  ['GET', '/api/po/drawer', 'shifts', adminOnly((env) => newpo.drawerAsks(env))],
  ['POST', '/api/po/drawer', 'shifts', adminOnly((env, ctx) => newpo.decideDrawer(env, ctx.body, ctx.account))],
  ['GET', '/api/np', 'insight', (env, ctx) => np.npView(env, ctx.query, ctx.account, { admin: till.roleOf(ctx.account) === 'admin' })],
  // A picture of the counters: for an admin, and a supervisor given Nice Place, who reads one the reader could not.
  ['GET', '/api/np/photo/:id', 'shifts', area('niceplace', 1, (env, ctx) => np.photo(env, ctx.params.id))],
  ['GET', '/api/np/pending', 'shifts', area('niceplace', 1, (env) => np.pendingReadings(env))],
  ['POST', '/api/np/review', 'shifts', area('niceplace', 2, (env, ctx) => np.reviewReading(env, ctx.body, ctx.account, { admin: till.roleOf(ctx.account) === 'admin' }))],
  ['POST', '/api/np/reread', 'shifts', area('niceplace', 2, (env, ctx) => np.rereadReading(env, ctx.body))],
  ['POST', '/api/np/move', 'shifts', area('niceplace', 2, (env, ctx) => np.moveReading(env, ctx.body, ctx.account))],
  ['POST', '/api/np/income', 'insight', adminOnly((env, ctx) => np.saveIncome(env, ctx.body, ctx.account))],
  ['POST', '/api/np/settings', 'insight', adminOnly((env, ctx) => np.saveSettings(env, ctx.body))],
  ['POST', '/api/np/reading', 'insight', adminOnly((env, ctx) => np.editReading(env, ctx.body, ctx.account))],
  // A picture added in Insight for a shift that has none: read like one from the link.
  ['POST', '/api/np/upload', 'insight', adminOnly((env, ctx) => np.uploadPhoto(env, ctx.body, ctx.account))],
  ['POST', '/api/np/check', 'insight', (env, ctx) => np.checkReading(env, ctx.body, ctx.account)],
  ['POST', '/api/np/answer', 'insight', (env, ctx) => np.answer(env, ctx.body, ctx.account)],

  // The expense form: a script on the Google Form posts each response the
  // moment it is submitted, signed with the form's own secret.
  ['POST', '/api/link/expense-form', 'form', async (env, ctx) => {
    // Only the form's own script gets here, so it is told what went wrong.
    let saved;
    try { saved = await advances.ingestForm(env, ctx.body); } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, `Insight could not save the responses: ${String(err?.message || err).slice(0, 300)}`);
    }
    const tell = advances.tellDifferences(env);
    if (ctx.execution?.waitUntil) ctx.execution.waitUntil(tell); else await tell;
    return saved;
  }],

  // Loading and configuring. Owners only: these change what every other screen
  // in the group is built on.
  ['GET', '/api/sources', 'owner', (env) => admin.sources(env)],
  ['POST', '/api/sources/:id', 'owner', (env, ctx) => admin.saveSource(env, ctx.params.id, ctx.body)],
  ['POST', '/api/sources', 'owner', (env, ctx) => admin.addSupabaseSource(env, ctx.body)],
  ['POST', '/api/sources/:id/mapping', 'owner', (env, ctx) => admin.saveMapping(env, ctx.params.id, ctx.body)],
  ['POST', '/api/sources/:id/remove', 'owner', (env, ctx) => admin.removeSource(env, ctx.params.id)],
  ['POST', '/api/refresh', 'owner', (env, ctx) => admin.refresh(env, ctx.body)],
  ['POST', '/api/settings', 'owner', (env, ctx) => admin.settings(env, ctx.body)],
  ['GET', '/api/runs', 'owner', (env) => admin.runs(env)],

  ['GET', '/api/accounts', 'owner', (env) => accounts.list(env)],
  ['POST', '/api/accounts', 'owner', (env, ctx) => accounts.save(env, ctx.body, ctx.account)],
  ['POST', '/api/accounts/:id/password', 'owner', (env, ctx) => accounts.setPassword(env, ctx.params.id, ctx.body)],
  ['POST', '/api/accounts/:id/access', 'owner', (env, ctx) => accounts.setAccess(env, ctx.params.id, ctx.body, ctx.account)],
  ['POST', '/api/accounts/:id/delete', 'owner', (env, ctx) => accounts.remove(env, ctx.params.id, ctx.account)],
  ['POST', '/api/systems/:id', 'owner', (env, ctx) => accounts.saveSystem(env, ctx.params.id, ctx.body)],
  ['GET', '/api/sso/log', 'owner', (env) => accounts.handoffLog(env)],
  ['GET', '/api/invitations', 'owner', async (env) => ({ invitations: await invitations.list(env) })],
  ['POST', '/api/invitations', 'owner', (env, ctx) => invitations.invite(env, ctx.body, ctx.account, { origin: ctx.url.origin })],
  ['POST', '/api/invitations/:id/resend', 'owner', (env, ctx) => invitations.resend(env, ctx.params.id, ctx.body, ctx.account, { origin: ctx.url.origin })],
  ['POST', '/api/invitations/:id/withdraw', 'owner', (env, ctx) => invitations.withdraw(env, ctx.params.id)],

  // Reports made elsewhere, published behind a PIN. Publishing is a multipart
  // upload, so the handler reads the request itself rather than a JSON body.
  ['GET', '/api/reports', 'owner', (env) => reports.list(env)],
  ['POST', '/api/reports', 'owner', (env, ctx) => reports.publish(env, ctx.request, ctx.account)],
  ['POST', '/api/reports/:slug/remove', 'owner', (env, ctx) => reports.remove(env, ctx.params.slug)],
  ['POST', '/api/reports/:slug/files/:name/remove', 'owner', (env, ctx) => reports.removeFile(env, ctx.params.slug, ctx.params.name)],
  ['POST', '/api/report-pins', 'owner', (env, ctx) => reports.createPin(env, ctx.body, ctx.account)],
  ['POST', '/api/report-pins/:id/revoke', 'owner', (env, ctx) => reports.revokePin(env, ctx.params.id)],
];

/**
 * Changes to a shift, refused on a locked day (see routes/lock.js). Each
 * names the body fields that hold a reconciliation, a staff-account move or
 * a HIVE closing report by id; days, keys and ASSD numbers are read anyway.
 * Notes, to-dos and proof requests are not changes to a shift and stay open.
 */
const LOCKED = {
  '/api/shifts/count': {}, '/api/shifts/po-safe': {}, '/api/shifts/expense': {}, '/api/shifts/expense/pull': {}, '/api/shifts/expense/link': {},
  '/api/shifts/form-match/apply': {}, '/api/shifts/receipts': {}, '/api/shifts/receipts-read': {}, '/api/shifts/answer': {}, '/api/shifts/answer-many': {},
  '/api/shifts/payment-home': {}, '/api/shifts/refunds/paid': {}, '/api/shifts/movement': {}, '/api/shifts/link': {}, '/api/shifts/unlink': { link: 'id' },
  '/api/till/resolve': {}, '/api/till/reopen': { report: 'reportId' }, '/api/till/move': { report: 'reportId' }, '/api/till/owner': {},
  '/api/till/approve': { link: 'link' }, '/api/till/charge': {}, '/api/till/charge/undo': { move: 'id' }, '/api/till/check': {}, '/api/till/check/undo': {},
  '/api/np/review': {}, '/api/np/reread': {}, '/api/np/move': {}, '/api/np/reading': {}, '/api/np/upload': {}, '/api/np/check': {}, '/api/np/answer': {},
};
for (const route of ROUTES) {
  if (route[0] === 'POST' && LOCKED[route[1]]) route[3] = locked(route[3], LOCKED[route[1]]);
}

/** A change to a shift: refused when any day it touches is locked. */
function locked(handler, ids = {}) {
  return async (env, ctx) => {
    await lock.assertOpen(env, await lock.daysOf(env, ctx.body, { dayOfKey: shiftRoutes.dayOfKey, ids }));
    return handler(env, ctx);
  };
}
;

/** The morning schedule in wrangler.toml: the daily till summary, at 06:45 in Accra (UTC). */
const SUMMARY_CRON = '45 6 * * *';

/** Everything an uploader may call, beyond signing in and the hub. */
const UPLOADER_MAY = new Set([
  'GET /api/shifts/files', 'POST /api/shifts/journal', 'POST /api/shifts/bank', 'POST /api/shifts/terminal',
]);

export default {
  async fetch(request, env, execution) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // A float's short link, /float/igna: their page, which reads the ending itself.
      if (/^\/float\/[A-Za-z0-9-]{2,30}\/?$/.test(url.pathname)) return floatPage(env, request, url);
      // A published report lives at its own address, in front of the app's
      // own files. Anything that is not one falls through to them as before.
      try {
        const served = await reports.serve(request, env, url);
        if (served) return served;
      } catch (err) {
        return errorResponse(err);
      }
      return env.ASSETS.fetch(request);
    }

    try {
      const match = findRoute(request.method, url.pathname);
      if (!match) throw new HttpError(404, 'No such endpoint');
      const [route, params] = match;
      const [, , permission, handler] = route;

      // Four levels, and the difference between them matters now that this is
      // a front door rather than a report: signing in, reading the numbers,
      // and changing what everybody else sees are three different things.
      let account = null;
      let body = null;
      if (permission === 'session') account = await requireSession(request, env);
      else if (permission === 'shifts') {
        account = await requireInsight(request, env);
        // An uploader reaches the upload endpoints and nothing else.
        // An uploader reaches the upload endpoints and nothing else; somebody
        // with Reports only, nothing here. Either may read the reports'
        // bootstrap when an admin has shared a report with them.
        const role = till.roleOf(account);
        const asked = `${request.method} ${url.pathname}`;
        const boot = asked === 'GET /api/bootstrap' && (role === 'uploader' || role === 'reports')
          && (await reportAccess.reportsOf(env, account)).length > 0;
        if (role === 'uploader' && !UPLOADER_MAY.has(asked) && !boot) {
          throw new HttpError(403, 'Your account uploads files and nothing else here.');
        }
        if (role === 'reports' && !boot) throw new HttpError(403, 'Your account opens the reports shared with you and nothing else.');
      } else if (permission === 'insight') {
        account = await requireInsight(request, env);
        // Anybody who is not an admin reads only the report pages an admin
        // shared with them (routes/reportaccess.js), and nothing else here.
        if (till.roleOf(account) !== 'admin') await reportAccess.requireReport(env, account, request.method, url.pathname);
      } else if (permission === 'owner') account = await requireOwner(request, env);
      // Looking as somebody else is look only: nothing may change while it is on.
      if (account?.viewedBy && request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(403, `You are viewing as ${account.name}: nothing can be changed. Stop viewing to do this as yourself.`, { viewing: true });
      }
      else if (permission === 'link') {
        const text = await request.text();
        const ok = await verifyLink(env.SSO_SECRET_ATTENDANCE, {
          at: request.headers.get('X-Till-At'), sig: request.headers.get('X-Till-Sig'), path: url.pathname, bodyText: text,
        });
        if (!ok) throw new HttpError(401, 'That request did not come from HIVE.');
        try { body = JSON.parse(text || '{}'); } catch { throw badRequest('That was not JSON.'); }
      } else if (permission === 'form') {
        if (!env.EXPENSE_FORM_SECRET) throw new HttpError(503, 'The expense form is not connected yet: set EXPENSE_FORM_SECRET.');
        const text = await request.text();
        const ok = await verifyForm(env.EXPENSE_FORM_SECRET, {
          at: request.headers.get('X-Form-At'), sig: request.headers.get('X-Form-Sig'), bodyText: text,
        });
        if (!ok) throw new HttpError(401, 'That did not come from the expense form.');
        try { body = JSON.parse(text || '{}'); } catch { throw badRequest('That was not JSON.'); }
      }

      const query = Object.fromEntries(url.searchParams);
      if (body === null) {
        body = request.method === 'POST' && request.headers.get('Content-Type')?.includes('application/json')
          ? await readJson(request)
          : {};
      }

      const result = await handler(env, { request, query, body, params, url, account, execution });
      return result instanceof Response ? result : json(result);
    } catch (err) {
      return errorResponse(err);
    }
  },

  /**
   * The nightly run, a little after midnight in Accra.
   *
   * Late enough that yesterday is finished everywhere, early enough that the
   * brief is waiting before anybody opens it. The window reaches back ten days
   * because every one of the four sources accepts a late correction.
   */
  /**
   * An email to the receipts address, handed over by Cloudflare Email
   * Routing: each photo or PDF in it from somebody on the list becomes a
   * draft PO. See docs/receipts.md for setting the address up.
   */
  async email(message, env, execution) {
    try {
      await receipts.fromEmail(env, message);
    } catch (err) {
      console.error('Receipts by email', err);
    }
  },

  async scheduled(event, env, execution) {
    // Two schedules: the nightly load, and the morning summary once the
    // night shift has handed over.
    if (event?.cron === SUMMARY_CRON) {
      execution.waitUntil(sendDailySummary(env).then((out) => { if (out.error) console.error('Daily summary', out.error); }));
      // Proof asked and not sent: a reminder, once a day, three at most.
      execution.waitUntil(proof.remindDue(env));
      // To-dos made from a difference: whoever each is for, each morning until done.
      execution.waitUntil(tasks.remindDue(env));
      // On Mondays last week's management report, on the 1st last month's.
      execution.waitUntil(mgmt.sendDue(env).then((out) => out.forEach((x) => { if (x.error || x.failed?.length) console.error('Management report', x.error || x.failed); }))
        .catch((err) => console.error('Management report', err)));
      // On the 5th, last month's prepaid stays to whoever an admin chose.
      if (new Date(event.scheduledTime || Date.now()).getUTCDate() === 5) {
        execution.waitUntil(prepaid.sendSummary(env, { auto: true }).then((out) => { if (out.failed?.length) console.error('Prepaid summary', out.failed); })
          .catch((err) => console.error('Prepaid summary', err)));
      }
      return;
    }
    execution.waitUntil(admin.refresh(env, { trigger: 'schedule' }).catch((err) => {
      console.error('Scheduled refresh failed', err);
    }));
    // Odoo's suppliers, for Buying › Suppliers, and on to the breakfast app and the maintenance store.
    execution.waitUntil(supplierBook.refreshFromOdoo(env).then(() => supplierBook.pushSuppliers(env))
      .catch((err) => console.error('Suppliers from Odoo', err)));
  },
};

/** The float page's own file, whatever the short link's address; the assets may answer with a redirect to it. */
async function floatPage(env, request, url) {
  let response = await env.ASSETS.fetch(new Request(new URL('/float.html', url), request));
  for (let hops = 0; hops < 2 && response.status >= 300 && response.status < 400 && response.headers.get('Location'); hops += 1) {
    response = await env.ASSETS.fetch(new Request(new URL(response.headers.get('Location'), url), request));
  }
  return response;
}

function findRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of ROUTES) {
    const [routeMethod, pattern] = route;
    if (routeMethod !== method) continue;
    const patternParts = pattern.split('/').filter(Boolean);
    if (patternParts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (patternParts[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return [route, params];
  }
  return null;
}

function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
  }
  // Odoo did not answer, refused, or said no: its own words, not "something went wrong".
  if (err?.name === 'OdooError') return json({ error: err.message, detail: null }, { status: 502 });
  if (isMissingTable(err)) {
    return json({
      error: 'The warehouse has not been built yet. Run the migrations, then refresh.',
      detail: String(err?.message ?? err),
    }, { status: 503 });
  }
  console.error(err);
  return json({ error: 'Something went wrong on the server' }, { status: 500 });
}

// ------------------------------------------------------------------ auth --

/**
 * The salt to stretch a password with.
 *
 * Answers for an address whether or not it has an account, with a stable salt
 * derived from the address itself in the second case. Without that, this
 * endpoint is a free list of who works here.
 */
async function passwordSalt(env, { body }) {
  const email = str(body?.email, 'Email address', { required: true, max: 200 });
  return json(await saltForEmail(env.DB, email));
}

/**
 * Two ways in.
 *
 * An account with an address and a stretched password is the ordinary route.
 * The shared bootstrap password is the other, and it exists for exactly one
 * situation: a fresh installation with no accounts in it yet, which somebody
 * has to be able to open in order to make the first one. A bootstrap session
 * can manage accounts and read the numbers; it deliberately cannot be handed
 * over to another system, because a password out of a config file is not a
 * person and should not be able to open a till under somebody's name.
 */
async function login(env, { body }) {
  if (!env.SESSION_SECRET) throw new HttpError(503, 'SESSION_SECRET has not been set on this Worker');

  if (body?.email) {
    const account = await accountForCredentials(env.DB, body.email, body.passwordKey);
    if (!account) throw new HttpError(401, 'That address and password were not recognised');
    const token = await createToken(env.SESSION_SECRET, { accountId: account.id });
    return json({ ok: true, account: { name: account.name, email: account.email, isOwner: account.isOwner } },
      { headers: { 'Set-Cookie': sessionCookie(token) } });
  }

  if (!await checkBootstrapPassword(env, body?.password)) {
    throw new HttpError(401, 'That password was not recognised');
  }
  const token = await createToken(env.SESSION_SECRET, { bootstrap: true });
  return json({ ok: true, bootstrap: true }, { headers: { 'Set-Cookie': sessionCookie(token) } });
}

async function logout() {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearCookie());
  headers.append('Set-Cookie', clearViewAsCookie());
  return new Response(JSON.stringify({ ok: true }), { headers });
}

async function me(env, { request }) {
  let account = null;
  try {
    account = await currentAccount(request, env);
  } catch {
    // A Worker with no SESSION_SECRET cannot sign anybody in, and the sign-in
    // screen needs to be able to say so rather than failing blank.
    return json({ signedIn: false, configured: false });
  }

  // Whether any account exists at all decides which sign-in form to show: an
  // installation with none still needs the shared password.
  let hasAccounts = false;
  try {
    hasAccounts = Boolean((await first(env.DB, 'SELECT 1 AS n FROM accounts WHERE active = 1 LIMIT 1'))?.n);
  } catch { hasAccounts = false; }

  return json({
    signedIn: Boolean(account),
    configured: Boolean(env.SESSION_SECRET && env.DASHBOARD_PASSWORD),
    hasAccounts,
    account: account && {
      id: account.id,
      name: account.name,
      email: account.email,
      isOwner: account.isOwner,
      bootstrap: account.bootstrap,
      // Looking as this account: who really is, and whether they may look as others at all.
      viewedBy: account.viewedBy || null,
      mayViewAs: mayViewAs(account.viewedBy ? await currentAccount(request, env, { real: true }) : account),
      canSeeReports: till.roleOf(account) === 'admin',
      // The report pages they may open: every one for an admin, as shared for anybody else.
      reports: await reportAccess.reportsOf(env, account),
      till: till.roleOf(account) ? { role: till.roleOf(account), access: await till.accessOf(env, account) } : null,
    },
  });
}

// ----------------------------------------------------------------- shifts --

/** A handler only an admin may use. */
function adminOnly(handler) {
  return async (env, ctx) => {
    await till.requireAdmin(ctx.account);
    return handler(env, ctx);
  };
}

/** A handler for whoever may do `level` with `area`: every admin, and the supervisors given it. */
function area(name, level, handler) {
  return async (env, ctx) => {
    await till.requireArea(env, ctx.account, name, level);
    return handler(env, ctx);
  };
}

/** Whoever may act on every one of these exceptions: the bank for any, or cash movements when all are the drawer's. */
async function mayActOn(env, account, keys) {
  if (keys.length && keys.every(shiftRoutes.isCashKey)) {
    const access = await till.accessOf(env, account);
    if ((access.bank || 0) >= 2) return;
    await till.requireArea(env, account, 'moves', 2);
    return;
  }
  await till.requireArea(env, account, 'bank', 2);
}

/** A handler for whoever may do `level` with any of these areas (a supervisor undoes only their own, still waiting). */
function anyOf(names, level, handler) {
  return async (env, ctx) => {
    const access = await till.accessOf(env, ctx.account);
    if (!names.some((n) => (access[n] || 0) >= level)) await till.requireArea(env, ctx.account, names[0], level);
    return handler(env, ctx);
  };
}

/** A handler on the exceptions named in the body's keys. */
function onKeys(handler) {
  return async (env, ctx) => {
    const keys = Array.isArray(ctx.body?.keys) ? ctx.body.keys.map(String) : [String(ctx.body?.key || '')];
    await mayActOn(env, ctx.account, keys);
    return handler(env, ctx);
  };
}

/** The Shifts screen's data, cut to what a supervisor was given. */
async function shiftsRead(env, ctx) {
  const role = till.roleOf(ctx.account);
  const data = await shiftRoutes.shifts(env, ctx.query, ctx.account);
  if (role === 'admin') return { ...data, canUpload: true };
  const access = await till.accessOf(env, ctx.account);
  if (!['day', 'week', 'month', 'money', 'bank', 'net', 'files', 'moves'].some((k) => access[k] > 0)) {
    throw new HttpError(403, 'No part of Shifts has been shared with you yet.');
  }
  return shiftRoutes.forSupervisor(data, access);
}

const isSupervisor = (ctx) => till.roleOf(ctx.account) !== 'admin';

/** A supervisor's answer waits for an admin; tell the admins, without holding up the reply. */
/**
 * One answer for many exceptions and unpaid stays, ticked together in the
 * Inbox. Each is saved as if answered on its own; one already settled by an
 * admin is skipped and counted. A supervisor's wait for an admin, who is told
 * once for the lot.
 */
async function answerMany(env, ctx) {
  const keys = [...new Set((Array.isArray(ctx.body?.keys) ? ctx.body.keys : []).map((k) => String(k || '').trim()).filter(Boolean))].slice(0, 300);
  if (!keys.length) throw badRequest('Tick what to answer.');
  if (!String(ctx.body?.answer || '').trim()) throw badRequest('Choose the answer.');
  if (keys.some((k) => k.startsWith('stay:'))) await till.requireArea(env, ctx.account, 'unpaid', 2);
  if (keys.some((k) => !k.startsWith('stay:'))) await mayActOn(env, ctx.account, keys.filter((k) => !k.startsWith('stay:')));
  const pending = isSupervisor(ctx);
  let saved = 0;
  const skipped = [];
  for (const key of keys) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await shiftRoutes.saveAnswer(env, { key, answer: ctx.body?.answer, note: ctx.body?.note }, ctx.account, { pending });
      saved += 1;
    } catch (err) { skipped.push({ key, why: String(err?.message || err) }); }
  }
  if (pending && saved) {
    const tell = till.tellApprovers(env, { text: `${ctx.account?.name || 'A supervisor'} answered ${saved} item${saved === 1 ? '' : 's'} at once: ${ctx.body?.answer || ''}.` });
    if (ctx.execution?.waitUntil) ctx.execution.waitUntil(tell); else await tell;
  }
  return { ok: true, saved, skipped, pending };
}

async function waitsForAdmin(env, ctx, saving, text) {
  const out = await saving;
  if (out?.pending) {
    const tell = till.tellApprovers(env, { text });
    if (ctx.execution?.waitUntil) ctx.execution.waitUntil(tell); else await tell;
  }
  return out;
}

/** A correction to a cash movement: an admin's applies, a supervisor's waits for an admin. */
/** Reconcile receipts swapped for cash: an admin, or whoever may act on cash movements. */
async function receiptsSwap(env, ctx) {
  if (till.roleOf(ctx.account) !== 'admin') await till.requireArea(env, ctx.account, 'moves', 2);
  return shiftRoutes.saveReceiptsSwap(env, ctx.body, ctx.account);
}

/** Link POs to a shift's expenses: an admin, or whoever may act on cash movements. */
async function linkPos(env, ctx) {
  if (till.roleOf(ctx.account) !== 'admin') await till.requireArea(env, ctx.account, 'moves', 2);
  return shiftRoutes.linkPos(env, ctx.body, ctx.account);
}

async function movement(env, ctx) {
  if (till.roleOf(ctx.account) === 'admin') return shiftRoutes.saveMovement(env, ctx.body, ctx.account);
  await till.requireArea(env, ctx.account, 'moves', 2);
  const out = await shiftRoutes.saveMovement(env, ctx.body, ctx.account, { pending: true, smallUpTo: await till.threshold(env) });
  if (out.pending) {
    const tell = till.tellApprovers(env, { seq: out.seq, kind: out.kind, by: ctx.account?.name || 'A supervisor' });
    if (ctx.execution?.waitUntil) ctx.execution.waitUntil(tell); else await tell;
  }
  return out;
}

/** Change your own password. Anybody may do this; nobody may do it to somebody else. */
async function changeOwnPassword(env, { body, account }) {
  if (!account?.id) throw badRequest('A shared-password session has no account to change.');
  return json(await accounts.setPassword(env, account.id, body));
}

// ------------------------------------------------------------------- sso --

/** Everything this person may open, and whether they will be handed over. */
async function hub(env, { account }) {
  const systems = await systemsFor(env, account);
  return json({
    account: {
      name: account.name, email: account.email,
      isOwner: account.isOwner, bootstrap: account.bootstrap,
    },
    systems,
  });
}

/**
 * Mint a hand-off and say where to send the browser.
 *
 * Answers with the address rather than a redirect so the front end can open it
 * in a new tab. A person moving between five systems all day wants five tabs,
 * not five round trips back to a hub they have to find again.
 */
async function ssoStart(env, { body, account }) {
  const systemId = str(body?.systemId, 'System', { required: true, max: 40 });
  const { url, system, expiresIn } = await issueCode(env, account, systemId);
  return json({ url, expiresIn, system: { id: system.id, label: system.label } });
}

/**
 * The back channel: a code in, an identity out, once.
 *
 * The caller is another system's server. It says which system it is and proves
 * it with its own shared secret; a secret that authenticates it as the laundry
 * cannot redeem a code minted for the POS.
 */
async function ssoRedeem(env, { request, body }) {
  const header = request.headers.get('Authorization') || '';
  const secret = header.replace(/^Bearer\s+/i, '').trim() || str(body?.secret, 'Secret', { max: 300 });
  const systemId = str(body?.systemId ?? body?.system, 'System', { required: true, max: 40 });
  const code = str(body?.code, 'Code', { required: true, max: 300 });
  return json(await redeemCode(env, { code, systemId, secret }));
}

// ---------------------------------------------------------------- export --

/**
 * One row per day per line, with revenue, cost, wages and contribution.
 *
 * The point of a warehouse is that somebody can take it away and do something
 * you did not think of, so the export is the whole joined table rather than
 * whichever screen they were looking at.
 */
async function exportCsv(env, { query }) {
  const config = await groupConfig(env.DB);
  const { from, to } = resolveRange(query, config.timezone, { days: 90 });
  const facts = await loadFacts(env.DB, from, to);

  const rows = [[
    'day', 'weekday', 'line', 'guests_in_house', 'revenue_net', 'discounts', 'collected',
    'outstanding', 'cash', 'card', 'other_tender', 'orders', 'covers',
    'purchases_cost', 'hours_worked', 'wage_cost', 'contribution', 'revenue_per_hour',
  ]];

  for (const row of facts.lineRows) {
    rows.push([
      row.day,
      facts.byDay.get(row.day)?.dow_label ?? '',
      row.line,
      facts.guestsOn(row.day),
      money(row.net), money(row.discounts), money(row.collected), money(row.outstanding),
      money(row.cash), money(row.card), money(row.other),
      row.orders, row.covers,
      money(row.cost), row.workedHours, money(row.labourCost), money(row.contribution),
      row.revenuePerHour == null ? '' : money(row.revenuePerHour),
    ]);
  }

  return csvResponse(`insight-${from}-to-${to}.csv`, rows);
}

/** Whole units, with two decimals, for a spreadsheet rather than for adding up. */
const money = (minorUnits) => (Number(minorUnits || 0) / 100).toFixed(2);
