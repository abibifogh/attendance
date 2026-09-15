import { api } from '../api.js';
import { h, mount } from '../util.js';
import { card, emptyState } from './components.js';
import { navigate } from '../app.js';

/**
 * My contract.
 *
 * WHAT WAS MISSING. The office could open a signed contract, read the
 * certificate under it and print the lot from the day signing was built. The
 * person who signed it could not. They saw the words once, on a link that
 * expires, pressed a button, and after that the only copy of their own
 * employment contract lived on somebody else's screen. Every bank, landlord
 * and visa office that asked them for it was asking for something they had no
 * way of producing, so the office was printing copies by hand.
 *
 * SIGNED ONES ONLY. A draft is the property still making up its mind. One that
 * is sent and unsigned is already in front of them, on the link carrying it.
 * What belongs here is what they agreed to.
 *
 * A LIST EVEN WHEN THERE IS ONE. Renewals, promotions and a change of terms
 * each issue a fresh contract, and the old one does not stop being a record of
 * what was true at the time. Opening the newest automatically would hide the
 * rest of somebody's history behind a screen they never see.
 */
export async function renderMyContracts() {
  const host = h('div');
  const { contracts, me } = await api.myContracts();

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'My contract'),
        h('div.sub', contracts.length
          ? 'Signed, with the evidence behind it. Open one to read it or save it as a PDF.'
          : 'Anything you have signed appears here.'),
      ),
    ),

    contracts.length
      ? h('div.me-list', contracts.map((row) => contractRow(row)))
      : emptyState('Nothing signed yet',
        'A contract shows here once you have signed it. If you signed one on paper before '
        + 'any of this, it appears as soon as the office files the scan. Ask them if it has '
        + 'been a while.'),

    contracts.length
      ? card('What you can do with it', { wide: true },
        h('p.muted',
          'Open a contract and press Save as PDF. You get the words you agreed to, both '
          + 'signatures, and the certificate of signature: the fingerprint of the text, when '
          + 'you signed, from where, and every step in between. That is the part a bank or a '
          + 'landlord is actually asking for when they ask whether an electronic contract is '
          + 'real.'),
        h('p.muted', { style: { marginBottom: 0 } },
          `It is issued to ${me.name}, employee ${me.employeeNo}. If anything on it is wrong, `
          + 'tell the office rather than editing anything yourself. A signed contract cannot '
          + 'be changed, only replaced by one that says what it supersedes.'),
      )
      : null,
  );

  return host;
}

/** One contract, said plainly enough to pick between two of them. */
function contractRow(row) {
  const signed = row.signed_at ? String(row.signed_at).slice(0, 10) : null;
  const when = signed ? new Date(`${signed}T12:00:00Z`) : null;

  return h('div.me-day',
    h('div.me-when',
      h('strong', when ? String(when.getUTCDate()) : '\u2014'),
      h('small.muted', when
        ? when.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
        : '')),
    h('div.me-what',
      h('strong', row.title),
      h('small.muted', row.origin === 'paper'
        ? 'Signed on paper, held here as a scan'
        : 'Signed on screen'),
      h('small.muted', row.employer_at
        ? 'Countersigned by the property'
        : 'Waiting on the property to countersign')),
    h('div.me-was',
      h('button.btn-sm', { onclick: () => navigate('my-contract', { id: row.id }) }, 'Open')),
  );
}
