/**
 * The expense form → Insight.
 *
 * Paste this whole file into the expense form's own script editor (open the
 * Google Form → ⋮ → Apps Script), then follow bi/docs/advances.md.
 *
 * Each response is sent to Insight the moment it is submitted: the PO number,
 * the amount, the TnT, who sent it and when. Nothing else. Each is signed with
 * the form's secret, so Insight takes it from this script and nobody else.
 */

/** The three questions, exactly as their titles read on the form (case does not matter). */
const QUESTIONS = {
  po: 'PO number',
  amount: 'Amount',
  tnt: 'TnT',
  // Optional: a question asking for the person's name. Leave '' to use the
  // email address the form collects, if it collects one.
  by: '',
};

/** Run once: sends every new response from now on. */
function setUp() {
  const form = FormApp.getActiveForm();
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'onSubmit') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('onSubmit').forForm(form).onFormSubmit().create();
  check_();
}

/** Run once after setUp: sends every response already on the form. Safe to run again. */
function sendAllPast() {
  const all = FormApp.getActiveForm().getResponses().map(toRecord_);
  for (let i = 0; i < all.length; i += 200) send_(all.slice(i, i + 200));
  Logger.log(`Sent ${all.length} responses.`);
}

function onSubmit(e) {
  send_([toRecord_(e.response)]);
}

function toRecord_(response) {
  const byTitle = {};
  for (const r of response.getItemResponses()) byTitle[r.getItem().getTitle().trim().toLowerCase()] = r.getResponse();
  const pick = (title) => {
    if (!title) return '';
    const v = byTitle[String(title).trim().toLowerCase()];
    return v == null ? '' : String(v);
  };
  return {
    responseId: response.getId(),
    po: pick(QUESTIONS.po),
    amount: pick(QUESTIONS.amount),
    tnt: pick(QUESTIONS.tnt),
    by: pick(QUESTIONS.by) || response.getRespondentEmail() || '',
    submittedAt: Utilities.formatDate(response.getTimestamp(), 'UTC', 'yyyy-MM-dd HH:mm'),
  };
}

function check_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('INSIGHT_URL') || !props.getProperty('FORM_SECRET')) {
    throw new Error('Set INSIGHT_URL and FORM_SECRET under Project Settings → Script properties first.');
  }
  const titles = FormApp.getActiveForm().getItems().map((i) => i.getTitle().trim().toLowerCase());
  for (const key of ['po', 'amount', 'tnt']) {
    if (!titles.includes(QUESTIONS[key].trim().toLowerCase())) {
      throw new Error(`The form has no question called "${QUESTIONS[key]}". Change QUESTIONS at the top to match.`);
    }
  }
}

function send_(responses) {
  const props = PropertiesService.getScriptProperties();
  const url = `${String(props.getProperty('INSIGHT_URL')).replace(/\/+$/, '')}/api/link/expense-form`;
  const body = JSON.stringify({ responses });
  const at = String(Date.now());
  const raw = Utilities.computeHmacSha256Signature(`expense-form\n${at}\n${body}`, props.getProperty('FORM_SECRET'), Utilities.Charset.UTF_8);
  const sig = raw.map((b) => (`0${(b & 0xff).toString(16)}`).slice(-2)).join('');
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: body,
    headers: { 'X-Form-At': at, 'X-Form-Sig': sig },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error(`Insight answered ${res.getResponseCode()}: ${res.getContentText()}`);
}
