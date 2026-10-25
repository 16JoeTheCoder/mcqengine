# DMC school Library: policy

For the school's Head of Cambridge and, if ever asked, Cambridge International. Written by the app's owner (a student) to describe exactly what the Library is, who can use it, and how it is kept within the school.

## What it is

DMC is a practice app for multiple-choice exam papers. The Library is a place inside the app where students of the school share sets of past papers (question papers, mark schemes and typed questions) so classmates can practise with them. It exists to support revision for the school's Cambridge programme, with the agreement of the school's Head of Cambridge.

## Who can use it

* **Only members of the school.** A member is an account whose email address is confirmed and ends in `@stjbs.sch.id`, or is on a short allowlist kept by the owner (for example a teacher who uses another address).
* This is checked by the server on every request, from the confirmed email in the signed sign-in token. It does not depend on anything the app or the user can change. Personal accounts (any other Google or email address) can use every other part of DMC, but the Library stays locked for them.
* The site is marked "noindex", so search engines do not list it, and no paper sets are included in the app's public code. The Library's files are kept in private storage and are handed out only as links that expire after 60 seconds, to members only.

## What may be posted

* Past papers, mark schemes and typed versions of them, for study at this school.
* Nothing personal (names, scores, contact details) and nothing that is not exam practice.
* Each set shows who posted it. Posting means the student agrees to this policy.

## Keeping it within the school

* Sets downloaded from the Library are marked as Library sets on the device. DMC will not export them through "Pack for friends", the feature for sharing packs as files.
* A student's personal backup may include Library sets so the student does not lose them; the backup is labelled private and is for the student's own devices.
* Signing in on another device syncs progress (scores and settings), never the papers themselves; Library sets are downloaded again from the Library.

**This is a deterrent, not DRM.** Anyone who can see a paper on a screen can copy it. These measures make sharing outside the school deliberate rather than accidental, and keep the Library itself closed to outsiders. They do not and cannot make copying impossible.

## Moderation and takedown

* Every set has a **Report** button. Three reports from different members hide the set until an admin looks at it.
* The person who posted a set can delete it at any time.
* The owner is an admin and can remove any set instantly. Removing a set deletes its files from storage.
* **Takedown requests** (from the school, Cambridge, or anyone with a reason) go to the owner, who removes the set the same day. Contact: the owner's school email, listed in the app's About dialog.
* If the school withdraws its agreement, the owner switches the Library off (by removing the school domain from the allowlist table, which locks it for everyone at once) and deletes the stored sets.

## What is stored, and where

* Library: each set's file, an optional cover image, its name, description, subject, paper and question counts, the poster's display name, star counts and reports.
* Sync (any signed-in account, by choice): session results, question statistics, small settings and fixes. Never PDFs.
* Hosted by Supabase (Singapore region), protected by row-level security rules that are part of the app's source code (`supabase/schema.sql`) and tested automatically.
* No analytics, tracking or advertising.

## Owner's note

The Head of Cambridge's agreement to run the Library inside the school should be kept in writing (an email is enough), together with any conditions attached to it. The Library should be switched off if that agreement ends.
