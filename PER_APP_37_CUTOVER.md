# Per App 37 — Handover

**From:** Per App 36 (deploys 36 (1) to 36 (25), 4–7 October 2026)
**Repo:** github.com/PerNorrgren/per_bot — HEAD at handover is `6bedbcc`, "Per App 36 (25)". Everything below marked as shipped is live.
**Stack:** Node/Express, sql.js SQLite on the Railway volume (`/app/db/perbot.db`), Cloudflare R2, Scaleway email, Twilio SMS, Stripe, ElevenLabs, Deepgram, Anthropic, BulkPublish.
**Deploy:** `bash ~/Downloads/deploy.sh` from Per's Mac.

---

## 1. Start of session checklist

1. Clone fresh: `git clone --depth 1 https://github.com/PerNorrgren/per_bot`. Confirm HEAD is `6bedbcc` or later.
2. Before building on any fix, grep the freshly pulled file to prove it landed.
3. Take the deploy.sh shipped with this handover as the base. Never rewrite it from scratch.
4. Every new file needs **both** a `copy_if_present` line **and** a `STAGE_CANDIDATES` entry, or it copies to disk and never commits.
5. Update `EXPECTED_FILES` and `COMMIT_MSG` every round. Always present deploy.sh with every batch, even if only those two changed.

## 2. Standing rules (unchanged, still binding)

- Never `git add -A`. deploy.sh stages an explicit list only.
- Every `/api` response defaults to `Cache-Control: no-store` (36 (1)). Keep it that way for anything new.
- Client pollers gate on login state and stop on 401.
- Long jobs (many AI calls, big files) use the background-job pattern: reply at once with a job id, then poll every 2 seconds.
- Every action button gets the yin/yang spinner and a popup on completion.
- Every error message says exactly what to do, as plain steps, and never points to a list somewhere else.
- No "brake" or "Moro" in any reader-facing or client-facing text (Rule 23).
- `updateCampaign`-style functions filter on `fields[k] !== undefined`, never only `Object.keys(fields)`.

---

## 3. What shipped in Per App 36

### Client app and UI
- **36 (1)** Home-screen shelf headings became white pill buttons opening full list pages (Practices, Courses, Popular Practices, Poems, Posts, Books). Live Meetings heading opens a Live Meetings page. Every shelf row is draggable on desktop, with ‹ › arrows for mouse and trackpad. `/api` defaults to `no-store`. deploy.sh: Dockerfile-changed false positive fixed, stranded-commit push added, `=====` end marker.
- **36 (4)** The background scene shows through the glass again: veil 0.22, glass tint 0.40, 3px photo blur, 70-second Ken Burns drift. CSS variables cover both normal and idle states.
- **36 (5)** Display > Background slider (0–100), live while dragging, saved to `users.a11y_scene_level` and applied before first paint.
- **36 (6)** Display menu anchored `right:0` so it opens leftwards; max-height and scroll for Larger text.
- **36 (8)** Full audio player: elapsed, "of total" and time left; skip ±15/30s; speed 0.75×–1.5×; lock-screen Media Session controls. A silent-practice timer lives inside the player: chips and slider, remembered per track, starts automatically when the track ends, big countdown, bell from the library or a built-in synth, and it keeps running with the screen locked (keep-alive silence stream).
- **36 (10)** Timer panel shows a "✓ Timer is set" status box; "Start the timer now instead" is the secondary choice.
- **36 (11)** "Bell at start" option removed.
- **36 (12)** "Take the whole course offline" works for self-paced courses, shows the size and remembers its state. Lesson-level marking is still there. Batch save (one database write).
- **36 (13)** Background sound for silent practice: three generated sounds (brown noise, ocean swells, rain) plus uploaded `timer_music` recordings. Volume slider, Hear it button, fade in and out, seamless loops, remembered.

### Live meetings
- **36 (2)** Day and time per meeting (UK time). Reminders on Wednesday at 11:00 and 20:00 for the Thursday 06:30 practice. Settings editor with Save, "Send reminder now" and a recent reminder log; all buttons have spinner and popup. The client page shows the next date, reminder times and a Join button.
- **36 (3)** Reminders go to everyone on file, not only members, each with a turn-off link. New column `users.pref_email_live_meetings`; `/live-meeting-reminders/:token` page with a POST-only opt-out.

### Content admin and courses
- **36 (7)** "Add Library files as lessons" on course detail. Groups by Day N / Week N / Module N / "Before you begin". Upload completion says "Next — organise into lessons" when Course is ticked. Lessons follow leading-number order. Done popup with counts.
- **36 (9)** New message type `enrolment_confirmed_self_paced`; self-paced instances send a different welcome email.
- **36 (14)** Course-instance emails saved as format `rich` (was `html`), existing rows migrated; the Comms editor carries text across the Plain/Rich switch.
- **36 (25)** Email editor button tool: the hidden native colour picker (Chrome never fired `change`) replaced by `chooseButtonColor()`, a small dialog with live preview, 8 swatches, an any-colour picker, Insert and Cancel, Enter and Escape.

### Social publishing (BulkPublish)
- **36 (15–18)** Strict per-platform channel choice: the app refuses or warns if a channel isn't chosen or isn't visible. Hourly health check with email and SMS alert. Per-day UK-time slots with content themes (`day_slots` column). Bluesky and X added; any new BulkPublish platform now works without code. `PLATFORM_ALIASES` normalise `twitter→x` and `bsky→bluesky`.
- **36 (19–21)** Posting plans seeded for Threads, Bluesky, Facebook, LinkedIn, Instagram and X, each with per-day UK slots and themes. Slot posting type is `calming` or `sales`. Email plan: newsletter Tue 10:30, Thu 20:00 and Sun 20:00 (calming only); launch Tue–Thu 13:30 and Fri 18:00 (sales only, skipped silently when no launch is running). Trial emails at 07:00 Europe/London.
- **Channels saved:** LinkedIn "Per Norrgren" (132), Facebook "Per Norrgren – Deeper Mindfulness" (267), Instagram "deepermindfulness" (268), Threads "deepermindfulness" (923), X "DeeperMind2024" (925), Bluesky "deepermindfulness.bsky.social" (927).
- **Prompt rules in `prompts.js`:** Facebook, LinkedIn and X never put URLs in the post text (link goes in the first comment); Instagram says "link in bio" and is written to be forwarded; X under 260 characters and bookmark-worthy; LinkedIn framed as focus, burnout and resilience, not spiritual; Bluesky under 280 characters.

### Retreat course
"Personal Retreat 2 Day - FELT Way": 32 ElevenLabs tracks uploaded, tagged `retreat`, placed as lessons. Each track guides in and ends; the person then sits with the built-in timer, which starts by itself, rings a bell at the end, and can play a background sound.

---

## 4. Database crisis, 4 October 2026 — what it was and what now protects us

**What happened.** At 08:27 the user count dropped to 0. The boot log showed "app_config seeded with defaults" and "Admin created". The cause: `save()` used `writeFileSync()`, which truncates the 40 MB live file to zero and then writes. Railway sends SIGTERM on every deploy and Node, with no handler, exited at once. A stop mid-write left an empty file, and the next boot opened it and seeded a fresh database.

**Recovery.** Restored `perbot-backup-2026-10-04.db` (taken at 01:00, before the reset): 389 users, all six channel choices intact.

**Protections now live (36 (22–24)):**
- **Atomic save:** write to `perbot.db.tmp`, fsync, rename over the live file. An interrupted save leaves the previous database whole.
- **SIGTERM / SIGINT handler:** one clean save, then exit.
- **Volume mount guard:** on Railway, `/app/db` must appear in `/proc/self/mountinfo` before any database is opened; waits 23 seconds, then maintenance mode.
- **Empty database refusal:** `looksLikeRealDatabase()` checks `app_config`, `users` and a user count above 0. Anything that fails is refused with code `DB_EMPTY`.
- **Auto-restore:** on `DB_EMPTY`, tries the newest 7 nightly R2 backups, uses the first good one, and sends a "restored automatically" email and SMS.
- **Boot alerts without a database:** `sendBootAlert()` goes straight to Scaleway and Twilio. Phone from the `ADMIN_PHONE` env variable (now set) or `alert-contacts.json` on the volume (written every 3 minutes by the health check).
- **Repo hygiene:** `db/perbot.db` untracked (it was never meant to be in git); `.dockerignore` excludes `db/*.db` and `db/*.db-*`.

**Still running in parallel:** nightly R2 backups at 01:00 (7 daily / 5 weekly / 12 monthly), the low-user-count alarm, and Railway's own backup schedule.

---

## 5. What is left — open items for Per App 37

| # | Item | Notes |
|---|---|---|
| 1 | Lesson done-popup should name the lesson | Today it says "1 lesson". |
| 2 | Weekly update email: AI generation must not start by itself | It must wait for the Generate button. |
| 3 | ~12 `updateCampaign`-style functions still use `Object.keys(fields)` | Switch to `fields[k] !== undefined`. Real risk of blanking columns. |
| 4 | Feature Guide and Feature List docs not updated for Per App 36 | `PER_BOT_FEATURE_GUIDE.md` (plain language, by audience) and `PER_BOT_FEATURE_LIST.md` (engineering). Section 3 above is the source. |
| 5 | Kindle URLs for *The Wired Heart* and *The Alarm* | Waiting on Per. |
| 6 | Port the database safety layers to the Mare App | Atomic save, SIGTERM handler, mount guard, empty-DB refusal and auto-restore apply equally to `mare_app` if it uses the same sql.js save pattern. Add to the Mare bug-fix log. |
| 7 | First live check of the auto-restore path | Built, but never yet triggered in production. A dry run against a copy is worth doing. |

Not app work, but tracked here for context: HFPM Lesson 11 change-notes pass is still needed.

---

## 6. Coming next: "Practise with Per"

The new articulation programme, *Taking Your Place*, needs a practice tool in the app. Full design is in the separate **Articulation handover**. In short, for the app build:

1. **Set the scene:** who, what you want to say, and what you fear will happen.
2. **Settle:** a short spoken settle in Per's voice (ElevenLabs).
3. **Speak:** spoken role-play (Deepgram in, ElevenLabs out). Per plays the other person at three levels (gentle, realistic, challenging). A **Pause** button steps out of the role for coaching. The hard moment can be replayed.
4. **Take it in:** guided reflection afterwards, with one line saved to a private noticing log.
5. **Card for tomorrow:** first line, key sentence, and an "If they ___, then I'll ___" plan.
6. **Follow-up:** the user gives the time of the real event; the app checks in a few hours later ("What did you expect, and what happened?").

**Safeguards from day one:** if the other person is described as threatening, controlling or abusive, no confrontation practice; switch to safety and support. Distress is noticed and signposted. Clear disclosure that it is AI, not Per live. Logs private to the user.

Suggested first build: scene, spoken rehearsal with Pause, and the follow-up check-in. Talk to Per, Deepgram, ElevenLabs and the email and SMS reminders already exist, so this is mostly new screens, one new prompt, and two tables (`practice_sessions`, `noticing_log`).
