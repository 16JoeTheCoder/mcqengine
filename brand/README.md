# Brand files

DMC picks up builtbyjosef logo files from this folder at build time and never redraws them.

* `tab-lockup-light.svg` / `tab-lockup-dark.svg`: signature lockup for light / dark grounds (top bar, footer, About).
* `tab-small.svg`: small tab mark for light grounds.

To add variants from the design system, drop them here with the same naming (`tab-primary-light.svg`, `tab-primary-dark.svg`, `tab-mono-paper.svg`…). `-light` means "for light grounds", `-dark` "for dark grounds". Rebuild to pick them up.
