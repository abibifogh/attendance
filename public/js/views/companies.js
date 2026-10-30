import { api } from '../api.js';
import { confirmAction, h, mount, toast } from '../util.js';
import { card } from './components.js';
import { field, formDialog } from './att-shared.js';
import { readLogo } from './att-setup.js';

/**
 * The companies people are employed by, under Settings → Company.
 *
 * The main company is the one the Company form above describes. Every other
 * one has its own name, numbers and tax office, which head its payslips and
 * its returns, and its own payroll each month. Who works for which is set on
 * each person under Staff and logins.
 */
export async function renderCompanies() {
  const host = h('div.companies');

  const draw = async () => {
    const { companies } = await api.companies();
    const others = companies.filter((c) => !c.main);
    const main = companies.find((c) => c.main);

    mount(host,
      h('p.muted.companies-lead',
        'Each company has its own payroll, payslips and GRA and SSNIT returns. Choose who works '
        + 'for which under People & logins.'),
      h('div.grid.companies-grid',
        main ? card(main.legalName || 'The main company', { note: 'Main company' },
          h('p.muted', `${main.people} ${main.people === 1 ? 'person' : 'people'}. `
            + 'Edited on the Company form.')) : null,
        others.map((c) => card(c.legalName || 'Unnamed company', { note: c.tin ? `TIN ${c.tin}` : 'No TIN yet' },
          h('dl.company-facts',
            h('dt', 'People'), h('dd', String(c.people)),
            h('dt', 'SSNIT'), h('dd', c.ssnit || 'Not set'),
            h('dt', 'Tax office'), h('dd', [c.taxOfficeKind, c.taxOffice].filter(Boolean).join(' ') || 'Not set')),
          c.logoAt
            ? h('img.logo-preview', {
              src: `/api/company/logo?company=${c.id}&v=${encodeURIComponent(c.logoAt)}`,
              alt: `${c.legalName} logo`,
            })
            : null,
          h('div.btn-row',
            h('button.btn-sm', { type: 'button', onclick: () => edit(c) }, 'Edit'),
            logoButton(c),
            !c.people && !c.payrolls
              ? h('button.btn-sm', { type: 'button', onclick: () => remove(c) }, 'Remove')
              : null)))),
      h('div.btn-row', { style: { marginTop: '.8rem' } },
        h('button.btn-sm', { type: 'button', onclick: () => edit(null) }, 'Add a company')));
  };

  const edit = async (c) => {
    const text = (label, value, hint, extra = {}) => {
      const input = h('input', { type: 'text', value: value ?? '', maxlength: 160, ...extra });
      return { input, el: field(label, input, hint) };
    };
    const legal = text('Registered name', c?.legalName, 'As the certificate has it', { required: true });
    const address = h('textarea', { rows: 3, maxlength: 300 }, c?.address ?? '');
    const phone = text('Telephone', c?.phone, '', { maxlength: 60, inputmode: 'tel' });
    const email = text('Email', c?.email, '', { maxlength: 120 });
    const website = text('Website', c?.website, '', { maxlength: 120 });
    const tin = text('TIN', c?.tin, 'The Taxpayer Identification Number the GRA issued', { maxlength: 40 });
    const ssnit = text('SSNIT employer number', c?.ssnit, '', { maxlength: 40 });
    const kind = h('select',
      [['', 'Not said'], ['LTO', 'LTO, Large Taxpayer Office'], ['TSC', 'TSC, Taxpayer Service Centre']]
        .map(([value, label]) => h('option', { value, selected: (c?.taxOfficeKind ?? '') === value }, label)));
    const office = text('Name of the tax office', c?.taxOffice, 'As the PAYE schedule asks for it', { maxlength: 60 });

    const done = await formDialog({
      title: c ? c.legalName : 'Add a company',
      submitLabel: c ? 'Save' : 'Add it',
      body: h('div',
        legal.el,
        field('Address', address, 'One line to a line, the way it should print'),
        phone.el, email.el, website.el, tin.el, ssnit.el,
        field('GRA tax office', kind, 'Ticked at the top of its PAYE schedule'),
        office.el),
      onSubmit: async () => {
        const body = {
          legalName: legal.input.value, address: address.value, phone: phone.input.value,
          email: email.input.value, website: website.input.value, tin: tin.input.value,
          ssnit: ssnit.input.value, taxOfficeKind: kind.value, taxOffice: office.input.value,
        };
        if (c) await api.updateCompany(c.id, body); else await api.createCompany(body);
        return true;
      },
    });
    if (done) {
      toast(c ? 'Saved.' : 'Company added.', 'good');
      await draw();
    }
  };

  const logoButton = (c) => {
    const picker = h('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' },
    });
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      try {
        await api.attSetLogo({ ...(await readLogo(file)), company: c.id });
        toast('Logo saved.', 'good');
        await draw();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    return h('span',
      h('button.btn-sm', { type: 'button', onclick: () => picker.click() }, c.logoAt ? 'Replace logo' : 'Add a logo'),
      c.logoAt
        ? h('button.btn-sm', {
          type: 'button',
          onclick: async () => {
            try {
              await api.attRemoveLogo(c.id);
              await draw();
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        }, 'Take logo off')
        : null,
      picker);
  };

  const remove = async (c) => {
    if (!confirmAction(`Remove ${c.legalName}? Nobody works for it and it has no payrolls.`)) return;
    try {
      await api.removeCompany(c.id);
      toast('Removed.', 'good');
      await draw();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  await draw();
  return host;
}
