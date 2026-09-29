# Shifts

The front desk's control sheet, done from the source records instead of typed
from them. It lives on the **Shifts** tab.

## What you load, and how often

All three are loaded on the Shifts tab under **Load files**, by an owner. The
files are opened in the browser. Only amounts, times and ASSD user names are
sent to Insight: guests' names and addresses are cut out of the journal on the
page, and the bank statement's salaries, suppliers and transfers are never
sent. Loading the same file twice changes nothing.

| File | Where it comes from | Notes |
| --- | --- | --- |
| ASSD detail journal | ASSD → Business Reports → *Detail Journal of every Transaction*, printed to PDF | Run it **one day past** the last shift you want. ASSD prints only the lines dated inside the benefit-date range, so a journal that ends on the 7th stops inside the 7th's last shift. |
| Card terminal report | The bank's merchant portal (TAMS), exported as CSV | Every tap, approved or declined, to the second. This is what card payments are matched on. |
| GTBank statement | Finacle customer statement, as the XLSX it comes in | Card settlements, card reversals, commission and MoMo. Rows the bank marked deleted or unposted are ignored. |

A weekly load is enough for the week's reconciliation. A newer journal that
overlaps an older one replaces the overlapping days and keeps the rest.

## What people type

| What | Who | When |
| --- | --- | --- |
| Counted closing | The person taking over the drawer | Every hand-over. It becomes the next shift's opening. |
| Opening | Anybody who reads the numbers | Only for the very first count, or after a gap. |
| Expense-sheet total and Odoo PO numbers | Admin | Per shift with expenses. **Save and read from Odoo** fetches vendor, total and state for each PO. Nothing in Odoo is changed. |
| An answer to an exception | Admin | When one appears. |

Everything typed is signed with the name of whoever typed it.

## How a shift is worked out

- **Where shifts start and end.** ASSD's *Beginn of Day Processing* marker is
  the hand-over. Everything between two markers is one shift, held by the user
  on the marker. Two markers in a row by the same person are one shift.
- **Which slot.** Shifts run 06–14, 14–22 and 22–06, and a night belongs to the
  day it starts. ASSD has no clock, so each shift is placed by the terminal's
  clock for card payments that identify it, and by the marker's date. A night's
  marker is usually dated the next morning, and that is allowed for.
- **Cash.** Cash payments on the front-desk register (001). Laundry paid in
  cash is included. Back-office entries on register 015 are never a shift's.
- **Left the drawer.** Cash Movements out of register 001, net of any put back.
  They are split into expenses and cash to the safe once the expense-sheet
  total is typed. Until then the split uses the receipts listed on ASSD's own
  hand-over count, or is shown as "not split".
- **The register.** Opening + cash − left the drawer = expected closing. The
  variance is the typed count minus that. ASSD's own booked deficit or surplus
  at the close is shown beside it.
- **Laundry.** ASSD's laundry sales for the day are compared with the laundry
  system's figures for the same day, once the laundry system is loaded.

## How card and MoMo payments are matched

In order:

1. One ASSD line to one payment of the same amount inside the shift's hours,
   then with 90 minutes' grace either side.
2. Two or three ASSD lines paid as one payment.
3. One ASSD line paid in two to four goes within 45 minutes. Card and MoMo can
   be mixed.
4. For days the terminal report does not cover, the bank's card credits by day.

Approved terminal payments are then joined to the bank statement by approval
code and card, to check each one arrived.

## The exception groups

| Group | What it means |
| --- | --- |
| Recorded as paid, but the payment failed | The terminal declined the amount and never approved it afterwards, yet ASSD has it as paid by card. |
| Recorded as card or MoMo, no payment found | Nothing of that amount arrived near the shift. |
| The same card charged twice | Two approved charges to one card, same amount, within 30 minutes, and ASSD has one. |
| Keying slips | Transposed digits, one digit different, or out by a factor of ten against a payment in the same shift. |
| Keyed twice in ASSD | The same amount twice in one shift, paid once. |
| Money received that ASSD does not show | Approved on the terminal or received by MoMo during the shift, and not in ASSD. |
| Did not reach the bank, or went back out | No bank credit six days after approval, a card reversal, or a refund keyed in ASSD. |
| Explained by the matcher | The same money split differently, paid on one shift and keyed on another within a day, a line and its reversal, or a bank credit with no terminal record. Shown so the explanation can be checked. |

The last shift in a journal is shown as far as the journal goes. Money taken
after the export ran is not reported as missing from ASSD.
