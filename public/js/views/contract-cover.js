import { h } from '../util.js';

/**
 * A contract's cover page, for printing from HIVE.
 *
 * The same page the signed PDF opens with: a formal frame, the employer's
 * logo in a ring (its initials where it has none, or where the logo cannot
 * be loaded), its registered name, the document's name between two
 * dividers, who it is between and what for, and the reference, the date
 * issued and the employee number. Only ever printed: on screen it is hidden.
 */

const initialsOf = (name) => String(name ?? '').split(/\s+/)
  .filter((w) => /^[A-Za-z]/.test(w) && !/^(and|of|the|ltd|limited)$/i.test(w))
  .slice(0, 3).map((w) => w[0].toUpperCase()).join('') || '?';

const longDate = (day) => (/^\d{4}-\d{2}-\d{2}/.test(String(day ?? ''))
  ? new Date(`${String(day).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })
  : (day || '—'));

const divider = () => h('div.pc-divider', { 'aria-hidden': 'true' }, h('span'), h('i'), h('span'));

export function contractCover(cover) {
  if (!cover) return null;
  const initials = h('span.pc-initials', initialsOf(cover.companyName));
  const ring = h('div.pc-ring',
    cover.logoUrl
      ? h('img', {
        src: cover.logoUrl,
        alt: `${cover.companyName} logo`,
        onerror: (e) => e.target.replaceWith(initials),
      })
      : initials);
  return h('section.print-cover',
    h('div.pc-frame',
      h('div.pc-inner',
        ring,
        h('div.pc-company', String(cover.companyName ?? '').toUpperCase()),
        h('div.pc-under', [cover.tradingAs ? `trading as ${cover.tradingAs}` : null, cover.address].filter(Boolean).join(' · ')),
        divider(),
        h('h1.pc-title', String(cover.title ?? '').toUpperCase()),
        cover.subtitle ? h('div.pc-subtitle', cover.subtitle) : null,
        divider(),
        h('p.pc-sentence', cover.sentence),
        h('div.pc-facts',
          h('div', h('span', 'REFERENCE'), h('b', cover.reference)),
          h('div', h('span', 'ISSUED'), h('b', longDate(cover.issued))),
          h('div', h('span', 'EMPLOYEE NO.'), h('b', cover.employeeNo || '—'))),
        h('div.pc-foot', `PRIVATE AND CONFIDENTIAL · CHECK THIS COPY AT ${location.host}/verify`.toUpperCase()))));
}
