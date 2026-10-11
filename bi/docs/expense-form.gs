/**
 * The expense form → Insight.
 *
 * Paste this whole file into a new Apps Script project (script.google.com →
 * New project), set the script properties, then follow bi/docs/advances.md.
 * It also works pasted into the form's own script editor (⋮ → Apps Script).
 *
 * Each response is sent to Insight the moment it is submitted: the PO number,
 * the amount, the TnT and whether the invoice included it, who sent it and
 * when. Nothing else: not the receipt, not the notes. Each is signed with
 * the form's secret, so Insight takes it from this script and nobody else.
 *
 * Script properties (Project Settings → Script properties):
 *   INSIGHT_URL   Insight's address, e.g. https://insight.example.com
 *   FORM_SECRET   the same text as the GitHub secret INSIGHT_EXPENSE_FORM_SECRET
 *   FORM_ID       the form's id, from its address: docs.google.com/forms/d/<FORM_ID>/edit
 *                 (not needed when pasted into the form's own script editor)
 */

/** The questions, exactly as their titles read on the form (case and spaces at the ends do not matter). */
const QUESTIONS = {
  po: 'Enter the Purchase Order number',
  amount: 'Enter the GHS Value',
  tnt: 'How much was transportation?',
  // "Yes, included in the invoice" means the amount has the transport in it already.
  transport: 'Was there transportation?',
  by: 'Select Your Name',
};

/** sendAllPast sends the responses from this day on, and none before it. */
const SEND_FROM = '2026-10-01';

/** Run once: sends every new response from now on. */
function setUp() {
  const form = form_();
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'onSubmit') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('onSubmit').forForm(form).onFormSubmit().create();
  check_();
}

/** Run once after setUp: sends the responses from SEND_FROM on. Safe to run again. */
function sendAllPast() {
  const since = new Date(`${SEND_FROM}T00:00:00Z`);
  const all = form_().getResponses(since).map(toRecord_);
  for (let i = 0; i < all.length; i += 200) send_(all.slice(i, i + 200));
  Logger.log(`Sent ${all.length} responses.`);
}

/** The expense form: by its id, or the form this script is part of. */
function form_() {
  const raw = prop_('FORM_ID');
  if (raw) {
    // The code alone, or the whole address pasted: docs.google.com/forms/d/<code>/edit
    const id = (raw.match(/\/d\/(?:e\/)?([\w-]{20,})/) || [null, raw])[1].trim();
    return FormApp.openById(id);
  }
  const form = FormApp.getActiveForm();
  if (!form) {
    const names = Object.keys(PropertiesService.getScriptProperties().getProperties());
    throw new Error(`Set FORM_ID under Project Settings → Script properties: the long code in the form's address. `
      + `The properties set now are: ${names.length ? names.join(', ') : 'none'}.`);
  }
  return form;
}

/** A script property, forgiving of case and stray spaces in its name. */
function prop_(name) {
  const all = PropertiesService.getScriptProperties().getProperties();
  const key = Object.keys(all).find((k) => k.trim().toUpperCase() === name);
  return key ? String(all[key]).trim() : '';
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
    tntIncluded: /included/i.test(pick(QUESTIONS.transport)),
    by: pick(QUESTIONS.by),
    submittedAt: Utilities.formatDate(response.getTimestamp(), 'UTC', 'yyyy-MM-dd HH:mm'),
  };
}

function check_() {
  if (!prop_('INSIGHT_URL') || !prop_('FORM_SECRET')) {
    throw new Error('Set INSIGHT_URL and FORM_SECRET under Project Settings → Script properties first.');
  }
  const titles = form_().getItems().map((i) => i.getTitle().trim().toLowerCase());
  for (const key of ['po', 'amount', 'tnt', 'transport', 'by']) {
    if (!titles.includes(QUESTIONS[key].trim().toLowerCase())) {
      throw new Error(`The form has no question called "${QUESTIONS[key]}". Change QUESTIONS at the top to match.`);
    }
  }
}

function send_(responses) {
  const url = `${prop_('INSIGHT_URL').replace(/\/+$/, '')}/api/link/expense-form`;
  const body = JSON.stringify({ responses });
  const at = String(Date.now());
  const raw = Utilities.computeHmacSha256Signature(`expense-form\n${at}\n${body}`, prop_('FORM_SECRET'), Utilities.Charset.UTF_8);
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
