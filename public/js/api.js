// Thin fetch wrapper. Every call goes through here so an expired session and a
// dropped connection are handled in exactly one place rather than in thirty.

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

async function request(path, { method = 'GET', body, signal } = {}) {
  if (pathHasHole(path)) {
    throw new ApiError(0, `Something is missing from this request (${path}). Reload and try again.`);
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'No connection to the server. Check the signal and try again.');
  }

  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Your session has expired. Sign in again.');
  }

  const type = response.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) {
    if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`);
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
  attUndoReview: (body) => request('/api/att/review/undo', { method: 'POST', body }),
  attOutstanding: (params = {}) => request(`/api/att/outstanding?${new URLSearchParams(params)}`),
  attSignDays: (body) => request('/api/att/sign-days', { method: 'POST', body }),
  attReopenDays: (body) => request('/api/att/sign-days/undo', { method: 'POST', body }),
  attQueries: (status) => request(`/api/att/queries${status ? `?status=${status}` : ''}`),
  attRaiseQuery: (body) => request('/api/att/queries', { method: 'POST', body }),
  attAnswerQuery: (id, body) => request(`/api/att/queries/${id}/answer`, { method: 'POST', body }),
  attWithdrawQuery: (id) => request(`/api/att/queries/${id}/withdraw`, { method: 'POST' }),

  attBalances: (asOf) => request(`/api/att/balances${asOf ? `?asOf=${asOf}` : ''}`),
  attExportUrl: (from, to) => `/api/att/export?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`,

  attResolve: (day, body) => request(`/api/att/days/${day}/resolve`, { method: 'POST', body }),
  attUnresolve: (day, body) => request(`/api/att/days/${day}/unresolve`, { method: 'POST', body }),
  attAddPunch: (body) => request('/api/att/punches', { method: 'POST', body }),
  attCorrectTimes: (day, body) => request(`/api/att/days/${day}/times`, { method: 'POST', body }),
  attTimeEdits: (params = {}) => request(`/api/att/time-edits?${new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
  )}`),

  attRoster: (from, to) => request(`/api/att/roster?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  attSaveRoster: (body) => request('/api/att/roster', { method: 'POST', body }),
  attCopyRoster: (body) => request('/api/att/roster/copy', { method: 'POST', body }),
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
  attCancelLeave: (id) => request(`/api/att/leave/${id}`, { method: 'DELETE' }),

  attStaff: () => request('/api/att/staff'),
  attCreateStaff: (body) => request('/api/att/staff', { method: 'POST', body }),
  attUpdateStaff: (id, body) => request(`/api/att/staff/${id}`, { method: 'PUT', body }),
  attDeleteStaff: (id) => request(`/api/att/staff/${id}`, { method: 'DELETE' }),
  attUnknown: () => request('/api/att/unknown'),

  attShifts: () => request('/api/att/shifts'),
  attShiftSuggestions: (days) => request(`/api/att/shift-suggestions${days ? `?days=${days}` : ''}`),
  attImportShifts: (shifts) => request('/api/att/shifts/import', { method: 'POST', body: { shifts } }),
  attCreateShift: (body) => request('/api/att/shifts', { method: 'POST', body }),
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

  notices: (limit = 20) => request(`/api/notices?limit=${limit}`),
  markNoticesSeen: (lastId) => request('/api/notices/seen', { method: 'POST', body: { lastId } }),

  dataSummary: (from, to) => request(`/api/data/summary?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  eraseData: (body) => request('/api/data/erase', { method: 'POST', body }),
  audit: (limit = 100) => request(`/api/audit?limit=${limit}`),
};
