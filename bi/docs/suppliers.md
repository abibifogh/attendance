# Buying › Suppliers

One list of suppliers. **Odoo is the list**: its vendors (anybody a PO or bill
went to) are read into Insight each night and when somebody presses
**Refresh from Odoo**, with their phone, email, TIN, address, terms and bank
accounts. Change those in Odoo; the supplier's page links to them there.

What Insight adds, because Odoo has no place for it:

- **Key suppliers**, in groups (Food & breakfast, Maintenance & hardware…, or a
  new one). Odoo lists one-off shops, refunds to staff and people as vendors
  too; the tab opens on the key ones, grouped. Press ☆ under *All in Odoo*.
- **Hide**: not a supplier (a member of staff, a one-off). Names that are a
  login in Odoo are marked *Staff?*.
- **Not linked**: names typed in the breakfast app, the maintenance store, a
  receipt or a drawer that no Odoo supplier has. Say which Odoo supplier each
  is, and its spend counts as theirs (*Other spellings* on their page).
- **How they are paid**: MoMo number, name and network, bank and account, and
  Odoo's bank accounts beside them. A note.

**Who**: anybody with the Buying report sees the list and the spend. Only
admins and supervisors change suppliers, and only they see or change how a
supplier is paid. Every change is kept in the supplier's history, with account
numbers shown as their last four digits.

**The apps**: the list (every Odoo supplier not hidden, key suppliers first)
goes to the breakfast app and the maintenance store each night and whenever a
supplier is marked key, grouped or hidden here. Whoever records a delivery
there picks the supplier from it, or types one it does not have. Signed with
`SSO_SECRET_BREAKFAST` and `SSO_SECRET_MAINTENANCE`, the same secrets as the
management report.

Spend is the warehouse's: Odoo bills by their date, and purchases from the
other systems. Odoo's own purchase lines are left out of the second part,
since the bills already carry them.

Code: `src/routes/supplierbook.js`, `src/connectors/odoo.js` (`vendorList`),
`public/js/views/supplierbook.js`; migration `0051_suppliers.sql`; tested in
`test/supplierbook.test.js`.
