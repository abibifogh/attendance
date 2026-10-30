# Nice Place

Nice Place is the public washroom. Four door counters count movements: **GB**
gents bath, **GT** gents toilet, **LB** ladies bath, **LT** ladies toilet. A
person going in and out is 2. The counters keep adding up.

Insight holds the counters, shift by shift, against the money the desk sends
with them (or, for older months, the income workbook), the toilets and the
showers apart. From the money for children and adults, and the prices, it
works out how many people paid, and holds that against the people counted.

The shifts: **Day 03:30 to 13:30**, **Night 13:30 to 23:00** (Accra time).

## On the phone, as an app

**The desk.** Open the staff link once on the desk phone and press **Put
Nice Place on this phone** (on an iPhone: Share, then Add to Home Screen). It
becomes the Nice Place app, a water drop on the home screen, opening straight
on the desk page with one tap. The link's code is built into the app (an app
on an iPhone's home screen keeps nothing the browser knew), so **New link**
stops the old app as well: open the new link and put it on the phone again.

**The supervisor.** Insight installs the same way: **Install Insight on this
phone** in the account menu, in search, or at the top of Pickups. Its
shortcuts open the Assistant, Shifts and Nice Place pickups.

Neither keeps anything on the phone: everything is read fresh each time, and
with no connection a page says so plainly.

## The desk: each shift's sales

On the phone at the desk, from the staff link, made as big and plain as it
can be for the ladies who use it:

1. **Tap your name.** The phone remembers it ("Not you?" changes it).
2. **The money.** The date and the shift are already there in big letters,
   from the clock read an hour back, so at 13:40 it is still the day shift
   being sent; "This is not my shift" offers the last four. Four big boxes:
   the shower for children and adults, the toilet for children and adults,
   in GH₵. The shower total, the toilet total and all the money add up as she
   types. A shift sent already says so.
3. **One picture of the counters**, read as below.
4. **Sent**: a big tick, what was sent, and what to write on the envelope
   (e.g. "30 Oct · Day").

The money goes where the workbook's did (`np_revenue`, marked "Desk: name"),
so everything below works from it unchanged, and the workbook is only needed
for months before the desk sent its own.

## Pickups

Front desk › Nice Place › **Pickups**: for admins, and supervisors given
**Nice Place pickups** (Settings › People & access › Supervisors; the preset
of the same name gives it with Nice Place counters). See looks; Act makes
pickups.

1. **Start a pickup.** Every shift sent since the last pickup is listed with
   its money, all ticked; untick one not in the safe. Shifts with no sales
   sent are listed in red, to chase.
2. **Paid from this money.** What, how much, from whom, and a picture of the
   receipt. Each is read and made a draft PO in Odoo carrying its reference
   (`NP/PU/014-1`, on the PO as Vendor Reference and Source Document), as a
   float's receipts are. One can be taken off before recording; its draft PO
   stays in Odoo to cancel there.
3. **The money.** Sales of the ticked shifts, less what was spent, is the
   net cash. Type what was counted; if it differs, say why. **Record the
   pickup.**

Each envelope is picked up once. The counted cash goes into the main safe's
book (Front desk › Safe) on the day of the pickup, and into the next count.
Admins see every pickup (sales, spent, net cash, counted, the difference) and
**Approve** or **Ask** the supervisor; the Assistant lists the ones waiting,
and shifts with no sales sent.

## The staff link

Front desk › Nice Place › **Make the link** (admins). Copy it and send it to
the staff; they keep it on their phone. It needs no account: the code after
`#` in the address is the key. **New link** makes another, and the old one
stops working.

At the end of each shift, the person on sends the money and one picture, as
under The desk above. Settings › Rules › Nice Place › Names on the link holds
the names.

**Reading the picture.** Cloudflare's Workers AI (model Llama 4 Scout, on
the same Cloudflare account, no key) reads each counter. A counter it cannot
read for certain (cut off, blurred, glare, covered) is left empty and marked
"to be read". Nothing is ever typed on the phone. The person can take a
clearer picture, or send this one as it is:

- **On sending**, the reader is asked once more about the counters it missed,
  told which ones to look at closely. What it reads now fills them in.
- **Still not read** (or the reader cannot be reached): the reading is kept
  with that counter empty, and the phone says the manager will read it. The
  shift is not counted until all four are in.
- **An admin or a supervisor** then reads it off the picture. It shows in
  Front desk › Shifts › To sort out under **Nice Place** ("Read GT off the picture"), and on the
  Nice Place page as **! Counter to read**, with a banner. The picture sits
  beside four boxes: the counters read are filled in, the missing one is
  empty, and each shows the last reading under it. **Try reading again** asks
  the reader once more; **Save the four numbers** saves all four (a misread one
  can be put right too). The reading is then marked as typed and checked by
  that person, and the shift is worked out.

A supervisor sees this only with **Nice Place counters** set in Settings ›
access (See shows the readings waiting; See and act lets them fill them in).
It is in neither preset, so it is given person by person. A supervisor fills in
only a reading still waiting; once all four are in, only an admin changes it.

The numbers saved are the picture's, checked again on the server, whatever is
in the boxes. A number lower than the last reading is pointed out (a misread,
or a counter reset) but not refused. The same picture is read once on the
page, and again on sending only for what was missed.

Settings › **Reading the counters off the picture** says how the last picture
went (read, or not and the reader's exact words why) and has **Try reading a
picture**: choose a photo and see what the reader makes of it, and its raw
answer. The reader is first asked for its answer in a fixed shape; if it
refuses that, it is asked again in plain words. Pictures are sent at most
1280 pixels across.

If the counters carry no GB / GT / LB / LT labels, say where each one is under
Settings › **How the counters are laid out** (for example "left to right:
GB, GT, LB, LT"); the reader is told.

**A shift with no picture** (none sent, or numbers typed in Insight): an admin
opens it and presses **📷 Add the picture**. It is read like one from the
link. With no reading, what is read becomes the reading, and a counter not
read waits to be typed from the picture, in the same box as above. With
numbers already typed, they stay; the picture is kept with them and any
number it reads differently is said, to fix if the picture is right. A shift
that has a picture already cannot be given another here.

Readings sent before this, typed because the picture could not be read, still
say "typed: picture not read" in Insight.

A wrong number can be sent again, with a new picture, within an hour of the first time; after
that an admin fixes it in Insight. The picture is made smaller on the phone
before it is sent and kept with the reading.

**A reading sent for the wrong day or shift** (the day shift's picture sent as
the night's, or on the wrong date): open the shift and press **Wrong day or
shift? Move it**, choose the right day and shift, and **Move**. The reading
goes there with its picture, and both shifts are worked out again. If the
shift chosen has a reading of its own, nothing moves until you press **Swap
the two** (each was probably sent for the other). The reading then says where
it was moved from and by whom. Admins can move any reading. A supervisor given
Nice Place can move one waiting to be read, from the Inbox. An answer given on
a shift stays with that shift.

## The income workbook

Upload it as it is kept: a sheet per month named like `SEP 26`, with Toilet and
Shower, Day and Night, and Adult, Child and Revenue under each, a row per date,
and Day and Night names under Shifts. Everything from the **Total** row down is
left out. Uploading a month again replaces it. **Template** downloads an empty
one for the month on screen.

Adult and Child are money: the people are the adults' money ÷ the adult price
plus the children's ÷ the child price (Settings: GH₵3 and GH₵1).

## The sums

For each shift, and for the toilets (GT + LT) and the showers (GB + LB) apart,
since a visitor pays for each:

- **People** = the movements since the reading before, ÷ 2.
- **Should have paid** = people less the staff and cleaners' walk-throughs
  (Settings: 10 per counter per shift).
- The money must be between every one a child (should have paid × GH₵1) and
  every one an adult (people × GH₵3).

| Status | Means |
|---|---|
| ✕ Not adding up | Less money than even all children would bring. |
| ! More people than paid | The workbook pays for fewer people than counted, by more than 10% (or 5). |
| ! More money than people | More than all adults would bring: a counter may not be counting. |
| ✓ Fits | Within the range, and the people paid for are close to those counted. |

Also said, where it applies:

- **The first reading** is counted from zero: the counters were set to zero at the start.
- **A counter lower than before** was reset (by accident or on purpose): it is counted from zero.
- **A missed picture** makes the next reading cover more than one shift: it is held against the money of all of them.
- **The workbook's adults and children** not adding up to its revenue.

Open a shift to see the picture beside the numbers. You can say they match (or
fix one, admins), and answer a shift that does not add up: counter fault, free
use, staff to account for it, or explained.
