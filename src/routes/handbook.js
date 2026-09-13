import { sha256Hex } from '../lib/files.js';
import {
  badRequest, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { DEFAULT_CHAPTERS } from '../lib/handbook-content.js';
import {
  ASKS, ASK_MAP, asksOf, hasDone, isFor, liveAsksOf, needsDoing, outstandingFor,
  whoIsOutstanding, wouldBeANewVersion,
} from '../lib/handbook.js';
import { parseList } from '../lib/attendance.js';

/**
 * The staff handbook.
 *
 * TWO BODIES PER CHAPTER, AND THAT IS THE WHOLE DESIGN. `body` is what an
 * administrator is working on; `live_body` is what the property is reading.
 * Editing does nothing to the second, and Publish is the one moment they meet.
 * A half-written disciplinary procedure in front of twenty-four people is
 * worse than no disciplinary procedure at all.
 *
 * And an acknowledgement is against a version and a hash of the exact words.
 * "She acknowledged the handbook" is not an answer to anything when the
 * handbook has been rewritten since, so a chapter republished with different
 * words moves to the next version and everybody is asked again.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const ipOf = (ctx) => ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
const agentOf = (ctx) => (ctx.request.headers.get('User-Agent') || '').slice(0, 200);

const can = (ctx, permission) => (ctx.session?.permissions ?? []).includes(permission)
  || ctx.session?.user?.role === 'admin';

async function isOn(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'handbook_on'")
    .first().catch(() => null);
  return String(row?.value ?? '0') === '1';
}

/** The staff record behind this login, or null. An admin may have none. */
async function meOf(ctx) {
  const staffId = Number(ctx.session?.user?.staff_id) || 0;
  if (!staffId) return null;
  return ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first()
    .catch(() => null);
}

const chapters = async (db) => (await db.prepare(
  'SELECT * FROM hb_chapter ORDER BY sort_order, id',
).all().catch(() => ({ results: [] }))).results ?? [];

const acksFor = async (db, staffId) => (await db.prepare(
  'SELECT * FROM hb_ack WHERE staff_id = ?',
).bind(staffId).all().catch(() => ({ results: [] }))).results ?? [];

/** What a reader is handed: the published words, never the draft. */
function asRead(chapter, { done = false } = {}) {
  return {
    id: chapter.id,
    code: chapter.code,
    title: chapter.live_title || chapter.title,
    summary: chapter.summary ?? null,
    body: chapter.live_body ?? '',
    version: chapter.version,
    asks: liveAsksOf(chapter),
    publishedAt: chapter.published_at ?? null,
    needs: needsDoing(chapter),
    done,
  };
}

/** And what an editor is handed: both, and who it is for. */
function asEdit(chapter, counts = null) {
  return {
    id: chapter.id,
    code: chapter.code,
    title: chapter.title,
    summary: chapter.summary ?? null,
    body: chapter.body ?? '',
    asks: asksOf(chapter),
    departments: parseList(chapter.departments),
    tags: parseList(chapter.tags),
    order: chapter.sort_order,
    status: chapter.status,
    version: chapter.version,
    liveTitle: chapter.live_title ?? null,
    liveAsks: chapter.live_asks ?? null,
    publishedAt: chapter.published_at ?? null,
    publishedBy: chapter.published_by ?? null,
    changed: chapter.status === 'published' && wouldBeANewVersion(chapter),
    updatedAt: chapter.updated_at ?? null,
    updatedBy: chapter.updated_by ?? null,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/**
 * The handbook, as whoever is signed in may read it.
 *
 * One screen for everybody, with the editing on top for the people who hold
 * it. Two screens would be two things to keep in step, and the second one
 * always falls behind.
 */
export async function readHandbook(ctx) {
  const on = await isOn(ctx.db);
  const staff = await meOf(ctx);
  const mayEdit = can(ctx, 'hr_manage');
  const mayCount = mayEdit || can(ctx, 'hr_view');

  // Off means off for the people it would be shown to. Whoever writes it still
  // needs to see it, or there is no way to get it ready.
  if (!on && !mayCount) {
    return json({ on: false, me: null, chapters: [], outstanding: [], manage: null });
  }

  const all = await chapters(ctx.db);
  const mine = staff ? await acksFor(ctx.db, staff.id) : [];

  // What is theirs to read. Somebody with no staff record behind their login
  // has nothing personally outstanding, and still gets to read the thing.
  const forMe = all
    .filter((c) => c.status === 'published')
    .filter((c) => !staff || isFor(c, staff));

  const outstanding = staff ? outstandingFor(all, staff, mine) : [];

  let manage = null;
  if (mayCount) {
    const people = (await ctx.db.prepare('SELECT * FROM att_staff WHERE active = 1')
      .all().catch(() => ({ results: [] }))).results ?? [];
    const everyAck = (await ctx.db.prepare('SELECT chapter_id, staff_id, version FROM hb_ack')
      .all().catch(() => ({ results: [] }))).results ?? [];

    manage = {
      mayEdit,
      chapters: all.map((c) => asEdit(c, needsDoing(c)
        ? whoIsOutstanding(c, people, everyAck)
        : null)).map((c) => ({
        ...c,
        counts: c.counts
          ? { of: c.counts.of, done: c.counts.done, waiting: c.counts.waiting.length }
          : null,
      })),
      // What the standard set would add, so the button can say how many.
      available: DEFAULT_CHAPTERS
        .filter((d) => !all.some((c) => c.code === d.code))
        .map((d) => ({ code: d.code, title: d.title })),
      asks: ASKS,
    };
  }

  return json({
    on,
    me: staff ? { id: staff.id, name: staff.name } : null,
    chapters: forMe.map((c) => asRead(c, { done: hasDone(c, mine) })),
    outstanding: outstanding.map((c) => ({ id: c.id, title: c.live_title || c.title })),
    manage,
  });
}

/**
 * A tick, or a signature.
 *
 * Recorded against the version and the hash of the words that were on the
 * screen. If the chapter has moved on since the page was opened, the answer is
 * no: they would be ticking something they have not read.
 */
export async function acknowledge(ctx, id) {
  if (!await isOn(ctx.db)) throw forbidden('The handbook is not published yet.');

  const staff = await meOf(ctx);
  if (!staff) {
    throw forbidden('This login is not linked to a staff record, so there is nothing to sign.');
  }

  const chapter = await one(ctx, id);
  if (chapter.status !== 'published') throw badRequest('That chapter is not published.');
  if (!isFor(chapter, staff)) throw forbidden('That chapter is not one of yours.');

  const asks = liveAsksOf(chapter);
  if (asks === 'read') throw badRequest('That chapter does not ask for anything.');

  const body = await readJson(ctx.request);

  // The version the browser was showing. A chapter republished while somebody
  // had it open is the one case this has to refuse.
  const seen = Number(body.version);
  if (Number.isFinite(seen) && seen !== Number(chapter.version)) {
    throw badRequest('This chapter has changed since you opened it. Read it again and then sign.');
  }

  let name = null;
  let ink = null;
  if (asks === 'sign') {
    name = str(body.name, 'Your name', { required: true, max: 120 });
    if (name.trim().length < 3) throw badRequest('Type your full name.');
    ink = typeof body.ink === 'string' && body.ink.startsWith('data:image/')
      ? body.ink.slice(0, 200_000)
      : null;
  }

  await ctx.db.prepare(
    `INSERT INTO hb_ack
       (chapter_id, staff_id, version, hash, asked, signer_name, signature_ink,
        signer_ip, signer_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (chapter_id, staff_id, version) DO NOTHING`,
  ).bind(
    chapter.id, staff.id, chapter.version, chapter.live_hash, asks,
    name, ink, ipOf(ctx), agentOf(ctx),
  ).run();

  await audit(ctx, 'handbook.acknowledged', chapter.id, {
    code: chapter.code, version: chapter.version, asked: asks,
  });

  return json({ ok: true, asked: asks });
}

// ---------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------

/** Make one, or change one. Nothing here reaches a member of staff. */
export async function saveChapter(ctx) {
  const body = await readJson(ctx.request);
  const id = Number(body.id) || 0;

  const title = str(body.title, 'Title', { required: true, max: 160 });
  const text = str(body.body, 'The chapter', { max: 60_000, fallback: '' }) ?? '';
  const summary = str(body.summary, 'Summary', { max: 300 });
  const asks = ASK_MAP.has(body.asks) ? body.asks : 'read';
  const order = int(body.order ?? 100, 'Order', { min: 0, max: 9999 });
  const departments = list(body.departments);
  const tags = list(body.tags);

  if (id) {
    const chapter = await one(ctx, id);
    await ctx.db.prepare(
      `UPDATE hb_chapter
          SET title = ?2, summary = ?3, body = ?4, asks = ?5, sort_order = ?6,
              departments = ?7, tags = ?8, updated_by = ?9, updated_at = datetime('now')
        WHERE id = ?1`,
    ).bind(
      chapter.id, title, summary, text, asks, order,
      departments, tags, actorOf(ctx),
    ).run();
    await audit(ctx, 'handbook.saved', chapter.id, { code: chapter.code });
    return json({ ok: true, id: chapter.id });
  }

  const code = (str(body.code, 'Code', { max: 40 }) || slug(title)) || `chapter_${Date.now()}`;
  const clash = await ctx.db.prepare('SELECT id FROM hb_chapter WHERE code = ?').bind(code).first();
  if (clash) throw badRequest('There is already a chapter with that code.');

  const made = await ctx.db.prepare(
    `INSERT INTO hb_chapter
       (code, title, summary, body, asks, sort_order, departments, tags, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
     RETURNING id`,
  ).bind(code, title, summary, text, asks, order, departments, tags, actorOf(ctx)).first();

  await audit(ctx, 'handbook.created', made?.id, { code });
  return json({ ok: true, id: made?.id ?? null });
}

/**
 * Put it in front of the property.
 *
 * The words are copied and hashed here, and that copy is what everybody reads
 * and what every acknowledgement points at. A wording change moves the version
 * on and asks everybody again; a change to the summary or the order does not,
 * because nobody acknowledged the summary.
 */
export async function publishChapter(ctx, id) {
  const chapter = await one(ctx, id);
  const body = await readJson(ctx.request).catch(() => ({}));

  if (!String(chapter.body ?? '').trim()) throw badRequest('There is nothing in that chapter yet.');

  // "Ask everybody again" is a deliberate choice for the case the words did not
  // change but the property wants the tick refreshed: a new year, a new
  // manager, an incident that made everybody's memory of it worth testing.
  const again = body.again === true;
  const fresh = wouldBeANewVersion(chapter) || again;
  const version = fresh ? Number(chapter.version || 0) + 1 : Number(chapter.version || 1);
  const hash = await sha256Hex(`${chapter.title}\n\n${chapter.body}`);

  await ctx.db.prepare(
    `UPDATE hb_chapter
        SET status = 'published',
            version = ?2,
            live_title = ?3,
            live_body = ?4,
            live_hash = ?5,
            live_asks = ?6,
            published_at = datetime('now'),
            published_by = ?7
      WHERE id = ?1`,
  ).bind(
    chapter.id, version, chapter.title, chapter.body, hash, asksOf(chapter), actorOf(ctx),
  ).run();

  await audit(ctx, 'handbook.published', chapter.id, {
    code: chapter.code, version, again,
  });

  // Everybody it applies to hears about it once, and only where it wants
  // something back. A reference page quietly appearing is not news.
  if (asksOf(chapter) !== 'read') {
    await createNotice(ctx.db, {
      kind: 'handbook.published',
      title: version > 1 && !fresh
        ? `${chapter.title} has been published again`
        : `${chapter.title}: please read and ${asksOf(chapter) === 'sign' ? 'sign' : 'tick'} it`,
      body: chapter.summary || 'It is in the handbook, under Handbook.',
      link: '#/handbook',
      audience: 'att_me',
    }, ctx);
  }

  return json({ ok: true, version, asked: fresh });
}

/** Take it back off the screen, without deleting anything anybody signed. */
export async function retireChapter(ctx, id) {
  const chapter = await one(ctx, id);
  await ctx.db.prepare(
    "UPDATE hb_chapter SET status = 'retired', updated_by = ?2, updated_at = datetime('now') WHERE id = ?1",
  ).bind(chapter.id, actorOf(ctx)).run();
  await audit(ctx, 'handbook.retired', chapter.id, { code: chapter.code });
  return json({ ok: true });
}

/**
 * Put the standard handbook in.
 *
 * As drafts, every one of them. A handbook is the property's word rather than
 * the app's, and eighteen chapters appearing on twenty-four phones because
 * somebody pressed a button once is exactly the thing this feature exists to
 * prevent.
 */
export async function installStandard(ctx) {
  const have = new Set((await chapters(ctx.db)).map((c) => c.code));
  let added = 0;

  for (const chapter of DEFAULT_CHAPTERS) {
    if (have.has(chapter.code)) continue;
    await ctx.db.prepare(
      `INSERT INTO hb_chapter
         (code, title, summary, body, asks, sort_order, departments, tags, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))`,
    ).bind(
      chapter.code, chapter.title, chapter.summary ?? null, chapter.body,
      chapter.asks ?? 'read', chapter.sort_order ?? 100,
      chapter.departments ? JSON.stringify(chapter.departments) : null,
      chapter.tags ? JSON.stringify(chapter.tags) : null,
      actorOf(ctx),
    ).run();
    added += 1;
  }

  await audit(ctx, 'handbook.installed', null, { added });
  return json({ ok: true, added, of: DEFAULT_CHAPTERS.length });
}

/** Who has done it and who has not, by name. */
export async function whoHasNot(ctx, id) {
  const chapter = await one(ctx, id);
  const people = (await ctx.db.prepare('SELECT * FROM att_staff WHERE active = 1 ORDER BY name')
    .all().catch(() => ({ results: [] }))).results ?? [];
  const acks = (await ctx.db.prepare(
    'SELECT * FROM hb_ack WHERE chapter_id = ?',
  ).bind(chapter.id).all().catch(() => ({ results: [] }))).results ?? [];

  const out = whoIsOutstanding(chapter, people, acks);
  const byStaff = new Map(acks
    .filter((a) => Number(a.version) === Number(chapter.version))
    .map((a) => [Number(a.staff_id), a]));

  return json({
    title: chapter.live_title || chapter.title,
    version: chapter.version,
    asks: liveAsksOf(chapter),
    of: out.of,
    done: out.done,
    waiting: out.waiting.map((p) => ({ id: p.id, name: p.name, department: p.department ?? null })),
    signed: people
      .filter((p) => byStaff.has(Number(p.id)))
      .map((p) => ({
        id: p.id,
        name: p.name,
        at: byStaff.get(Number(p.id)).at,
        signerName: byStaff.get(Number(p.id)).signer_name ?? null,
      })),
  });
}

// ---------------------------------------------------------------------------

async function one(ctx, id) {
  const chapter = await ctx.db.prepare('SELECT * FROM hb_chapter WHERE id = ?')
    .bind(int(id, 'Chapter', { min: 1 })).first();
  if (!chapter) throw notFound('No such chapter.');
  return chapter;
}

const list = (value) => {
  const items = Array.isArray(value)
    ? value.map((v) => String(v).trim()).filter(Boolean)
    : [];
  return items.length ? JSON.stringify([...new Set(items)]) : null;
};

const slug = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '_')
  .replace(/^_|_$/g, '').slice(0, 40);

async function audit(ctx, action, id, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
  ).bind(actorOf(ctx), action, String(id ?? ''), JSON.stringify(detail)).run().catch(() => {});
}
