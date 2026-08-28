// Thin fetch wrapper. Every call goes through here so an expired session and a
// dropped connection are handled in exactly one place rather than in thirty.

import { tabId } from './live.js';

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

/**
 * Whether the server is answering.
 *
 * Not `navigator.onLine`, which only says whether the device has a network
 * interface: it stays true on a phone with two bars and no data, and true when
 * the site itself is down. The only honest test is whether a request came
 * back, so that is what this tracks.
 *
 * It matters more than it used to. The app is installable now, so it opens
 * from a home screen whether or not anything can be reached — and a screen
 * that opens is a screen somebody believes. "Nobody absent, all settled" is a
 * reasonable-looking morning and a dangerous thing to show when the truth is
 * that nothing could be fetched.
 */
let reachable = true;
const watchers = new Set();

export function serverReachable() { return reachable; }

export function onReachabilityChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function reachedServer(yes) {
  if (reachable === yes) return;
  reachable = yes;
  for (const fn of watchers) { try { fn(yes); } catch { /* a watcher is a courtesy */ } }
}

/**
 * A path with a missing id in it, caught here rather than at the far end.
 *
 * `/api/att/staff/${id}` with an undefined id builds the perfectly valid-looking
 * `/api/att/staff/undefined`, which reaches the server, matches the update
 * route, finds nothing, and comes back as "No such member of staff" — an answer
 * that sends whoever reads it looking in entirely the wrong place.
 *
 * No request is worth making with a hole in it, so it fails at the call site
 * instead, naming the path so the culprit is obvious.
 */
export function pathHasHole(path) {
  return /\/(undefined|null|NaN)(\/|$)/.test(String(path));
}

/**
 * A failure that did not come from this app, said so plainly.
 *
 * Every refusal this app makes comes back as JSON with a sentence in it — "a
 * day that has not finished cannot be signed off", "that overlaps an existing
 * sign-off". So an error that is *not* JSON did not come from the app at all:
 * it came from Cloudflare, or a proxy, or whatever else sits between the
 * browser and the site. "Request failed (503)" told the reader none of that,
 * and reads like the app rejecting what they did.
 *
 * The distinction matters because the two have opposite answers. A refusal
 * means change something and try again. This means change nothing and try
 * again.
 */
async function notFromTheApp(response) {
  const gateway = [502, 503, 504].includes(response.status);
  const where = gateway
    ? 'The site did not answer'
    : `Something between your browser and the site returned an error (${response.status})`;

  // Whatever the page said, in case it names the real cause. Tags stripped:
  // an error page is usually HTML and its words are the only useful part.
  let said = '';
  try {
    said = (await response.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch { /* a body that cannot be read tells us nothing, which is fine */ }

  return `${where}${gateway ? ` (${response.status})` : ''}. This is the connection or the host `
    + 'rather than anything you did — the app itself always answers with a reason. Wait a moment '
    + `and try again.${said ? ` It said: "${said}"` : ''}`;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  if (pathHasHole(path)) {
    throw new ApiError(0, `Something is missing from this request (${path}). Reload and try again.`);
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        // Which tab is asking. Only ever used to leave this tab out of the
        // announcement its own save causes: it has already redrawn itself off
        // the answer, and a second redraw over staged edits is how somebody
        // loses work. See live.js.
        'X-Hive-Client': tabId(),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    reachedServer(false);
    throw new ApiError(0, 'No connection to the server. Check the signal and try again.');
  }

  // Anything at all came back — even a refusal — so the server is there.
  reachedServer(true);

  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Your session has expired. Sign in again.');
  }

  const type = response.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) {
    if (!response.ok) throw new ApiError(response.status, await notFromTheApp(response), null);
    return response;
  }

  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error || `Request failed (${response.status})`, data.detail);
  return data;
}

export const api = {
  ApiError,
  login: (pin) => request('/api/auth/login', { method: 'POST', body: { pin } }),
  passwordSalt: (email) => request('/api/auth/salt', { method: 'POST', body: { email } }),
  loginWithKey: (email, passwordKey) =>
    request('/api/auth/login', { method: 'POST', body: { email, passwordKey } }),
  changeCredentials: (body) => request('/api/auth/change-credentials', { method: 'POST', body }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),

  // ------------------------------------------------------------ attendance --
  attBootstrap: () => request('/api/att/bootstrap'),
  attDay: (day) => request(`/api/att/day${day ? `?day=${day}` : ''}`),
  attStaffDay: (id, day) => request(`/api/att/staff/${id}/day${day ? `?day=${day}` : ''}`),
  attWeek: (from) => request(`/api/att/week${from ? `?from=${from}` : ''}`),
  attStaffReport: (id, from, to) => request(`/api/att/staff/${id}/report?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  attOverview: (month) => request(`/api/att/overview${month ? `?month=${month}` : ''}`),
  attReview: (params) => request(`/api/att/review?${new URLSearchParams(params)}`),
  attDecideReview: (body) => request('/api/att/review', { method: 'POST', body }),
  attSetCalendar: (body) => request('/api/att/calendar', { method: 'POST', body }),
  attUndoReview: (body) => request('/api/att/review/undo', { method: 'POST', body }),
  attOutstanding: (params = {}) => request(`/api/att/outstanding?${new URLSearchParams(params)}`),
  attLeaveAdjustments: (staffId) => request(`/api/att/staff/${staffId}/adjustments`),
  attChangeDaysApplied: (id, body) => request(`/api/att/reviews/${id}/days`, { method: 'POST', body }),
  attSignDays: (body) => request('/api/att/sign-days', { method: 'POST', body }),
  attReopenDays: (body) => request('/api/att/sign-days/undo', { method: 'POST', body }),
  attQueries: (status) => request(`/api/att/queries${status ? `?status=${status}` : ''}`),
  attDeciders: () => request('/api/att/deciders'),
  attRaiseQuery: (body) => request('/api/att/queries', { method: 'POST', body }),
  attAnswerQuery: (id, body) => request(`/api/att/queries/${id}/answer`, { method: 'POST', body }),
  attWithdrawQuery: (id) => request(`/api/att/queries/${id}/withdraw`, { method: 'POST' }),

  attBalances: (asOf) => request(`/api/att/balances${asOf ? `?asOf=${asOf}` : ''}`),
  attExportUrl: (from, to) => `/api/att/export?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`,
  // Just the ones needing somebody. A single day, or a range for a Monday
  // catch-up.
  attIssuesUrl: ({ day, from, to } = {}) => `/api/att/export/issues?${new URLSearchParams({
    ...(day ? { day } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`,

  attResolve: (day, body) => request(`/api/att/days/${day}/resolve`, { method: 'POST', body }),
  attUnresolve: (day, body) => request(`/api/att/days/${day}/unresolve`, { method: 'POST', body }),
  attAddPunch: (body) => request('/api/att/punches', { method: 'POST', body }),
  hrForm: () => request('/api/hr/form'),
  hrSaveForm: (body) => request('/api/hr/form', { method: 'PUT', body }),
  hrWaitingDocuments: () => request('/api/hr/documents'),
  hrDecideDocument: (id, body) => request(`/api/hr/documents/${id}/decide`, { method: 'POST', body }),

  attCorrectTimes: (day, body) => request(`/api/att/days/${day}/times`, { method: 'POST', body }),
  attDecideTimeEdit: (id, body) => request(`/api/att/time-edits/${id}/decide`, { method: 'POST', body }),
  attDecideTimeEdits: (body) => request('/api/att/time-edits/decide', { method: 'POST', body }),
  attTimeEdits: (params = {}) => request(`/api/att/time-edits?${new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
  )}`),

  attRoster: (from, to) => request(`/api/att/roster?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  hrStaffPay: (id) => request(`/api/hr/staff/${id}/pay`),
  hrSetStaffPay: (id, body) => request(`/api/hr/staff/${id}/pay`, { method: 'POST', body }),
  hrRemoveStaffPay: (id, rateId) => request(`/api/hr/staff/${id}/pay/${rateId}`, { method: 'DELETE' }),
  attLabourCost: (params) => request(`/api/att/labour-cost?${new URLSearchParams(params)}`),
  attWorkload: (params) => request(`/api/att/workload?${new URLSearchParams(params)}`),
  attWorkloadRota: (from, to) => request(`/api/att/workload/rota?${new URLSearchParams({ from, to })}`),
  attSaveRoster: (body) => request('/api/att/roster', { method: 'POST', body }),
  // A member of staff, looking at their own. None of these takes a staff id:
  // who you are comes off the session, so there is no version of somebody
  // else's week to ask for.
  myWeek: (from) => request(`/api/me/week${from ? `?from=${from}` : ''}`),
  myReport: (month) => request(`/api/me/report${month ? `?month=${month}` : ''}`),
  myAskForLeave: (body) => request('/api/me/leave', { method: 'POST', body }),
  myWithdrawLeave: (id) => request(`/api/me/leave/${id}/withdraw`, { method: 'POST', body: {} }),
  mySetAvailability: (body) => request('/api/me/availability', { method: 'POST', body }),
  myRunningLate: (body) => request('/api/me/running-late', { method: 'POST', body }),
  myAdvances: () => request('/api/me/advances'),
  myMedical: (year) => request(`/api/me/medical${year ? `?year=${year}` : ''}`),
  myMedicalClaim: (body) => request('/api/me/medical', { method: 'POST', body }),
  myWithdrawClaim: (id) => request(`/api/me/medical/${id}/withdraw`, { method: 'POST', body: {} }),
  myAskForAdvance: (body) => request('/api/me/advances', { method: 'POST', body }),
  myWithdrawAdvance: (id) => request(`/api/me/advances/${id}/withdraw`, { method: 'POST', body: {} }),

  // ------------------------------------------------------------ advances --
  advances: (month) => request(`/api/advances${month ? `?month=${month}` : ''}`),
  advanceAdd: (body) => request('/api/advances', { method: 'POST', body }),
  advanceCloseMonth: (body) => request('/api/advances/close', { method: 'POST', body }),
  advancesFor: (staffId) => request(`/api/advances/staff/${staffId}`),
  advanceDecide: (id, body) => request(`/api/advances/${id}/decide`, { method: 'POST', body }),
  advanceAdjust: (id, body) => request(`/api/advances/${id}`, { method: 'PATCH', body }),
  advanceEntry: (id, body) => request(`/api/advances/${id}/entry`, { method: 'POST', body }),
  advanceRemoveEntry: (id, entryId) => request(`/api/advances/${id}/entry/${entryId}`, { method: 'DELETE' }),
  advancePaperUrl: (id) => `/api/advances/${id}/paper`,

  // ------------------------------------------------------------- medical --
  medical: (year) => request(`/api/medical${year ? `?year=${year}` : ''}`),
  medicalSetAllowances: (body) => request('/api/medical/allowances', { method: 'POST', body }),
  medicalDecide: (id, body) => request(`/api/medical/claims/${id}/decide`, { method: 'POST', body }),
  medicalReceiptUrl: (id) => `/api/medical/receipt/${id}`,

  // ------------------------------------------------------------- payroll --
  payroll: (month) => request(`/api/payroll${month ? `?month=${month}` : ''}`),
  payslip: (staffId, month) => request(`/api/payroll/slip/${staffId}${month ? `?month=${month}` : ''}`),
  payrollProfiles: (body) => request('/api/payroll/profiles', { method: 'POST', body }),
  payrollScheme: (body) => request('/api/payroll/schemes', { method: 'POST', body }),
  payrollRemoveScheme: (id) => request(`/api/payroll/schemes/${id}`, { method: 'DELETE' }),
  payrollScores: (body) => request('/api/payroll/scores', { method: 'POST', body }),
  payrollPenalty: (body) => request('/api/payroll/penalties', { method: 'POST', body }),
  payrollRemovePenalty: (id) => request(`/api/payroll/penalties/${id}`, { method: 'DELETE' }),
  payrollReturns: (month) => request(`/api/payroll/returns?month=${encodeURIComponent(month)}`),
  payrollAccess: () => request('/api/payroll/access'),
  payrollUnlock: (body) => request('/api/payroll/unlock', { method: 'POST', body }),
  payrollSetPin: (body) => request('/api/payroll/pin', { method: 'POST', body }),
  payrollResetPin: (id) => request(`/api/payroll/pin/${id}`, { method: 'DELETE' }),
  payrollLock: () => request('/api/payroll/lock', { method: 'POST', body: {} }),
  payrollGrants: () => request('/api/payroll/grants'),
  payrollGrant: (body) => request('/api/payroll/grants', { method: 'POST', body }),
  payrollRevoke: (id) => request(`/api/payroll/grants/${id}`, { method: 'DELETE' }),
  payrollCopy: (body) => request('/api/payroll/copy', { method: 'POST', body }),
  payrollReadInput: (body) => request('/api/payroll/input/read', { method: 'POST', body }),
  payrollApplyInput: (body) => request('/api/payroll/input/apply', { method: 'POST', body }),
  payrollClose: (body) => request('/api/payroll/close', { method: 'POST', body }),
  payrollReopen: (body) => request('/api/payroll/reopen', { method: 'POST', body }),

  attBirthdays: () => request('/api/att/birthdays'),
  attBirthdayCard: (body) => request('/api/att/birthdays/card', { method: 'POST', body }),
  attSuggestRoster: (from, to) => request(`/api/att/roster/suggest?from=${from}&to=${to}`),
  attRosterHistory: (params) => request(`/api/att/roster/history?${new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== ''),
  )}`),
  attPublishRoster: (body) => request('/api/att/roster/publish', { method: 'POST', body }),
  attSetAvailability: (body) => request('/api/att/availability', { method: 'POST', body }),
  attCopyRoster: (body) => request('/api/att/roster/copy', { method: 'POST', body }),
  attClearRoster: (body) => request('/api/att/roster/clear', { method: 'POST', body }),
  attWaitingAvailability: () => request('/api/att/availability/waiting'),
  setMyPhoto: (body) => request('/api/me/photo', { method: 'POST', body }),
  clearMyPhoto: () => request('/api/me/photo', { method: 'DELETE' }),
  attDecideAvailability: (body) => request('/api/att/availability/decide', { method: 'POST', body }),
  attSavePattern: (body) => request('/api/att/patterns', { method: 'POST', body }),

  attRotaImport: () => request('/api/att/rota-import'),
  attRotaImportPreview: (body) => request('/api/att/rota-import', { method: 'POST', body }),
  attRotaImportName: (body) => request('/api/att/rota-import/name', { method: 'POST', body }),
  attRotaImportShift: (body) => request('/api/att/rota-import/shift', { method: 'POST', body }),
  attRotaImportConfirm: () => request('/api/att/rota-import/confirm', { method: 'POST', body: {} }),
  attRotaImportDiscard: () => request('/api/att/rota-import/discard', { method: 'POST', body: {} }),

  attLeave: (params = {}) => request(`/api/att/leave?${new URLSearchParams(params)}`),
  attRequestLeave: (body) => request('/api/att/leave', { method: 'POST', body }),
  attDecideLeave: (id, body) => request(`/api/att/leave/${id}/decide`, { method: 'POST', body }),
  attSetLeaveType: (id, body) => request(`/api/att/leave/${id}/type`, { method: 'POST', body }),
  attLeaveDays: (id) => request(`/api/att/leave/${id}/days`),
  attCancelLeave: (id) => request(`/api/att/leave/${id}`, { method: 'DELETE' }),

  attStaff: () => request('/api/att/staff'),
  attCreateStaff: (body) => request('/api/att/staff', { method: 'POST', body }),
  attReadStaffImport: (text) => request('/api/att/staff/import/read', { method: 'POST', body: { text } }),
  attApplyStaffImport: (text) => request('/api/att/staff/import', { method: 'POST', body: { text } }),
  attUpdateStaff: (id, body) => request(`/api/att/staff/${id}`, { method: 'PUT', body }),
  attDeleteStaff: (id) => request(`/api/att/staff/${id}`, { method: 'DELETE' }),
  attUnknown: () => request('/api/att/unknown'),

  attShifts: () => request('/api/att/shifts'),
  attShiftSuggestions: (days) => request(`/api/att/shift-suggestions${days ? `?days=${days}` : ''}`),
  attImportShifts: (shifts) => request('/api/att/shifts/import', { method: 'POST', body: { shifts } }),
  attCreateShift: (body) => request('/api/att/shifts', { method: 'POST', body }),
  attGroupShifts: (body) => request('/api/att/shifts/group', { method: 'POST', body }),
  attUpdateShift: (id, body) => request(`/api/att/shifts/${id}`, { method: 'PUT', body }),
  attDeleteShift: (id) => request(`/api/att/shifts/${id}`, { method: 'DELETE' }),

  attReasons: () => request('/api/att/reasons'),
  attCreateReason: (body) => request('/api/att/reasons', { method: 'POST', body }),
  attUpdateReason: (code, body) => request(`/api/att/reasons/${code}`, { method: 'PUT', body }),
  attDeleteReason: (code) => request(`/api/att/reasons/${code}`, { method: 'DELETE' }),

  attHolidays: (year) => request(`/api/att/holidays${year ? `?year=${year}` : ''}`),
  attCreateHoliday: (body) => request('/api/att/holidays', { method: 'POST', body }),
  attGenerateHolidays: (year) => request('/api/att/holidays/generate', { method: 'POST', body: { year } }),
  attDeleteHoliday: (id) => request(`/api/att/holidays/${id}`, { method: 'DELETE' }),

  attDevices: () => request('/api/att/devices'),
  attCreateDevice: (body) => request('/api/att/devices', { method: 'POST', body }),
  attUpdateDevice: (id, body) => request(`/api/att/devices/${id}`, { method: 'PUT', body }),
  attRotateToken: (id) => request(`/api/att/devices/${id}/token`, { method: 'POST' }),
  attDeleteDevice: (id) => request(`/api/att/devices/${id}`, { method: 'DELETE' }),

  attUpdateSettings: (body) => request('/api/att/settings', { method: 'PUT', body }),
  attSetLogo: (body) => request('/api/att/company/logo', { method: 'POST', body }),

  lunch: (week) => request(`/api/lunch${week ? `?week=${week}` : ''}`),
  lunchSetMenu: (body) => request('/api/lunch/menu', { method: 'POST', body }),
  lunchSetOrder: (body) => request('/api/lunch/order', { method: 'POST', body }),
  lunchMakeLink: () => request('/api/lunch/link', { method: 'POST', body: {} }),
  lunchSwitch: (body) => request('/api/lunch/switch', { method: 'POST', body }),
  lunchSetSchedule: (body) => request('/api/lunch/schedule', { method: 'POST', body }),
  attRemoveLogo: () => request('/api/att/company/logo', { method: 'DELETE' }),
  attRecompute: (body) => request('/api/att/recompute', { method: 'POST', body }),

  // ------------------------------------------------------ employee records --
  hrModel: () => request('/api/hr/model'),
  hrPeople: () => request('/api/hr/people'),
  hrPerson: (id) => request(`/api/hr/people/${id}`),
  hrSavePerson: (id, body) => request(`/api/hr/people/${id}`, { method: 'PUT', body }),
  hrSaveList: (id, list, rows) => request(`/api/hr/people/${id}/lists/${list}`, { method: 'PUT', body: { rows } }),

  hrAddDocument: (id, body) => request(`/api/hr/people/${id}/documents`, { method: 'POST', body }),
  hrDocumentUrl: (id) => `/api/hr/documents/${id}`,
  hrDeleteDocument: (id) => request(`/api/hr/documents/${id}`, { method: 'DELETE' }),

  hrCreateInvite: (id, body) => request(`/api/hr/people/${id}/invites`, { method: 'POST', body }),
  hrRevokeInvite: (id) => request(`/api/hr/invites/${id}/revoke`, { method: 'POST' }),

  hrSubmissions: () => request('/api/hr/submissions'),
  hrAcceptSubmission: (id, keys) => request(`/api/hr/submissions/${id}/accept`, { method: 'POST', body: { keys } }),
  hrRejectSubmission: (id, note) => request(`/api/hr/submissions/${id}/reject`, { method: 'POST', body: { note } }),

  hrTemplates: () => request('/api/hr/templates'),
  hrCreateTemplate: (body) => request('/api/hr/templates', { method: 'POST', body }),
  hrUpdateTemplate: (id, body) => request(`/api/hr/templates/${id}`, { method: 'PUT', body }),
  hrDeleteTemplate: (id) => request(`/api/hr/templates/${id}`, { method: 'DELETE' }),

  hrIssueContract: (id, body) => request(`/api/hr/people/${id}/contracts`, { method: 'POST', body }),
  hrFileContract: (id, body) => request(`/api/hr/people/${id}/contracts/file`, { method: 'POST', body }),
  hrLoadStandardTemplates: () => request('/api/hr/templates/standard', { method: 'POST' }),
  hrContract: (id) => request(`/api/hr/contracts/${id}`),
  hrCountersign: (id, body) => request(`/api/hr/contracts/${id}/countersign`, { method: 'POST', body }),
  hrVoidContract: (id, note) => request(`/api/hr/contracts/${id}/void`, { method: 'POST', body: { note } }),

  // ------------------------------------------------------------- letters --
  corrModel: () => request('/api/corr/model'),
  corrLetters: (params = {}) => request(`/api/corr/letters?${new URLSearchParams(params)}`),
  corrCreateLetter: (body) => request('/api/corr/letters', { method: 'POST', body }),
  corrLetter: (id) => request(`/api/corr/letters/${id}`),
  corrUpdateLetter: (id, body) => request(`/api/corr/letters/${id}`, { method: 'PUT', body }),
  corrAddEnclosure: (id, body) => request(`/api/corr/letters/${id}/enclosures`, { method: 'POST', body }),
  corrSendForSignature: (id, body) => request(`/api/corr/letters/${id}/send`, { method: 'POST', body }),
  corrDispatch: (id, body) => request(`/api/corr/letters/${id}/dispatch`, { method: 'POST', body }),
  corrClose: (id, note) => request(`/api/corr/letters/${id}/close`, { method: 'POST', body: { note } }),
  corrVoid: (id, note) => request(`/api/corr/letters/${id}/void`, { method: 'POST', body: { note } }),
  corrSign: (id, body) => request(`/api/corr/letters/${id}/sign`, { method: 'POST', body }),
  corrRevokeRecipient: (id) => request(`/api/corr/recipients/${id}/revoke`, { method: 'POST' }),
  corrFileUrl: (id) => `/api/corr/files/${id}`,
  corrLetterheads: () => request('/api/corr/letterheads'),
  corrAddLetterhead: (body) => request('/api/corr/letterheads', { method: 'POST', body }),
  corrSaveLetterhead: (id, body) => request(`/api/corr/letterheads/${id}`, { method: 'PUT', body }),
  corrRemoveLetterhead: (id) => request(`/api/corr/letterheads/${id}`, { method: 'DELETE' }),
  corrLetterheadUrl: (id) => `/api/corr/letterheads/${id}/image`,

  corrParties: () => request('/api/corr/parties'),
  corrCreateParty: (body) => request('/api/corr/parties', { method: 'POST', body }),
  corrUpdateParty: (id, body) => request(`/api/corr/parties/${id}`, { method: 'PUT', body }),

  corrMe: () => request('/api/corr/me'),
  corrSaveMySignature: (body) => request('/api/corr/me/signature', { method: 'PUT', body }),
  corrDeleteMySignature: () => request('/api/corr/me/signature', { method: 'DELETE' }),

  corrStamps: () => request('/api/corr/stamps'),
  corrSaveStamp: (body) => request('/api/corr/stamps', { method: 'POST', body }),
  corrDeleteStamp: (id) => request(`/api/corr/stamps/${id}`, { method: 'DELETE' }),

  // -------------------------------------------------------- people and data --
  users: () => request('/api/users'),
  createUser: (body) => request('/api/users', { method: 'POST', body }),
  updateUser: (id, body) => request(`/api/users/${id}`, { method: 'PUT', body }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),

  pushKey: () => request('/api/push/key'),
  pushStatus: (endpoint) => request(`/api/push/status${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`),
  pushSubscribe: (body) => request('/api/push/subscribe', { method: 'POST', body }),
  pushUnsubscribe: (body) => request('/api/push/unsubscribe', { method: 'POST', body }),
  pushTest: (body) => request('/api/push/test', { method: 'POST', body }),
  removePushDevice: (id) => request(`/api/push/devices/${id}`, { method: 'DELETE' }),

  notifications: () => request('/api/notifications'),
  updateNotifications: (body) => request('/api/notifications', { method: 'PUT', body }),
  testNotification: () => request('/api/notifications/test', { method: 'POST' }),
  testText: (to) => request('/api/notifications/test-text', { method: 'POST', body: { to } }),

  notices: (limit = 20) => request(`/api/notices?limit=${limit}`),
  markNoticesSeen: (lastId) => request('/api/notices/seen', { method: 'POST', body: { lastId } }),

  dataSummary: (from, to) => request(`/api/data/summary?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  eraseData: (body) => request('/api/data/erase', { method: 'POST', body }),
  audit: (limit = 100) => request(`/api/audit?limit=${limit}`),
};
