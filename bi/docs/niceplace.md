# Nice Place

Nice Place is the public washroom. Four door counters count movements: **GB**
gents bath, **GT** gents toilet, **LB** ladies bath, **LT** ladies toilet. A
person going in and out is 2. The counters keep adding up.

Insight holds the counters, shift by shift (day and night), against the money
the monthly income workbook reports, the toilets and the showers apart.

## The staff link

Operations › Nice Place › **Make the link** (admins). Copy it and send it to
the staff; they keep it on their phone. It needs no account: the code after
`#` in the address is the key. **New link** makes another, and the old one
stops working.

At the end of each shift, the person on:

1. chooses their name (Settings › Names on the link holds the list);
2. checks the date and shift (the one after the last sent is suggested);
3. takes one picture of the four counters: the four numbers fill in by
   themselves, read off the picture, and cannot be typed over;
4. checks them against the counters (one wrong means a new picture) and
   presses **Send**.

**Reading the picture.** Cloudflare's Workers AI (model Llama 4 Scout, on
the same Cloudflare account, no key) reads each counter. A counter it cannot
read for certain (cut off, blurred, glare, covered) is left empty and
marked, and the page asks for the picture again; **Send** waits until it
has one with all four. The numbers sent are the picture's, checked again on
the server, whatever is in the boxes. A number lower than the last reading is
pointed out (a misread, or a counter reset) but not refused. Only when the
reader cannot be reached may the numbers be typed, and that reading is marked
"typed: picture not read" in Insight. The same picture is read only once.

Settings › **Reading the counters off the picture** says how the last picture
went (read, or not and the reader's exact words why) and has **Try reading a
picture**: choose a photo and see what the reader makes of it, and its raw
answer. The reader is first asked for its answer in a fixed shape; if it
refuses that, it is asked again in plain words. Pictures are sent at most
1280 pixels across.

If the counters carry no GB / GT / LB / LT labels, say where each one is under
Settings › **How the counters are laid out** (for example "left to right:
GB, GT, LB, LT"); the reader is told.

In Insight, a reading whose numbers were typed because the picture could not
be read then says so on its row and in its detail: look at the picture.

A number typed wrong can be sent again within an hour of the first time; after
that an admin fixes it in Insight. The picture is made smaller on the phone
before it is sent and kept with the reading.

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
