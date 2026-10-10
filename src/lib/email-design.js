/**
 * How every HIVE email looks.
 *
 * One design, made of the same few blocks, so a staff email about a shift and
 * a manager's email about a till read as one family: a HIVE header band, a
 * status label in words and colour, a sentence for a headline, when it is, the
 * facts in a table with amounts lined up on the right, an optional callout or
 * quote, one gold button that says where it goes, and a footer that says why
 * this person got it.
 *
 * WHAT A NOTICE PASSES. `mail` on the notice, all optional:
 *
 *   status, tone        the label at the top: "Approved", "Needs your answer";
 *                       tone is good | warn | bad | info | neutral
 *   subject, preheader  the inbox line; default to the notice title and body
 *   eyebrow             small grey words beside the label: "Till", "Leave"
 *   headline, sub       a sentence, and when it is, in words
 *   intro, note         plain paragraphs; a newline is a line break
 *   code                a one-time code, set large
 *   facts               [[label, value, { tone, strong, big }]]
 *   schedule            { title, rows: [[day, time, what, { tone, text }]] }
 *   table               { title, head: [...], right, rows: [[cell | { text, tone }]] }
 *   callout             { tone, text }
 *   quote               { by, text }
 *   button              the button's words; it goes to the notice's link
 *   why                 the first line of the footer
 *
 * A notice with no `mail` still comes out in this design, built from its title
 * and body, so nothing that has not been given its own layout yet looks worse
 * than it did.
 *
 * Everything is escaped. A note somebody typed is shown as words, never as
 * markup, whoever typed it.
 *
 * WHY TABLES AND INLINE STYLES. Mail clients strip stylesheets and half of them
 * ignore flexbox. The one <style> block is for dark mode in the clients that
 * honour it (Apple Mail, Outlook on the web); every colour is inline first, in
 * mid tones that survive Gmail's own darkening.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const C = {
  bg: '#eef0f3', card: '#ffffff', ink: '#15191f', dim: '#5a6371', faint: '#8a93a0',
  rule: '#e4e7eb', soft: '#f6f7f9', band: '#0d1117', bandText: '#f2f4f7', bandDim: '#9aa3ae',
  gold: '#f2a93b', goldText: '#0d1117', link: '#1f5fd0',
};

/** [text colour, background] for each tone, light. Dark versions are in the style block. */
const TONE = {
  good: ['#0f7048', '#e3f4ec'],
  warn: ['#8f5200', '#fcefd9'],
  bad: ['#b02436', '#fce9ec'],
  info: ['#1f5fd0', '#e7eeff'],
  neutral: ['#4a535e', '#eef0f3'],
};

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPE[c]);
const lines = (value) => esc(value).replace(/\r?\n/g, '<br>');
const toneOf = (t) => (TONE[t] ? t : 'neutral');

/** The label a notice gets when nobody has chosen one, from how urgent it is. */
const LEVEL_LOOK = {
  good: ['good', 'Done'],
  info: ['info', 'Update'],
  warn: ['warn', 'Heads-up'],
  high: ['bad', 'Urgent'],
};

/** A whole notice, as it should arrive. */
export function renderMail({ notice, propertyName, companyName = null, siteUrl = null }) {
  const given = notice.mail && typeof notice.mail === 'object' ? notice.mail : {};
  const [fallbackTone, fallbackStatus] = LEVEL_LOOK[notice.level] ?? LEVEL_LOOK.info;
  const mail = {
    tone: fallbackTone,
    status: fallbackStatus,
    headline: notice.title,
    intro: notice.mail ? null : notice.body,
    button: notice.link ? 'Open in HIVE' : null,
    ...given,
  };

  const site = siteUrl ? String(siteUrl).replace(/\/$/, '') : null;
  const link = notice.link ? String(notice.link) : null;
  const href = link && /^https?:\/\//i.test(link) ? link
    : (link && site ? `${site}/${link.replace(/^\/*/, '')}` : null);
  // The invitation and a signing code go to people who cannot change any setting.
  const settingsHref = site && given.settingsLink !== false ? `${site}/#/notifications` : null;

  const subject = clip(mail.subject || notice.title, 200);
  const preheader = clip(mail.preheader || notice.body || mail.sub || notice.title, 200);

  return {
    subject,
    html: mailDocument({
      title: subject,
      preheader,
      body: mailBody({ mail, href, settingsHref, site, propertyName, companyName }),
    }),
  };
}

function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The page around it. Light by default, with a dark version for clients that ask. */
export function mailDocument({ title, preheader, body }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .m-bg { background:#0b0e12 !important; }
  .m-card { background:#161b22 !important; }
  .m-ink { color:#e8ecf1 !important; }
  .m-dim { color:#a3adba !important; }
  .m-faint { color:#8a93a0 !important; }
  .m-rule { border-color:#29313b !important; }
  .m-soft { background:#1d232b !important; }
  .t-good { color:#56c995 !important; } .tb-good { background:#10261c !important; }
  .t-warn { color:#f0b04a !important; } .tb-warn { background:#2b2113 !important; }
  .t-bad { color:#ff8292 !important; } .tb-bad { background:#2e151a !important; }
  .t-info { color:#86abff !important; } .tb-info { background:#17223b !important; }
  .t-neutral { color:#b3bcc7 !important; } .tb-neutral { background:#1d232b !important; }
}
@media (max-width: 480px) { .m-pad { padding-left:16px !important; padding-right:16px !important; } }
</style>
</head>
<body class="m-bg" style="margin:0;padding:0;background:${C.bg};color:${C.ink}">
${preheader ? `<div data-preheader style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preheader)}</div>` : ''}
${body}
</body></html>`;
}

function chip(tone, text, size = 11) {
  const t = toneOf(tone);
  return `<span class="t-${t} tb-${t}" style="display:inline-block;background:${TONE[t][1]};color:${TONE[t][0]};`
    + `font:700 ${size}px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;padding:6px 9px;`
    + `border-radius:999px;white-space:nowrap">${esc(text)}</span>`;
}

function label(text, top = 18) {
  return `<p class="m-faint" style="margin:${top}px 0 6px;font:700 12px/1 ${FONT};color:${C.faint};`
    + `letter-spacing:.08em;text-transform:uppercase">${esc(text)}</p>`;
}

function mailBody({ mail, href, settingsHref, site, propertyName, companyName }) {
  const out = [];

  const mark = site
    ? `<img src="${esc(site)}/icons/hive-192.png" width="22" height="22" alt="" style="display:block;border:0;border-radius:4px">`
    : '';
  out.push(`<div style="background:${C.band};padding:14px 22px;border-radius:14px 14px 0 0" class="m-pad">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
${mark ? `<td style="width:22px;vertical-align:middle">${mark}</td>` : ''}
<td style="vertical-align:middle;padding-left:${mark ? 8 : 0}px;font:700 14px/1 ${FONT};color:${C.bandText};letter-spacing:.06em">HIVE</td>
<td style="vertical-align:middle;text-align:right;font:500 12px/1.3 ${FONT};color:${C.bandDim}">${esc(propertyName)}</td>
</tr></table></div>`);

  const body = [];
  body.push(`<div>${chip(mail.tone, mail.status)}${mail.eyebrow
    ? `<span class="m-faint" style="padding-left:10px;font:500 12px/1.3 ${FONT};color:${C.faint}">${esc(mail.eyebrow)}</span>`
    : ''}</div>`);
  body.push(`<h1 class="m-ink" style="margin:14px 0 0;font:650 21px/1.3 ${FONT};color:${C.ink};letter-spacing:-.01em">${esc(mail.headline)}</h1>`);
  if (mail.sub) body.push(`<p class="m-dim" style="margin:6px 0 0;font:500 14px/1.45 ${FONT};color:${C.dim}">${esc(mail.sub)}</p>`);
  if (mail.intro) body.push(`<p class="m-ink" style="margin:14px 0 0;font:15px/1.6 ${FONT};color:${C.ink}">${lines(mail.intro)}</p>`);
  if (mail.code) {
    body.push(`<p class="m-ink m-soft" style="margin:16px 0 0;background:${C.soft};border-radius:10px;padding:16px 0;`
      + `text-align:center;font:700 32px/1.2 ${MONO};letter-spacing:.18em;color:${C.ink}">${esc(mail.code)}</p>`);
  }

  if (Array.isArray(mail.facts) && mail.facts.length) body.push(factsTable(mail.facts));
  if (mail.schedule?.rows?.length) body.push(scheduleTable(mail.schedule));
  if (mail.table?.rows?.length) body.push(dataTable(mail.table));

  if (mail.callout?.text) {
    const t = toneOf(mail.callout.tone);
    body.push(`<div class="t-${t} tb-${t}" style="margin-top:16px;background:${TONE[t][1]};border-radius:10px;padding:12px 14px;`
      + `font:600 14px/1.5 ${FONT};color:${TONE[t][0]}">${lines(mail.callout.text)}</div>`);
  }
  if (mail.quote?.text) {
    body.push(`<div class="m-soft" style="margin-top:16px;background:${C.soft};border-radius:10px;padding:12px 14px">
${mail.quote.by ? `<div class="m-faint" style="font:700 11px/1 ${FONT};color:${C.faint};letter-spacing:.08em;text-transform:uppercase">${esc(mail.quote.by)}</div>` : ''}
<div class="m-ink" style="margin-top:${mail.quote.by ? 6 : 0}px;font:italic 15px/1.55 ${FONT};color:${C.ink}">“${lines(mail.quote.text)}”</div></div>`);
  }
  if (mail.note) body.push(`<p class="m-dim" style="margin:16px 0 0;font:14px/1.6 ${FONT};color:${C.dim}">${lines(mail.note)}</p>`);

  if (mail.button && href) {
    body.push(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:22px"><tr>
<td style="background:${C.gold};border-radius:10px;text-align:center">
<a href="${esc(href)}" style="display:block;padding:14px 18px;font:700 15px/1 ${FONT};color:${C.goldText};text-decoration:none">${esc(mail.button)}</a>
</td></tr></table>`);
  }

  out.push(`<div class="m-card m-pad" style="background:${C.card};padding:22px 22px 24px">${body.join('\n')}</div>`);

  const why = mail.why || 'You get this because it is addressed to you in HIVE.';
  const from = companyName && companyName !== propertyName ? `${propertyName} · ${companyName}` : propertyName;
  out.push(`<div class="m-card m-rule m-pad" style="background:${C.card};border-top:1px solid ${C.rule};padding:14px 22px 18px;border-radius:0 0 14px 14px">
<p class="m-faint" style="margin:0;font:12.5px/1.55 ${FONT};color:${C.faint}">${esc(why)}${settingsHref
    ? ` <a href="${esc(settingsHref)}" class="m-dim" style="color:${C.dim};font-weight:600;text-decoration:underline">Notification settings</a>`
    : ''}</p>
<p class="m-faint" style="margin:8px 0 0;font:12px/1.5 ${FONT};color:${C.faint}">Sent by HIVE for ${esc(from)}</p>
</div>`);

  return `<div class="m-bg" style="background:${C.bg};padding:20px 12px">
<div style="max-width:560px;margin:0 auto">${out.join('\n')}</div></div>`;
}

function factsTable(facts) {
  const rows = facts.filter((f) => Array.isArray(f) && f[1] != null && f[1] !== '').map(([name, value, opt = {}], i) => {
    const t = opt.tone ? toneOf(opt.tone) : null;
    const top = i ? `border-top:1px solid ${C.rule};` : '';
    return `<tr>
<td class="m-dim m-rule" style="${top}padding:10px 0;font:14px/1.4 ${FONT};color:${C.dim};vertical-align:top">${esc(name)}</td>
<td class="${t ? `t-${t}` : 'm-ink'} m-rule" style="${top}padding:10px 0 10px 12px;font:${opt.strong ? 700 : 600} ${opt.big ? 17 : 14}px/1.4 ${FONT};color:${t ? TONE[t][0] : C.ink};text-align:right;font-variant-numeric:tabular-nums;vertical-align:top">${esc(value)}</td>
</tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="m-rule" style="margin-top:16px;border-top:1px solid ${C.rule};border-bottom:1px solid ${C.rule}">${rows}</table>`;
}

function scheduleTable(schedule) {
  const rows = schedule.rows.map(([day, time, what, tag], i) => {
    const top = i ? `border-top:1px solid ${C.rule};` : '';
    const tagHtml = tag?.text ? ` ${chip(tag.tone, tag.text, 10)}` : '';
    return `<tr>
<td class="m-ink m-rule" style="${top}padding:10px 12px 10px 0;width:92px;font:650 13px/1.35 ${FONT};color:${C.ink};vertical-align:top">${esc(day)}</td>
<td class="m-ink m-rule" style="${top}padding:10px 0;font:14px/1.35 ${FONT};color:${C.ink};vertical-align:top">${esc(what)}${tagHtml}${time
      ? `<div class="m-dim" style="font:13px/1.35 ${FONT};color:${C.dim};font-variant-numeric:tabular-nums">${esc(time)}</div>`
      : ''}</td></tr>`;
  }).join('');
  return `${schedule.title ? label(schedule.title) : ''}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="m-soft" style="margin-top:${schedule.title ? 0 : 16}px;background:${C.soft};border-radius:10px"><tr><td style="padding:2px 14px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table></td></tr></table>`;
}

function dataTable(table) {
  const head = table.head ?? [];
  const last = (i, n) => table.right && i === n - 1;
  const th = head.map((h, i) => `<th class="m-faint m-rule" style="text-align:${last(i, head.length) ? 'right' : 'left'};padding:8px 8px 8px 0;font:700 11px/1.2 ${FONT};color:${C.faint};letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid ${C.rule}">${esc(h)}</th>`).join('');
  const rows = table.rows.map((r) => `<tr>${r.map((c, i) => {
    const cell = c && typeof c === 'object' ? c : { text: c };
    const t = cell.tone ? toneOf(cell.tone) : null;
    const cls = t ? `t-${t}` : (i ? 'm-dim' : 'm-ink');
    const colour = t ? TONE[t][0] : (i ? C.dim : C.ink);
    return `<td class="${cls} m-rule" style="padding:9px 8px 9px 0;border-bottom:1px solid ${C.rule};font:${i && !cell.strong ? 400 : 600} 13px/1.35 ${FONT};color:${colour};text-align:${last(i, r.length) ? 'right' : 'left'};font-variant-numeric:tabular-nums;vertical-align:top">${esc(cell.text)}</td>`;
  }).join('')}</tr>`).join('');
  return `${table.title ? label(table.title) : ''}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:${table.title ? 0 : 16}px;border-collapse:collapse">${th ? `<thead><tr>${th}</tr></thead>` : ''}<tbody>${rows}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Words for dates, times and money, shared by everything that fills a mail
// ---------------------------------------------------------------------------

/** "Saturday 10 October". */
export function sayDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(day ?? ''))) return String(day ?? '');
  return new Date(`${String(day).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

/** "Sat 10 Oct". */
export function sayShortDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(day ?? ''))) return String(day ?? '');
  return new Date(`${String(day).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

/** "Saturday 10 to Friday 16 October", or across months "Fri 30 Oct to Mon 2 Nov". */
export function sayRange(from, to) {
  if (!to || from === to) return sayDate(from);
  const a = String(from).slice(0, 10);
  const b = String(to).slice(0, 10);
  if (a.slice(0, 7) === b.slice(0, 7)) {
    const first = new Date(`${a}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', timeZone: 'UTC' });
    return `${first} to ${sayDate(b)}`;
  }
  return `${sayShortDate(a)} to ${sayShortDate(b)}`;
}

/** "6:00 am" from "06:00"; anything that is not a clock time comes back as it was. */
export function sayTime(clock) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(clock ?? ''));
  if (!m) return String(clock ?? '');
  const h = Number(m[1]);
  const suffix = h < 12 || h === 24 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:${m[2]} ${suffix}`;
}

/** "6 am to 2 pm", dropping ":00" where it says nothing. */
export function sayHours(start, end) {
  const short = (t) => sayTime(t).replace(':00 ', ' ');
  if (!start) return '';
  return end ? `${short(start)} to ${short(end)}` : short(start);
}

/** "October 2026" from "2026-10". */
export function sayMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month ?? ''))) return String(month ?? '');
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The first name, for a sentence. */
export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || String(name ?? '');
