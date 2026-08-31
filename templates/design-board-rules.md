# Design board rules, portable

Paste into a Claude Design project's own instructions, or send it as the first
message of a new design project. Claude Design does not read this machine's
`CLAUDE.md` or any repo file, so this is a manual paste every time; the point of
keeping it here is that it has one durable address.

Product-neutral: no Interplanetary Groups tokens. Written by Claude Design on
25 August 2026, after board backdrops kept landing close enough to the designs
that the designs were hard to read.

---

## Canvas backdrop

Render the backdrop around artboards and frames, never the designs themselves,
in a chromatically neutral gray, `#8c8c8c` (equal R, G, B), so it never tints
the design's colors. Shift it (roughly `#767676` to `#949494`) if a design loses
separation against it. The goal is separation, not a fixed hex.

Never recolor the designs, components, or their backgrounds. Brand tokens and
design system values stay as they are.

## Board chrome on gray

Chrome is the eyebrow, title, subtext and captions around the frames. On gray it
needs more contrast and size than default:

- Eyebrow `#131418`, 12.5px, weight 700
- Title `#0b0c0e`
- Subtext `#0d0e11`, **16px minimum**, line-height 1.6, max-width ~76ch
- Captions `#1f2024`, **14px minimum**, line-height 1.6

Darken further if a lighter backdrop shade is used.
