import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PAGE, faceOf, textOf } from './paper.js';

/**
 * The finished, signed copy of a document, as a PDF.
 *
 * What a signed contract or letter used to be was a web page with a print
 * button. This is the file somebody can keep, email and print: the words, the
 * signatures drawn onto the page where they were made, a footer on every page
 * with the document's reference and where to check it, and a certificate at
 * the back saying who signed, when, from where, how they proved it was them,
 * and every step on the way.
 *
 * Tamper evidence is the fingerprint. The SHA-256 of the finished file is
 * kept, and anybody can check a copy at /verify: a file whose fingerprint is
 * not on record has been changed, whatever it looks like.
 *
 * Uploaded letters keep their own pages as they were; the signatures go on a
 * page of their own and on the certificate, because there is no place on
 * somebody else's PDF that HIVE was told to sign.
 */

const A4 = [595.28, 841.89];
const M = 56;
const INK = rgb(0.08, 0.1, 0.12);
const DIM = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.85, 0.87, 0.9);

/** What the built-in faces can draw: anything else is mapped or dropped. */
export function plain(text) {
  return String(text ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/•/g, '-')
    .replace(/₵/g, 'GHS ').replace(/→/g, '->').replace(/ /g, ' ')
    .replace(/\t/g, '    ')
    .replace(/[^\x0A\x20-\x7E\xA0-\xFF]/g, '?');
}

function wrap(text, font, size, width) {
  const out = [];
  for (const para of plain(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(next, size) <= width) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/** Bytes out of a data URL, and whether they are a PNG or a JPEG. */
function fromDataUrl(url) {
  const m = /^data:(image\/(png|jpe?g));base64,(.+)$/i.exec(String(url ?? ''));
  if (!m) return null;
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return { bytes, png: m[2].toLowerCase() === 'png' };
}

async function embedInk(doc, ink) {
  const got = fromDataUrl(ink);
  if (!got) return null;
  try {
    return got.png ? await doc.embedPng(got.bytes) : await doc.embedJpg(got.bytes);
  } catch {
    return null;
  }
}

async function embedImage(doc, bytes, mime = '') {
  if (!bytes?.length) return null;
  try {
    if (/png/i.test(mime) || (bytes[0] === 0x89 && bytes[1] === 0x50)) return await doc.embedPng(bytes);
    return await doc.embedJpg(bytes);
  } catch {
    return null;
  }
}

/** A picture fitted inside a box, never stretched. y is from the top. */
function drawFitted(page, img, x, yTop, w, h) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  page.drawImage(img, { x, y: A4[1] - yTop - dh, width: dw, height: dh });
}

const stamp = (value) => (value ? `${String(value).replace('T', ' ').slice(0, 16)} UTC` : '');

async function fonts(doc) {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
}

/** One signature: the mark, or the typed name in a hand-like face, and under it who and when. */
async function signatureBlock(doc, page, f, x, yTop, w, { label, ink, name, at, how }) {
  page.drawText(plain(label).toUpperCase(), { x, y: A4[1] - yTop, size: 7.5, font: f.bold, color: DIM });
  const img = ink ? await embedInk(doc, ink) : null;
  if (img) drawFitted(page, img, x, yTop + 6, w, 46);
  else if (name) page.drawText(plain(name), { x, y: A4[1] - yTop - 38, size: 20, font: f.italic, color: INK });
  page.drawLine({ start: { x, y: A4[1] - yTop - 56 }, end: { x: x + w, y: A4[1] - yTop - 56 }, thickness: 0.6, color: RULE });
  page.drawText(plain(name || ''), { x, y: A4[1] - yTop - 68, size: 9.5, font: f.bold, color: INK });
  page.drawText(plain([stamp(at), how].filter(Boolean).join(' · ')), { x, y: A4[1] - yTop - 80, size: 8, font: f.regular, color: DIM });
}

function footers(doc, f, { reference, verifyUrl }) {
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    page.drawLine({ start: { x: M, y: 36 }, end: { x: A4[0] - M, y: 36 }, thickness: 0.5, color: RULE });
    page.drawText(plain(`${reference} · Check this copy at ${verifyUrl}`), { x: M, y: 24, size: 7.5, font: f.regular, color: DIM });
    const n = `Page ${i + 1} of ${pages.length}`;
    page.drawText(n, { x: A4[0] - M - f.regular.widthOfTextAtSize(n, 7.5), y: 24, size: 7.5, font: f.regular, color: DIM });
  });
}

/**
 * The certificate at the back. `signers` are {role, name, at, ip, agent,
 * how, ink}; `events` are {at, what, who, detail, ip}.
 */
async function certificate(doc, f, { title, reference, property, fingerprint, fingerprintLabel, signers, events, verifyUrl }) {
  let page = doc.addPage(A4);
  let y = 70;
  const line = (text, { size = 9.5, font = f.regular, color = INK, gap = 4 } = {}) => {
    for (const l of wrap(text, font, size, A4[0] - 2 * M)) {
      if (y > A4[1] - 70) { page = doc.addPage(A4); y = 70; }
      page.drawText(l, { x: M, y: A4[1] - y, size, font, color });
      y += size + gap;
    }
  };
  line('Certificate of signature', { size: 18, font: f.bold, gap: 8 });
  line(`${property} · ${reference}`, { color: DIM, gap: 14 });
  line('DOCUMENT', { size: 7.5, font: f.bold, color: DIM });
  line(title, { font: f.bold });
  line(`${fingerprintLabel}: ${fingerprint}`, { size: 7.5, font: f.mono, color: DIM, gap: 12 });

  line('SIGNED BY', { size: 7.5, font: f.bold, color: DIM });
  for (const s of signers) {
    if (y > A4[1] - 170) { page = doc.addPage(A4); y = 70; }
    await signatureBlock(doc, page, f, M, y, 200, {
      label: s.role, ink: s.ink, name: s.name, at: s.at, how: s.how,
    });
    const facts = [
      s.ip ? `From ${s.ip}` : null,
      s.agent ? String(s.agent).slice(0, 90) : null,
    ].filter(Boolean);
    let fy = y + 10;
    for (const fact of facts) {
      page.drawText(plain(fact), { x: M + 230, y: A4[1] - fy, size: 8, font: f.regular, color: DIM });
      fy += 12;
    }
    y += 100;
  }

  line('WHAT HAPPENED', { size: 7.5, font: f.bold, color: DIM, gap: 6 });
  for (const e of events) {
    line(`${stamp(e.at)}  ${e.what}${e.who ? ` · ${e.who}` : ''}${e.detail ? ` · ${e.detail}` : ''}${e.ip ? ` · ${e.ip}` : ''}`,
      { size: 8, gap: 3 });
  }
  y += 10;
  line(`The fingerprint (SHA-256) of this file is kept by ${property}. Anybody can check that a copy `
    + `is genuine at ${verifyUrl}: a copy that has been changed in any way will not match.`,
  { size: 8.5, color: DIM });
}

async function finish(doc, at) {
  doc.setProducer('HIVE');
  doc.setCreator('HIVE');
  if (at) {
    const when = new Date(`${String(at).replace(' ', 'T')}Z`);
    if (!Number.isNaN(when.getTime())) { doc.setCreationDate(when); doc.setModificationDate(when); }
  }
  return doc.save();
}

/** A signed contract, from its words. */
export async function contractPdf({ contract, events = [], property, reference, verifyUrl }) {
  const doc = await PDFDocument.create();
  doc.setTitle(plain(`${contract.title} - ${contract.staff_name ?? ''}`));
  doc.setAuthor(plain(property));
  const f = await fonts(doc);

  let page = doc.addPage(A4);
  let y = 64;
  page.drawText(plain(property), { x: M, y: A4[1] - y, size: 10, font: f.bold, color: DIM });
  y += 26;
  for (const l of wrap(contract.title, f.serifBold, 17, A4[0] - 2 * M)) {
    page.drawText(l, { x: M, y: A4[1] - y, size: 17, font: f.serifBold, color: INK });
    y += 22;
  }
  y += 8;
  for (const l of wrap(contract.body, f.serif, 10.5, A4[0] - 2 * M)) {
    if (y > A4[1] - 70) { page = doc.addPage(A4); y = 64; }
    if (l) page.drawText(l, { x: M, y: A4[1] - y, size: 10.5, font: f.serif, color: INK });
    y += 14.5;
  }

  if (y > A4[1] - 200) { page = doc.addPage(A4); y = 64; }
  y += 20;
  const col = (A4[0] - 2 * M - 30) / 2;
  await signatureBlock(doc, page, f, M, y, col, {
    label: 'Signed by the employee', ink: contract.signature_ink, name: contract.signer_name,
    at: contract.signed_at, how: contract.signer_check ? `checked by ${contract.signer_check}` : null,
  });
  await signatureBlock(doc, page, f, M + col + 30, y, col, {
    label: 'For the employer', ink: contract.employer_ink, name: contract.employer_name, at: contract.employer_at,
  });

  await certificate(doc, f, {
    title: contract.title,
    reference,
    property,
    fingerprint: contract.body_hash,
    fingerprintLabel: 'Fingerprint of the words signed (SHA-256)',
    verifyUrl,
    signers: [
      {
        role: 'Employee', name: contract.signer_name, at: contract.signed_at, ip: contract.signer_ip,
        agent: contract.signer_agent, how: contract.signer_check ? `identity checked by ${contract.signer_check}` : 'signed from their own link',
        ink: contract.signature_ink,
      },
      contract.employer_at ? {
        role: 'Employer', name: contract.employer_name, at: contract.employer_at,
        how: 'confirmed with their own PIN or password', ink: contract.employer_ink,
      } : null,
    ].filter(Boolean),
    events,
  });
  footers(doc, f, { reference, verifyUrl });
  return finish(doc, contract.employer_at || contract.signed_at);
}

/**
 * A signed letter. A composed letter is drawn from its layout, on its
 * letterhead, with each signature in the place left for it; an uploaded one
 * keeps its own pages and gains a page of signatures.
 */
export async function letterPdf({
  letter, recipients = [], events = [], property, verifyUrl, layout = null,
  letterhead = null, original = null, stampInk = null,
}) {
  const reference = letter.reference;
  const doc = await PDFDocument.create();
  doc.setTitle(plain(`${letter.subject} - ${reference}`));
  doc.setAuthor(plain(property));
  const f = await fonts(doc);
  const signers = recipients.filter((r) => r.role !== 'copy');

  const signatureOf = (index) => (index === 0
    ? { ink: letter.signature_ink, name: letter.signed_by, at: letter.signed_at }
    : (() => {
      // Numbered by position in the whole list, copies included, as the
      // signing page numbers them.
      const r = [...recipients].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[index - 1];
      return r && r.role !== 'copy' ? { ink: r.signature_ink, name: r.signer_name || r.name, at: r.signed_at } : null;
    })());

  if (letter.source === 'uploaded' && original?.length) {
    const src = await PDFDocument.load(original, { ignoreEncryption: true }).catch(() => null);
    if (src) {
      for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
    } else {
      const img = await embedImage(doc, original, letter.mime);
      if (img) { const p = doc.addPage(A4); drawFitted(p, img, M, 50, A4[0] - 2 * M, A4[1] - 120); }
    }
    // The signatures, on a page of their own.
    const page = doc.addPage(A4);
    page.drawText(plain(`Signatures · ${letter.subject}`), { x: M, y: A4[1] - 70, size: 14, font: f.bold, color: INK });
    let y = 100;
    if (letter.signed_at) {
      await signatureBlock(doc, page, f, M, y, 220, { label: `For ${property}`, ...signatureOf(0) });
      y += 100;
    }
    for (const r of signers) {
      if (!r.signed_at) continue;
      if (y > A4[1] - 140) break;
      await signatureBlock(doc, page, f, M, y, 220, {
        label: r.role === 'approver' ? 'Approved by' : 'Signed by', ink: r.signature_ink, name: r.signer_name || r.name, at: r.signed_at,
      });
      y += 100;
    }
  } else {
    const blocks = layout?.blocks ?? [];
    const pages = Math.max(1, layout?.pages ?? 1);
    const head = letterhead ? await embedImage(doc, letterhead.bytes, letterhead.mime) : null;
    const px = A4[0] / PAGE.widthPx;
    for (let n = 1; n <= pages; n += 1) {
      const page = doc.addPage(A4);
      if (head && (n === 1 || letterhead.laterPages)) page.drawImage(head, { x: 0, y: 0, width: A4[0], height: A4[1] });
      for (const b of blocks.filter((x) => x.page === n)) {
        const x = (b.x / 100) * A4[0];
        const yTop = (b.y / 100) * A4[1];
        const w = (b.w / 100) * A4[0];
        if (b.role === 'field') {
          const h = ((b.h ?? 7) / 100) * A4[1];
          const s = signatureOf(b.signer ?? 0);
          if (!s?.at) continue;
          if (b.field === 'date') {
            page.drawText(plain(String(s.at).slice(0, 10)), { x, y: A4[1] - yTop - Math.min(h, 14), size: 10, font: f.regular, color: INK });
          } else {
            const img = s.ink ? await embedInk(doc, s.ink) : null;
            if (img) drawFitted(page, img, x, yTop, w, h);
            else page.drawText(plain(b.field === 'initials' ? initialsOf(s.name) : s.name || ''), { x, y: A4[1] - yTop - h * 0.7, size: Math.min(20, h * 0.6), font: f.italic, color: INK });
          }
          continue;
        }
        const face = faceOf(b.face).key;
        const font = face === 'mono' ? f.mono : face === 'sans' ? (b.bold ? f.bold : f.regular) : (b.bold ? f.serifBold : f.serif);
        const size = (b.size ?? 11) * px;
        let ly = yTop + size;
        for (const l of wrap(textOf(b.html), font, size, w)) {
          if (l) {
            const lw = font.widthOfTextAtSize(l, size);
            const lx = b.align === 'right' ? x + w - lw : b.align === 'center' ? x + (w - lw) / 2 : x;
            page.drawText(l, { x: lx, y: A4[1] - ly, size, font, color: INK });
          }
          ly += size * (b.line ?? 1.45);
        }
      }
    }
    if (!blocks.length && letter.body) {
      const page = doc.getPages()[0];
      let y = 120;
      for (const l of wrap(textOf(letter.body), f.serif, 10.5, A4[0] - 2 * M)) {
        if (l) page.drawText(l, { x: M, y: A4[1] - y, size: 10.5, font: f.serif, color: INK });
        y += 14.5;
      }
    }
    if (stampInk && letter.stamped_at) {
      const img = await embedInk(doc, stampInk);
      if (img) drawFitted(doc.getPages()[0], img, A4[0] - M - 110, A4[1] - 240, 100, 100);
    }
  }

  await certificate(doc, f, {
    title: letter.subject,
    reference,
    property,
    fingerprint: letter.source === 'uploaded' ? (letter.file_hash || '') : (letter.body_hash || ''),
    fingerprintLabel: letter.source === 'uploaded' ? 'Fingerprint of the file sent (SHA-256)' : 'Fingerprint of the words sent (SHA-256)',
    verifyUrl,
    signers: [
      letter.signed_at ? { role: `For ${property}`, name: letter.signed_by, at: letter.signed_at, how: 'confirmed with their own PIN or password', ink: letter.signature_ink } : null,
      ...signers.filter((r) => r.signed_at).map((r) => ({
        role: r.role === 'approver' ? 'Approved by' : 'Signed by',
        name: r.signer_name || r.name,
        at: r.signed_at,
        ip: r.signer_ip,
        agent: r.signer_agent,
        how: r.signer_check ? `identity checked by ${r.signer_check}` : 'signed from their own link',
        ink: r.signature_ink,
      })),
    ].filter(Boolean),
    events,
  });
  footers(doc, f, { reference, verifyUrl });
  const last = signers.map((r) => r.signed_at).filter(Boolean).sort().pop() || letter.signed_at;
  return finish(doc, last);
}

const initialsOf = (name) => String(name ?? '').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('');

/** SHA-256 of bytes, as hex. */
export async function fingerprint(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
