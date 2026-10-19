import { h, mount } from './util.js';

/**
 * Check a signed copy.
 *
 * Choose the PDF; the browser works out its fingerprint and asks HIVE whether
 * it issued a signed copy with that fingerprint. The file itself never leaves
 * the device. A copy changed in any way, even by one character, will not
 * match.
 */
const root = document.getElementById('verify');

async function fingerprintOf(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function draw(result = null, busy = false) {
  const input = h('input', {
    type: 'file', accept: 'application/pdf,.pdf',
    onchange: async () => {
      const file = input.files?.[0];
      if (!file) return;
      draw(null, true);
      try {
        const hash = await fingerprintOf(file);
        const res = await fetch('/api/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'That did not work.');
        draw({ ...out, name: file.name, hash });
      } catch (err) {
        draw({ error: err.message });
      }
    },
  });

  mount(root,
    h('div.card',
      h('h1', 'Check a signed copy'),
      h('p.muted', 'Choose the PDF you were given. Your browser works out its fingerprint and checks it '
        + 'against the signed copies on record. The file itself is not uploaded.'),
      h('label.btn.btn-primary.btn-wide', input, busy ? 'Checking…' : 'Choose the PDF')),
    result?.error ? h('div.card.verify-result.is-bad', h('strong', result.error)) : null,
    result && !result.error
      ? h(`div.card.verify-result.${result.genuine ? 'is-good' : 'is-bad'}`,
        h('h2', result.genuine ? 'Genuine' : 'Not on record'),
        result.genuine
          ? h('dl.decide-facts',
            h('dt', 'Document'), h('dd', result.title),
            h('dt', 'Reference'), h('dd', result.reference),
            h('dt', 'Issued by'), h('dd', result.property),
            h('dt', 'Signed by'), h('dd', result.signers || '—'),
            h('dt', 'Completed'), h('dd', result.completedAt ? `${String(result.completedAt).slice(0, 16)} UTC` : '—'))
          : h('p', result.message),
        h('p.fineprint', `Fingerprint of ${result.name}: ${result.hash}`))
      : null);
  input.hidden = true;
}

draw();
