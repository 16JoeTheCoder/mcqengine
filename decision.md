# Phase 2 decisions

One line each, with the reason. Made during the Phase 2 build; the long-term list is [docs/DECISIONS.md](docs/DECISIONS.md), where the lasting ones are copied at the end.

## Identity (the unlinking bug)

- Root cause 1: packs had no permanent identity. The pack format carried only title and subject, so exporting a pack and importing the file again made a second pack with a new random id. Fix: `pack.setId` (UUID) in every pack, every export and every Library download.
- Root cause 2: posting gave the set a fresh random UUID and never linked the poster's own pack, and downloading always created `lib-<set id>`. Posting and downloading on one device therefore left two packs; posting again made a second Library set. Fix: the set ID *is* the pack's `setId`; download and import look a pack up by set ID, never by title.
- Root cause 3: papers matched by the id an AI wrote (`9702-s24-12`, `phys-may-june-2024-p12`, …), so one Cambridge paper became two. Fix: canonical keys worked out from file names or cover text (`shared/paper-key.ts`); the AI id is only a suggestion the user confirms.
- Regression tests: `tests/unit/unlinking.test.ts` (all three failed on the old code, see log.md).
- Existing pack ids are kept (sessions and sync rows point at them); `setId` is a new field and legacy packs get one on first export or post. Legacy `lib-<id>` downloads count as set `<id>` (`setIdOf`).
- A resolved paper takes its key as its id, so new question IDs read `9702_s24_qp_12#7`; a paper already stored under that key keeps its old id so its history stays linked.
- The validator keeps canonical keys' underscores; every other id is still slugified as before.
- Edited questions (same key, different hash) are a choice, "keep mine" or "use the Library's" (`prefer` in mergeDoc), instead of always blocking; leaving it unset keeps the old conflict behaviour for manual imports.
- The 53-bit content hash stays: it detects edits, it is not a security boundary.

## Cloudflare

- The Cloudflare tools attached to this build session point at a different account; nothing was created there. Every Cloudflare step is in setup.md for an agent with the council account token.
- D1 Time Travel: checked in Cloudflare's docs (D1 limits page, Nov 2026): available on every plan, 30 days on Workers Paid and 7 days on Workers Free, no extra cost. The council account's plan is not visible from here, so setup.md runs `wrangler d1 time-travel info` to confirm it is on. It is the second safety net; the nightly R2 dump is the first.
