import { badRequest, int, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { firstName } from '../lib/email-design.js';
import { DEFAULT_FAQ, LINK_PATHS, LINKS, TOPICS, TOPIC_KEYS } from '../lib/hr-faq-content.js';

/**
 * The HR FAQ.
 *
 * Everybody signed in reads the published questions. Whoever holds HR writes
 * them, and sees the drafts and the questions people have asked that nothing
 * here answers yet.
 *
 * TWO BODIES, LIKE A HANDBOOK CHAPTER. `answer` is what HR is working on;
 * `live_answer` is what staff read. Editing changes nothing on the screen
 * until Publish. A half-rewritten answer about sick days in front of
 * twenty-four people is worse than the old one.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const can = (ctx, permission) => (ctx.session?.permissions ?? []).includes(permission)
  || ctx.session?.user?.role === 'admin';

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

/** The staff record behind this login, or null. An admin may have none. */
async function meOf(ctx) {
  const staffId = Number(ctx.session?.user?.staff_id) || 0;
  if (!staffId) return null;
  return ctx.db.prepare('SELECT id, name, department FROM att_staff WHERE id = ?')
    .bind(staffId).first().catch(() => null);
}

const parseLinks = (raw) => {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list)
      ? list.filter((l) => l && LINK_PATHS.includes(l.path)).map((l) => ({
        label: String(l.label ?? '').slice(0, 60) || LINKS.find((k) => k.path === l.path)?.label,
        path: l.path,
      }))
      : [];
  } catch {
    return [];
  }
};

/** Links as they arrive from the screen, checked against the list the app has. */
function readLinks(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > 4) throw badRequest('Four links is the most an answer needs.');
  return JSON.stringify(list.map((l, i) => {
    const path = str(l?.path, `Link ${i + 1}`, { required: true, max: 40 });
    if (!LINK_PATHS.includes(path)) throw badRequest('An answer can only link to a screen in HIVE.');
    const label = str(l?.label, `Link ${i + 1} label`, { max: 60 })
      || LINKS.find((k) => k.path === path).label;
    return { label, path };
  }));
}

/** What a reader is handed: the published words, never the draft. */
const asRead = (row) => ({
  id: row.id,
  code: row.code,
  topic: row.topic,
  question: row.live_question || row.question,
  answer: row.live_answer || '',
  links: parseLinks(row.live_links),
  updatedAt: row.published_at,
});

/** And what the editor sees: both, and where they differ. */
const asEdit = (row) => ({
  id: row.id,
  code: row.code,
  topic: row.topic,
  question: row.question,
  answer: row.answer,
  links: parseLinks(row.links),
  order: row.sort_order,
  status: row.status,
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  // Something has changed since it was last published, so Publish would do
  // something. The question, the answer or the links; the order is not read.
  changed: row.status === 'published' && (
    row.question !== row.live_question || row.answer !== row.live_answer
    || (row.links || '[]') !== (row.live_links || '[]')),
});

const all = async (db) => (await db.prepare(
  'SELECT * FROM hr_faq ORDER BY sort_order, id',
).all().catch(() => ({ results: [] }))).results ?? [];

async function one(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM hr_faq WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('No such question.');
  return row;
}

// ---------------------------------------------------------------------------

/** Everybody's FAQ, and for HR the drafts and the open questions as well. */
export async function readFaq(ctx) {
  const rows = await all(ctx.db);
  const staff = await meOf(ctx);
  const mayEdit = can(ctx, 'hr_manage');

  const mine = staff
    ? (await ctx.db.prepare(
      'SELECT * FROM hr_faq_question WHERE staff_id = ? ORDER BY id DESC LIMIT 10',
    ).bind(staff.id).all().catch(() => ({ results: [] }))).results ?? []
    : [];

  let manage = null;
  if (mayEdit) {
    const open = (await ctx.db.prepare(
      `SELECT q.*, s.name AS staff_name, s.department
         FROM hr_faq_question q JOIN att_staff s ON s.id = q.staff_id
        WHERE q.status = 'open' ORDER BY q.id`,
    ).all().catch(() => ({ results: [] }))).results ?? [];
    manage = {
      entries: rows.map(asEdit),
      open: open.map((o) => ({
        id: o.id, staffId: o.staff_id, name: o.staff_name, department: o.department ?? null,
        question: o.question, askedAt: o.asked_at,
      })),
      available: DEFAULT_FAQ.filter((d) => !rows.some((r) => r.code === d.code))
        .map((d) => ({ code: d.code, question: d.question })),
    };
  }

  return json({
    topics: TOPICS,
    links: LINKS,
    me: staff ? { id: staff.id, name: staff.name } : null,
    entries: rows.filter((r) => r.status === 'published').map(asRead),
    asked: mine.map((m) => ({
      id: m.id, question: m.question, status: m.status, answer: m.answer, askedAt: m.asked_at,
      answeredAt: m.answered_at,
    })),
    manage,
  });
}

/** Save a draft: a new question, or changes to one. Nothing staff see moves. */
export async function saveEntry(ctx) {
  const body = await readJson(ctx.request);
  const id = Number(body.id) || 0;

  const topic = str(body.topic, 'Topic', { required: true, max: 20 });
  if (!TOPIC_KEYS.includes(topic)) throw badRequest('That is not one of the topics.');
  const question = str(body.question, 'Question', { required: true, max: 200 });
  const answer = str(body.answer, 'Answer', { max: 6000, fallback: '' }) ?? '';
  const links = readLinks(body.links);
  const order = int(body.order ?? 100, 'Order', { min: 0, max: 9999 });

  if (id) {
    const row = await one(ctx, id);
    await ctx.db.prepare(
      `UPDATE hr_faq
          SET topic = ?2, question = ?3, answer = ?4, links = ?5, sort_order = ?6,
              updated_by = ?7, updated_at = datetime('now')
        WHERE id = ?1`,
    ).bind(row.id, topic, question, answer, links, order, actorOf(ctx)).run();
    await audit(ctx, 'hr_faq.saved', row.id, { code: row.code });
    return json({ ok: true, id: row.id });
  }

  const code = `q_${Date.now().toString(36)}`;
  const made = await ctx.db.prepare(
    `INSERT INTO hr_faq (code, topic, question, answer, links, sort_order, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
  ).bind(code, topic, question, answer, links, order, actorOf(ctx)).first();
  await audit(ctx, 'hr_faq.created', made?.id, { code });
  return json({ ok: true, id: made?.id ?? null });
}

/** Put the draft in front of staff. */
export async function publishEntry(ctx, id) {
  const row = await one(ctx, id);
  if (!String(row.answer ?? '').trim()) throw badRequest('Write the answer before publishing it.');
  await ctx.db.prepare(
    `UPDATE hr_faq
        SET status = 'published', live_question = question, live_answer = answer,
            live_links = links, published_at = datetime('now'), published_by = ?2
      WHERE id = ?1`,
  ).bind(row.id, actorOf(ctx)).run();
  await audit(ctx, 'hr_faq.published', row.id, { code: row.code });
  return json({ ok: true, id: row.id });
}

/** Take it off the screen. The draft stays, so it can come back. */
export async function retireEntry(ctx, id) {
  const row = await one(ctx, id);
  await ctx.db.prepare(
    "UPDATE hr_faq SET status = 'retired', updated_by = ?2, updated_at = datetime('now') WHERE id = ?1",
  ).bind(row.id, actorOf(ctx)).run();
  await audit(ctx, 'hr_faq.retired', row.id, { code: row.code });
  return json({ ok: true, id: row.id });
}

/** Gone for good. Only something nobody is reading. */
export async function removeEntry(ctx, id) {
  const row = await one(ctx, id);
  if (row.status === 'published') throw badRequest('Retire it first, then remove it.');
  await ctx.db.prepare('DELETE FROM hr_faq WHERE id = ?').bind(row.id).run();
  await audit(ctx, 'hr_faq.removed', row.id, { code: row.code });
  return json({ ok: true });
}

/** Add whatever of the standard set is missing, as drafts. Never over an edit. */
export async function installStandard(ctx) {
  const rows = await all(ctx.db);
  const have = new Set(rows.map((r) => r.code));
  let added = 0;
  for (const [i, d] of DEFAULT_FAQ.entries()) {
    if (have.has(d.code)) continue;
    await ctx.db.prepare(
      `INSERT OR IGNORE INTO hr_faq (code, topic, question, answer, links, sort_order, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(d.code, d.topic, d.question, d.answer, JSON.stringify(d.links), (i + 1) * 10, actorOf(ctx)).run();
    added += 1;
  }
  await audit(ctx, 'hr_faq.installed', null, { added });
  return json({ ok: true, added });
}

/**
 * Tell staff the FAQ changed.
 *
 * On request rather than on every publish: HR fixing a typo in four answers
 * should not be four notifications. One short notice, naming what moved.
 */
export async function tellStaff(ctx) {
  const body = await readJson(ctx.request);
  const about = str(body.about, 'What changed', { max: 200 });
  const notice = await createNotice(ctx.db, {
    kind: 'hr_faq.changed',
    level: 'info',
    title: 'The HR FAQ has been updated',
    body: about || 'Open it to see what changed.',
    link: '#/hr-faq',
    actor: actorOf(ctx),
    // Everybody with a login. The FAQ is for the people on the floor, and
    // whoever manages them reads it too.
    audience: null,
    report: true,
    mail: {
      status: 'Updated',
      tone: 'info',
      eyebrow: 'HR FAQ',
      subject: 'The HR FAQ has been updated',
      preheader: about || 'Open it to see what changed.',
      headline: about ? 'There is something new in the HR FAQ' : 'The HR FAQ has been updated',
      quote: about ? { by: 'From HR', text: about } : null,
      intro: about ? null : 'Open it to see what changed.',
      button: 'Read the HR FAQ',
      why: 'You get this because HR told all staff about this change.',
    },
  }, ctx);
  await audit(ctx, 'hr_faq.told', null, { about });
  return json({ ok: true, told: notice?.buzzed ?? 0 });
}

// ---------------------------------------------------------------------------
// Asking

/** A question the FAQ did not answer, sent to whoever holds HR. */
export async function ask(ctx) {
  const staff = await meOf(ctx);
  if (!staff) throw badRequest('This login is not linked to a staff record, so HR would not know who asked.');
  const body = await readJson(ctx.request);
  const question = str(body.question, 'Your question', { required: true, max: 500 });

  // One open question at a time. The second one is almost always the first
  // one again, typed while waiting.
  const waiting = await ctx.db.prepare(
    "SELECT id FROM hr_faq_question WHERE staff_id = ? AND status = 'open'",
  ).bind(staff.id).first();
  if (waiting) throw badRequest('You already have a question waiting on HR. They will answer it soon.');

  const made = await ctx.db.prepare(
    'INSERT INTO hr_faq_question (staff_id, question) VALUES (?1, ?2) RETURNING id',
  ).bind(staff.id, question).first();

  await createNotice(ctx.db, {
    kind: 'hr_faq.asked',
    level: 'info',
    title: `${staff.name} has a question for HR`,
    body: question.slice(0, 200),
    link: '#/hr-faq',
    actor: staff.name,
    audience: 'hr_manage',
    mail: {
      status: 'Needs your answer',
      tone: 'warn',
      eyebrow: 'HR FAQ',
      subject: `${staff.name} has a question for HR`,
      preheader: question.slice(0, 200),
      headline: `${staff.name} has a question for HR`,
      sub: staff.department || null,
      quote: { by: `${firstName(staff.name)} asks`, text: question },
      button: `Answer ${firstName(staff.name)}`,
      why: 'You get this because you answer HR questions.',
    },
  }, ctx);
  await audit(ctx, 'hr_faq.asked', made?.id, { staffId: staff.id });
  return json({ ok: true, id: made?.id ?? null });
}

/**
 * HR answers. The person is told, and the answer can go straight into the
 * FAQ as a new draft so the next person finds it without asking.
 */
export async function answerQuestion(ctx, id) {
  const body = await readJson(ctx.request);
  const row = await ctx.db.prepare(
    'SELECT q.*, s.name AS staff_name FROM hr_faq_question q JOIN att_staff s ON s.id = q.staff_id WHERE q.id = ?',
  ).bind(Number(id)).first();
  if (!row) throw notFound('No such question.');
  if (row.status !== 'open') throw badRequest('That question has been answered.');

  const answer = str(body.answer, 'The answer', { required: true, max: 6000 });

  let faqId = null;
  if (body.addToFaq) {
    const topic = str(body.topic, 'Topic', { required: true, max: 20 });
    if (!TOPIC_KEYS.includes(topic)) throw badRequest('That is not one of the topics.');
    const question = str(body.question, 'Question', { max: 200 }) || row.question.slice(0, 200);
    const made = await ctx.db.prepare(
      `INSERT INTO hr_faq (code, topic, question, answer, links, sort_order, created_by)
       VALUES (?1, ?2, ?3, ?4, '[]', 900, ?5) RETURNING id`,
    ).bind(`q_${Date.now().toString(36)}`, topic, question, answer, actorOf(ctx)).first();
    faqId = made?.id ?? null;
  }

  await ctx.db.prepare(
    `UPDATE hr_faq_question
        SET status = 'answered', answer = ?2, faq_id = ?3, answered_by = ?4, answered_at = datetime('now')
      WHERE id = ?1`,
  ).bind(row.id, answer, faqId, actorOf(ctx)).run();

  const person = await ctx.db.prepare(
    'SELECT id FROM users WHERE staff_id = ? AND active = 1',
  ).bind(row.staff_id).first().catch(() => null);
  const asker = row.staff_name || 'Somebody';
  await createNotice(ctx.db, {
    kind: 'hr_faq.answered',
    level: 'info',
    title: 'HR has answered your question',
    body: answer.slice(0, 200),
    link: '#/hr-faq',
    actor: actorOf(ctx),
    userId: person?.id ?? null,
    audience: person ? null : 'hr_manage',
    // With no login to send it to, it goes to HR, who read it as about somebody.
    mail: {
      status: 'Answered',
      tone: 'good',
      eyebrow: 'HR FAQ',
      subject: person ? 'HR has answered your question' : `HR has answered ${asker}’s question`,
      preheader: answer.slice(0, 200),
      headline: person ? 'HR has answered your question' : `HR has answered ${asker}’s question`,
      quote: row.question
        ? { by: person ? 'You asked' : `${firstName(asker)} asked`, text: row.question }
        : null,
      note: `HR says: ${answer}`,
      button: person ? 'See it in HIVE' : 'See the questions',
      why: person
        ? 'You get this because you asked HR a question.'
        : `You get this because ${asker} has no login to tell, and you answer HR questions.`,
    },
  }, ctx);
  await audit(ctx, 'hr_faq.answered', row.id, { staffId: row.staff_id, faqId });
  return json({ ok: true, faqId });
}
