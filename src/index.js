import {
  clearCookie, createToken, getPepper, getSession, hashPin, isReservedPin,
  saltForEmail, sessionCookie, storedPassword, throttleCheck, throttleFail,
  throttleReset, tokenTtl, userForCredentials, userForPin, verifyPasswordKey,
} from './lib/auth.js';
import { PERMISSIONS, ROLES, allows, effectivePermissions } from './lib/permissions.js';
import {
  HttpError, badRequest, forbidden, isMissingTable, json, readJson, str, unauthorized,
} from './lib/http.js';
import * as att from './routes/attendance.js';
import * as suggest from './routes/suggest.js';
import * as mine from './routes/me.js';
import { watchShifts } from './lib/shift-watch.js';
import * as birthday from './routes/birthdays.js';
import * as attSetup from './routes/attendance-setup.js';
import * as rotaImport from './routes/rota-import.js';
import * as people from './routes/people.js';
import * as invite from './routes/invite.js';
import * as corr from './routes/correspondence.js';
import * as signoff from './routes/signoff.js';
import * as workload from './routes/workload.js';
import * as pay from './routes/pay.js';
import * as advance from './routes/advances.js';
import * as medical from './routes/medical.js';
import * as payroll from './routes/payroll.js';
import * as payAccess from './routes/payroll-access.js';
import * as lunch from './routes/lunch.js';
import * as sign from './routes/sign.js';
import * as admin from './routes/admin.js';
import * as push from './routes/push.js';
import * as live from './lib/live.js';
import { handleSsoArrival } from './lib/sso-consumer.js';
import { todayIn } from './util/dates.js';
import { PIN_TAKEN } from './routes/admin.js';

// The one thing in this runtime two requests can both be looking at. Named
// here because Wrangler binds a Durable Object by the class the entry point
// exports, not by the file it was written in.
export { LiveHub } from './live-hub.js';

/**
 * Route table: [method, pattern, permission, handler].
 *
 * The permission is the gate. Hiding a menu item is a courtesy to the person
 * using the app; this table is what actually stops a supervisor reading the
 * leave balances. `null` means the endpoint is open to anyone signed in, and
 * `'public'` means no session is required at all.
 */
export const ROUTES = [
  ['POST', '/api/auth/salt', 'public', passwordSalt],
  ['POST', '/api/auth/login', 'public', login],
  ['POST', '/api/auth/logout', 'public', logout],
  ['GET', '/api/auth/me', 'public', me],
  ['POST', '/api/auth/change-credentials', null, changeCredentials],

  // ------------------------------------------------------------- the feed --
  // Public in the sense that no session reaches it: the caller is a script on a
  // cupboard PC that must keep working at three in the morning. It proves
  // itself with a device token instead, and the only thing that token can do is
  // add punches to its own terminal's serial.
  ['POST', '/api/att/ingest', 'public', att.ingest],
  // The same feed, reporting what the terminal says about its own attendance
  // configuration. Same token, same one thing it is allowed to do.
  ['POST', '/api/att/device-config', 'public', att.deviceConfig],
  // The terminal posting its own events, with nothing running on site. The
  // token is in the path because a listening-host configuration has nowhere to
  // put a header.
  ['POST', '/api/att/push/:token', 'public', att.pushEvents],

  // ------------------------------------------------------------- every day --
  ['GET', '/api/att/bootstrap', 'att_view', att.bootstrap],
  ['GET', '/api/att/day', 'att_view', att.day],
  ['GET', '/api/att/staff/:id/day', 'att_view', att.staffDay],

  ['GET', '/api/att/week', 'att_reports', att.week],
  // The same week as four numbers a person. Its own permission, because the
  // whole point of it is somebody who may have this and not the week itself.
  ['GET', '/api/att/totals', ['att_totals', 'att_reports'], att.weekTotals],
  // Reachable by whoever signs periods off, because that is where the days are
  // corrected. The leave balance is stripped from the answer for anybody
  // without the reports permission — see `staffReport`.
  ['GET', '/api/att/staff/:id/report', ['att_reports', 'att_signoff'], att.staffReport],
  // The rota planner reads this month before building the next one. What they
  // must not see — how much leave anybody has left — is taken out of the
  // answer rather than left to the screen to hide.
  ['GET', '/api/att/overview', ['att_reports', 'att_rota'], att.overview],
  ['GET', '/api/att/export', 'att_reports', att.exportCsv],
  // The morning list, downloaded. Everything in it is already on the screen
  // this is offered from, so it needs that screen's permission and not the
  // reports one — otherwise whoever does the chasing has to ask somebody else
  // for a copy of what they are looking at.
  ['GET', '/api/att/export/issues', 'att_view', att.exportIssues],
  ['GET', '/api/att/balances', 'att_reports', att.balances],

  // The monthly reckoning. Reading it is a report; signing it off moves
  // somebody's leave, so it needs the permission that approves leave.
  ['GET', '/api/att/review', ['att_reports', 'att_signoff'], att.periodReview],
  ['POST', '/api/att/review', 'att_signoff', att.decidePeriod],
  ['POST', '/api/att/review/undo', 'att_signoff', att.undoPeriod],
  // What a particular month expected of a particular person. Setting it moves
  // what the sign-off proposes against their leave, so it needs the permission
  // that sets the property up rather than the one that signs.
  ['POST', '/api/att/calendar', 'att_setup', att.setCalendar],

  // What is still waiting, day by day, and what to do about the awkward ones.
  ['GET', '/api/att/outstanding', 'att_signoff', signoff.outstanding],
  ['POST', '/api/att/sign-days', 'att_signoff', signoff.signDays],
  ['GET', '/api/att/staff/:id/adjustments', ['att_reports', 'att_signoff'], signoff.leaveAdjustments],
  ['POST', '/api/att/reviews/:id/days', 'att_signoff', signoff.changeDaysApplied],
  ['POST', '/api/att/sign-days/undo', 'att_signoff', signoff.reopenDays],
  // Raising a question is part of signing off; answering one is deciding, and
  // deciding is what settling a day and approving leave already need.
  ['GET', '/api/att/queries', ['att_signoff', 'att_manage'], signoff.listQueries],
  ['POST', '/api/att/queries', 'att_signoff', signoff.raiseQuery],
  // Who a question can be addressed to. Names only, and only of people who
  // could actually answer one.
  ['GET', '/api/att/deciders', 'att_signoff', signoff.listDeciders],
  ['POST', '/api/att/queries/:id/answer', 'att_manage', signoff.answerQuery],
  ['POST', '/api/att/queries/:id/withdraw', 'att_signoff', signoff.withdrawQuery],

  // Settling a day is a decision with somebody's name on it, so it sits behind
  // its own permission rather than travelling with the reports.
  ['POST', '/api/att/days/:day/resolve', 'att_manage', att.resolveDay],
  ['POST', '/api/att/days/:day/unresolve', 'att_manage', att.unresolveDay],

  // Correcting a clock time is deliberately smaller than settling a day: it
  // says when somebody left, not what the day should be charged to. Whoever
  // builds the rota is the person who notices, so they get this one on its own
  // — and every use of it is written down and announced.
  ['POST', '/api/att/days/:day/times', 'att_times', att.correctTimes],
  ['GET', '/api/att/time-edits', ['att_setup', 'att_reports', 'att_times'], att.timeEdits],
  ['POST', '/api/att/time-edits/:id/decide', 'att_setup', att.decideTimeEdit],
  ['POST', '/api/att/time-edits/decide', 'att_setup', att.decideTimeEdits],
  ['POST', '/api/att/punches', 'att_manage', att.addPunch],

  ['GET', '/api/att/roster', ['att_rota', 'att_reports'], att.getRoster],

  // How the rota is treating people. Whoever builds it needs this most,
  // which is why it is not behind the reports permission.
  ['POST', '/api/att/roster/publish', 'att_rota', att.publishRoster],
  ['GET', '/api/att/roster/suggest', 'att_rota', suggest.suggestRoster],
  ['GET', '/api/att/roster/history', ['att_rota', 'att_reports'], att.rosterHistory],
  // The rota as a file, draft and all. Everything else that leaves this app is
  // a record of what happened; a rota being built has not happened yet, which
  // is exactly why somebody wants it out.
  ['GET', '/api/att/roster/export', ['att_rota', 'att_reports'], att.exportRoster],
  // A face against a name on the rota. The picture and nothing else — see the
  // note on the handler.
  ['GET', '/api/att/staff/:id/photo', ['att_rota', 'att_view', 'att_reports'], att.staffPhoto],

  // The one thing here that is not about hours, lateness or money.
  ['GET', '/api/att/birthdays', 'att_view', birthday.birthdays],
  ['POST', '/api/att/birthdays/card', 'att_view', birthday.sendBirthdayCard],

  // A member of staff, looking at their own. Every route resolves who they are
  // from the session, so none of them takes a staff id and none of them has a
  // version of "somebody else's" to get wrong.
  ['GET', '/api/me/week', 'att_me', mine.myWeek],
  ['GET', '/api/me/report', 'att_me', mine.myReport],
  ['POST', '/api/me/leave', 'att_me', mine.askForLeave],
  ['POST', '/api/me/leave/:id/withdraw', 'att_me', mine.withdrawMyLeave],
  ['POST', '/api/me/availability', 'att_me', mine.setMyAvailability],
  // The face against their own name on the rota, chosen by them.
  ['POST', '/api/me/photo', 'att_me', mine.setMyPhoto],
  ['DELETE', '/api/me/photo', 'att_me', mine.clearMyPhoto],
  ['POST', '/api/me/running-late', 'att_me', mine.tellThemImLate],
  ['GET', '/api/me/advances', 'att_me', advance.myAdvances],
  ['POST', '/api/me/advances', 'att_me', advance.askForAdvance],
  ['POST', '/api/me/advances/:id/withdraw', 'att_me', advance.withdrawMyAdvance],
  ['GET', '/api/me/medical', 'att_me', medical.myMedical],
  ['POST', '/api/me/medical', 'att_me', medical.claim],
  ['POST', '/api/me/medical/:id/withdraw', 'att_me', medical.withdrawClaim],
  ['POST', '/api/att/availability', 'att_rota', att.setAvailability],
  // What people have asked for and nobody has answered yet, and the answer.
  ['GET', '/api/att/availability/waiting', 'att_rota', att.waitingAvailability],
  ['POST', '/api/att/availability/decide', 'att_rota', att.decideAvailability],
  ['GET', '/api/att/workload', ['att_rota', 'att_reports'], workload.workload],

  // Pay. Its own permission, held by nobody by default — a manager holds
  // employee records as a matter of course, and what a colleague earns is a
  // different order of confidence from where they live.
  ['GET', '/api/hr/staff/:id/pay', 'hr_pay', pay.staffPay],
  ['POST', '/api/hr/staff/:id/pay', 'hr_pay', pay.setPay],
  ['DELETE', '/api/hr/staff/:id/pay/:rateId', 'hr_pay', pay.removePay],
  ['GET', '/api/att/labour-cost', 'hr_pay', pay.labourCost],

  // ---------------------------------------------------------- advances --
  // The same permission as what anybody earns: an advance says as much about
  // somebody's circumstances as their salary does, and usually more.
  ['GET', '/api/advances', 'hr_pay', advance.advances],
  ['POST', '/api/advances', 'hr_pay', advance.addAdvance],
  ['POST', '/api/advances/close', 'hr_pay', advance.closeMonth],
  ['GET', '/api/advances/staff/:id', 'hr_pay', advance.staffAdvances],
  ['POST', '/api/advances/:id/decide', 'hr_pay', advance.decideAdvance],
  ['PATCH', '/api/advances/:id', 'hr_pay', advance.adjustAdvance],
  ['POST', '/api/advances/:id/entry', 'hr_pay', advance.addEntry],
  ['DELETE', '/api/advances/:id/entry/:entryId', 'hr_pay', advance.removeEntry],
  // The bill or the tenancy agreement behind a request. Readable by whoever
  // decides it and by whoever attached it — see `paper`.
  ['GET', '/api/advances/:id/paper', ['hr_pay', 'att_me'], advance.paper],

  // ----------------------------------------------------- medical claims --
  // A list of somebody's hospital bills says more about them than any other
  // screen here, so it sits behind the same permission as the wages.
  ['GET', '/api/medical', 'hr_pay', medical.medical],
  ['POST', '/api/medical/allowances', 'hr_pay', medical.setAllowances],
  ['POST', '/api/medical/claims/:id/decide', 'hr_pay', medical.decideClaim],
  // Readable by whoever decides the claim and by whoever handed the bill in.
  // The check is on the receipt itself — see `receipt`.
  ['GET', '/api/medical/receipt/:id', ['hr_pay', 'att_me'], medical.receipt],

  // ------------------------------------------------------------- lunch --
  // Whoever runs the kitchen, and one address everybody else opens.
  ['GET', '/api/lunch', 'lunch', lunch.lunchWeek],
  ['POST', '/api/lunch/menu', 'lunch', lunch.setMenu],
  ['POST', '/api/lunch/order', 'lunch', lunch.setOrder],
  ['POST', '/api/lunch/link', 'lunch', lunch.makeLink],
  ['POST', '/api/lunch/switch', 'lunch', lunch.setOpen],
  ['POST', '/api/lunch/schedule', 'lunch', lunch.setSchedule],

  // The public half. Nothing here needs a session; the token is the whole of
  // the check, and what it opens is first names, rostered days and meals.
  ['GET', '/api/l/:token', 'public', lunch.lunchOpen],
  ['GET', '/api/l/:token/me/:id', 'public', lunch.lunchMine],
  ['POST', '/api/l/:token/me/:id', 'public', lunch.lunchSay],

  // ----------------------------------------------------------- payroll --
  ['GET', '/api/payroll', 'hr_pay', payroll.payroll],
  ['GET', '/api/payroll/slip/:id', 'hr_pay', payroll.payslip],
  ['POST', '/api/payroll/profiles', 'hr_pay', payroll.setProfiles],
  ['POST', '/api/payroll/schemes', 'hr_pay', payroll.saveScheme],
  ['DELETE', '/api/payroll/schemes/:id', 'hr_pay', payroll.removeScheme],
  ['POST', '/api/payroll/scores', 'hr_pay', payroll.setScores],
  ['POST', '/api/payroll/penalties', 'hr_pay', payroll.addPenalty],
  ['DELETE', '/api/payroll/penalties/:id', 'hr_pay', payroll.removePenalty],
  // Where somebody stands with the lock, and the code that opens it. Outside
  // the lock by necessity: a screen that cannot ask for the code is a screen
  // nobody can get into.
  ['GET', '/api/payroll/access', 'hr_pay', payAccess.myAccess],
  ['POST', '/api/payroll/unlock', 'hr_pay', payAccess.unlock],
  ['POST', '/api/payroll/pin', 'hr_pay', payAccess.setPin],
  ['POST', '/api/payroll/lock', 'hr_pay', payAccess.lock],
  // Granting it is an administrator's job, so it lives with the logins.
  ['GET', '/api/payroll/grants', 'users', payAccess.accessList],
  ['POST', '/api/payroll/grants', 'users', payAccess.grant],
  ['DELETE', '/api/payroll/grants/:id', 'users', payAccess.revoke],
  ['DELETE', '/api/payroll/pin/:id', 'users', payAccess.resetPin],

  ['GET', '/api/payroll/returns', 'hr_pay', payroll.returns],
  ['GET', '/api/payroll/input/template', 'hr_pay', payroll.inputTemplate],
  ['POST', '/api/payroll/input/read', 'hr_pay', payroll.readInput],
  ['POST', '/api/payroll/input/apply', 'hr_pay', payroll.applyInput],
  ['POST', '/api/payroll/copy', 'hr_pay', payroll.copyRun],
  ['POST', '/api/payroll/close', 'hr_pay', payroll.closeRun],
  ['POST', '/api/payroll/reopen', 'hr_pay', payroll.reopenRun],
  ['GET', '/api/att/workload/rota', ['att_rota', 'att_reports'], workload.rotaWarnings],
  ['POST', '/api/att/roster', 'att_rota', att.saveRoster],
  ['POST', '/api/att/roster/copy', 'att_rota', att.copyRoster],
  // Taking a period back off. Its own route rather than a flag on the save,
  // because a save is a list of cells somebody chose and this is a range.
  ['POST', '/api/att/roster/clear', 'att_rota', att.clearRoster],
  ['POST', '/api/att/patterns', 'att_rota', att.savePattern],

  // Importing a week. Reading and drafting is part of building the rota;
  // so is confirming it, because the draft only ever writes the rota.
  ['GET', '/api/att/rota-import', 'att_rota', rotaImport.getRotaImport],
  ['POST', '/api/att/rota-import', 'att_rota', rotaImport.previewRotaImport],
  ['POST', '/api/att/rota-import/name', 'att_rota', rotaImport.mapImportName],
  ['POST', '/api/att/rota-import/shift', 'att_rota', rotaImport.resolveImportShift],
  ['POST', '/api/att/rota-import/confirm', 'att_rota', rotaImport.confirmRotaImport],
  ['POST', '/api/att/rota-import/discard', 'att_rota', rotaImport.discardRotaImport],

  ['GET', '/api/att/leave', 'att_view', att.listLeave],
  ['POST', '/api/att/leave', 'att_rota', att.requestLeave],
  ['GET', '/api/att/leave/:id/days', 'att_manage', att.leaveDays],
  ['POST', '/api/att/leave/:id/decide', 'att_manage', att.decideLeave],
  ['POST', '/api/att/leave/:id/type', 'att_manage', att.setLeaveType],
  ['DELETE', '/api/att/leave/:id', 'att_manage', att.cancelLeave],

  // ----------------------------------------------------------------- setup --
  ['GET', '/api/att/staff', ['att_setup', 'att_rota'], attSetup.listStaff],
  ['POST', '/api/att/staff', 'att_setup', attSetup.createStaff],
  ['PUT', '/api/att/staff/:id', 'att_setup', attSetup.updateStaff],
  ['DELETE', '/api/att/staff/:id', 'att_setup', attSetup.deleteStaff],
  ['GET', '/api/att/unknown', 'att_setup', attSetup.unknownEmployees],

  ['GET', '/api/att/shifts', ['att_setup', 'att_rota'], attSetup.listShifts],
  ['GET', '/api/att/shift-suggestions', 'att_setup', att.shiftSuggestions],
  ['POST', '/api/att/shifts/import', 'att_setup', att.importShifts],
  ['POST', '/api/att/shifts', 'att_setup', attSetup.createShift],
  ['POST', '/api/att/shifts/group', 'att_setup', attSetup.groupShifts],
  ['PUT', '/api/att/shifts/:id', 'att_setup', attSetup.updateShift],
  ['DELETE', '/api/att/shifts/:id', 'att_setup', attSetup.deleteShift],

  ['GET', '/api/att/reasons', 'att_view', attSetup.listReasons],
  ['POST', '/api/att/reasons', 'att_setup', attSetup.createReason],
  ['PUT', '/api/att/reasons/:code', 'att_setup', attSetup.updateReason],
  ['DELETE', '/api/att/reasons/:code', 'att_setup', attSetup.deleteReason],

  ['GET', '/api/att/holidays', 'att_view', attSetup.listHolidays],
  ['POST', '/api/att/holidays', 'att_setup', attSetup.createHoliday],
  ['POST', '/api/att/holidays/generate', 'att_setup', attSetup.generateHolidays],
  ['DELETE', '/api/att/holidays/:id', 'att_setup', attSetup.deleteHoliday],

  ['GET', '/api/att/devices', 'att_setup', attSetup.listDevices],
  ['POST', '/api/att/devices', 'att_setup', attSetup.createDevice],
  ['PUT', '/api/att/devices/:id', 'att_setup', attSetup.updateDevice],
  ['POST', '/api/att/devices/:id/token', 'att_setup', attSetup.rotateToken],
  ['DELETE', '/api/att/devices/:id', 'att_setup', attSetup.deleteDevice],

  ['PUT', '/api/att/settings', 'att_setup', attSetup.updateSettings],
  ['POST', '/api/att/recompute', 'att_setup', attSetup.recomputeRange],

  // The property's mark. Set by whoever sets the property up, and read by
  // anybody signed in, because it heads their own payslip.
  ['POST', '/api/att/company/logo', 'att_setup', attSetup.setCompanyLogo],
  ['DELETE', '/api/att/company/logo', 'att_setup', attSetup.removeCompanyLogo],
  ['GET', '/api/company/logo', 'att_me', attSetup.companyLogo],

  // -------------------------------------------------------------- records --
  ['GET', '/api/hr/model', 'hr_view', people.peopleModel],
  ['GET', '/api/hr/people', 'hr_view', people.listPeople],
  ['GET', '/api/hr/people/:id', 'hr_view', people.getPerson],
  ['PUT', '/api/hr/people/:id', 'hr_manage', people.savePerson],
  ['PUT', '/api/hr/people/:id/lists/:list', 'hr_manage', people.saveList],

  // What this property asks its people for. Reading it needs only the
  // permission that reads records; changing what everybody is asked needs the
  // one that manages them.
  ['GET', '/api/hr/form', 'hr_view', people.getForm],
  ['PUT', '/api/hr/form', 'hr_manage', people.saveForm],

  ['POST', '/api/hr/people/:id/documents', 'hr_manage', people.addDocument],
  ['GET', '/api/hr/documents', 'hr_view', people.listWaitingDocuments],
  ['POST', '/api/hr/documents/:id/decide', 'hr_manage', people.decideDocument],
  // Reading a scan of somebody's Ghana Card is reading the number on it, so it
  // needs the permission that unmasks the number and not the one that hides it.
  ['GET', '/api/hr/documents/:id', 'hr_manage', people.getDocument],
  ['DELETE', '/api/hr/documents/:id', 'hr_manage', people.deleteDocument],

  ['POST', '/api/hr/people/:id/invites', 'hr_manage', people.createInvite],
  ['POST', '/api/hr/invites/:id/revoke', 'hr_manage', people.revokeInvite],

  ['GET', '/api/hr/submissions', 'hr_view', people.listSubmissions],
  ['POST', '/api/hr/submissions/:id/accept', 'hr_manage', people.acceptSubmission],
  ['POST', '/api/hr/submissions/:id/reject', 'hr_manage', people.rejectSubmission],

  ['GET', '/api/hr/templates', 'hr_manage', people.listTemplates],
  ['POST', '/api/hr/templates', 'hr_manage', (ctx) => people.saveTemplate(ctx, null)],
  ['PUT', '/api/hr/templates/:id', 'hr_manage', people.saveTemplate],
  ['DELETE', '/api/hr/templates/:id', 'hr_manage', people.deleteTemplate],

  ['POST', '/api/hr/people/:id/contracts', 'hr_manage', people.issueContract],
  // A contract signed on paper years ago, scanned. The commonest case for
  // anybody already on the books, and until now there was nowhere to put it.
  ['POST', '/api/hr/people/:id/contracts/file', 'hr_manage', people.fileSignedContract],
  ['POST', '/api/hr/templates/standard', 'hr_manage', people.loadStandardTemplates],
  ['GET', '/api/hr/contracts/:id', 'hr_view', people.getContract],
  ['POST', '/api/hr/contracts/:id/countersign', 'hr_manage', people.countersignContract],
  ['POST', '/api/hr/contracts/:id/void', 'hr_manage', people.voidContract],

  // ------------------------------------------------- somebody with a link --
  // No session reaches any of these. The token in the path is the whole of the
  // caller's authority and it can only ever act on the one person the link was
  // made for — see the note at the top of routes/invite.js.
  ['GET', '/api/i/:token', 'public', invite.inviteHead],
  ['POST', '/api/i/:token/open', 'public', invite.inviteOpen],
  ['POST', '/api/i/:token/details', 'public', invite.inviteDetails],
  // The paper they are holding, photographed on the device that is asking for
  // it. It lands as a claim, exactly like the typed answers beside it.
  ['POST', '/api/i/:token/files', 'public', invite.inviteFile],
  ['POST', '/api/i/:token/files/:id/remove', 'public', invite.inviteFileRemove],
  ['POST', '/api/i/:token/viewed', 'public', invite.inviteViewed],
  ['POST', '/api/i/:token/sign', 'public', invite.inviteSign],
  ['POST', '/api/i/:token/decline', 'public', invite.inviteDecline],

  // ------------------------------------------------------------- letters --
  ['GET', '/api/corr/model', 'corr_view', corr.letterModel],
  ['GET', '/api/corr/letters', 'corr_view', corr.listLetters],
  ['POST', '/api/corr/letters', 'corr_write', corr.createLetter],
  ['GET', '/api/corr/letters/:id', 'corr_view', corr.getLetter],
  ['PUT', '/api/corr/letters/:id', 'corr_write', corr.updateLetter],
  ['POST', '/api/corr/letters/:id/enclosures', 'corr_write', corr.addEnclosure],
  ['POST', '/api/corr/letters/:id/send', 'corr_write', corr.sendForSignature],
  ['POST', '/api/corr/letters/:id/dispatch', 'corr_write', corr.dispatchLetter],
  ['POST', '/api/corr/letters/:id/close', 'corr_write', corr.closeLetter],
  ['POST', '/api/corr/letters/:id/void', 'corr_write', corr.voidLetter],
  // Signing for the property is its own permission, and the handler asks for
  // the signer's own password or PIN on top of the session.
  ['POST', '/api/corr/letters/:id/sign', 'corr_sign', corr.signLetter],
  ['POST', '/api/corr/recipients/:id/revoke', 'corr_write', corr.revokeRecipient],
  ['GET', '/api/corr/files/:id', 'corr_view', corr.getFile],

  // ------------------------------------------------------------ letterheads --
  // The printed paper the property already has, uploaded once and laid on
  // under every letter written here.
  ['GET', '/api/corr/letterheads', 'corr_view', corr.listLetterheads],
  ['POST', '/api/corr/letterheads', 'corr_write', (ctx) => corr.saveLetterhead(ctx, null)],
  ['PUT', '/api/corr/letterheads/:id', 'corr_write', corr.saveLetterhead],
  ['DELETE', '/api/corr/letterheads/:id', 'corr_write', corr.removeLetterhead],
  ['GET', '/api/corr/letterheads/:id/image', 'corr_view', corr.letterheadImage],

  ['GET', '/api/corr/parties', 'corr_view', corr.listParties],
  ['POST', '/api/corr/parties', 'corr_write', (ctx) => corr.saveParty(ctx, null)],
  ['PUT', '/api/corr/parties/:id', 'corr_write', corr.saveParty],

  // Your own signature, and only ever your own — see the note in the handler.
  ['GET', '/api/corr/me', 'corr_sign', corr.signChallenge],
  ['PUT', '/api/corr/me/signature', 'corr_sign', corr.saveMySignature],
  ['DELETE', '/api/corr/me/signature', 'corr_sign', corr.deleteMySignature],

  ['GET', '/api/corr/stamps', 'corr_view', corr.listStamps],
  ['POST', '/api/corr/stamps', 'corr_sign', corr.saveStamp],
  ['DELETE', '/api/corr/stamps/:id', 'corr_sign', corr.deleteStamp],

  // --------------------------------------------- somebody asked to sign it --
  // No session reaches any of these. The token in the path names exactly one
  // recipient of exactly one letter — see the note at the top of sign.js.
  ['GET', '/api/s/:token', 'public', sign.signHead],
  ['POST', '/api/s/:token/open', 'public', sign.signOpen],
  ['GET', '/api/s/:token/file', 'public', sign.signFile],
  ['GET', '/api/s/:token/letterhead', 'public', sign.signLetterhead],
  ['POST', '/api/s/:token/code', 'public', sign.signRequestCode],
  ['POST', '/api/s/:token/sign', 'public', sign.signDocument],
  ['POST', '/api/s/:token/decline', 'public', sign.signDecline],

  // ------------------------------------------------------- people and data --
  ['GET', '/api/users', 'users', admin.listUsers],
  ['POST', '/api/users', 'users', admin.createUser],
  ['PUT', '/api/users/:id', 'users', admin.updateUser],
  ['DELETE', '/api/users/:id', 'users', admin.deleteUser],

  // Being told, rather than asking every minute. A socket, held open for as
  // long as the tab is, carrying the fact that something changed and nothing
  // else — see the note at the top of lib/live.js.
  ['GET', '/api/live', null, live.connect],

  ['GET', '/api/push/key', null, push.publicKey],
  ['GET', '/api/push/status', null, push.status],
  ['POST', '/api/push/subscribe', null, push.subscribe],
  ['POST', '/api/push/unsubscribe', null, push.unsubscribe],
  ['POST', '/api/push/test', null, push.test],
  ['DELETE', '/api/push/devices/:id', 'users', push.removeDevice],

  ['GET', '/api/notifications', 'users', admin.getNotifications],
  ['PUT', '/api/notifications', 'users', admin.updateNotifications],
  ['POST', '/api/notifications/test', 'users', admin.testNotification],

  ['GET', '/api/data/summary', 'users', admin.dataSummary],
  ['POST', '/api/data/erase', 'users', admin.eraseData],
  ['GET', '/api/audit', 'users', admin.auditTrail],

  // The bell. Open to anyone signed in, and what each person sees is decided
  // inside the query by the permissions they already hold.
  ['GET', '/api/notices', null, admin.listNoticesRoute],
  ['POST', '/api/notices/seen', null, admin.markNoticesSeen],
];

/**
 * Serve one page from the assets, without letting the address move.
 *
 * The token in `/i/<token>` is the whole of the link, and the page reads it
 * back out of the address bar. So the address bar has to still say what the
 * person was sent — and asking the assets binding for `/invite.html` does not
 * guarantee that. Static hosting tidies URLs: a request for a `.html` file is
 * answered with a redirect to the extension-less form, which is a courtesy on
 * an ordinary site and, here, throws the token away. The browser follows it to
 * `/invite`, the page loads perfectly, and the first thing it does is look for
 * a token in an address that no longer has one.
 *
 * That failure is worth spelling out because of how it reads from the outside:
 * the person is told their link will not open, so they ask for another, which
 * is built correctly, sent correctly, and fails in exactly the same way. There
 * is nothing wrong with the link at any point.
 *
 * So any redirect is followed here instead of being handed on. What comes back
 * is the page, at the address the person actually opened.
 */
async function servePage(env, url, request, path) {
  const REDIRECTS = new Set([301, 302, 303, 307, 308]);
  let target = new URL(path, url);

  for (let hop = 0; hop < 4; hop += 1) {
    const response = await env.ASSETS.fetch(new Request(target, {
      method: 'GET',
      headers: request.headers,
    }));
    if (!REDIRECTS.has(response.status)) return response;

    const location = response.headers.get('Location');
    // A redirect with nowhere to go, or one that leaves this site, is not ours
    // to chase. Hand it back rather than guess.
    if (!location) return response;
    const next = new URL(location, target);
    if (next.origin !== target.origin) return response;
    target = next;
  }

  // Four hops and still moving is a misconfiguration, not a page.
  return new Response('Not found', { status: 404 });
}

/**
 * Everything the payroll lock covers.
 *
 * A prefix rather than a list of routes, so a route added under it is covered
 * the day it is written rather than the day somebody remembers.
 *
 * The handful that ask about the lock itself are outside it, because a screen
 * that cannot ask for the PIN is a screen nobody can get into.
 */
const PAYROLL_PREFIX = '/api/payroll';
const OUTSIDE_THE_LOCK = new Set([
  '/api/payroll/access',
  '/api/payroll/unlock',
  '/api/payroll/pin',
  '/api/payroll/lock',
  '/api/payroll/grants',
]);
const locked = (pathname) => pathname.startsWith(PAYROLL_PREFIX)
  && !OUTSIDE_THE_LOCK.has(pathname)
  && !pathname.startsWith('/api/payroll/grants/')
  && !pathname.startsWith('/api/payroll/pin/');

/**
 * Somebody else's payslip, and nothing else in the app.
 *
 * A payslip is the one document that is entirely about one person's money.
 * Running the payroll is a job somebody can be given; reading a colleague's
 * payslip is not, whatever else they hold.
 */
const ADMIN_ONLY = new Set(['/api/payroll/slip/:id']);

function match(pattern, pathname) {
  const want = pattern.split('/');
  // A trailing slash is the same address. Browsers, messaging apps and people
  // retyping a link off a screen all add one, and answering "unknown endpoint"
  // to `/api/i/<token>/` is a 404 that reads like a broken link rather than a
  // stray character.
  const got = (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname).split('/');
  if (want.length !== got.length) return null;
  const params = [];
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (!got[i]) return null;
      params.push(decodeURIComponent(got[i]));
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

export default {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url);

    // The link somebody is sent reads `/i/<token>` — short enough to type off a
    // screen and to survive being pasted into a message. It is one page, and
    // the token is read back out of the address by the page itself, which is
    // why the address must not be allowed to change on the way.
    if (url.pathname.startsWith('/i/')) {
      return servePage(env, url, request, '/invite.html');
    }

    // The same idea for a letter sent out for signature. A separate page from
    // the staff one: this is opened by suppliers, banks and guests, and the
    // less of the system it can reach the better.
    if (url.pathname.startsWith('/s/')) {
      return servePage(env, url, request, '/sign.html');
    }

    // The lunch list. One address for the whole property rather than one per
    // person: almost nobody who eats here has a login, and the page is built
    // to be found on a noticeboard.
    if (url.pathname.startsWith('/lunch/')) {
      return servePage(env, url, request, '/lunch.html');
    }

    // Arriving from the group hub with a hand-off code. Not under /api/
    // because a person follows this link in their address bar, and what comes
    // back is a redirect and a cookie rather than JSON.
    if (url.pathname === '/sso') {
      return handleSsoArrival(request, env, env.DB);
    }

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await route(request, env, url, executionContext);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
      }
      if (isMissingTable(err)) {
        return json({
          error: 'This site has been updated but its database has not. '
            + 'Run the latest database changes — see “Create the tables” in the setup guide — '
            + 'and this will start working. Nothing has been lost.',
          detail: { missingSchema: true },
        }, { status: 503 });
      }
      // Last resort: a constraint that slipped past its handler is still a
      // rule being broken, not a broken server. Say which rule.
      const text = String(err?.message ?? err);
      if (/UNIQUE constraint/i.test(text)) {
        return json({
          error: 'That would duplicate something that has to be unique — usually a name or an '
            + 'employee number that is already taken. Change it and try again.',
        }, { status: 400 });
      }
      if (/FOREIGN KEY constraint/i.test(text)) {
        return json({
          error: 'That refers to something that no longer exists. Reload the page and try again.',
        }, { status: 400 });
      }

      console.error('Unhandled error', err);
      return json({ error: 'Something went wrong on the server' }, { status: 500 });
    }
  },

  /**
   * The daily tick, from a Cron Trigger.
   *
   * Recomputes the last few days so a punch that arrived late is reflected, and
   * rings the bell once for whatever still needs a person. Once — a
   * notification per exception would be a dozen a morning and everybody would
   * learn to swipe them away.
   *
   * Idempotent, so a cron that fires twice cannot produce two rounds of email.
   */
  async scheduled(event, env, executionContext) {
    if (!env.DB) return;

    const run = (async () => {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'")
        .first()
        .catch(() => null);
      const timezone = row?.value || 'UTC';

      // Two schedules through one handler. The frequent one watches the shifts
      // people are inside — one that started with nothing recorded against it,
      // and one about to end with nobody clocked out. The daily one does the
      // recompute and the morning bell. Told apart by the cron that fired, so
      // adding a third never means guessing from the clock.
      const nightly = String(event?.cron ?? '').startsWith('30 0');

      const watched = await watchShifts(env.DB, {
        timezone,
        ctx: { env, executionContext },
      }).catch((err) => {
        console.error('Shift watch failed', err);
        return { nudged: 0 };
      });
      if (watched.nudged) console.log(`Attendance: ${watched.nudged} told their shift has started`);
      if (watched.reminded) console.log(`Attendance: ${watched.reminded} reminded to clock out`);

      if (!nightly) return;

      const result = await att.dailyTick(env.DB, env, todayIn(timezone));
      if (result.open || result.absent) {
        console.log(`Attendance: ${result.open} to confirm, ${result.absent} absent`);
      }

      // And whose birthday it is, which is the one thing the daily run does
      // that nobody has to act on.
      const wishes = await birthday.wishThem(env.DB, {
        timezone,
        ctx: { env, executionContext },
      }).catch((err) => {
        console.error('Birthdays failed', err);
        return { wished: 0 };
      });
      if (wishes.wished) console.log(`Birthdays: ${wishes.wished} wished`);

      // And whether last month's advance deductions were actually taken, which
      // is the one thing in here that asks a person a question rather than
      // telling them something.
      const asked = await advance.askAboutTheMonth(env.DB, {
        timezone,
        ctx: { env, executionContext },
      }).catch((err) => {
        console.error('Advance month-end failed', err);
        return { asked: 0 };
      });
      if (asked.asked) console.log(`Advances: ${asked.asked} to confirm for ${asked.month}`);
    })().catch((err) => console.error('Scheduled run failed', err));

    if (executionContext?.waitUntil) executionContext.waitUntil(run);
    else await run;
  },
};

async function route(request, env, url, executionContext) {
  if (!env.SESSION_SECRET) {
    return json(
      { error: 'Server not configured: SESSION_SECRET is missing. See the README setup steps.' },
      { status: 503 },
    );
  }
  if (!env.DB) {
    return json({ error: 'Server not configured: no database binding.' }, { status: 503 });
  }

  const method = request.method === 'HEAD' ? 'GET' : request.method;
  let allowedMethods = null;

  for (const [routeMethod, pattern, permission, handler] of ROUTES) {
    const params = match(pattern, url.pathname);
    if (!params) continue;
    if (routeMethod !== method) {
      allowedMethods = allowedMethods || [];
      allowedMethods.push(routeMethod);
      continue;
    }

    const ctx = { request, env, url, db: env.DB, executionContext, session: null };

    if (permission !== 'public') {
      ctx.session = await getSession(request, env, env.DB);
      if (!ctx.session) throw unauthorized();
      // A list means any one of them is enough — see `allows`.
      if (!allows(permission, ctx.session.permissions)) {
        throw forbidden('You do not have access to that part of the system.');
      }
      // The second lock, applied here rather than inside each handler: a
      // payroll route added later and wired to the right permission but
      // nothing else is exactly the accident this exists to stop.
      if (locked(url.pathname)) await payAccess.guardPayroll(ctx);
      if (ADMIN_ONLY.has(pattern) && ctx.session.user.role !== 'admin') {
        throw forbidden('Only an administrator can open somebody else\u2019s payslip.');
      }
    }

    const response = await handler(ctx, ...params);

    // One place, so a route added later is live the day it is written rather
    // than the day somebody remembers. Only what actually changed something,
    // and only where it worked: a refused save is not news.
    if (response?.ok && live.worthTelling(method, url.pathname)) {
      live.announce(env, executionContext, {
        topic: live.topicFor(url.pathname),
        by: request.headers.get('X-Hive-Client'),
      });
    }

    return response;
  }

  if (allowedMethods?.length) {
    return json({ error: 'Method not allowed' }, {
      status: 405,
      headers: { Allow: [...new Set(allowedMethods)].join(', ') },
    });
  }
  return json({ error: 'Unknown endpoint' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

/**
 * The salt and work factor to derive with, for a given address.
 *
 * Public by necessity — the browser needs it before it can prove anything. An
 * address with no account gets a stable made-up salt, so this cannot be used to
 * find out who has an account.
 */
async function passwordSalt(ctx) {
  const body = await readJson(ctx.request);
  const email = str(body.email, 'Email address', { required: true, max: 200 });
  const params = await saltForEmail(ctx.db, email, await getPepper(ctx.db));
  return json(params);
}

async function login(ctx) {
  const { request, env, url, db } = ctx;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const gate = throttleCheck(ip);
  if (!gate.allowed) {
    return json(
      { error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.` },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } },
    );
  }

  const body = await readJson(request);

  // Two ways in: a PIN for a supervisor with a phone in a corridor, or an email
  // address and password. An administrator must have the second and may have
  // the first as well; everybody else has only the PIN.
  const user = body.email
    ? await userForCredentials(db, body.email, String(body.passwordKey ?? ''))
    : await userForPin(db, str(body.pin, 'PIN', { required: true, max: 64 }), env);

  if (!user) {
    throttleFail(ip);
    // A uniform delay keeps a wrong credential from being distinguishable by
    // timing, and says nothing about which half was wrong.
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest(body.email
      ? 'That email address and password combination was not recognised'
      : 'That PIN was not recognised');
  }

  throttleReset(ip);

  const now = Math.floor(Date.now() / 1000);
  const token = await createToken(
    {
      uid: user.id,
      role: user.role,
      recovery: user.isRecovery ? 1 : 0,
      // Which credential opened this session. A PIN is enough for the app; it
      // is not enough to choose the PIN that guards the payroll.
      via: body.email ? 'password' : 'pin',
      iat: now,
      exp: now + tokenTtl(user.role),
    },
    env.SESSION_SECRET,
  );

  if (!user.isRecovery) {
    await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .bind(user.id).run().catch(() => {});
  }

  return json({
    ok: true,
    role: user.role,
    name: user.name,
    email: user.email ?? null,
    isRecovery: Boolean(user.isRecovery),
    permissions: effectivePermissions(user),
  }, {
    headers: { 'Set-Cookie': sessionCookie(token, user.role, url.protocol === 'https:') },
  });
}

async function logout(ctx) {
  return json({ ok: true }, {
    headers: { 'Set-Cookie': clearCookie(ctx.url.protocol === 'https:') },
  });
}

async function me(ctx) {
  const session = await getSession(ctx.request, ctx.env, ctx.db);
  if (!session) return json({ authenticated: false });

  // Who the property is, sent with the session because the header shows the
  // name on every screen and a payslip prints the rest of it. Nine short
  // strings and a timestamp: cheaper than a second request from every screen
  // that heads a piece of paper.
  const settings = await ctx.db.prepare(
    "SELECT key, value FROM settings WHERE key = 'timezone' OR key = 'property_name' "
    + "OR key = 'property_address' OR key LIKE 'company_%'",
  ).all();

  return json({
    authenticated: true,
    role: session.user.role,
    name: session.user.name,
    email: session.user.email ?? null,
    userId: session.user.id,
    isRecovery: Boolean(session.user.isRecovery),
    // Whether this login belongs to somebody on the rota. The menu uses it to
    // decide whether "my own" means anything: an administrator holds every
    // permission there is, and with no staff record behind it My shifts would
    // open an apology.
    staffId: session.user.staff_id ?? null,
    signsInWith: session.user.role === 'admin' ? 'password' : 'pin',
    // What they typed to get here, so My account knows which credential it can
    // ask them to confirm with.
    signedInWith: session.via ?? 'pin',
    // Whether they already have a login PIN, so My account offers to change it
    // rather than to set one.
    hasPin: Boolean(session.user.has_pin),
    permissions: session.permissions,
    // What each one is called. Thirteen short strings sent with the session,
    // so a screen can name a permission the reader does not hold without
    // keeping a second copy of the list that drifts the first time one is
    // renamed. The labels are not secret — they are the words on the Users
    // screen, and knowing that "Sign off attendance" exists is exactly what
    // lets somebody ask for it.
    permissionLabels: Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label])),
    roleLabels: Object.fromEntries(ROLES.map((r) => [r.key, r.label])),
    settings: Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value])),
  });
}

/**
 * Change your own PIN or password.
 *
 * Everyone can do this for themselves, which is what stops a shared PIN quietly
 * becoming permanent because changing it needed an administrator. The current
 * credential is always required, so an unattended signed-in tablet cannot be
 * used to lock its owner out.
 */
async function changeCredentials(ctx) {
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  if (session.user.isRecovery) {
    throw badRequest(
      'You are signed in with the emergency recovery PIN, which is set on the server rather than here. '
      + 'Sign in with your own account to change its credentials.',
    );
  }

  const row = await db.prepare(
    'SELECT id, role, pin_hash, password_hash FROM users WHERE id = ?',
  ).bind(session.user.id).first();
  if (!row) throw badRequest('Your account could not be found');

  // Administrators hold a password, and may hold a PIN alongside it; everyone
  // else holds a PIN.
  if (session.user.role === 'admin') {
    const pepper = await getPepper(db);
    const currentKey = String(body.currentPasswordKey ?? '');

    if (!await verifyPasswordKey(currentKey, row.password_hash, pepper)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      throw badRequest('Your current password is not correct');
    }

    // The password is what authorises anything done to the PIN, whether or not
    // one exists yet. It outranks the PIN, so it can always speak for it, and
    // asking for the PIN instead would leave an administrator who has
    // forgotten theirs unable to choose another.
    if (body.removePin || body.newPin != null) {
      const wanted = String(body.newPin ?? '');
      if (body.removePin) {
        await db.batch([
          db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ?').bind(row.id),
          db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
            .bind(`${session.user.name} (${session.user.role})`, 'account.pin_removed', String(row.id), null),
        ]);
        return json({ ok: true, changed: 'pin', hasPin: false });
      }

      if (!/^\d{4,10}$/.test(wanted)) throw badRequest('The new PIN must be 4 to 10 digits');
      if (await isReservedPin(wanted, ctx.env)) throw badRequest(PIN_TAKEN);

      try {
        await db.batch([
          db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?')
            .bind(await hashPin(wanted, pepper), row.id),
          db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
            .bind(`${session.user.name} (${session.user.role})`, 'account.pin_change', String(row.id), null),
        ]);
      } catch (err) {
        if (String(err).includes('UNIQUE')) throw badRequest(PIN_TAKEN);
        throw err;
      }
      return json({ ok: true, changed: 'pin', hasPin: true });
    }

    if (!body.passwordKey || !body.passwordSalt) {
      throw badRequest('The new password did not reach the server correctly. Please try again.');
    }
    if (body.passwordKey === currentKey) {
      throw badRequest('The new password is the same as the current one');
    }

    const next = await storedPassword({
      passwordKey: String(body.passwordKey),
      salt: String(body.passwordSalt),
      iterations: body.passwordIterations,
    }, pepper);

    await db.batch([
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(next, row.id),
      db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
        .bind(`${session.user.name} (${session.user.role})`, 'account.password_change', String(row.id), null),
    ]);

    return json({ ok: true, changed: 'password' });
  }

  const current = String(body.currentPin ?? '');
  const next = String(body.newPin ?? '');
  const pepper = await getPepper(db);

  if (await hashPin(current, pepper) !== row.pin_hash) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest('Your current PIN is not correct');
  }
  if (!/^\d{4,10}$/.test(next)) throw badRequest('The new PIN must be 4 to 10 digits');
  if (next === current) throw badRequest('The new PIN is the same as the current one');
  if (await isReservedPin(next, ctx.env)) throw badRequest(PIN_TAKEN);

  try {
    await db.batch([
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?')
        .bind(await hashPin(next, pepper), row.id),
      db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
        .bind(`${session.user.name} (${session.user.role})`, 'account.pin_change', String(row.id), null),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw badRequest(PIN_TAKEN);
    throw err;
  }

  return json({ ok: true, changed: 'pin' });
}
