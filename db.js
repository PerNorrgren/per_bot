const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'db', 'perbot.db');
let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  // ── App configuration (Path A: one deployment per facilitator/org) ──
  // Single-row settings for THIS deployment's brand identity and business
  // rules. Deliberately holds no secrets — Stripe/Brevo/DB credentials stay
  // as Railway env vars, never entered through a web form or stored here.
  // payments_enabled lets a facilitator opt out of Stripe entirely; when
  // false, pricing/checkout UI hides throughout the app rather than just
  // failing gracefully when Stripe isn't configured.
  db.run(`CREATE TABLE IF NOT EXISTS app_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    brand_name TEXT NOT NULL DEFAULT 'Deeper Mindfulness',
    tagline TEXT NOT NULL DEFAULT 'Making the practices land and last for life.',
    primary_color TEXT NOT NULL DEFAULT '#B4E6C8',
    logo_url TEXT,
    contact_email TEXT,
    currency TEXT NOT NULL DEFAULT 'gbp',
    legal_entity_name TEXT NOT NULL DEFAULT 'Per Norrgren trading as Deeper Mindfulness',
    legal_jurisdiction TEXT NOT NULL DEFAULT 'United Kingdom',
    payments_enabled INTEGER NOT NULL DEFAULT 1,
    setup_completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Facilitators ──
  db.run(`CREATE TABLE IF NOT EXISTS facilitators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'facilitator',
    must_change_password INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Categories ──
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    parent_id TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES categories(id)
  )`);

  // ── FILE LIBRARY (single source of truth) ──
  db.run(`CREATE TABLE IF NOT EXISTS library_files (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    category_id TEXT,
    subcategory_id TEXT,
    visibility TEXT DEFAULT 'client',
    storage_type TEXT DEFAULT 'disk',
    archived INTEGER DEFAULT 0,
    facilitator_resource INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (subcategory_id) REFERENCES categories(id)
  )`);

  // ── Courses ──
  db.run(`CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    category_id TEXT,
    subcategory_id TEXT,
    guest_visible INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (subcategory_id) REFERENCES categories(id)
  )`);

  // ── Lessons ──
  db.run(`CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    lesson_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    visibility TEXT DEFAULT 'client',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (course_id) REFERENCES courses(id)
  )`);

  // ── Lesson → Library file references ──
  db.run(`CREATE TABLE IF NOT EXISTS lesson_file_refs (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (lesson_id) REFERENCES lessons(id),
    FOREIGN KEY (file_id) REFERENCES library_files(id)
  )`);

  // ── Course instances ──
  // A specific offering of a course. mode='self_paced' has no dates/capacity —
  // open-ended enrolment. mode='cohort' is a scheduled group run with a start/
  // end date and (optionally) a capacity; its live meetings live in
  // instance_sessions below. Price is one-off and only ever charged to
  // Explorers — Members enrol free regardless of price_cents (enforced at
  // enrolment time, not here, since tier can change after an instance exists).
  db.run(`CREATE TABLE IF NOT EXISTS course_instances (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'self_paced',
    title TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    capacity INTEGER,
    price_cents INTEGER DEFAULT 0,
    stripe_price_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (course_id) REFERENCES courses(id)
  )`);

  // ── Enrolments ──
  // One row per user per instance. payment_status: 'free' (Member — always
  // free regardless of instance price), 'paid' (Explorer who completed
  // checkout), 'pending' (Explorer mid-checkout — see Stripe webhook).
  // A user cannot have two enrolments in the same instance (UNIQUE below).
  db.run(`CREATE TABLE IF NOT EXISTS enrolments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    course_instance_id TEXT NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'free',
    amount_paid_cents INTEGER DEFAULT 0,
    stripe_payment_intent_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    enrolled_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    UNIQUE(user_id, course_instance_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (course_instance_id) REFERENCES course_instances(id)
  )`);

  // ── Lesson progress ──
  // One row per lesson per enrolment. last_position is a free-text resume
  // pointer (e.g. a lesson_file_refs id, or a timestamp within an audio file)
  // — deliberately generic so the resume mechanism isn't locked to one
  // content type. % complete for a course is derived at query time from
  // completed-count / total-lessons, not stored, so it's never stale.
  db.run(`CREATE TABLE IF NOT EXISTS lesson_progress (
    id TEXT PRIMARY KEY,
    enrolment_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started',
    last_position TEXT,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(enrolment_id, lesson_id),
    FOREIGN KEY (enrolment_id) REFERENCES enrolments(id),
    FOREIGN KEY (lesson_id) REFERENCES lessons(id)
  )`);

  // ── Cohort live sessions ──
  // Scheduled meetings for a mode='cohort' instance. facilitator_notes is
  // private; handout is what students see for that specific session.
  db.run(`CREATE TABLE IF NOT EXISTS instance_sessions (
    id TEXT PRIMARY KEY,
    course_instance_id TEXT NOT NULL,
    session_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    scheduled_at TEXT,
    facilitator_notes TEXT DEFAULT '',
    handout TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (course_instance_id) REFERENCES course_instances(id)
  )`);

  // ── Student notes ──
  // A facilitator's private notes on one student within one cohort instance —
  // separate from the clinical `sessions` table, which is 1:1 client work,
  // not tied to a course.
  db.run(`CREATE TABLE IF NOT EXISTS student_notes (
    id TEXT PRIMARY KEY,
    course_instance_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    facilitator_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (course_instance_id) REFERENCES course_instances(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // ── Quizzes ── (Per Bot 5 follow-on — basic quiz support from the start)
  // One quiz per lesson, optional. question_type: 'single_choice' |
  // 'multi_choice' | 'true_false' — the three basic types for v1.
  db.run(`CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL,
    title TEXT NOT NULL,
    pass_threshold_pct INTEGER DEFAULT 70,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lesson_id) REFERENCES lessons(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS quiz_questions (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    question_type TEXT NOT NULL DEFAULT 'single_choice',
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS quiz_options (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    option_text TEXT NOT NULL,
    is_correct INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (question_id) REFERENCES quiz_questions(id)
  )`);
  // One attempt per submission (a user can retake — every attempt is kept,
  // not overwritten, so there's a real history rather than just a latest score).
  db.run(`CREATE TABLE IF NOT EXISTS quiz_attempts (
    id TEXT PRIMARY KEY,
    enrolment_id TEXT NOT NULL,
    quiz_id TEXT NOT NULL,
    score_pct INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    answers_json TEXT DEFAULT '',
    attempted_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (enrolment_id) REFERENCES enrolments(id),
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  )`);

  // ── Playlists ──
  db.run(`CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    category_id TEXT,
    subcategory_id TEXT,
    guest_visible INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (subcategory_id) REFERENCES categories(id)
  )`);

  // ── Playlist → Library file references ──
  db.run(`CREATE TABLE IF NOT EXISTS playlist_track_refs (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    title TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id),
    FOREIGN KEY (file_id) REFERENCES library_files(id)
  )`);

  // ── Users (formerly 'clients') ──
  // Holds everyone who is not a facilitator or admin: Explorers, Members, Clients.
  // member_tier: 0=Explorer(registered), 1=Member1, 2=Member2, 3=Member3
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    facilitator_id TEXT,
    category_id TEXT,
    subcategory_id TEXT,
    arc TEXT DEFAULT '',
    archived INTEGER DEFAULT 0,
    must_change_password INTEGER DEFAULT 1,
    is_system_client INTEGER DEFAULT 0,
    is_client INTEGER DEFAULT 0,
    registered_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    -- Membership
    member_tier INTEGER DEFAULT 0,
    member_since TEXT,
    member_expires_at TEXT,
    trial_ends_at TEXT,
    -- Stripe
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    -- GDPR / consent
    consent_given INTEGER DEFAULT 0,
    consent_date TEXT,
    consent_version TEXT,
    lawful_basis TEXT,
    data_retention_until TEXT,
    -- Communication preferences (all default ON — user can opt out)
    pref_email_motd INTEGER DEFAULT 1,
    pref_email_reminders INTEGER DEFAULT 1,
    pref_email_renewal INTEGER DEFAULT 1,
    pref_email_news INTEGER DEFAULT 1,
    pref_sms INTEGER DEFAULT 0,
    phone TEXT,
    language TEXT DEFAULT 'en',
    FOREIGN KEY (facilitator_id) REFERENCES facilitators(id),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (subcategory_id) REFERENCES categories(id)
  )`);

  // ── Sessions ──
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    facilitator_id TEXT,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    client_summary TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES users(id)
  )`);

  // ── Client practices ──
  db.run(`CREATE TABLE IF NOT EXISTS practices (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT DEFAULT '',
    filename TEXT DEFAULT '',
    is_favourite INTEGER DEFAULT 0,
    use_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES users(id)
  )`);

  // ── Programme assignments ──
  db.run(`CREATE TABLE IF NOT EXISTS programme_assignments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_type TEXT NOT NULL,
    category_id TEXT NOT NULL,
    subcategory_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )`);

  // ── Invitations ──
  db.run(`CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    facilitator_id TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    FOREIGN KEY (facilitator_id) REFERENCES facilitators(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_favourites (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, file_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_playlists (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_playlist_items (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (playlist_id) REFERENCES user_playlists(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS guest_leads (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    source TEXT DEFAULT 'guest_page'
  )`);

  // ── Facilitator requests (Per Bot 5, item 11) ──
  // Member → Facilitator (Member 3) is apply-then-approve, never self-serve —
  // the person has to actually be a member first. user_id is set when the
  // requester was logged in as a member at submission time (auto-filled from
  // their account); it's NULL for anonymous submissions via the public link,
  // which the admin table surfaces clearly so Per can apply his own judgement
  // (approve requires a linked member account — see setMemberTier call site).
  // status: 'pending' | 'approved' | 'declined' | 'deferred' | 'archived'
  db.run(`CREATE TABLE IF NOT EXISTS facilitator_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    decided_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS content_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_type TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content_id TEXT NOT NULL,
    played_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Membership plans — configurable per tier/billing cycle ──
  // trial_days: 0 means no trial for this plan
  db.run(`CREATE TABLE IF NOT EXISTS membership_plans (
    id TEXT PRIMARY KEY,
    tier INTEGER NOT NULL,
    name TEXT NOT NULL,
    billing_cycle TEXT NOT NULL,
    price_pence INTEGER NOT NULL,
    trial_days INTEGER DEFAULT 0,
    stripe_price_id TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Message of the day ──
  // status: 'draft' | 'approved' | 'sent'
  // scheduled_date: ISO date string (YYYY-MM-DD). NULL = send next available day.
  db.run(`CREATE TABLE IF NOT EXISTS messages_of_the_day (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    scheduled_date TEXT,
    status TEXT DEFAULT 'draft',
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Newsletters ── One-off broadcasts to everyone opted into "News and
  // updates" (pref_email_news), regardless of membership tier — distinct
  // from messages_of_the_day, which is a rotating queue of short daily
  // stanzas. A newsletter has a subject line and is manually composed and
  // sent each time (no queue, no auto-advance) since content differs every
  // send rather than drawing from a pre-written pool.
  db.run(`CREATE TABLE IF NOT EXISTS newsletters (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    recipient_count INTEGER,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Legal documents ──
  db.run(`CREATE TABLE IF NOT EXISTS legal_documents (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL,
    requires_consent INTEGER DEFAULT 0,
    published INTEGER DEFAULT 0,
    published_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_legal_slug_version ON legal_documents(slug, version DESC)`);

  // ── Legal document translations — on-demand, not auto-generated ──
  // Unlike the email-template auto-translate cache, these are never served
  // silently: a translation only exists here because someone explicitly
  // requested one via the admin panel, and it stays status='draft' — visible
  // only to admin — until Per has actually read and confirmed it. One row
  // per (document_id, language); re-requesting overwrites the existing draft
  // rather than erroring, so asking again after an edit to the English
  // source is just "generate again, not additive."
  db.run(`CREATE TABLE IF NOT EXISTS legal_translations (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    language TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    requested_note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    published_at TEXT,
    UNIQUE(document_id, language),
    FOREIGN KEY (document_id) REFERENCES legal_documents(id)
  )`);

  // ── User consent records ──
  db.run(`CREATE TABLE IF NOT EXISTS user_legal_consents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL,
    accepted_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, slug, version),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // ── Migrations — add columns to existing tables if they don't exist ──
  // This is how we handle the live database which was created before the full schema
  // above existed. The CREATE TABLE IF NOT EXISTS above handles new installs;
  // these ALTER TABLE statements handle the upgrade path for existing databases.
  const migrations = [
    // library_files columns added after initial schema
    "ALTER TABLE library_files ADD COLUMN visibility_registered INTEGER DEFAULT 0",
    "ALTER TABLE library_files ADD COLUMN visibility_member INTEGER DEFAULT 0",
    "ALTER TABLE library_files ADD COLUMN visibility_client INTEGER DEFAULT 1",
    "ALTER TABLE library_files ADD COLUMN visibility_facilitator INTEGER DEFAULT 0",
    "ALTER TABLE library_files ADD COLUMN storage_type TEXT DEFAULT 'disk'",
    "ALTER TABLE library_files ADD COLUMN archived INTEGER DEFAULT 0",
    "ALTER TABLE library_files ADD COLUMN facilitator_resource INTEGER DEFAULT 0",
    // facilitators
    "ALTER TABLE facilitators ADD COLUMN must_change_password INTEGER DEFAULT 1",
    // sessions
    "ALTER TABLE sessions ADD COLUMN facilitator_id TEXT",
    "ALTER TABLE sessions ADD COLUMN client_summary TEXT DEFAULT ''",
    // trial email sequence + inactivity reminder dedupe (Per Bot 5, items 4 & 8)
    "ALTER TABLE users ADD COLUMN trial_email_day3_sent INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN trial_email_day10_sent INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN trial_email_day14_sent INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN last_reminder_sent_at TEXT",
    // Facilitator WebSocket Stage 2 (Per Bot 5, item 9) — the AI-generated
    // client-facing summary lands here as a draft. It only becomes visible to
    // the client (via client_summary) once the facilitator explicitly releases
    // it — see releaseSession(). Editing/regenerating the draft never touches
    // client_summary, so nothing can leak to the client before release.
    "ALTER TABLE sessions ADD COLUMN client_summary_draft TEXT DEFAULT ''",
    // Per-user MOTD delivery schedule (Per Bot 6, item: choose day/time for
    // daily message + SMS). Days are comma-separated JS getUTCDay() values,
    // 0=Sunday..6=Saturday. Hour is 0-23 UTC. Defaults match the brief:
    // every day, 09:00 UTC. motd_last_sent_date dedupes against the hourly
    // cron firing more than once inside a user's chosen hour.
    "ALTER TABLE users ADD COLUMN motd_days TEXT DEFAULT '0,1,2,3,4,5,6'",
    "ALTER TABLE users ADD COLUMN motd_hour INTEGER DEFAULT 9",
    "ALTER TABLE users ADD COLUMN motd_last_sent_date TEXT",
    // Inactivity reminder settings — previously hardcoded (4 days, fixed
    // subject line) even though the admin panel showed editable fields for
    // both; those fields never actually persisted anywhere. Real now.
    "ALTER TABLE app_config ADD COLUMN reminder_days INTEGER DEFAULT 4",
    "ALTER TABLE app_config ADD COLUMN reminder_subject TEXT DEFAULT 'Whenever you''re ready'",
    // Per-type SMS preferences (Per Bot 6) — previously a single pref_sms
    // column existed, but was only ever wired up for MOTD, which made it
    // impossible to want SMS for reminders without also getting it for the
    // daily message. Newsletter deliberately has no SMS variant — SMS has
    // a hard length limit and no formatting, so a newsletter's actual
    // content wouldn't survive the trip; email-only is a real constraint
    // there, not an oversight.
    "ALTER TABLE users ADD COLUMN pref_sms_motd INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN pref_sms_reminders INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN pref_sms_renewal INTEGER DEFAULT 0",
    // Renewal reminders (Per Bot 6) — genuinely new, not previously built.
    // pref_email_renewal/pref_email_news existed as columns before this,
    // but nothing ever sent anything for renewal — this migration and the
    // tracking column below are what make it a real feature rather than a
    // dormant toggle. renewal_reminder_sent_for stores the expiry date the
    // reminder was already sent for, not just a timestamp — since
    // member_expires_at itself changes every renewal cycle, comparing
    // against it directly means the reminder naturally re-arms itself each
    // cycle without needing separate reset logic.
    "ALTER TABLE users ADD COLUMN renewal_reminder_sent_for TEXT",
    "ALTER TABLE app_config ADD COLUMN renewal_reminder_days INTEGER DEFAULT 5",
    "ALTER TABLE app_config ADD COLUMN renewal_reminder_subject TEXT DEFAULT 'Your membership renews soon'",
    // Rich newsletters (Per Bot 6) — format tells the send/render pipeline
    // whether `body` is plain text (apply \n->br the same as always) or
    // already-HTML from the rich editor (render as-is). newsletter_footer is
    // an admin-editable template appended to every send, holding the
    // {{unsubscribe_link}} placeholder — see ensureUnsubscribeToken below.
    // Without a REAL one-click unsubscribe, newsletter-only contacts (no
    // password, no login) would have no way to ever opt out, since the only
    // other path — My Account — requires logging in.
    "ALTER TABLE newsletters ADD COLUMN format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN newsletter_footer TEXT",
    "ALTER TABLE users ADD COLUMN unsubscribe_token TEXT",
    // Newsletter audience targeting — comma-separated segment keys (see
    // getNewsletterRecipients below), defaults to 'all' for any pre-existing
    // rows so nothing already sent silently reinterprets who it went to.
    "ALTER TABLE newsletters ADD COLUMN audience TEXT DEFAULT 'all'",
    // Optional in general, but becomes required the moment a user wants MOTD
    // email or SMS on — see the PATCH /api/account validation in server.js.
    // motd_hour is interpreted IN THIS TIMEZONE once it's set, not UTC.
    "ALTER TABLE users ADD COLUMN timezone TEXT",
    // Magic-link invites (Per Bot 6) — lets a newsletter-only contact click
    // one personalised link and land as a real Member, trial clock starting
    // at the moment THEY click, not when the newsletter was sent or the
    // token was generated. invite_token_used_at guards against the same
    // link being replayed later to restart the trial.
    "ALTER TABLE users ADD COLUMN invite_token TEXT",
    "ALTER TABLE users ADD COLUMN invite_token_used_at TEXT",
    // Tracks which approved message is "today's" active message — see
    // sendScheduledMotd() in server.js. Stays 'approved' (not 'sent') while
    // active so different users can still receive it across their own
    // scheduled hours on the same calendar day.
    "ALTER TABLE messages_of_the_day ADD COLUMN activated_date TEXT",
    // ── clients → users rename migration ──
    // SQLite cannot rename tables in older versions, so we use a copy-and-rename
    // approach via the migration block below. Handled separately after this list.
  ];
  migrations.forEach(sql => {
    try { db.run(sql); } catch(e) { /* column already exists — ignore */ }
  });

  // Must run after migrations, not with the other CREATE INDEX statements
  // above — invite_token doesn't exist until the migration above adds it.
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users(invite_token)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_unsubscribe_token ON users(unsubscribe_token)`);

  // ── Backfill: existing notification-opted-in users get a default timezone ──
  // Timezone is now required for anyone receiving MOTD email/SMS (see
  // PATCH /api/account), but users who opted in before this column existed
  // would otherwise silently stop receiving anything the moment this deploys
  // — the scheduled sender only considers users with a timezone set. Rather
  // than let that happen invisibly, default them to Europe/London (Per's own
  // base) so delivery continues exactly as before until/unless they change
  // it themselves in My Account. New sign-ups get no default — they're
  // required to actively choose a timezone before turning notifications on.
  try {
    db.run(`UPDATE users SET timezone='Europe/London' WHERE timezone IS NULL AND (pref_email_motd=1 OR pref_sms=1)`);
  } catch(e) { /* ignore */ }

  // pref_sms used to be the only SMS preference, wired up exclusively for
  // MOTD — carry forward anyone who'd already opted in so this restructure
  // doesn't silently opt them out of something they'd turned on.
  try {
    db.run(`UPDATE users SET pref_sms_motd=1 WHERE pref_sms=1 AND (pref_sms_motd IS NULL OR pref_sms_motd=0)`);
  } catch(e) { /* ignore */ }

  // ── clients → users table migration ──
  // If the old 'clients' table still exists and 'users' does not yet have any rows
  // (i.e., this is the first boot after upgrading), copy all rows across and drop
  // the old table. If 'users' already has rows, the migration already ran.
  try {
    const oldExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='clients'");
    const hasOldTable = oldExists.length && oldExists[0].values.length;
    if (hasOldTable) {
      // Copy existing rows into users. Map old column names to new ones.
      // member_tier derives from old is_member + membership_level:
      //   membership_level='registered' or is_member=0 → tier 0
      //   is_member=1 and membership_level='member' (or anything) → tier 1 (Member1)
      db.run(`INSERT OR IGNORE INTO users
        (id, name, email, password_hash, facilitator_id, category_id, subcategory_id,
         arc, archived, must_change_password, is_system_client, is_client,
         registered_at, created_at,
         member_tier, consent_given, consent_date, consent_version, lawful_basis, data_retention_until)
        SELECT
          id, name, email, password_hash, facilitator_id, category_id, subcategory_id,
          arc, archived, must_change_password,
          COALESCE(is_system_client, 0),
          COALESCE(is_client, 0),
          COALESCE(registered_at, created_at), created_at,
          CASE WHEN COALESCE(is_member,0)=1 THEN 1 ELSE 0 END,
          COALESCE(consent_given, 0),
          consent_date, consent_version, lawful_basis, data_retention_until
        FROM clients`);
      db.run(`DROP TABLE clients`);
      console.log('[db] clients table migrated to users and dropped.');
    }
  } catch(e) {
    // clients table doesn't exist or migration already done — fine
  }

  // Seed app config if empty — must happen before legal documents, since
  // legal doc seeding reads this deployment's identity to substitute into
  // the templates.
  const existingConfig = queryAll('SELECT id FROM app_config LIMIT 1');
  if (!existingConfig.length) seedAppConfig();

  // Seed categories if empty
  const existing = queryAll('SELECT id FROM categories LIMIT 1');
  if (!existing.length) seedCategories();

  // Seed default membership plans if empty
  const existingPlans = queryAll('SELECT id FROM membership_plans LIMIT 1');
  if (!existingPlans.length) seedMembershipPlans();

  // Seed legal documents if empty
  const existingLegal = queryAll('SELECT id FROM legal_documents LIMIT 1');
  if (!existingLegal.length) seedLegalDocuments();

  save();
  return db;
}

function seedCategories() {
  const cats = [
    { id:'cat-mindfulness',  name:'Mindfulness',      slug:'mindfulness',       parent_id:null,             sort_order:1 },
    { id:'cat-felt',         name:'FELT·FIBRE',        slug:'felt-fibre',        parent_id:null,             sort_order:2 },
    { id:'cat-girls',        name:'Girls Programme',   slug:'girls-programme',   parent_id:null,             sort_order:3 },
    { id:'cat-therapy',      name:'Therapy',           slug:'therapy',           parent_id:null,             sort_order:4 },
    { id:'sub-mfl',          name:'Mindfulness for Life', slug:'mindfulness-for-life', parent_id:'cat-mindfulness', sort_order:1 },
    { id:'sub-mbct',         name:'MBCT',              slug:'mbct',              parent_id:'cat-mindfulness', sort_order:2 },
    { id:'sub-mbsr',         name:'MBSR',              slug:'mbsr',              parent_id:'cat-mindfulness', sort_order:3 },
    { id:'sub-mind-intro',   name:'Introduction',      slug:'mindfulness-intro', parent_id:'cat-mindfulness', sort_order:4 },
    { id:'sub-deeper',       name:'Deeper Mindfulness', slug:'deeper-mindfulness',parent_id:'cat-mindfulness', sort_order:5 },
    { id:'sub-felt-intro',   name:'Introduction',      slug:'felt-intro',        parent_id:'cat-felt',        sort_order:1 },
    { id:'sub-felt-prac',    name:'Practitioner',      slug:'felt-practitioner', parent_id:'cat-felt',        sort_order:2 },
    { id:'sub-finding-calm', name:'Finding Calm',      slug:'finding-calm',      parent_id:'cat-felt',        sort_order:3 },
    { id:'sub-finding-joy',  name:'Finding Joy',       slug:'finding-joy',       parent_id:'cat-felt',        sort_order:4 },
    { id:'sub-girls-y',      name:'Younger Girls',     slug:'girls-younger',     parent_id:'cat-girls',       sort_order:1 },
    { id:'sub-girls-o',      name:'Older Girls',       slug:'girls-older',       parent_id:'cat-girls',       sort_order:2 },
    { id:'sub-cbt',          name:'CBT',               slug:'cbt',               parent_id:'cat-therapy',     sort_order:1 },
    { id:'sub-felt-therapy', name:'FELT·FIBRE Therapy',slug:'felt-therapy',      parent_id:'cat-therapy',     sort_order:2 },
    { id:'sub-therapy-gen',  name:'General',           slug:'therapy-general',   parent_id:'cat-therapy',     sort_order:3 },
  ];
  cats.forEach(c => {
    db.run('INSERT OR IGNORE INTO categories (id,name,slug,parent_id,sort_order) VALUES (?,?,?,?,?)',
      [c.id, c.name, c.slug, c.parent_id, c.sort_order]);
  });
}

function seedMembershipPlans() {
  // Three tiers × three billing cycles, no trial by default.
  // Prices in pence (GBP). Stripe price IDs are empty — set via Admin once Stripe is wired.
  const plans = [
    { id:'plan-m1-monthly', tier:1, name:'Member 1 — Monthly',  billing_cycle:'monthly',  price_pence:999,   trial_days:0 },
    { id:'plan-m1-annual',  tier:1, name:'Member 1 — Annual',   billing_cycle:'annual',   price_pence:9900,  trial_days:0 },
    { id:'plan-m1-once',    tier:1, name:'Member 1 — Lifetime', billing_cycle:'lifetime', price_pence:19900, trial_days:0 },
    { id:'plan-m2-monthly', tier:2, name:'Member 2 — Monthly',  billing_cycle:'monthly',  price_pence:1499,  trial_days:0 },
    { id:'plan-m2-annual',  tier:2, name:'Member 2 — Annual',   billing_cycle:'annual',   price_pence:14900, trial_days:0 },
    { id:'plan-m2-once',    tier:2, name:'Member 2 — Lifetime', billing_cycle:'lifetime', price_pence:29900, trial_days:0 },
    { id:'plan-m3-monthly', tier:3, name:'Member 3 — Monthly',  billing_cycle:'monthly',  price_pence:1999,  trial_days:0 },
    { id:'plan-m3-annual',  tier:3, name:'Member 3 — Annual',   billing_cycle:'annual',   price_pence:19900, trial_days:0 },
    { id:'plan-m3-once',    tier:3, name:'Member 3 — Lifetime', billing_cycle:'lifetime', price_pence:39900, trial_days:0 },
  ];
  plans.forEach(p => {
    db.run(`INSERT OR IGNORE INTO membership_plans (id,tier,name,billing_cycle,price_pence,trial_days,active)
      VALUES (?,?,?,?,?,?,1)`, [p.id, p.tier, p.name, p.billing_cycle, p.price_pence, p.trial_days]);
  });
}

function save() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function getDbSync() {
  if (!db) throw new Error('DB not initialised');
  return db;
}

function rowsToObjects(result) {
  return result.values.map(row => {
    const obj = {};
    result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function queryOne(sql, params = []) {
  const result = getDbSync().exec(sql, params);
  if (!result.length || !result[0].values.length) return null;
  return rowsToObjects(result[0])[0];
}

function queryAll(sql, params = []) {
  const result = getDbSync().exec(sql, params);
  if (!result.length) return [];
  return rowsToObjects(result[0]);
}

// ── Facilitators ──
function createFacilitator(id, name, email, passwordHash, role = 'facilitator') {
  getDbSync().run('INSERT INTO facilitators (id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
    [id, name, email.toLowerCase(), passwordHash, role]);
  save();
}
function getFacilitatorByEmail(email) { return queryOne('SELECT * FROM facilitators WHERE email=?', [email.toLowerCase()]); }
function getFacilitatorById(id) { return queryOne('SELECT * FROM facilitators WHERE id=?', [id]); }
function updateFacilitatorPassword(id, hash) {
  getDbSync().run('UPDATE facilitators SET password_hash=?,must_change_password=0 WHERE id=?', [hash, id]); save();
}
function deleteFacilitator(id) { getDbSync().run('DELETE FROM facilitators WHERE id=?', [id]); save(); }
function archiveFacilitator(id) {
  getDbSync().run("UPDATE facilitators SET role='facilitator_archived' WHERE id=?", [id]); save();
}
function unarchiveFacilitator(id) {
  getDbSync().run("UPDATE facilitators SET role='facilitator' WHERE id=?", [id]); save();
}
function updateFacilitatorDetails(id, name, email) {
  getDbSync().run('UPDATE facilitators SET name=?,email=? WHERE id=?', [name, email.toLowerCase(), id]); save();
}
function getAllAdmins() {
  return queryAll("SELECT id,name,email,role,must_change_password,created_at FROM facilitators WHERE role='admin' ORDER BY name ASC");
}
function getAllFacilitators(includeArchived=false) {
  if (includeArchived) {
    return queryAll("SELECT id,name,email,role,must_change_password,created_at FROM facilitators WHERE role!='admin' ORDER BY name ASC");
  }
  return queryAll("SELECT id,name,email,role,must_change_password,created_at FROM facilitators WHERE role='facilitator' ORDER BY name ASC");
}

// ── Categories ──
function getAllCategories() { return queryAll('SELECT * FROM categories ORDER BY sort_order ASC, name ASC'); }
function getTopCategories() { return queryAll('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY sort_order ASC'); }
function getSubcategories(parentId) { return queryAll('SELECT * FROM categories WHERE parent_id=? ORDER BY sort_order ASC', [parentId]); }
function createCategory(id, name, slug, parentId, sortOrder) {
  getDbSync().run('INSERT INTO categories (id,name,slug,parent_id,sort_order) VALUES (?,?,?,?,?)',
    [id, name, slug, parentId || null, sortOrder || 0]); save();
}
function renameCategory(id, name) {
  getDbSync().run('UPDATE categories SET name=? WHERE id=?', [name, id]); save();
}
function deleteCategory(id) { getDbSync().run('DELETE FROM categories WHERE id=?', [id]); save(); }

// ── Library files ──
function addLibraryFile(id, title, description, filename, originalName, fileType, fileSize, categoryId, subcategoryId, visibility, storageType, facilitatorResource) {
  getDbSync().run(`INSERT INTO library_files
    (id,title,description,filename,original_name,file_type,file_size,category_id,subcategory_id,visibility,storage_type,facilitator_resource)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, title, description||'', filename, originalName, fileType, fileSize||0,
     categoryId, subcategoryId||null, visibility||'client', storageType||'disk', facilitatorResource ? 1 : 0]);
  save();
}
function getLibraryFile(id) { return queryOne('SELECT * FROM library_files WHERE id=?', [id]); }
function getLibraryFiles(filters = {}) {
  let sql = `SELECT f.*,
    cat.name as category_name, sub.name as subcategory_name,
    (SELECT COUNT(*) FROM lesson_file_refs WHERE file_id=f.id) +
    (SELECT COUNT(*) FROM playlist_track_refs WHERE file_id=f.id) as use_count
    FROM library_files f
    LEFT JOIN categories cat ON f.category_id=cat.id
    LEFT JOIN categories sub ON f.subcategory_id=sub.id
    WHERE 1=1`;
  const params = [];
  if (!filters.includeArchived) sql += ' AND f.archived=0';
  if (filters.categoryId)    { sql += ' AND f.category_id=?';    params.push(filters.categoryId); }
  if (filters.subcategoryId) { sql += ' AND f.subcategory_id=?'; params.push(filters.subcategoryId); }
  if (filters.visibility)    { sql += ' AND f.visibility=?';     params.push(filters.visibility); }
  if (filters.search)        { sql += ' AND (f.title LIKE ? OR f.original_name LIKE ?)';
    params.push('%'+filters.search+'%', '%'+filters.search+'%'); }
  sql += ' ORDER BY f.created_at DESC';
  return queryAll(sql, params);
}
function updateLibraryFile(id, fields) {
  const allowed = ['title','description','category_id','subcategory_id','visibility'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k}=?`).join(', ');
  if (!sets) return;
  getDbSync().run(`UPDATE library_files SET ${sets} WHERE id=?`, [...Object.values(fields).filter((v,i) => allowed.includes(Object.keys(fields)[i])), id]);
  save();
}
function renameLibraryFile(id, filename) {
  getDbSync().run('UPDATE library_files SET filename=? WHERE id=?', [filename, id]); save();
}
function archiveLibraryFile(id, archived) {
  getDbSync().run('UPDATE library_files SET archived=? WHERE id=?', [archived ? 1 : 0, id]); save();
}
function deleteLibraryFile(id) {
  getDbSync().run('DELETE FROM lesson_file_refs WHERE file_id=?', [id]);
  getDbSync().run('DELETE FROM playlist_track_refs WHERE file_id=?', [id]);
  getDbSync().run('DELETE FROM library_files WHERE id=?', [id]);
  save();
}
function getFileUsage(fileId) {
  const lessons   = queryAll(`SELECT l.title as lesson_title, c.title as course_title
    FROM lesson_file_refs r JOIN lessons l ON r.lesson_id=l.id JOIN courses c ON l.course_id=c.id
    WHERE r.file_id=?`, [fileId]);
  const playlists = queryAll(`SELECT p.title as playlist_title
    FROM playlist_track_refs r JOIN playlists p ON r.playlist_id=p.id
    WHERE r.file_id=?`, [fileId]);
  return { lessons, playlists };
}

// ── Courses ──
function createCourse(id, title, description, categoryId, subcategoryId, guestVisible) {
  getDbSync().run('INSERT INTO courses (id,title,description,category_id,subcategory_id,guest_visible) VALUES (?,?,?,?,?,?)',
    [id, title, description||'', categoryId, subcategoryId||null, guestVisible?1:0]); save();
}
function updateCourse(id, title, description, categoryId, subcategoryId, guestVisible) {
  getDbSync().run('UPDATE courses SET title=?,description=?,category_id=?,subcategory_id=?,guest_visible=? WHERE id=?',
    [title, description||'', categoryId, subcategoryId||null, guestVisible?1:0, id]); save();
}
function getCourse(id) { return queryOne('SELECT * FROM courses WHERE id=?', [id]); }
function getAllCourses(filters = {}) {
  let sql = `SELECT c.*, cat.name as category_name, sub.name as subcategory_name
    FROM courses c
    LEFT JOIN categories cat ON c.category_id=cat.id
    LEFT JOIN categories sub ON c.subcategory_id=sub.id WHERE 1=1`;
  const params = [];
  if (filters.categoryId)    { sql += ' AND c.category_id=?';    params.push(filters.categoryId); }
  if (filters.subcategoryId) { sql += ' AND c.subcategory_id=?'; params.push(filters.subcategoryId); }
  sql += ' ORDER BY cat.sort_order, c.sort_order, c.title';
  return queryAll(sql, params);
}
function deleteCourse(id) {
  const lessons = queryAll('SELECT id FROM lessons WHERE course_id=?', [id]);
  lessons.forEach(l => { getDbSync().run('DELETE FROM lesson_file_refs WHERE lesson_id=?', [l.id]); });
  getDbSync().run('DELETE FROM lessons WHERE course_id=?', [id]);
  getDbSync().run('DELETE FROM courses WHERE id=?', [id]);
  save();
}

// ── Lessons ──
function createLesson(id, courseId, lessonNumber, title, description, visibility) {
  getDbSync().run('INSERT INTO lessons (id,course_id,lesson_number,title,description,visibility) VALUES (?,?,?,?,?,?)',
    [id, courseId, lessonNumber, title, description||'', visibility||'client']); save();
}
function updateLesson(id, lessonNumber, title, description, visibility) {
  getDbSync().run('UPDATE lessons SET lesson_number=?,title=?,description=?,visibility=? WHERE id=?',
    [lessonNumber, title, description||'', visibility||'client', id]); save();
}
function getLessonsForCourse(courseId) {
  return queryAll('SELECT * FROM lessons WHERE course_id=? ORDER BY lesson_number ASC', [courseId]);
}
function getLesson(id) { return queryOne('SELECT * FROM lessons WHERE id=?', [id]); }
function deleteLesson(id) {
  getDbSync().run('DELETE FROM lesson_file_refs WHERE lesson_id=?', [id]);
  getDbSync().run('DELETE FROM lessons WHERE id=?', [id]);
  save();
}

// ── Lesson file refs ──
function addLessonFileRef(id, lessonId, fileId, sortOrder) {
  getDbSync().run('INSERT INTO lesson_file_refs (id,lesson_id,file_id,sort_order) VALUES (?,?,?,?)',
    [id, lessonId, fileId, sortOrder||0]); save();
}
function getFilesForLesson(lessonId) {
  return queryAll(`SELECT r.id as ref_id, r.sort_order, f.*
    FROM lesson_file_refs r JOIN library_files f ON r.file_id=f.id
    WHERE r.lesson_id=? ORDER BY r.sort_order ASC`, [lessonId]);
}
function removeLessonFileRef(refId) {
  getDbSync().run('DELETE FROM lesson_file_refs WHERE id=?', [refId]); save();
}

// ── Course instances ──
function createCourseInstance(id, courseId, mode, title, startDate, endDate, capacity, priceCents, stripePriceId, status) {
  getDbSync().run(
    `INSERT INTO course_instances (id,course_id,mode,title,start_date,end_date,capacity,price_cents,stripe_price_id,status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, courseId, mode||'self_paced', title, startDate||null, endDate||null, capacity||null, priceCents||0, stripePriceId||null, status||'draft']
  );
  save();
}
function getCourseInstance(id) {
  return queryOne(
    `SELECT ci.*, c.title as course_title
     FROM course_instances ci LEFT JOIN courses c ON ci.course_id=c.id
     WHERE ci.id=?`, [id]
  );
}
function getInstancesForCourse(courseId) {
  return queryAll('SELECT * FROM course_instances WHERE course_id=? ORDER BY created_at DESC', [courseId]);
}
function getAllCourseInstances(filters = {}) {
  let sql = `SELECT ci.*, c.title as course_title
    FROM course_instances ci LEFT JOIN courses c ON ci.course_id=c.id WHERE 1=1`;
  const params = [];
  if (filters.status) { sql += ' AND ci.status=?'; params.push(filters.status); }
  if (filters.mode)   { sql += ' AND ci.mode=?';   params.push(filters.mode); }
  sql += ' ORDER BY ci.created_at DESC';
  return queryAll(sql, params);
}
function updateCourseInstance(id, fields) {
  const allowed = ['mode','title','start_date','end_date','capacity','price_cents','stripe_price_id','status'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k));
  if (!sets.length) return;
  getDbSync().run(
    `UPDATE course_instances SET ${sets.map(k=>`${k}=?`).join(',')} WHERE id=?`,
    [...sets.map(k=>fields[k]), id]
  );
  save();
}
function deleteCourseInstance(id) {
  const enrolmentIds = queryAll('SELECT id FROM enrolments WHERE course_instance_id=?', [id]).map(e=>e.id);
  enrolmentIds.forEach(eid => {
    getDbSync().run('DELETE FROM lesson_progress WHERE enrolment_id=?', [eid]);
    getDbSync().run('DELETE FROM quiz_attempts WHERE enrolment_id=?', [eid]);
  });
  getDbSync().run('DELETE FROM enrolments WHERE course_instance_id=?', [id]);
  getDbSync().run('DELETE FROM instance_sessions WHERE course_instance_id=?', [id]);
  getDbSync().run('DELETE FROM student_notes WHERE course_instance_id=?', [id]);
  getDbSync().run('DELETE FROM course_instances WHERE id=?', [id]);
  save();
}

// ── Enrolments ──
// isMember decides payment_status/amount at creation time: Members enrol free
// regardless of the instance's price_cents; Explorers pay what the instance
// charges (amountPaidCents/paymentIntentId come from the completed Stripe
// checkout, or are omitted for a 'pending' row created right before checkout).
function createEnrolment(id, userId, courseInstanceId, paymentStatus, amountPaidCents, stripePaymentIntentId) {
  getDbSync().run(
    `INSERT INTO enrolments (id,user_id,course_instance_id,payment_status,amount_paid_cents,stripe_payment_intent_id)
     VALUES (?,?,?,?,?,?)`,
    [id, userId, courseInstanceId, paymentStatus||'free', amountPaidCents||0, stripePaymentIntentId||null]
  );
  save();
}
function getEnrolment(id) { return queryOne('SELECT * FROM enrolments WHERE id=?', [id]); }
function getEnrolmentForUserAndInstance(userId, courseInstanceId) {
  return queryOne('SELECT * FROM enrolments WHERE user_id=? AND course_instance_id=?', [userId, courseInstanceId]);
}
// For the client's own "My Courses" list — course/instance info plus a live
// % complete computed from lesson_progress, never stored/stale.
function getEnrolmentsForUser(userId) {
  const rows = queryAll(
    `SELECT e.*, ci.title as instance_title, ci.mode, ci.course_id, c.title as course_title
     FROM enrolments e
     JOIN course_instances ci ON e.course_instance_id = ci.id
     JOIN courses c ON ci.course_id = c.id
     WHERE e.user_id=?
     ORDER BY e.enrolled_at DESC`, [userId]
  );
  return rows.map(r => {
    const totalLessons = queryOne('SELECT COUNT(*) as n FROM lessons WHERE course_id=?', [r.course_id]).n;
    const completedLessons = queryOne(
      `SELECT COUNT(*) as n FROM lesson_progress WHERE enrolment_id=? AND status='completed'`, [r.id]
    ).n;
    const percentComplete = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
    return { ...r, total_lessons: totalLessons, completed_lessons: completedLessons, percent_complete: percentComplete };
  });
}
function getEnrolmentsForInstance(courseInstanceId) {
  return queryAll(
    `SELECT e.*, u.name as user_name, u.email as user_email
     FROM enrolments e JOIN users u ON e.user_id = u.id
     WHERE e.course_instance_id=? ORDER BY e.enrolled_at DESC`, [courseInstanceId]
  );
}
function updateEnrolmentPaymentStatus(id, paymentStatus, amountPaidCents, stripePaymentIntentId) {
  getDbSync().run(
    `UPDATE enrolments SET payment_status=?, amount_paid_cents=?, stripe_payment_intent_id=COALESCE(?,stripe_payment_intent_id) WHERE id=?`,
    [paymentStatus, amountPaidCents||0, stripePaymentIntentId||null, id]
  );
  save();
}
function markEnrolmentCompleted(id) {
  getDbSync().run(`UPDATE enrolments SET status='completed', completed_at=datetime('now') WHERE id=?`, [id]);
  save();
}
function deleteEnrolment(id) {
  getDbSync().run('DELETE FROM lesson_progress WHERE enrolment_id=?', [id]);
  getDbSync().run('DELETE FROM quiz_attempts WHERE enrolment_id=?', [id]);
  getDbSync().run('DELETE FROM enrolments WHERE id=?', [id]);
  save();
}

// ── Lesson progress ──
// Insert-or-update in one call — the resume flow calls this every time a
// student opens or finishes a lesson, so it needs to be idempotent per
// (enrolment_id, lesson_id) rather than erroring on a duplicate.
function upsertLessonProgress(id, enrolmentId, lessonId, status, lastPosition) {
  const existing = queryOne('SELECT id FROM lesson_progress WHERE enrolment_id=? AND lesson_id=?', [enrolmentId, lessonId]);
  if (existing) {
    const completedClause = status === 'completed' ? `, completed_at=datetime('now')` : '';
    getDbSync().run(
      `UPDATE lesson_progress SET status=?, last_position=? ${completedClause} WHERE id=?`,
      [status, lastPosition||null, existing.id]
    );
  } else {
    getDbSync().run(
      `INSERT INTO lesson_progress (id,enrolment_id,lesson_id,status,last_position,started_at,completed_at)
       VALUES (?,?,?,?,?,datetime('now'),${status==='completed' ? "datetime('now')" : 'NULL'})`,
      [id, enrolmentId, lessonId, status, lastPosition||null]
    );
  }
  save();
}
function getLessonProgress(enrolmentId, lessonId) {
  return queryOne('SELECT * FROM lesson_progress WHERE enrolment_id=? AND lesson_id=?', [enrolmentId, lessonId]);
}
function getProgressForEnrolment(enrolmentId) {
  return queryAll(
    `SELECT lp.*, l.title as lesson_title, l.lesson_number
     FROM lesson_progress lp JOIN lessons l ON lp.lesson_id = l.id
     WHERE lp.enrolment_id=? ORDER BY l.lesson_number ASC`, [enrolmentId]
  );
}
// The "Continue Lesson X" pointer — the most recently touched in-progress
// lesson if one exists, otherwise the first not-yet-started lesson in course
// order. Returns null only when every lesson in the course is completed.
function getResumePoint(enrolmentId, courseId) {
  const allLessons = queryAll('SELECT id, lesson_number, title FROM lessons WHERE course_id=? ORDER BY lesson_number ASC', [courseId]);
  if (!allLessons.length) return null;
  const progressRows = queryAll('SELECT * FROM lesson_progress WHERE enrolment_id=?', [enrolmentId]);
  const progressByLesson = {};
  progressRows.forEach(p => { progressByLesson[p.lesson_id] = p; });

  const inProgress = progressRows
    .filter(p => p.status === 'in_progress')
    .sort((a,b) => new Date(b.started_at||0) - new Date(a.started_at||0))[0];
  if (inProgress) {
    const lesson = allLessons.find(l => l.id === inProgress.lesson_id);
    return lesson ? { ...lesson, last_position: inProgress.last_position, status: 'in_progress' } : null;
  }
  const nextNotStarted = allLessons.find(l => !progressByLesson[l.id] || progressByLesson[l.id].status === 'not_started');
  if (nextNotStarted) return { ...nextNotStarted, last_position: null, status: 'not_started' };
  return null; // every lesson completed
}

// The single "Continue Lesson X" card for the client dashboard — picks the
// most recently active lesson across ALL of a user's active, incomplete
// enrolments (not just one course). Falls back to enrolled_at for an
// enrolment with no progress yet at all, so a freshly-enrolled course can
// still surface as "start here" rather than being invisible until touched.
function getDashboardResumeCard(userId) {
  const enrolments = getEnrolmentsForUser(userId).filter(e => e.status === 'active' && e.percent_complete < 100);
  if (!enrolments.length) return null;

  let best = null;
  for (const e of enrolments) {
    const resume = getResumePoint(e.id, e.course_id);
    if (!resume) continue;
    let activityTime = e.enrolled_at;
    if (resume.status === 'in_progress') {
      const row = queryOne('SELECT started_at FROM lesson_progress WHERE enrolment_id=? AND lesson_id=?', [e.id, resume.id]);
      if (row?.started_at) activityTime = row.started_at;
    }
    if (!best || new Date(activityTime) > new Date(best.activityTime)) {
      best = {
        lesson_id: resume.id, lesson_title: resume.title, lesson_number: resume.lesson_number,
        last_position: resume.last_position, lesson_status: resume.status,
        enrolment_id: e.id, course_instance_id: e.course_instance_id, course_id: e.course_id,
        course_title: e.course_title, instance_title: e.instance_title,
        percent_complete: e.percent_complete, activityTime,
      };
    }
  }
  return best;
}

// ── Cohort live sessions ──
function addInstanceSession(id, courseInstanceId, sessionNumber, title, scheduledAt, facilitatorNotes, handout) {
  getDbSync().run(
    `INSERT INTO instance_sessions (id,course_instance_id,session_number,title,scheduled_at,facilitator_notes,handout)
     VALUES (?,?,?,?,?,?,?)`,
    [id, courseInstanceId, sessionNumber, title, scheduledAt||null, facilitatorNotes||'', handout||'']
  );
  save();
}
function getSessionsForInstance(courseInstanceId) {
  return queryAll('SELECT * FROM instance_sessions WHERE course_instance_id=? ORDER BY session_number ASC', [courseInstanceId]);
}
function updateInstanceSession(id, fields) {
  const allowed = ['title','scheduled_at','facilitator_notes','handout'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k));
  if (!sets.length) return;
  getDbSync().run(`UPDATE instance_sessions SET ${sets.map(k=>`${k}=?`).join(',')} WHERE id=?`, [...sets.map(k=>fields[k]), id]);
  save();
}
function deleteInstanceSession(id) { getDbSync().run('DELETE FROM instance_sessions WHERE id=?', [id]); save(); }

// ── Student notes ── (facilitator's private notes on a student within a cohort — separate from the clinical `sessions` table)
function addStudentNote(id, courseInstanceId, userId, facilitatorId, note) {
  getDbSync().run(
    'INSERT INTO student_notes (id,course_instance_id,user_id,facilitator_id,note) VALUES (?,?,?,?,?)',
    [id, courseInstanceId, userId, facilitatorId, note]
  );
  save();
}
function getNotesForStudentInInstance(courseInstanceId, userId) {
  return queryAll('SELECT * FROM student_notes WHERE course_instance_id=? AND user_id=? ORDER BY created_at DESC', [courseInstanceId, userId]);
}

// ── Quizzes ──
function createQuiz(id, lessonId, title, passThresholdPct) {
  getDbSync().run('INSERT INTO quizzes (id,lesson_id,title,pass_threshold_pct) VALUES (?,?,?,?)',
    [id, lessonId, title, passThresholdPct||70]);
  save();
}
function getQuiz(id) { return queryOne('SELECT * FROM quizzes WHERE id=?', [id]); }
function getQuizForLesson(lessonId) { return queryOne('SELECT * FROM quizzes WHERE lesson_id=?', [lessonId]); }
function updateQuiz(id, title, passThresholdPct) {
  getDbSync().run('UPDATE quizzes SET title=?,pass_threshold_pct=? WHERE id=?', [title, passThresholdPct||70, id]);
  save();
}
function deleteQuiz(id) {
  const qIds = queryAll('SELECT id FROM quiz_questions WHERE quiz_id=?', [id]).map(q=>q.id);
  qIds.forEach(qid => getDbSync().run('DELETE FROM quiz_options WHERE question_id=?', [qid]));
  getDbSync().run('DELETE FROM quiz_questions WHERE quiz_id=?', [id]);
  getDbSync().run('DELETE FROM quiz_attempts WHERE quiz_id=?', [id]);
  getDbSync().run('DELETE FROM quizzes WHERE id=?', [id]);
  save();
}

function addQuizQuestion(id, quizId, questionText, questionType, sortOrder) {
  getDbSync().run('INSERT INTO quiz_questions (id,quiz_id,question_text,question_type,sort_order) VALUES (?,?,?,?,?)',
    [id, quizId, questionText, questionType||'single_choice', sortOrder||0]);
  save();
}
function getQuestionsForQuiz(quizId) {
  return queryAll('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort_order ASC', [quizId]);
}
function updateQuizQuestion(id, questionText, questionType, sortOrder) {
  getDbSync().run('UPDATE quiz_questions SET question_text=?,question_type=?,sort_order=? WHERE id=?',
    [questionText, questionType, sortOrder||0, id]);
  save();
}
function deleteQuizQuestion(id) {
  getDbSync().run('DELETE FROM quiz_options WHERE question_id=?', [id]);
  getDbSync().run('DELETE FROM quiz_questions WHERE id=?', [id]);
  save();
}

function addQuizOption(id, questionId, optionText, isCorrect, sortOrder) {
  getDbSync().run('INSERT INTO quiz_options (id,question_id,option_text,is_correct,sort_order) VALUES (?,?,?,?,?)',
    [id, questionId, optionText, isCorrect?1:0, sortOrder||0]);
  save();
}
function getOptionsForQuestion(questionId) {
  return queryAll('SELECT * FROM quiz_options WHERE question_id=? ORDER BY sort_order ASC', [questionId]);
}
function updateQuizOption(id, optionText, isCorrect, sortOrder) {
  getDbSync().run('UPDATE quiz_options SET option_text=?,is_correct=?,sort_order=? WHERE id=?',
    [optionText, isCorrect?1:0, sortOrder||0, id]);
  save();
}
function deleteQuizOption(id) { getDbSync().run('DELETE FROM quiz_options WHERE id=?', [id]); save(); }

// Full quiz with questions and their options nested — what the client-facing
// "take this quiz" screen actually needs in one call.
function getFullQuiz(quizId) {
  const quiz = getQuiz(quizId);
  if (!quiz) return null;
  const questions = getQuestionsForQuiz(quizId).map(q => ({
    ...q,
    options: getOptionsForQuestion(q.id),
  }));
  return { ...quiz, questions };
}

// Client-facing version of getFullQuiz — strips is_correct from every option
// before it ever leaves the server. Scoring happens server-side against the
// real data (see the /attempt endpoint), so the client never needs, and must
// never receive, the answer key while taking the quiz.
function getQuizForTaking(quizId) {
  const full = getFullQuiz(quizId);
  if (!full) return null;
  return {
    ...full,
    questions: full.questions.map(q => ({
      ...q,
      options: q.options.map(({ is_correct, ...safe }) => safe),
    })),
  };
}

function recordQuizAttempt(id, enrolmentId, quizId, scorePct, passed, answersJson) {
  getDbSync().run(
    'INSERT INTO quiz_attempts (id,enrolment_id,quiz_id,score_pct,passed,answers_json) VALUES (?,?,?,?,?,?)',
    [id, enrolmentId, quizId, scorePct, passed?1:0, answersJson||'']
  );
  save();
}
function getAttemptsForEnrolment(enrolmentId, quizId) {
  return queryAll('SELECT * FROM quiz_attempts WHERE enrolment_id=? AND quiz_id=? ORDER BY attempted_at DESC', [enrolmentId, quizId]);
}
function getBestAttempt(enrolmentId, quizId) {
  return queryOne('SELECT * FROM quiz_attempts WHERE enrolment_id=? AND quiz_id=? ORDER BY score_pct DESC LIMIT 1', [enrolmentId, quizId]);
}

// ── Playlists ──
function createPlaylist(id, title, description, categoryId, subcategoryId, guestVisible) {
  getDbSync().run('INSERT INTO playlists (id,title,description,category_id,subcategory_id,guest_visible) VALUES (?,?,?,?,?,?)',
    [id, title, description||'', categoryId, subcategoryId||null, guestVisible?1:0]); save();
}
function getPlaylist(id) { return queryOne('SELECT * FROM playlists WHERE id=?', [id]); }
function getAllPlaylists(filters = {}) {
  let sql = `SELECT p.*, cat.name as category_name, sub.name as subcategory_name,
    (SELECT COUNT(*) FROM playlist_track_refs WHERE playlist_id=p.id) as track_count
    FROM playlists p
    LEFT JOIN categories cat ON p.category_id=cat.id
    LEFT JOIN categories sub ON p.subcategory_id=sub.id WHERE 1=1`;
  const params = [];
  if (filters.categoryId) { sql += ' AND p.category_id=?'; params.push(filters.categoryId); }
  sql += ' ORDER BY cat.sort_order, p.sort_order, p.title';
  return queryAll(sql, params);
}
function deletePlaylist(id) {
  getDbSync().run('DELETE FROM playlist_track_refs WHERE playlist_id=?', [id]);
  getDbSync().run('DELETE FROM playlists WHERE id=?', [id]);
  save();
}

// ── Playlist track refs ──
function addPlaylistTrackRef(id, playlistId, fileId, title, sortOrder) {
  getDbSync().run('INSERT INTO playlist_track_refs (id,playlist_id,file_id,title,sort_order) VALUES (?,?,?,?,?)',
    [id, playlistId, fileId, title||'', sortOrder||0]); save();
}
function getTracksForPlaylist(playlistId) {
  return queryAll(`SELECT r.id as ref_id, r.title as track_title, r.sort_order, f.*
    FROM playlist_track_refs r JOIN library_files f ON r.file_id=f.id
    WHERE r.playlist_id=? ORDER BY r.sort_order ASC`, [playlistId]);
}
function removePlaylistTrackRef(refId) {
  getDbSync().run('DELETE FROM playlist_track_refs WHERE id=?', [refId]); save();
}
function updateTrackOrder(refId, sortOrder) {
  getDbSync().run('UPDATE playlist_track_refs SET sort_order=? WHERE id=?', [sortOrder, refId]); save();
}

// ── Users (all non-facilitator accounts) ──
function createUser(id, name, facilitatorId, email, passwordHash, categoryId, subcategoryId, consent) {
  const c = consent || {};
  getDbSync().run(
    `INSERT INTO users
      (id,name,facilitator_id,email,password_hash,category_id,subcategory_id,
       consent_given,consent_date,consent_version,lawful_basis)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, name, facilitatorId, email||null, passwordHash||null, categoryId||null, subcategoryId||null,
      c.consentGiven ? 1 : 0,
      c.consentGiven ? (c.consentDate || new Date().toISOString()) : null,
      c.consentGiven ? (c.consentVersion || null) : null,
      c.lawfulBasis || null
    ]
  ); save();
}

// Keep old name as alias so any code that missed the rename still works
const createClient = createUser;

function getUser(id) { return queryOne('SELECT * FROM users WHERE id=?', [id]); }
const getClient = getUser; // alias

function getUserByEmail(email) {
  if (!email) return null;
  return queryOne('SELECT * FROM users WHERE email=?', [email.toLowerCase()]);
}
const getClientByEmail = getUserByEmail; // alias

function getAllUsers(facilitatorId, includeArchived = false) {
  const sql = includeArchived
    ? 'SELECT * FROM users WHERE facilitator_id=? ORDER BY name ASC'
    : 'SELECT * FROM users WHERE facilitator_id=? AND archived=0 ORDER BY name ASC';
  return queryAll(sql, [facilitatorId]);
}
const getAllClients = getAllUsers; // alias

function getAllUsersAdmin(includeArchived = false) {
  const where = includeArchived ? '' : 'WHERE u.archived=0';
  return queryAll(`SELECT u.*, f.name as facilitator_name, cat.name as category_name, sub.name as subcategory_name
    FROM users u LEFT JOIN facilitators f ON u.facilitator_id=f.id
    LEFT JOIN categories cat ON u.category_id=cat.id
    LEFT JOIN categories sub ON u.subcategory_id=sub.id ${where} ORDER BY u.name ASC`);
}
const getAllClientsAdmin = getAllUsersAdmin; // alias

function updateArc(userId, arc) { getDbSync().run('UPDATE users SET arc=? WHERE id=?', [arc, userId]); save(); }
function archiveClient(id) { getDbSync().run('UPDATE users SET archived=1-archived WHERE id=?', [id]); save(); }
function updateClientPassword(id, hash) {
  getDbSync().run('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', [hash, id]); save();
}
function updateClientEmail(id, email) { getDbSync().run('UPDATE users SET email=? WHERE id=?', [email.toLowerCase(), id]); save(); }
function updateClientProgramme(id, categoryId, subcategoryId) {
  getDbSync().run('UPDATE users SET category_id=?,subcategory_id=? WHERE id=?', [categoryId, subcategoryId||null, id]); save();
}
function updateClientDetails(id, name, email, facilitatorId) {
  getDbSync().run('UPDATE users SET name=?,email=?,facilitator_id=? WHERE id=?',
    [name, email||null, facilitatorId||null, id]);
  save();
}
// Name-only update — updateClientDetails above sets email and facilitator_id
// unconditionally from whatever it's passed, including null, which would
// silently wipe them if you only meant to change the name. Used by the
// invite-claim flow, where only the name might need correcting.
function updateUserName(id, name) {
  getDbSync().run('UPDATE users SET name=? WHERE id=?', [name, id]);
  save();
}
function deleteClient(id) {
  getDbSync().run('DELETE FROM users WHERE id=?', [id]);
  save();
}

// ── Self-registration ──
// Every new registration auto-starts a 14-day, no-card Member 1 trial.
// member_since is set now (trial counts as the start of membership); trial_ends_at
// governs the countdown; member_expires_at stays NULL until/unless they subscribe
// via Stripe. checkTrialExpiry() (called on login) drops them to Explorer if the
// trial lapses with no active subscription.
function registerUser(id, name, email, passwordHash) {
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  getDbSync().run(
    `INSERT INTO users (id,name,email,password_hash,facilitator_id,arc,archived,must_change_password,member_tier,member_since,trial_ends_at,is_client,is_system_client)
     VALUES (?,?,?,NULL,NULL,'',0,0,1,datetime('now'),?,0,1)`,
    [id, name, email.toLowerCase(), trialEndsAt]
  );
  getDbSync().run('UPDATE users SET password_hash=? WHERE id=?', [passwordHash, id]);
  save();
}

// ── Mailing-list import (Per Bot 6) ── Distinct from registerUser: no
// password, no trial, no member_tier — a passive email-only contact who
// subscribed to the newsletter list before Per Bot existed, not someone who
// registered on the platform. Explorer tier (0), opted into news only —
// every other email preference starts OFF, since they never asked for
// daily messages, reminders, or renewal notices; only the newsletter they
// actually signed up for. must_change_password=0 so nothing forces a
// password flow they never started. lawful_basis records plainly that this
// is a carried-over mailing list relationship, not a Per Bot registration —
// factual record-keeping, not a legal opinion on adequacy.
function createMailingListContact(id, name, email) {
  getDbSync().run(
    `INSERT INTO users
       (id,name,email,password_hash,facilitator_id,arc,archived,must_change_password,
        member_tier,is_client,is_system_client,
        pref_email_motd,pref_email_reminders,pref_email_renewal,pref_email_news,pref_sms,
        lawful_basis)
     VALUES (?,?,?,NULL,NULL,'',0,0, 0,0,0, 0,0,0,1,0, 'Existing mailing list — imported, not registered via Per Bot')`,
    [id, name, email.toLowerCase()]
  );
  save();
}

// ── Magic-link invites ──
// One personalised claim link per newsletter-only contact. The token itself
// never expires on a timer — Per's explicit requirement is that clicking it
// two weeks late should still give a full, fresh trial, so the only thing
// that invalidates a token is actually using it (invite_token_used_at).
function ensureInviteToken(userId) {
  const user = getUser(userId);
  if (!user) return null;
  if (user.invite_token) return user.invite_token;
  const token = crypto.randomBytes(24).toString('base64url');
  getDbSync().run('UPDATE users SET invite_token=? WHERE id=?', [token, userId]);
  save();
  return token;
}
function getUserByInviteToken(token) {
  return queryOne('SELECT * FROM users WHERE invite_token=?', [token]);
}
function markInviteTokenUsed(userId) {
  getDbSync().run("UPDATE users SET invite_token_used_at=datetime('now') WHERE id=?", [userId]);
  save();
}

// ── Unsubscribe tokens ── One per user, generated lazily the first time
// it's needed (a newsletter send). Deliberately never expires and never
// gets marked "used" the way invite tokens do — unsubscribing is meant to
// work every time someone clicks it in an old email, not just once.
function ensureUnsubscribeToken(userId) {
  const user = getUser(userId);
  if (!user) return null;
  if (user.unsubscribe_token) return user.unsubscribe_token;
  const token = crypto.randomBytes(24).toString('base64url');
  getDbSync().run('UPDATE users SET unsubscribe_token=? WHERE id=?', [token, userId]);
  save();
  return token;
}
function getUserByUnsubscribeToken(token) {
  return queryOne('SELECT * FROM users WHERE unsubscribe_token=?', [token]);
}

// ── Trial expiry ──
// Called on every login for client-role users. If a trial has lapsed and no paid
// subscription picked it up (no stripe_subscription_id), drop back to Explorer.
// Leaves member_since alone — that's a historical fact, not a current-tier signal.
function checkTrialExpiry(userId) {
  const user = getUser(userId);
  if (!user) return user;
  const trialLapsed = user.trial_ends_at && new Date(user.trial_ends_at) < new Date();
  const noActiveSubscription = !user.stripe_subscription_id;
  if (trialLapsed && noActiveSubscription && user.member_tier > 0) {
    getDbSync().run(
      `UPDATE users SET member_tier=0, trial_ends_at=NULL WHERE id=?`,
      [userId]
    );
    save();
    return getUser(userId);
  }
  return user;
}

// ── Membership ──
// member_tier: 0=Explorer, 1=Member1, 2=Member2, 3=Member3
function setMemberTier(userId, tier, expiresAt, trialEndsAt, stripeCustomerId, stripeSubscriptionId) {
  getDbSync().run(
    `UPDATE users SET
      member_tier=?,
      member_since=COALESCE(member_since, datetime('now')),
      member_expires_at=?,
      trial_ends_at=?,
      stripe_customer_id=COALESCE(?,stripe_customer_id),
      stripe_subscription_id=COALESCE(?,stripe_subscription_id)
    WHERE id=?`,
    [tier, expiresAt||null, trialEndsAt||null, stripeCustomerId||null, stripeSubscriptionId||null, userId]
  );
  save();
}

// ── Manual membership expiry override (Per Bot 5, item 6) ──
// For honouring existing WordPress subscribers migrated by hand: sets
// member_expires_at directly without touching tier, trial_ends_at, or Stripe
// fields — deliberately narrower than setMemberTier, which would otherwise
// clear trial_ends_at as a side effect even when that's not the intent here.
// If member_since isn't set yet (a WordPress import with no trial history),
// this sets it to now so "Member since" has a sensible value to display.
function setMemberExpiry(userId, expiresAt) {
  getDbSync().run(
    `UPDATE users SET
      member_expires_at=?,
      member_since=COALESCE(member_since, datetime('now'))
    WHERE id=?`,
    [expiresAt || null, userId]
  );
  save();
}

// Legacy alias used by existing Admin routes — maps to Member1
function upgradeToMember(userId, level = 'member') {
  const tier = level === 'member' ? 1 : (parseInt(level) || 1);
  setMemberTier(userId, tier, null, null, null, null);
}

function downgradeToExplorer(userId) {
  getDbSync().run(`UPDATE users SET member_tier=0, member_expires_at=NULL, stripe_subscription_id=NULL WHERE id=?`, [userId]);
  save();
}

function markAsClient(userId, facilitatorId) {
  getDbSync().run('UPDATE users SET is_client=1, facilitator_id=? WHERE id=?', [facilitatorId, userId]);
  save();
}
function markAsSystemClient(id) {
  getDbSync().run('UPDATE users SET is_system_client=1, facilitator_id=NULL WHERE id=?', [id]);
  save();
}

// ── User preferences (My Account) ──
function updateUserPreferences(userId, prefs) {
  const allowed = ['pref_email_motd','pref_email_reminders','pref_email_renewal','pref_email_news','pref_sms','pref_sms_motd','pref_sms_reminders','pref_sms_renewal','phone','language','motd_days','motd_hour','timezone'];
  const sets = Object.keys(prefs).filter(k => allowed.includes(k)).map(k => `${k}=?`).join(', ');
  if (!sets) return;
  getDbSync().run(`UPDATE users SET ${sets} WHERE id=?`,
    [...Object.keys(prefs).filter(k => allowed.includes(k)).map(k => prefs[k]), userId]);
  save();
}

// ── Content visibility — cascade model ──
// Explorer(0) < Member1(1) < Member2(2) < Member3(3) < Client(4) < Facilitator(5) < Admin(6)
// NOTE: the visibility column in library_files still uses string names for backwards
// compatibility with the Admin UI. The mapping below converts string → numeric rank.
const LEVEL_RANK = {
  registered: 0,   // Explorer
  member:     1,   // legacy alias → Member1
  member_1:   1,
  member_2:   2,
  member_3:   3,
  client:     4,
  facilitator:5,
  admin:      6,
};

function userMaxLevel(flags) {
  if (flags.isAdmin)        return 6;
  if (flags.isFacilitator)  return 5;
  if (flags.isClient)       return 4;
  const tier = flags.memberTier || 0;
  if (tier >= 3) return 3;
  if (tier >= 2) return 2;
  if (tier >= 1) return 1;
  return 0;
}

function canSeeFile(file, userLevel) {
  const fileLevel = LEVEL_RANK[file.visibility] ?? 0;
  return userLevel >= fileLevel;
}

// Build user flags from a user DB record
function userFlagsFromRecord(userRec, role) {
  return {
    memberTier:    userRec?.member_tier || 0,
    isClient:      userRec?.is_client === 1,
    isFacilitator: role === 'facilitator' || role === 'admin',
    isAdmin:       role === 'admin',
    // legacy isMember flag for any code that still reads it
    isMember:      (userRec?.member_tier || 0) >= 1,
  };
}

function getLibraryFilesForUser(userFlags) {
  const level = userMaxLevel(userFlags);
  const files = queryAll('SELECT * FROM library_files WHERE archived=0 AND facilitator_resource=0 ORDER BY title ASC');
  return files.filter(f => canSeeFile(f, level)).map(f => ({ ...f, accessible: true }));
}

function getAllLibraryFilesWithAccess(userFlags) {
  const level = userMaxLevel(userFlags);
  const files = queryAll('SELECT * FROM library_files WHERE archived=0 AND facilitator_resource=0 ORDER BY title ASC');
  return files.map(f => ({ ...f, accessible: canSeeFile(f, level) }));
}

function getFacilitatorResources() {
  return queryAll(`SELECT f.*, cat.name as category_name, sub.name as subcategory_name
    FROM library_files f
    LEFT JOIN categories cat ON f.category_id=cat.id
    LEFT JOIN categories sub ON f.subcategory_id=sub.id
    WHERE f.archived=0 AND f.facilitator_resource=1
    ORDER BY f.created_at DESC`);
}

function canAccessFile(file, userFlags) {
  if (file.archived) return false;
  return canSeeFile(file, userMaxLevel(userFlags));
}

// ── Sessions ──
function addSession(id, clientId, facilitatorId, type, summary, clientSummary, clientSummaryDraft) {
  getDbSync().run('INSERT INTO sessions (id,client_id,facilitator_id,type,summary,client_summary,client_summary_draft) VALUES (?,?,?,?,?,?,?)',
    [id, clientId, facilitatorId, type, summary, clientSummary||'', clientSummaryDraft||'']); save();
}
function getSessionsForClient(clientId) {
  return queryAll('SELECT * FROM sessions WHERE client_id=? ORDER BY created_at DESC', [clientId]);
}
function getClientSessionsForClient(clientId) {
  return queryAll('SELECT id,type,client_summary,created_at FROM sessions WHERE client_id=? AND client_summary!="" ORDER BY created_at DESC', [clientId]);
}

// ── Facilitator WebSocket Stage 2 — review / edit / regenerate / release ──
function getSessionById(id) {
  return queryOne(
    `SELECT s.*, u.name as client_name, u.email as client_email
     FROM sessions s LEFT JOIN users u ON s.client_id = u.id
     WHERE s.id=?`, [id]
  );
}
function getSessionsForFacilitatorReview(facilitatorId, isAdmin) {
  // Admin sees everything; a facilitator only sees their own sessions — this
  // matches the existing ownership check on /api/clients/:id (user.facilitator_id
  // !== req.user.id → 403), which the original version of this function didn't.
  const where = isAdmin ? '' : 'WHERE s.facilitator_id=?';
  const params = isAdmin ? [] : [facilitatorId];
  return queryAll(
    `SELECT s.id, s.client_id, s.facilitator_id, s.type, s.client_summary, s.client_summary_draft, s.created_at,
            u.name as client_name
     FROM sessions s LEFT JOIN users u ON s.client_id = u.id
     ${where}
     ORDER BY s.created_at DESC`,
    params
  );
}
// Edit — updates the private clinical record and/or the client-facing draft.
// Never touches client_summary, so an edit can never accidentally release.
function updateSessionDraft(id, summary, clientSummaryDraft) {
  const sets = [];
  const params = [];
  if (summary != null)            { sets.push('summary=?');              params.push(summary); }
  if (clientSummaryDraft != null) { sets.push('client_summary_draft=?'); params.push(clientSummaryDraft); }
  if (!sets.length) return;
  params.push(id);
  getDbSync().run(`UPDATE sessions SET ${sets.join(', ')} WHERE id=?`, params);
  save();
}
// Release — copies the (possibly edited) draft into client_summary, which is
// the field getClientSessionsForClient actually reads. This is the moment a
// summary becomes visible on the client's own Sessions tab.
function releaseSession(id) {
  getDbSync().run(`UPDATE sessions SET client_summary = client_summary_draft WHERE id=?`, [id]);
  save();
}
// Unrelease — pulls it back out of client view without losing the draft, in
// case something was released by mistake.
function unreleaseSession(id) {
  getDbSync().run(`UPDATE sessions SET client_summary='' WHERE id=?`, [id]);
  save();
}

// ── Practices ──
function addPractice(id, clientId, title, type, content, filename) {
  getDbSync().run('INSERT INTO practices (id,client_id,title,type,content,filename) VALUES (?,?,?,?,?,?)',
    [id, clientId, title, type, content||'', filename||'']); save();
}
function getPracticesForClient(clientId) {
  return queryAll('SELECT * FROM practices WHERE client_id=? ORDER BY created_at DESC', [clientId]);
}
function toggleFavourite(id) { getDbSync().run('UPDATE practices SET is_favourite=1-is_favourite WHERE id=?', [id]); save(); }
function incrementUseCount(id) { getDbSync().run('UPDATE practices SET use_count=use_count+1 WHERE id=?', [id]); save(); }
function deletePractice(id) { getDbSync().run('DELETE FROM practices WHERE id=?', [id]); save(); }

// ── Programme assignments ──
function assignProgramme(id, userId, userType, categoryId, subcategoryId) {
  getDbSync().run('INSERT OR REPLACE INTO programme_assignments (id,user_id,user_type,category_id,subcategory_id) VALUES (?,?,?,?,?)',
    [id, userId, userType, categoryId, subcategoryId||null]); save();
}
function getProgrammesForUser(userId, userType) {
  return queryAll(`SELECT pa.*, c.name as category_name, s.name as subcategory_name
    FROM programme_assignments pa
    LEFT JOIN categories c ON pa.category_id=c.id
    LEFT JOIN categories s ON pa.subcategory_id=s.id
    WHERE pa.user_id=? AND pa.user_type=?`, [userId, userType]);
}

// ── Content history ──
function recordPlay(id, userId, userType, contentType, contentId) {
  const recent = queryOne(
    `SELECT id FROM content_history
     WHERE user_id=? AND content_id=? AND content_type=?
       AND played_at > datetime('now', '-5 minutes')
     ORDER BY played_at DESC LIMIT 1`,
    [userId, contentId, contentType]
  );
  if (recent) return;
  getDbSync().run('INSERT INTO content_history (id,user_id,user_type,content_type,content_id) VALUES (?,?,?,?,?)',
    [id, userId, userType, contentType, contentId]); save();
}
function getContentHistory(userId, limit = 100) {
  return queryAll(
    `SELECT ch.id, ch.content_type, ch.content_id, ch.played_at,
            lf.title, lf.file_type, lf.category_id, c.name AS category_name
     FROM content_history ch
     LEFT JOIN library_files lf ON ch.content_id = lf.id
     LEFT JOIN categories c ON lf.category_id = c.id
     WHERE ch.user_id = ?
     ORDER BY ch.played_at DESC
     LIMIT ?`,
    [userId, limit]
  );
}

// ── User favourites ──
function addFavourite(id, clientId, fileId) {
  try { getDbSync().run('INSERT OR IGNORE INTO user_favourites (id,client_id,file_id) VALUES (?,?,?)', [id, clientId, fileId]); save(); } catch(e) {}
}
function removeFavourite(clientId, fileId) {
  getDbSync().run('DELETE FROM user_favourites WHERE client_id=? AND file_id=?', [clientId, fileId]); save();
}
function getFavourites(clientId) {
  return queryAll(`SELECT lf.*, 1 as is_favourite FROM library_files lf
    JOIN user_favourites uf ON lf.id = uf.file_id
    WHERE uf.client_id=? ORDER BY uf.created_at DESC`, [clientId]);
}

// ── User playlists ──
function createUserPlaylist(id, clientId, name) {
  getDbSync().run('INSERT INTO user_playlists (id,client_id,name) VALUES (?,?,?)', [id, clientId, name]); save();
}
function getUserPlaylists(clientId) {
  const lists = queryAll('SELECT * FROM user_playlists WHERE client_id=? ORDER BY created_at DESC', [clientId]);
  return lists.map(pl => ({
    ...pl,
    items: queryAll(`SELECT lf.*, upi.sort_order FROM library_files lf
      JOIN user_playlist_items upi ON lf.id=upi.file_id
      WHERE upi.playlist_id=? ORDER BY upi.sort_order ASC`, [pl.id])
  }));
}
function addToUserPlaylist(id, playlistId, fileId, sortOrder) {
  getDbSync().run('INSERT OR IGNORE INTO user_playlist_items (id,playlist_id,file_id,sort_order) VALUES (?,?,?,?)', [id, playlistId, fileId, sortOrder]); save();
}
function removeFromUserPlaylist(playlistId, fileId) {
  getDbSync().run('DELETE FROM user_playlist_items WHERE playlist_id=? AND file_id=?', [playlistId, fileId]); save();
}
function deleteUserPlaylist(id) {
  getDbSync().run('DELETE FROM user_playlist_items WHERE playlist_id=?', [id]);
  getDbSync().run('DELETE FROM user_playlists WHERE id=?', [id]); save();
}
function renameUserPlaylist(id, name) {
  getDbSync().run('UPDATE user_playlists SET name=? WHERE id=?', [name, id]); save();
}

// ── Invitations ──
function createInvitation(id, token, facilitatorId, email, expiresAt) {
  getDbSync().run(
    'INSERT INTO invitations (id,token,facilitator_id,email,expires_at) VALUES (?,?,?,?,?)',
    [id, token, facilitatorId, email.toLowerCase(), expiresAt]
  );
  save();
}
function getInvitationByToken(token) {
  return queryOne('SELECT * FROM invitations WHERE token=?', [token]);
}
function acceptInvitation(token, acceptedAt) {
  getDbSync().run('UPDATE invitations SET accepted_at=? WHERE token=?', [acceptedAt, token]);
  save();
}
function getInvitationsForFacilitator(facilitatorId) {
  return queryAll('SELECT * FROM invitations WHERE facilitator_id=? ORDER BY created_at DESC', [facilitatorId]);
}

// ── Guest leads ──
function addGuestLead(id, name, email, source) {
  getDbSync().run(
    'INSERT OR IGNORE INTO guest_leads (id,name,email,source) VALUES (?,?,?,?)',
    [id, name||null, email||null, source||'guest_page']
  );
  save();
}
function getGuestLeads() { return queryAll('SELECT * FROM guest_leads ORDER BY created_at DESC'); }
function deleteGuestLead(id) { getDbSync().run('DELETE FROM guest_leads WHERE id=?', [id]); save(); }
function getGuestLead(id) { return queryOne('SELECT * FROM guest_leads WHERE id=?', [id]); }

// ── Facilitator requests (Per Bot 5, item 11) ──
function createFacilitatorRequest(id, userId, name, email, message) {
  getDbSync().run(
    'INSERT INTO facilitator_requests (id,user_id,name,email,message,status) VALUES (?,?,?,?,?,?)',
    [id, userId || null, name, email.toLowerCase(), message || null, 'pending']
  );
  save();
}
// A pending request already open for this email — used to block duplicate submissions.
function getPendingFacilitatorRequestByEmail(email) {
  return queryOne(`SELECT * FROM facilitator_requests WHERE email=? AND status='pending'`, [email.toLowerCase()]);
}
// Joins in member_tier/member_since where user_id is set, so the admin table
// can show "Member since X" vs "Not currently a member" without a second query.
function getFacilitatorRequests(status) {
  const where = status ? `WHERE fr.status=?` : '';
  const params = status ? [status] : [];
  return queryAll(
    `SELECT fr.*, u.member_tier, u.member_since
     FROM facilitator_requests fr
     LEFT JOIN users u ON fr.user_id = u.id
     ${where}
     ORDER BY fr.created_at DESC`,
    params
  );
}
function getFacilitatorRequestById(id) {
  return queryOne(
    `SELECT fr.*, u.member_tier, u.member_since
     FROM facilitator_requests fr
     LEFT JOIN users u ON fr.user_id = u.id
     WHERE fr.id=?`, [id]
  );
}
// A member checking their own account page — do they already have a request
// in flight (or a past decision worth showing) so we don't show the button
// again pointlessly.
function getLatestFacilitatorRequestForUser(userId) {
  return queryOne(
    `SELECT * FROM facilitator_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
}
function setFacilitatorRequestStatus(id, status) {
  getDbSync().run(
    `UPDATE facilitator_requests SET status=?, decided_at=datetime('now') WHERE id=?`,
    [status, id]
  );
  save();
}
function deleteFacilitatorRequest(id) { getDbSync().run('DELETE FROM facilitator_requests WHERE id=?', [id]); save(); }

// ── Seed default content categories ──
function seedContentCategories() {
  const existing = queryAll('SELECT * FROM categories WHERE parent_id IS NULL');
  const names = ['Courses', 'One-to-one session material', 'Guided practice tracks', 'Written material and information videos'];
  names.forEach(name => {
    if (!existing.find(c => c.name === name)) {
      const id   = 'seed-' + name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
      const slug = id + '-' + Date.now();
      try { getDbSync().run('INSERT INTO categories (id,name,slug,parent_id,sort_order) VALUES (?,?,?,NULL,0)', [id, name, slug]); save(); } catch(e) {}
    }
  });
}

// ── Membership plans ──
function getMembershipPlans(activeOnly = true) {
  const sql = activeOnly
    ? 'SELECT * FROM membership_plans WHERE active=1 ORDER BY tier ASC, billing_cycle ASC'
    : 'SELECT * FROM membership_plans ORDER BY tier ASC, billing_cycle ASC';
  return queryAll(sql);
}
function updateMembershipPlan(id, fields) {
  const allowed = ['name','price_pence','trial_days','stripe_price_id','active'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k}=?`).join(', ');
  if (!sets) return;
  getDbSync().run(`UPDATE membership_plans SET ${sets} WHERE id=?`,
    [...Object.keys(fields).filter(k => allowed.includes(k)).map(k => fields[k]), id]);
  save();
}

// ── Messages of the day ──
function addMotd(id, body, scheduledDate) {
  getDbSync().run(
    `INSERT INTO messages_of_the_day (id,body,scheduled_date,status) VALUES (?,?,?,'draft')`,
    [id, body, scheduledDate||null]
  );
  save();
}
function getMotd(id) { return queryOne('SELECT * FROM messages_of_the_day WHERE id=?', [id]); }
function getAllMotd(statusFilter) {
  if (statusFilter) return queryAll('SELECT * FROM messages_of_the_day WHERE status=? ORDER BY scheduled_date ASC, created_at ASC', [statusFilter]);
  return queryAll('SELECT * FROM messages_of_the_day ORDER BY scheduled_date ASC, created_at ASC');
}
function approveMotd(id) {
  getDbSync().run("UPDATE messages_of_the_day SET status='approved' WHERE id=?", [id]); save();
}
function updateMotd(id, body, scheduledDate) {
  getDbSync().run('UPDATE messages_of_the_day SET body=?,scheduled_date=? WHERE id=?', [body, scheduledDate||null, id]); save();
}
function deleteMotd(id) {
  getDbSync().run('DELETE FROM messages_of_the_day WHERE id=?', [id]); save();
}
function markMotdSent(id) {
  getDbSync().run("UPDATE messages_of_the_day SET status='sent', sent_at=datetime('now') WHERE id=?", [id]); save();
}
function countApprovedMotd() {
  const result = queryOne("SELECT COUNT(*) as cnt FROM messages_of_the_day WHERE status='approved'");
  return result?.cnt || 0;
}
// Get the next approved MOTD to send (oldest scheduled_date or oldest created_at if no date)
function getNextMotdToSend() {
  return queryOne(
    `SELECT * FROM messages_of_the_day WHERE status='approved'
     ORDER BY
       CASE WHEN scheduled_date IS NOT NULL THEN scheduled_date ELSE '9999-99-99' END ASC,
       created_at ASC
     LIMIT 1`
  );
}
// Get all users who want MOTD emails and have an email address
function getMotdRecipients() {
  return queryAll(`SELECT id,name,email FROM users WHERE pref_email_motd=1 AND email IS NOT NULL AND archived=0`);
}

// ── Per-user scheduled MOTD delivery ──
// "Active" means: the message currently assigned to today's date. It stays
// status='approved' the whole day it's active (not marked 'sent' the moment
// anyone receives it) because different users are due at different hours —
// see sendScheduledMotd() in server.js for the full flow.
function getActiveMotdForDate(dateStr) {
  return queryOne(`SELECT * FROM messages_of_the_day WHERE activated_date=? LIMIT 1`, [dateStr]);
}
// Any message left active from a previous day that never got formally closed
// out (i.e. the server was down at rollover time, or this is the first run
// after deploy). Finds it so the caller can mark it 'sent' before activating
// today's.
function getStaleActiveMotd(todayStr) {
  return queryOne(`SELECT * FROM messages_of_the_day WHERE activated_date IS NOT NULL AND activated_date != ? AND status='approved' LIMIT 1`, [todayStr]);
}
function activateMotd(id, dateStr) {
  getDbSync().run(`UPDATE messages_of_the_day SET activated_date=? WHERE id=?`, [dateStr, id]);
  save();
}
// Candidates for the scheduled MOTD sender: opted into email and/or SMS,
// and — since timezone is required for notifications — has one set. Returns
// everyone eligible; the actual day/hour match happens in JS (server.js,
// sendScheduledMotd) because SQLite has no IANA timezone support, so "is it
// this user's chosen hour right now" can only be computed per-row via
// Intl.DateTimeFormat, not filtered in SQL.
function getMotdNotificationCandidates() {
  return queryAll(
    `SELECT id, name, email, phone, pref_email_motd, pref_sms_motd AS pref_sms, timezone, motd_days, motd_hour, motd_last_sent_date
     FROM users
     WHERE archived=0 AND (pref_email_motd=1 OR pref_sms_motd=1) AND timezone IS NOT NULL AND timezone != ''`
  );
}
function markMotdSentForUser(userId, todayStr) {
  getDbSync().run(`UPDATE users SET motd_last_sent_date=? WHERE id=?`, [todayStr, userId]);
  save();
}

// ── Newsletters ── One-off broadcasts, distinct from the MOTD queue — see
// table comment above for why.
function addNewsletter(id, subject, body, audience, format) {
  getDbSync().run(
    `INSERT INTO newsletters (id,subject,body,status,audience,format) VALUES (?,?,?,'draft',?,?)`,
    [id, subject, body, audience || 'all', format || 'plain']
  );
  save();
}
function getNewsletter(id) { return queryOne('SELECT * FROM newsletters WHERE id=?', [id]); }
function getAllNewsletters() { return queryAll('SELECT * FROM newsletters ORDER BY created_at DESC'); }
function updateNewsletter(id, subject, body, audience, format) {
  getDbSync().run("UPDATE newsletters SET subject=?, body=?, audience=?, format=? WHERE id=? AND status='draft'", [subject, body, audience || 'all', format || 'plain', id]);
  save();
}
function deleteNewsletterDraft(id) {
  getDbSync().run("DELETE FROM newsletters WHERE id=? AND status='draft'", [id]);
  save();
}
function markNewsletterSent(id, recipientCount) {
  getDbSync().run("UPDATE newsletters SET status='sent', sent_at=datetime('now'), recipient_count=? WHERE id=?", [recipientCount, id]);
  save();
}

// ── Newsletter audience segments ──
// The 377-person mailing-list import created accounts at member_tier=0 with
// NO password (createMailingListContact — passive, no login). A real
// Explorer is also member_tier=0, but WITH a password (self-registered, or
// bulk-imported as a real account) — so "newsletter-only" vs "Explorer" is
// distinguished by password_hash, not tier, even though both currently sit
// at the same tier number. This lets Per keep his old list as pure
// newsletter contacts today, and as people get invited to actually join
// (given a password), they automatically graduate into the Explorer segment
// without needing any manual re-tagging.
const NEWSLETTER_AUDIENCE_CLAUSES = {
  newsletter_only: `member_tier=0 AND password_hash IS NULL`,
  explorer:        `member_tier=0 AND password_hash IS NOT NULL`,
  member1:         `member_tier=1`,
  member2:         `member_tier=2`,
  member3:         `member_tier=3`,
};

// segments: array of keys from NEWSLETTER_AUDIENCE_CLAUSES, or the string/array
// containing 'all' for everyone opted in regardless of tier or login status.
function getNewsletterRecipients(segments) {
  const base = `pref_email_news=1 AND email IS NOT NULL AND archived=0`;
  const list = Array.isArray(segments) ? segments : String(segments || 'all').split(',').map(s => s.trim()).filter(Boolean);
  const cols = `id, name, email, (password_hash IS NOT NULL) as has_login`;

  if (!list.length || list.includes('all')) {
    return queryAll(`SELECT ${cols} FROM users WHERE ${base}`);
  }

  const clauses = list.map(s => NEWSLETTER_AUDIENCE_CLAUSES[s]).filter(Boolean);
  if (!clauses.length) return []; // no recognised segment — safer to send nobody than everybody

  return queryAll(`SELECT ${cols} FROM users WHERE ${base} AND (${clauses.join(' OR ')})`);
}

// Get users who haven't been active in the last N days (for reminder emails).
// Deduped: skips anyone reminded in the last 7 days so a persistently inactive
// user gets nudged weekly, not every single day the cron job runs.
function getInactiveUsers(days = 4) {
  return queryAll(
    `SELECT u.id, u.name, u.email, u.phone, u.pref_email_reminders, u.pref_sms_reminders FROM users u
     WHERE (u.pref_email_reminders=1 OR u.pref_sms_reminders=1)
       AND u.archived=0
       AND (u.last_reminder_sent_at IS NULL OR u.last_reminder_sent_at <= datetime('now', '-7 days'))
       AND NOT EXISTS (
         SELECT 1 FROM content_history ch
         WHERE ch.user_id=u.id
           AND ch.played_at > datetime('now', '-${days} days')
       )`,
    []
  );
}
function markReminderSent(userId) {
  getDbSync().run(`UPDATE users SET last_reminder_sent_at=datetime('now') WHERE id=?`, [userId]);
  save();
}

// ── Renewal reminders ── Genuinely new — pref_email_renewal existed as a
// column before this, but nothing ever checked subscription expiry or sent
// anything for it. member_expires_at is kept in sync by the Stripe webhook
// handler (extended on invoice.payment_succeeded, cleared to Explorer on
// cancellation), so it's a reliable field to build this on rather than
// needing a fresh Stripe API call per check. Only matches users with an
// active subscription (stripe_subscription_id set) — lifetime members have
// no expiry to remind about, and someone already dropped to Explorer
// wouldn't have a subscription id left to match on anyway.
function getUpcomingRenewals(daysBefore) {
  return queryAll(
    `SELECT id, name, email, phone, pref_email_renewal, pref_sms_renewal, member_expires_at, member_tier
     FROM users
     WHERE archived=0
       AND (pref_email_renewal=1 OR pref_sms_renewal=1)
       AND stripe_subscription_id IS NOT NULL
       AND member_expires_at IS NOT NULL
       AND date(member_expires_at) = date('now', '+' || ? || ' days')
       AND (renewal_reminder_sent_for IS NULL OR renewal_reminder_sent_for != member_expires_at)`,
    [daysBefore]
  );
}
// Stores the expiry date itself, not just a timestamp — since
// member_expires_at changes every renewal cycle, this naturally re-arms
// for the next cycle without any separate reset step.
function markRenewalReminderSent(userId, expiresAt) {
  getDbSync().run(`UPDATE users SET renewal_reminder_sent_for=? WHERE id=?`, [expiresAt, userId]);
  save();
}

// ── Trial email sequence (Per Bot 5, item 4) ──
// Three touchpoints during the 14-day trial: day 3, day 10, day 14. Each has
// its own "already sent" flag so the cron job can run daily without risking
// a duplicate send — daysSinceStart is measured from member_since, which is
// set at the moment the trial starts (see registerUser). Only fires for
// people still genuinely on trial: tier 1, a trial_ends_at set, and no
// Stripe subscription yet (once they've subscribed, the trial nudges no
// longer apply to them).
const TRIAL_EMAIL_FLAGS = ['trial_email_day3_sent', 'trial_email_day10_sent', 'trial_email_day14_sent'];

function getTrialEmailCandidates(daysSinceStart, flagColumn) {
  if (!TRIAL_EMAIL_FLAGS.includes(flagColumn)) throw new Error('Invalid trial email flag column: ' + flagColumn);
  return queryAll(
    `SELECT id, name, email, trial_ends_at FROM users
     WHERE member_tier=1
       AND trial_ends_at IS NOT NULL
       AND stripe_subscription_id IS NULL
       AND ${flagColumn}=0
       AND email IS NOT NULL
       AND archived=0
       AND member_since IS NOT NULL
       AND datetime(member_since) <= datetime('now', '-${daysSinceStart} days')`
  );
}
function markTrialEmailSent(userId, flagColumn) {
  if (!TRIAL_EMAIL_FLAGS.includes(flagColumn)) throw new Error('Invalid trial email flag column: ' + flagColumn);
  getDbSync().run(`UPDATE users SET ${flagColumn}=1 WHERE id=?`, [userId]);
  save();
}

function getUserByStripeCustomer(stripeCustomerId) {
  return queryOne('SELECT * FROM users WHERE stripe_customer_id=?', [stripeCustomerId]);
}
function getUserByStripeSubscription(stripeSubscriptionId) {
  return queryOne('SELECT * FROM users WHERE stripe_subscription_id=?', [stripeSubscriptionId]);
}

// ── Legal document functions ──

// ── App config (Path A: one deployment per facilitator/org) ──
function getAppConfig() { return queryOne(`SELECT * FROM app_config WHERE id='default'`); }

function updateAppConfig(fields) {
  const allowed = ['brand_name','tagline','primary_color','logo_url','contact_email','currency','legal_entity_name','legal_jurisdiction','payments_enabled','setup_completed','reminder_days','reminder_subject','newsletter_footer','renewal_reminder_days','renewal_reminder_subject'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k));
  if (!sets.length) return;
  getDbSync().run(
    `UPDATE app_config SET ${sets.map(k=>`${k}=?`).join(',')} WHERE id='default'`,
    sets.map(k => fields[k])
  );
  save();
}

function isSetupComplete() {
  const config = getAppConfig();
  return !!(config && config.setup_completed);
}

function seedAppConfig() {
  // An existing deployment (Per's own live site, mid-migration into this
  // feature) already has published legal documents from before app_config
  // existed at all — that's the signal this is NOT a fresh clone, and it
  // must never be redirected to /setup or have its identity reset. A
  // genuinely new clone (Rotterdam Uni, or the next one) has an empty
  // legal_documents table until seedLegalDocuments runs a few lines below
  // this, so it correctly lands as setup_completed=0.
  const alreadyLive = queryAll('SELECT id FROM legal_documents LIMIT 1').length > 0;
  getDbSync().run(
    `INSERT OR IGNORE INTO app_config (id, setup_completed) VALUES ('default', ?)`,
    [alreadyLive ? 1 : 0]
  );
  save();
  console.log(alreadyLive
    ? '[db] app_config seeded — existing deployment detected, setup marked complete.'
    : '[db] app_config seeded with defaults — visit /setup to configure this deployment.');
}

function seedLegalDocuments() {
  try {
    const { buildLegalDocs } = require('./legal_docs_seed');
    const config = getAppConfig();
    const docs = buildLegalDocs({
      legalEntityName: config?.legal_entity_name,
      contactEmail: config?.contact_email,
      legalJurisdiction: config?.legal_jurisdiction,
    });
    docs.forEach(doc => {
      db.run(
        `INSERT OR IGNORE INTO legal_documents
          (id, slug, title, version, content, requires_consent, published, published_at)
         VALUES (?,?,?,?,?,?,1,datetime('now'))`,
        [doc.id, doc.slug, doc.title, doc.version, doc.content, doc.requires_consent ? 1 : 0]
      );
    });
    save();
    console.log('[db] legal documents seeded.');
  } catch(e) {
    console.warn('[db] legal_docs_seed not found — skipping seed:', e.message);
  }
}

function getLegalDocument(slug) {
  return queryOne(
    `SELECT * FROM legal_documents WHERE slug=? AND published=1 ORDER BY version DESC LIMIT 1`,
    [slug]
  );
}

// Fetch one specific document version row by its own id — used by the
// translation endpoints, which operate on "this exact version", not
// necessarily the currently-published one (Per may want to translate a
// draft before publishing it).
function getLegalDocumentById(id) {
  return queryOne('SELECT * FROM legal_documents WHERE id=?', [id]);
}

function getLegalDocumentVersion(slug, version) {
  return queryOne('SELECT * FROM legal_documents WHERE slug=? AND version=?', [slug, version]);
}

function getLegalDocumentHistory(slug) {
  return queryAll('SELECT * FROM legal_documents WHERE slug=? ORDER BY version DESC', [slug]);
}

function getAllCurrentLegalDocuments() {
  return queryAll(
    `SELECT ld.* FROM legal_documents ld
     INNER JOIN (
       SELECT slug, MAX(version) as max_version
       FROM legal_documents WHERE published=1
       GROUP BY slug
     ) latest ON ld.slug=latest.slug AND ld.version=latest.max_version
     ORDER BY ld.title ASC`
  );
}

function getAllLegalDocumentsAdmin() {
  return queryAll(
    `SELECT ld.*,
      (SELECT COUNT(*) FROM user_legal_consents WHERE slug=ld.slug AND version=ld.version) as consent_count
     FROM legal_documents ld
     ORDER BY ld.slug ASC, ld.version DESC`
  );
}

function createLegalDocument(id, slug, title, content, requiresConsent) {
  const current = queryOne('SELECT MAX(version) as v FROM legal_documents WHERE slug=?', [slug]);
  const version = (current?.v || 0) + 1;
  db.run(
    `INSERT INTO legal_documents (id,slug,title,version,content,requires_consent,published)
     VALUES (?,?,?,?,?,?,0)`,
    [id, slug, title, version, content, requiresConsent ? 1 : 0]
  );
  save();
  return version;
}

function updateLegalDocument(id, title, content, requiresConsent) {
  db.run(
    `UPDATE legal_documents SET title=?,content=?,requires_consent=? WHERE id=? AND published=0`,
    [title, content, requiresConsent ? 1 : 0, id]
  );
  save();
}

function publishLegalDocument(id) {
  db.run(`UPDATE legal_documents SET published=1, published_at=datetime('now') WHERE id=?`, [id]);
  save();
}

// Regenerate all five legal documents as new published versions using the
// current app_config identity. Needed because legal docs seed with defaults
// on first boot — before a facilitator has ever reached /setup — so this is
// how their real identity actually lands in the live documents once they
// submit the setup form (or later change legal_entity_name/contact_email/
// jurisdiction from settings). Old versions are never deleted — same
// versioning model the rest of the legal document system already uses, so
// anyone who consented to an earlier version keeps that record.
// generateId: a () => string callback — kept as a parameter rather than
// requiring uuid directly in db.js, since every other create function here
// takes its id from the caller.
function regenerateLegalDocumentsFromConfig(generateId) {
  const { buildLegalDocs } = require('./legal_docs_seed');
  const config = getAppConfig();
  const docs = buildLegalDocs({
    legalEntityName: config?.legal_entity_name,
    contactEmail: config?.contact_email,
    legalJurisdiction: config?.legal_jurisdiction,
  });
  docs.forEach(doc => {
    const id = generateId();
    createLegalDocument(id, doc.slug, doc.title, doc.content, doc.requires_consent);
    publishLegalDocument(id);
  });
}

function deleteLegalDocumentDraft(id) {
  db.run(`DELETE FROM legal_documents WHERE id=? AND published=0`, [id]);
  save();
}

// ── Legal document translations (on-demand, admin-reviewed) ──
function addLegalTranslation(id, documentId, slug, language, title, content, requestedNote) {
  getDbSync().run(
    `INSERT INTO legal_translations (id,document_id,slug,language,title,content,status,requested_note)
     VALUES (?,?,?,?,?,?,'draft',?)
     ON CONFLICT(document_id,language) DO UPDATE SET
       title=excluded.title, content=excluded.content, status='draft',
       published_at=NULL, requested_note=excluded.requested_note, created_at=datetime('now')`,
    [id, documentId, slug, language, title, content, requestedNote || null]
  );
  save();
  return getLegalTranslation(documentId, language);
}
function getLegalTranslation(documentId, language) {
  return queryOne('SELECT * FROM legal_translations WHERE document_id=? AND language=?', [documentId, language]);
}
function getLegalTranslationById(id) {
  return queryOne('SELECT * FROM legal_translations WHERE id=?', [id]);
}
function getLegalTranslationsForDoc(documentId) {
  return queryAll('SELECT * FROM legal_translations WHERE document_id=? ORDER BY language ASC', [documentId]);
}
function updateLegalTranslation(id, title, content) {
  getDbSync().run('UPDATE legal_translations SET title=?, content=? WHERE id=?', [title, content, id]);
  save();
}
function publishLegalTranslation(id) {
  getDbSync().run("UPDATE legal_translations SET status='published', published_at=datetime('now') WHERE id=?", [id]);
  save();
}
function unpublishLegalTranslation(id) {
  getDbSync().run("UPDATE legal_translations SET status='draft', published_at=NULL WHERE id=?", [id]);
  save();
}
function deleteLegalTranslation(id) {
  getDbSync().run('DELETE FROM legal_translations WHERE id=?', [id]);
  save();
}
// Public consumption — the published translation for whichever version of
// this slug is currently live. Returns null if no one's ever requested this
// language, or the translation exists but hasn't been confirmed/published
// yet — callers should fall back to the English original in that case.
function getPublishedLegalTranslation(slug, language) {
  return queryOne(
    `SELECT lt.* FROM legal_translations lt
     JOIN legal_documents ld ON lt.document_id = ld.id
     WHERE ld.slug=? AND ld.published=1 AND lt.language=? AND lt.status='published'
     ORDER BY ld.version DESC LIMIT 1`,
    [slug, language]
  );
}

function recordLegalConsent(id, userId, documentId, slug, version) {
  try {
    db.run(
      `INSERT OR IGNORE INTO user_legal_consents (id,user_id,document_id,slug,version)
       VALUES (?,?,?,?,?)`,
      [id, userId, documentId, slug, version]
    );
    save();
  } catch(e) { /* duplicate */ }
}

function hasUserAcceptedDocument(userId, slug) {
  const current = getLegalDocument(slug);
  if (!current) return true;
  const consent = queryOne(
    'SELECT id FROM user_legal_consents WHERE user_id=? AND slug=? AND version=?',
    [userId, slug, current.version]
  );
  return !!consent;
}

function getPendingConsentsForUser(userId) {
  const docs = getAllCurrentLegalDocuments();
  return docs.filter(doc => {
    if (!doc.requires_consent) return false;
    const consent = queryOne(
      'SELECT id FROM user_legal_consents WHERE user_id=? AND slug=? AND version=?',
      [userId, doc.slug, doc.version]
    );
    return !consent;
  });
}

function getUserConsentHistory(userId) {
  return queryAll(
    `SELECT ulc.*, ld.title FROM user_legal_consents ulc
     LEFT JOIN legal_documents ld ON ulc.document_id=ld.id
     WHERE ulc.user_id=? ORDER BY ulc.accepted_at DESC`,
    [userId]
  );
}

module.exports = {
  getAppConfig, updateAppConfig, isSetupComplete, regenerateLegalDocumentsFromConfig,
  getDb, save,
  // Facilitators
  createFacilitator, getFacilitatorByEmail, getFacilitatorById,
  getAllAdmins, getAllFacilitators, updateFacilitatorPassword, updateFacilitatorDetails,
  archiveFacilitator, unarchiveFacilitator, deleteFacilitator,
  // Categories
  getAllCategories, getTopCategories, getSubcategories,
  createCategory, renameCategory, deleteCategory,
  // Library
  addLibraryFile, getLibraryFile, getLibraryFiles, updateLibraryFile,
  renameLibraryFile, deleteLibraryFile, archiveLibraryFile, getFileUsage,
  // Courses
  createCourse, updateCourse, getCourse, getAllCourses, deleteCourse,
  // Lessons
  createLesson, updateLesson, getLessonsForCourse, getLesson, deleteLesson,
  // Lesson file refs
  addLessonFileRef, getFilesForLesson, removeLessonFileRef,
  // Course instances
  createCourseInstance, getCourseInstance, getInstancesForCourse, getAllCourseInstances,
  updateCourseInstance, deleteCourseInstance,
  // Enrolments
  createEnrolment, getEnrolment, getEnrolmentForUserAndInstance, getEnrolmentsForUser,
  getEnrolmentsForInstance, updateEnrolmentPaymentStatus, markEnrolmentCompleted, deleteEnrolment,
  // Lesson progress
  upsertLessonProgress, getLessonProgress, getProgressForEnrolment, getResumePoint, getDashboardResumeCard,
  // Cohort live sessions
  addInstanceSession, getSessionsForInstance, updateInstanceSession, deleteInstanceSession,
  // Student notes
  addStudentNote, getNotesForStudentInInstance,
  // Quizzes
  createQuiz, getQuiz, getQuizForLesson, updateQuiz, deleteQuiz, getFullQuiz, getQuizForTaking,
  addQuizQuestion, getQuestionsForQuiz, updateQuizQuestion, deleteQuizQuestion,
  addQuizOption, getOptionsForQuestion, updateQuizOption, deleteQuizOption,
  recordQuizAttempt, getAttemptsForEnrolment, getBestAttempt,
  // Playlists
  createPlaylist, getPlaylist, getAllPlaylists, deletePlaylist,
  // Playlist track refs
  addPlaylistTrackRef, getTracksForPlaylist, removePlaylistTrackRef, updateTrackOrder,
  // Users (primary names)
  createUser, getUser, getUserByEmail, getAllUsers, getAllUsersAdmin,
  // Users (legacy aliases — keep so nothing breaks during transition)
  createClient, getClient, getClientByEmail, getAllClients, getAllClientsAdmin,
  // User management
  updateArc, archiveClient, updateClientPassword, updateClientEmail, updateClientProgramme,
  updateClientDetails, updateUserName, deleteClient,
  // Membership
  setMemberTier, setMemberExpiry, upgradeToMember, downgradeToExplorer, markAsClient, markAsSystemClient,
  // Preferences
  updateUserPreferences, userFlagsFromRecord,
  // Sessions
  addSession, getSessionsForClient, getClientSessionsForClient,
  getSessionById, getSessionsForFacilitatorReview, updateSessionDraft, releaseSession, unreleaseSession,
  // Practices
  addPractice, getPracticesForClient, toggleFavourite, incrementUseCount, deletePractice,
  // Programmes
  assignProgramme, getProgrammesForUser,
  // History
  recordPlay, getContentHistory,
  // Content categories seed
  seedContentCategories,
  // Favourites
  addFavourite, removeFavourite, getFavourites,
  // User playlists
  createUserPlaylist, getUserPlaylists, addToUserPlaylist, removeFromUserPlaylist, deleteUserPlaylist, renameUserPlaylist,
  // Registration
  registerUser, createMailingListContact,
  ensureInviteToken, getUserByInviteToken, markInviteTokenUsed,
  ensureUnsubscribeToken, getUserByUnsubscribeToken,
  checkTrialExpiry,
  // Content visibility
  getLibraryFilesForUser, getAllLibraryFilesWithAccess, canAccessFile, getFacilitatorResources,
  userMaxLevel, LEVEL_RANK,
  // Invitations
  createInvitation, getInvitationByToken, acceptInvitation, getInvitationsForFacilitator,
  // Guest leads
  addGuestLead, getGuestLeads, deleteGuestLead, getGuestLead,
  createFacilitatorRequest, getPendingFacilitatorRequestByEmail, getFacilitatorRequests,
  getFacilitatorRequestById, setFacilitatorRequestStatus, deleteFacilitatorRequest,
  getLatestFacilitatorRequestForUser,
  // Membership plans
  getMembershipPlans, updateMembershipPlan,
  // MOTD
  addMotd, getMotd, getAllMotd, approveMotd, updateMotd, deleteMotd,
  markMotdSent, countApprovedMotd, getNextMotdToSend, getMotdRecipients,
  getActiveMotdForDate, getStaleActiveMotd, activateMotd, getMotdNotificationCandidates, markMotdSentForUser,
  addNewsletter, getNewsletter, getAllNewsletters, updateNewsletter, deleteNewsletterDraft, markNewsletterSent, getNewsletterRecipients,
  // Reminders
  getInactiveUsers,
  markReminderSent,
  getUpcomingRenewals,
  markRenewalReminderSent,
  getTrialEmailCandidates,
  markTrialEmailSent,
  // Stripe lookups
  getUserByStripeCustomer, getUserByStripeSubscription,
  // Legal documents
  getLegalDocument, getLegalDocumentById, getLegalDocumentVersion, getLegalDocumentHistory,
  getAllCurrentLegalDocuments, getAllLegalDocumentsAdmin,
  createLegalDocument, updateLegalDocument, publishLegalDocument, deleteLegalDocumentDraft,
  addLegalTranslation, getLegalTranslation, getLegalTranslationById, getLegalTranslationsForDoc,
  updateLegalTranslation, publishLegalTranslation, unpublishLegalTranslation, deleteLegalTranslation,
  getPublishedLegalTranslation,
  // User legal consents
  recordLegalConsent, hasUserAcceptedDocument, getPendingConsentsForUser, getUserConsentHistory,
};
