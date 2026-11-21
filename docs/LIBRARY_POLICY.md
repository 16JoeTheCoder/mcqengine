# DMC school Library: policy

For the school's Head of Cambridge and, if ever asked, Cambridge International. Written by the app's owner (a student) to describe exactly what the Library is, who can use it, and how it is kept within the school.

## What it is

DMC is a practice app for multiple-choice exam papers. The Library is a place inside the app where students of the school share sets of past papers (question papers, mark schemes and typed questions) so classmates can practise with them. It exists to support revision for the school's Cambridge programme, with the agreement of the school's Head of Cambridge.

## Who can use it

* **Only members of the school.** Everyone signs in with Google. A member is a verified school Google account: its email ends in `@stjbs.sch.id` *and* Google confirms it belongs to the school's Google Workspace (the `hd` claim), or its address is on a short allowlist kept by the admins (for example a teacher who uses another address).
* This is checked by DMC's own server on every request, from the identity Google signs and the server verifies. It does not depend on anything the app or the user can change. Personal accounts (any other Google account) can use every other part of DMC, but the Library stays locked for them.
* The site is marked "noindex", so search engines do not list it, and no paper sets are included in the app's public code. The Library's files are kept in private storage that has no public address; the server hands each file only to a signed-in member, after checking that the file belongs to a set that member may see.

## What may be posted

* Past papers, mark schemes and typed versions of them, for study at this school.
* Nothing personal (names, scores, contact details) and nothing that is not exam practice.
* Each set shows who posted it. Posting means the student agrees to this policy.

## Keeping it within the school

* Sets downloaded from the Library are marked as Library sets on the device. DMC will not export them through "Share with friends", the feature for sharing paper sets as files.
* A student's personal backup may include Library sets so the student does not lose them; the backup is labelled private and is for the student's own devices.
* Signing in on another device syncs progress (scores and settings), never the papers themselves; Library sets are downloaded again from the Library.

**This is a deterrent, not DRM.** Anyone who can see a paper on a screen can copy it. These measures make sharing outside the school deliberate rather than accidental, and keep the Library itself closed to outsiders. They do not and cannot make copying impossible.

## Moderation and takedown

* Every set has a **Report** button. Three reports from different members hide the set until an admin looks at it.
* The person who posted a set can delete it at any time.
* Admins (the owner first) can remove any set instantly from the admin panel. A removed set disappears for everyone at once; its files are deleted from storage 7 days later, once nothing else uses them.
* **Takedown requests** (from the school, Cambridge, or anyone with a reason) go to the owner, Josef Yang, at school or through the Head of Cambridge. The owner removes the set the same day.
* If the school withdraws its agreement, the owner switches the Library off (Admin > School domains > remove `stjbs.sch.id`, and empty the allowlist, which locks it for everyone at once) and deletes the stored sets.

## What is stored, and where

* Accounts: email address, display name (from the email, editable), Google account ID, and whether Google says it belongs to the school. No passwords: Google handles sign-in.
* Library: each set's files (question papers, mark schemes, typed questions, images, an optional cover; each file stored once), its name, description, subject, paper and question counts, version, the poster's display name, star counts and reports.
* Sync (any signed-in account; on by default for school accounts, off for personal ones, and anyone can switch it off in Settings): session results, question statistics, small settings and fixes. Never PDFs.
* Daily download and upload counts per account, so admins can see storage and bandwidth use. AI import sends only the pages a person chooses, with their consent, to NVIDIA's API; nothing is kept.
* Hosted on Cloudflare, in the student council's account: the app and its server run on Cloudflare Workers, the database on Cloudflare D1 and the files on Cloudflare R2, both created with an Asia-Pacific location hint. Cloudflare's terms and data processing addendum apply (cloudflare.com/terms, cloudflare.com/cloudflare-customer-dpa). Every access rule is part of the app's source code (`worker/`) and tested automatically.
* The database is backed up every night (kept 7 days, plus 4 weekly copies) into the same private storage.
* No analytics, tracking or advertising.

## Owner's note

The Head of Cambridge's agreement to run the Library inside the school should be kept in writing (an email is enough), together with any conditions attached to it. The Library should be switched off if that agreement ends.
