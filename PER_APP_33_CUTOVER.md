# Per App 33 — Cutover Handover

Continues directly from Per App 32 (course registration hardening, certificate/attendance system, Live Course discovery card). This session covered: launch-day bug hunting across the registration and course pages, a major campaign-scheduling architecture fix, and four new public marketing pages built from scratch.

---

## Registration & course pages — bugs found and fixed this session

- **Blank screen after registering** — real root cause found, not a registration bug at all. `#start` (the audio-unlock "tap to begin" overlay) defaulted to `display:flex` (visible) in its own CSS and only got hidden by an async config check completing. For a brief window on every fresh page load it was visible and tappable even though the app is configured for calm landing — tapping it during that window ran the old non-calm-landing conversation-start flow, a mismatched path. Fixed by flipping the CSS default to hidden with an explicit else-branch for the genuine fallback (calm-landing-off) case.
- **Registration confirmation popup** — simplified wording, auto-redirects to splash after 1.8s instead of requiring a manual click (kept as fallback). The Enrol Now path previously showed no confirmation at all — now uses the same popup as the form-based flow.
- **Price shown to existing members** — `checkAlreadyLoggedIn()` now hides the price next to Enrol Now for a genuine member who won't be charged (same trial-vs-paid distinction used elsewhere).
- **Membership grant gap** — `attemptEnrolUser`'s free-enrolment branch never checked/granted `grants_membership_months`, unlike the paid Stripe path right next to it. Fixed (matters for a free/comp'd instance an Explorer could enrol in directly).
- **Courses tab reordering** — Available Courses (live Zoom sorted first) now shows above My Courses, so the actively-promoted course needs no scrolling to find.
- **You/Home activity accordion** — two fixes: (1) cohort vs self-paced instances of the same course now show distinctly via `instance_title` instead of sharing an identical "X% complete" subtitle; (2) a nested nested scroll container was trapping scroll gestures — removed. (3) Per's own request: the Courses section in this accordion now just opens the real Courses tab directly instead of maintaining a second, more limited duplicate list.
- **Admin: Remove enrolment** — new button in the Enrolments modal to un-register someone from an instance (testing, or a genuine cancellation). Deliberately plain — deletes the enrolment and its own records (lesson progress, quiz attempts, session attendance, certificate) only, doesn't touch Stripe or membership tier. `deleteEnrolment` updated to also clean up `session_attendance` and `certificates`, two tables that didn't exist when it was first written.
- **Practices carousel** — three fixes: instant (non-animated) loop-back instead of a visible full-width slide-backward; resume-after-touch delay 6s → 4s; genuine mouse click-drag scrolling added (browsers don't provide this natively for a scroll container the way touch swipe already works).

## Popular Practices (new feature)

Top 5 practices by real plays, ranked from `content_history` (already logs every play event — no new tracking needed). Admin can pin any practice to guarantee inclusion, overriding the automatic ranking; pinned items still sort among themselves by play count. New `library_files.popular_pinned` column. Client: new shelf on the splash screen, cross-referenced against tier-access already computed for the main content list (a locked practice shows the same lock/upgrade treatment as everywhere else). Admin: "⭐ Popular Practices" button in the Library toolbar opens a management view with real play counts and a pin/unpin tick per row.

## Four new public marketing pages

All follow the same visual pattern: the same rotating Ken Burns-style backdrop already established on `register.html`, dark glass panels, no login required.

- **`/samurai`** — "The Modern Samurai" landing page. Lists content by **tag** (not the Categories admin field — a real, corrected mix-up this session; tags and categories are separate systems). Listen/Read + separate Download on each item, via a public signed-URL endpoint that re-checks the tag itself (never a general "any file id" backdoor). Download fixed to genuinely force-download (fetches as blob first — `<a download>` doesn't reliably work cross-origin, which is what R2's signed URLs are).
- **`/welcome`** — the main app marketing page. This *is* "the app itself" page — confirmed with Per, no separate page needed.
- **`/wired-heart`** — real chapter list (14 chapters, confirmed directly against the current manuscript, including the one title that was initially a best-guess reconstruction from a truncated filename — later confirmed exact). Real quotes pulled from the actual current manuscript, not fabricated.
- **`/alarm`** — real nine-part structure (Parts One through Nine, plus "5½ — The Auditor"), confirmed from a newer complete manuscript (`Alarm_5x8_v7_KDP`) found via project search that wasn't in the original source material used to build the page's first draft.

Both book pages: **"Read Book In App"** → `/register` (both ebooks are already readable in-app), **"Buy Book"** → external Kindle link, hidden entirely until a real URL is set (checks for the `#` placeholder automatically). No admin panel for any of these four pages — Per's own call, one-off pages regenerated by asking directly if something needs to change.

**Still needed from Per:** real KDP/Kindle links for both books, to un-hide the Buy Book buttons.

## Campaign video script generator (new feature)

New "✨ Generate scripts" button next to the existing manual "+ Add video." Takes what's being sold, optional seed material (paste a book excerpt, blog post, course description — anything), and how many video slots, and generates that many titled scripts in one pass via `anthropicFetch` (thinking disabled for reliable JSON). System prompt embeds the two established marketing pillars from this whole session — nervous-system-through-the-body as where wellness is heading, belonging/never-left-alone — with an explicit instruction to vary the angle across scripts rather than writing N versions of the same pitch, and to paraphrase from seed material rather than reproducing it. New endpoint: `POST /api/admin/campaigns/:id/generate-video-scripts`.

## Campaign scheduling — major architecture fix

**Root cause found:** BulkPublish's Free plan caps at **10 scheduled posts total**. `/activate` used to pre-schedule every pending social step with BulkPublish's own future-dated scheduling API the moment a campaign went live. A campaign with 10 videos across up to 3 channels each creates ~30 individual steps (one per channel per video — ticking multiple channels in the admin UI creates a separate step for each), so the first ~10 succeeded and the rest failed on quota, not a connection problem.

**Fixed properly, not worked around:** social steps now behave exactly like email steps already did — left `pending` at go-live, picked up by a new daily cron (`sendDueCampaignSocialSteps`, mirrors `sendDueCampaignEmailSteps` exactly, 07:55 UTC) that fires only whatever's due that specific day, immediately, via the existing `publishToChannel` registry (`fireCampaignSocialStep`, shared by `/activate`'s immediate-fire, `/resume`'s immediate-fire, and the cron). At any moment BulkPublish only ever sees the handful of posts due today — sidesteps the quota entirely regardless of plan tier or campaign size. Per has since upgraded to BulkPublish Pro anyway, but this architecture is the right one regardless of plan.

**Campaign's own Link now auto-appends** to every step's content at publish time (`fireCampaignSocialStep` looks up the campaign fresh and appends `promotes_url` if not already present in the content) — Per's request, so a whole campaign's worth of already-written scripts never need hand-editing to add the actual registration link. Works for every future campaign too.

**Resume button added** — a paused campaign previously had no way back at all (fell into a generic `else` branch showing only "Close"). Now resets any failed steps to pending, resumes, and immediately fires anything already overdue rather than waiting up to 24 hours for the next cron run.

## Two real bugs in `updateCampaign` / `setCampaignStatus` (found while fixing the above)

1. **`WHERE ... AND status='draft'` blocked Goal/Promoting/Link from ever saving once a campaign went active**, with zero error shown. Split the WHERE clause — only `name`/`offer_id`/`audience`/`source_tag` (genuinely risky to change campaign logic mid-flight) keep the draft-only restriction; `goal`/`promotes_label`/`promotes_url` are safe metadata and now save regardless of status.
2. **The actual, deeper root cause of a 500 error even after fix #1**: `Object.keys(fields)` includes a key even when its value is `undefined` (`{name: undefined}` still has a real `name` key), and the PATCH route always destructures all six possible fields from `req.body` regardless of what was actually sent — so a save that only ever touched goal/link still *looked* like it touched name/offer/audience too, re-triggering the draft-only restriction incorrectly. Very likely the actual crash cause too: those undefined values were being passed as real SQL bind parameters, which most SQL libraries reject outright (unlike `null`). Fixed at the root: `updateCampaign` now filters on an actually-defined value, not just key presence.

**⚠️ Known follow-up, not yet done:** the exact same `Object.keys(fields).filter(k => allowed.includes(k))` pattern (without the `!== undefined` check) exists in **at least 12 other update functions** across `db.js`. Deliberately not touched this session to avoid rushing 12 individual verifications under launch-day time pressure. Worth a proper audit once things settle — each one needs checking whether its actual callers ever pass a mix of defined/undefined fields in a way that would trigger the same class of bug.

`setCampaignStatus('active')` had the identical WHERE-clause-too-narrow bug shape (only matched `status='draft'`, so resuming a paused campaign silently did nothing) — fixed alongside the Resume button work, without resetting `started_at` on resume (every step's `offset_days` counts from the *original* go-live moment, not whenever it was paused/resumed).

## deploy.sh — infrastructure fixes this session

- **Stale git lock auto-clearing.** Per's repo lives inside a OneDrive-synced folder; OneDrive's background sync can transiently touch/lock files inside `.git`, producing spurious "File exists" errors even with no real concurrent git process. Deploy script now sweeps *any* `.lock` file anywhere under `.git` (not just `index.lock` — `HEAD.lock` and `objects/maintenance.lock` have both been hit in practice), removes anything older than 2 minutes automatically with a clear log line, leaves anything fresher in place in case something's genuinely still running. Tested thoroughly (fresh/stale/nested scenarios) before shipping.
- **STAGE_CANDIDATES gap found and fixed.** New HTML/asset files were being copied to disk via `copy_if_present` but never added to `STAGE_CANDIDATES` (the separate list of files actually eligible for git staging) — meaning they'd copy successfully but never actually get committed. Found while wiring up `/samurai`; the certificate logo/signature images from earlier this session had the exact same gap (they were only "working" because they'd persisted on disk, never because they were version-controlled). All fixed; new files added this session were added to `STAGE_CANDIDATES` correctly from the start.

## Pending — repo relocation (paused, not urgent)

Per's `per_bot` repo lives inside a OneDrive-synced folder, which is the root cause of the recurring stale-lock issue (the auto-clear fix above handles it either way, but moving the repo removes the cause entirely). Plan agreed: `cp -R` (not `mv` — a first `mv` attempt timed out on OneDrive's Files-On-Demand needing to fully download thousands of small `.git/objects` files; original folder confirmed still fully intact afterward) from the OneDrive path to `~/Developer/per_bot`, verify with `git status`, then update `deploy.sh`'s `PROJECT_ROOT` to the new path. **Per has explicitly deferred this until after the Finding Mindfulness launch** — nothing broken in the meantime, deploy.sh works fine from the current location.

## Noted, explicitly deferred by Per

- **Email delivery retry/alerting.** Per's own words: "email sending fails and get stuck, never retries... I need to have an email about this please should something stop." Explicitly "for later" — not built this session. Worth scoping properly once the launch settles: likely a cron check for stuck/repeatedly-failing sends, with an admin alert email.

## Still outstanding from earlier sessions (unchanged, for reference)

- Certificate images not showing correctly in the editor / Certificates admin page going blank — parked, not urgent (certificates aren't needed until courses actually complete, ~10 weeks out).
- Facilitator email on registration, first-login welcome message — not built, nice-to-haves.
- Course messaging system (facilitator → group) — on the to-do list.
- The 12-other-instances `Object.keys(undefined)` audit noted above.

## Key established conventions from this session (for consistency going forward)

- **Tags vs Categories are separate systems.** Tags (`library_file_tags`) drive the themed practice carousel and now the Samurai page. Categories (a different admin field) are unrelated. Easy to conflate — confirmed this the hard way.
- **Marketing page pattern**: Ken Burns CSS backdrop (reuses the same curated Unsplash set as `register.html`), dark glass panels, no admin panel for one-off pages — regenerate by asking directly.
- **Every new file needs both `copy_if_present` AND `STAGE_CANDIDATES` entries** in deploy.sh, or it copies to disk but never gets committed.
- **`updateCampaign`-style functions**: filter on `fields[k] !== undefined`, never just `Object.keys(fields).includes(k)`, when a caller might destructure more fields than it actually received.
