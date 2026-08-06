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

  // ── 1:1 video/audio calls (Per Bot 12) ──
  // One row per call attempt between a facilitator and a client. Recording
  // is genuinely optional per call (consent asked fresh each time, not a
  // blanket setting) and defaults to facilitator-only visibility —
  // shared_with_client only flips on when the facilitator explicitly
  // shares that specific recording, at which point it shows up in the
  // client's own account. recording_key/transcript stay NULL until the
  // facilitator's browser (the one that composites and uploads the
  // recording — see server.js) finishes uploading and Deepgram finishes
  // transcribing, both of which happen after the call itself has ended.
  // ── Skins (Per Bot 20) — multi-brand foundation ──
  // Deliberately branding-only: a skin controls how the app LOOKS to
  // whoever's tagged with it (login page, favicon, name, colour,
  // background images, contact person) — it does NOT control which
  // content/courses they can see. That's a real, separate decision
  // (content-per-skin) intentionally left for later, once an actual
  // second organisation's needs are known rather than guessed at now.
  // id is the slug itself (used directly in URLs like /login/rotterdam),
  // not a generated uuid — there's never a reason to reference a skin by
  // anything other than its own short name.
  // ── Referral events (Per Bot 22) ──
  // One row per successful referral credit — doubles as the audit trail
  // and as the content for the referrer's own small "someone joined!"
  // feed (see /api/my/referrals). Only ever written once per referred
  // user (guarded by users.referral_rewarded above), on their first
  // successful payment — not on registration, and not on any later
  // renewal, per the "must actually pay, once" design.
  db.run(`CREATE TABLE IF NOT EXISTS referral_events (
    id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL,
    referred_user_id TEXT NOT NULL,
    referred_name TEXT,
    days_credited INTEGER NOT NULL DEFAULT 30,
    seen_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS skins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    logo_url TEXT,
    favicon_url TEXT,
    primary_color TEXT,
    contact_name TEXT,
    contact_email TEXT,
    background_images TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    facilitator_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    call_type TEXT NOT NULL DEFAULT 'video',
    status TEXT NOT NULL DEFAULT 'ringing',
    recording_consent TEXT,
    recording_key TEXT,
    recording_duration_seconds INTEGER,
    transcript TEXT,
    transcript_status TEXT,
    shared_with_client INTEGER NOT NULL DEFAULT 0,
    shared_at TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    answered_at TEXT,
    ended_at TEXT,
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

  // ── Content kinds (Per Bot 33e) — was a hardcoded CONTENT_KINDS array in
  // admin/content.html; moved to the DB so it's editable from the same
  // Categories tab as categories/subcategories, same rename/delete pattern.
  // `value` is the stable slug stored on library_files.content_type — kept
  // separate from `label` so renaming a kind never touches existing files'
  // records, exactly like a category rename doesn't touch its id.
  db.run(`CREATE TABLE IF NOT EXISTS content_kinds (
    id TEXT PRIMARY KEY,
    value TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
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

  // ── Content shares (Per Bot 22) ── Many-to-many: any file shared with
  // any number of specific people, independent of facilitator assignment
  // and independent of tier — a practice is person-level, not
  // subscription-level. Deliberately separate from library_files'
  // existing assigned_client_id column rather than replacing it: that
  // column is a single-client facilitator assignment already relied on
  // elsewhere, and this is additive — both feed the same "My Practices"
  // view on the client side, but neither needs to know about the other.
  db.run(`CREATE TABLE IF NOT EXISTS content_shares (
    id TEXT PRIMARY KEY,
    library_file_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    shared_by_role TEXT,
    shared_by_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(library_file_id, user_id),
    FOREIGN KEY (library_file_id) REFERENCES library_files(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // ── AI generate jobs (Per Bot 22) ── Backs the newsletter editor's
  // "Generate & insert" background jobs (see /api/admin/comms-ai-generate).
  // Was an in-memory Map — fine for the request/response latency problem
  // it fixed, but a job vanished if the server process restarted for any
  // reason mid-generation, which happened twice in testing. A real table
  // survives that: any job still 'pending' when the server boots means
  // the previous attempt never finished and gets automatically re-run
  // (see recoverPendingAiGenerateJobs in server.js). Also doubles as the
  // Reports > Generated Images history, so sumie rows are never pruned —
  // that's the whole point of keeping them.
  db.run(`CREATE TABLE IF NOT EXISTS ai_generate_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    context TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    html TEXT,
    image_url TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
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

  // ── Messages (Per Bot 8) — facilitator ↔ client, two-way. session_id
  // NULL means the client's general thread; set means it's tied to that
  // specific session (opened from the session's own record so context
  // stays attached). course_instance_id is unused for now — a deliberate
  // placeholder so the later cohort/course-instance messaging feature
  // (community channel + per-lesson teacher channel) extends this same
  // table instead of needing a second, parallel messaging system.
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    facilitator_id TEXT NOT NULL,
    session_id TEXT,
    course_instance_id TEXT,
    sender_role TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    content TEXT DEFAULT '',
    filename TEXT DEFAULT '',
    original_filename TEXT DEFAULT '',
    edited_at TEXT,
    deleted_at TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Client journal entries (Per Bot 6) ── Client-authored, distinct
  // from the sessions table above which holds facilitator/bot-generated
  // summaries. Each entry has TWO independent sharing flags — a client
  // might want the companion bot to know something without a facilitator
  // seeing it, or vice versa, so these are never coupled together.
  db.run(`CREATE TABLE IF NOT EXISTS client_journal_entries (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_type TEXT DEFAULT 'written',
    original_filename TEXT,
    share_with_bot INTEGER DEFAULT 0,
    share_with_facilitator INTEGER DEFAULT 0,
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

  // ── Client <-> facilitator relationships (Per Bot 13) ──
  // A client can have more than one facilitator now — this table is what
  // makes that real, alongside (not replacing) the legacy users.facilitator_id
  // single column, which stays exactly as-is for backward compatibility
  // (existing queries that assume one facilitator keep working unchanged).
  // "Talk" itself is treated as facilitator #1 for every client but is
  // NEVER a row in here or in the facilitators table — it's a synthetic
  // id ('talk') the API layer adds to every client's list, since it isn't
  // a real login-capable account and doesn't need one.
  db.run(`CREATE TABLE IF NOT EXISTS client_facilitators (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    facilitator_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, facilitator_id)
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

  // ── Offers (Per Bot 17) ── Named, dated promotional campaigns. Each has a
  // unique `code` a promo link/register call can reference. `is_default`
  // marks the one standing evergreen offer used when no code is given (only
  // one row should ever have is_default=1 — enforced in the helper
  // functions below, not by a DB constraint, since sql.js doesn't easily
  // support a partial unique index). `active` is a manual kill-switch,
  // independent of the launch/expiry date window — an offer can be within
  // its dates but toggled off, or have live dates but not yet be turned on.
  // `cloned_from` is lineage-only (which offer this was built from), never
  // read for any access logic.
  db.run(`CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    headline TEXT,
    description TEXT,
    trial_days INTEGER NOT NULL DEFAULT 14,
    launch_date TEXT,
    expiry_date TEXT,
    is_default INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    cloned_from TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Per Bot 18 — funnel tracking. One row per landing on /promotions,
  // whether via a /promo/<code> link, a bare visit, or a link carrying a
  // ?src= platform tag. Deliberately append-only and minimal — this is a
  // hit log to aggregate later, not a per-visitor record (no user id;
  // nobody's identified yet at this point, they haven't registered).
  // promo_code is stored as the raw string as well as offer_id, so a hit
  // still means something in reporting even if the offer it pointed at is
  // later renamed or deleted.
  db.run(`CREATE TABLE IF NOT EXISTS promo_hits (
    id TEXT PRIMARY KEY,
    offer_id TEXT,
    promo_code TEXT,
    source TEXT,
    skin_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_promo_hits_offer ON promo_hits(offer_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_promo_hits_created ON promo_hits(created_at)`);

  // ── Social posts (Per Bot 17 phase 4) ── History of message-builder
  // generations, so a past run can be revisited or duplicated into a new
  // editable draft rather than being lost the moment the page reloads.
  // `results` is a JSON blob keyed by platform (facebook/linkedin/...) —
  // one row per generation batch, not per platform, since a batch is
  // conceptually one "post" even though it produced several variants.
  db.run(`CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY,
    source_text TEXT NOT NULL,
    platforms TEXT NOT NULL,
    results TEXT NOT NULL,
    offer_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Signal lines (Per Bot 17 phase 6) ── The rotating "line bank" —
  // short signal-aware phrases (the "three truths" style: "You don't have
  // to earn the right to rest") used across /promotions, the message
  // builder, and eventually course intros/selling pages. `prior_tag`
  // marks which of the three primary priors a line speaks to (fear,
  // belonging, mattering) or 'general' for ones that don't map to a
  // single prior. `status` gives editorial control before anything goes
  // live: draft (needs review — every trend-scan result starts here),
  // active (in rotation), archived (retired but kept for reference/
  // lineage, never shown). `source` distinguishes hand-written lines from
  // ones generated by the trend-scan tool; `trend_context` is a short
  // human-readable note on what current trend prompted a scanned line,
  // shown to Per during review so a line doesn't get approved blind.
  db.run(`CREATE TABLE IF NOT EXISTS signal_lines (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    prior_tag TEXT NOT NULL DEFAULT 'general',
    status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL DEFAULT 'manual',
    trend_context TEXT,
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

  // ── Scheduled (recurring) messages (Per Bot 21) ── A reusable template
  // that periodically spawns a real, one-off send — reusing the exact
  // same newsletter send pipeline every occurrence (see scheduled_message_id
  // on newsletters below), rather than a second, parallel sending path.
  // recurrence_config is JSON, shape depends on recurrence_type:
  //   daily               → {}
  //   weekly              → { daysOfWeek: [0-6, ...] }        (0=Sun..6=Sat)
  //   monthly_date        → { dayOfMonth: 1-31 | 'last' }
  //   monthly_nth_weekday → { nth: 1-4 | -1, weekday: 0-6 }   (-1 = last)
  //   yearly              → { month: 1-12, day: 1-31 }
  // last_sent_date (YYYY-MM-DD) guards against sending twice in the same
  // day if the cron tick ever runs more than once within the send hour.
  db.run(`CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    format TEXT DEFAULT 'plain',
    audience TEXT DEFAULT 'all',
    recurrence_type TEXT NOT NULL,
    recurrence_config TEXT,
    send_hour INTEGER DEFAULT 7,
    active INTEGER DEFAULT 1,
    last_sent_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Campaigns (Per Bot 18) ──
  // A campaign is a named sequence of steps, mixing calming (line-bank,
  // no CTA) and sales (offer-linked, tracked) content across email and
  // social, fired on a schedule once approved. Draft until explicitly
  // approved — nothing in a draft campaign ever sends anywhere.
  // audience: same NEWSLETTER_AUDIENCE_CLAUSES segments as newsletters —
  // applies only to this campaign's email steps; social steps go to
  // whatever account is connected, audience doesn't apply to them.
  // offer_id nullable — a pure-calming campaign genuinely has no offer.
  db.run(`CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    offer_id TEXT,
    audience TEXT DEFAULT 'all',
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT
  )`);
  // offset_days: day N of the campaign, counted from started_at (day 0 =
  // the day it goes live). type: calming | sales. channel: email or one
  // of the BulkPublish platform keys. line_id: which signal_line a
  // calming step drew from, kept for reference/re-roll, not required.
  // status: pending (not yet fired) -> scheduled (social steps only, once
  // BulkPublish has accepted it) or sent (email steps, once actually
  // delivered) -> failed if either of those errors.
  db.run(`CREATE TABLE IF NOT EXISTS campaign_steps (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    step_order INTEGER NOT NULL DEFAULT 0,
    offset_days INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    channel TEXT NOT NULL,
    subject TEXT,
    content TEXT,
    line_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    external_post_id TEXT,
    sent_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_campaign_steps_campaign ON campaign_steps(campaign_id)`);

  // ── Email log (Per Bot 8) ──
  // Every email the app sends — welcome, password reset, reminders,
  // renewals, message alerts, newsletters, anything — logs itself here via
  // sendEmail() below, with zero changes needed at any individual call
  // site. kind classifies what it was; newsletter_id is only set for
  // kind='newsletter', letting the same log serve both a general "every
  // email ever sent" admin view and the newsletter-specific progress/
  // reconcile view as just a filtered slice of this one table.
  // For newsletters specifically, a row is written for every intended
  // recipient BEFORE the send attempt, not after — a crash mid-batch then
  // leaves a clear record of who was *supposed* to get it (status stays
  // 'pending') rather than silence. Transactional (non-newsletter) emails
  // are one-off sends with no batch to crash mid-way through, so those log
  // after attempting, not before.
  // scaleway_email_id is the id Scaleway's API returns for that specific
  // send, letting us later ask Scaleway directly "what happened to this
  // one" (delivered/bounced/spam) rather than guessing from a subject-line
  // search.
  db.run(`CREATE TABLE IF NOT EXISTS email_log (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'other',
    newsletter_id TEXT,
    user_id TEXT,
    email TEXT NOT NULL,
    subject TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    scaleway_email_id TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Cron job activity log (Per Bot 20) ── One row per scheduled job
  // run, for the Reports hub's cron activity report. detail is a short
  // free-text summary (e.g. "3 sent, 1 failed") — enough to spot a job
  // silently doing nothing without needing to dig through Railway logs.
  // Kept lean deliberately: this is a health/activity log, not an audit
  // trail, so old rows are pruned (see pruneCronLog) rather than kept
  // forever.
  db.run(`CREATE TABLE IF NOT EXISTS cron_log (
    id TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    detail TEXT,
    error TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    duration_ms INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cron_log_job_time ON cron_log(job_name, started_at)`);

  // ── Login activity log (Per Bot 20) ── One row per authenticated
  // session issued — covers the main sign-in form plus every other place
  // that hands someone a session cookie (register, the newsletter
  // self-service invite claim, a facilitator-invite acceptance, and a
  // dual-role switch), each tagged with which kind of event it was so
  // the Reports hub can distinguish "someone signed in" from "someone's
  // account was just created and they were logged in as part of that."
  db.run(`CREATE TABLE IF NOT EXISTS login_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    role TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'login',
    logged_in_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_login_log_time ON login_log(logged_in_at)`);

  // ── Talk-to-Per session log (Per Bot 20) ── One row per live voice
  // session with the WebSocket-based Talk-to-Per feature, so the Reports
  // hub can show real usage hours rather than nothing at all. started_at
  // is set when the socket opens; ended_at + duration_seconds are filled
  // in once it closes (whether the person hung up, the tab closed, or the
  // stale-session sweep in cron.js finalized it). A row with ended_at
  // still NULL means either a session genuinely in progress right now, or
  // one that crashed without a clean close — the sweep is what catches
  // and finalizes those the same way it does for chat sessions.
  db.run(`CREATE TABLE IF NOT EXISTS talk_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    duration_seconds INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_talk_sessions_user_time ON talk_sessions(user_id, started_at)`);

  // ── Tomte image library (Per Bot 31) ──
  // Previously, a Tomte photo only ever existed as a side-effect of being
  // uploaded straight into a specific slot (a language+action pair, a
  // facilitator's own override, a client's own override) — there was no
  // way to have a photo just sit in a pool, unassigned, ready to be used
  // later. getAllTomteImages() used to fake a "library" by scanning
  // wherever a filename happened to already be in use, which is why
  // every upload had to immediately BE something.
  // This table is the real thing: upload adds a row here, nothing else.
  // Assigning it to a language+action (tomte_language_defaults below) or
  // a specific person is now a separate step that references this table
  // rather than triggering a fresh upload every time.
  db.run(`CREATE TABLE IF NOT EXISTS tomte_image_library (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Per Bot 21 — welcome tour slides: Per's own phone photos of the app
  // with a caption explaining each one, offered by Tomte as a one-time
  // "want a quick walkthrough?" tip (see TOMTE_TIPS in server.js). Same
  // R2-backed upload pattern as tomte_image_library above — filename
  // stored, actual bytes live in R2, served through the same
  // /tomte-images/:key route. sort_order is a plain integer set by the
  // admin reorder endpoint, not alphabetical/created_at — the sequence
  // is a deliberate walkthrough order, not a gallery.
  db.run(`CREATE TABLE IF NOT EXISTS onboarding_tour_slides (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    caption TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Tomte language + action image defaults (Per Bot 8) ── One row per
  // (language, action) pair — e.g. Dutch+shrug, Dutch+smile — each with its
  // own image. 'default' is the plain neutral pose and also the fallback
  // for any action that doesn't have its own image yet. A person's own
  // personal Tomte image always wins for the 'default' action specifically;
  // for every other action, this table is checked directly (exact
  // language+action match only, no cascading) before falling through to
  // the standard default resolution — see resolveTomteImage in server.js.
  db.run(`CREATE TABLE IF NOT EXISTS tomte_language_defaults (
    language TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'default',
    image_filename TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (language, action)
  )`);

  // ── Tomte skin defaults (Per Bot 33o) — same idea as the language
  // defaults above, one layer more specific: lets a skin (e.g. a
  // University cohort) show its own Tomte photo instead of the standard
  // one, for a given language+action. Kept as its own table rather than
  // adding a nullable skin_id onto tomte_language_defaults, since that
  // table's primary key is (language, action) and SQLite can't extend a
  // primary key via ALTER TABLE without a full rebuild — a parallel table
  // with its own (skin_id, language, action) key is the same shape
  // without that risk. Resolution order (see resolveTomteImage in
  // server.js): this skin-scoped table is checked FIRST at every tier,
  // falling through to tomte_language_defaults exactly as before when
  // there's no skin, or the skin has no override for that slot.
  db.run(`CREATE TABLE IF NOT EXISTS tomte_skin_defaults (
    skin_id TEXT NOT NULL,
    language TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'default',
    image_filename TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (skin_id, language, action)
  )`);

  // ── Talk signal scripts (Per Bot 33s) — short, pre-written "three
  // signal" mini-practices (max ~1 min) Talk can sprinkle into a live
  // conversation. skin_id NULL = universal (offered on every skin,
  // including plain Deeper Mindfulness); set = only offered on that skin.
  // Deliberately NOT sent to Claude in full on every turn — only
  // topic+situation (the "menu") go in the system prompt; the actual
  // script_text or file only gets pulled in once Talk names a specific
  // one via a [[SIGNAL:id]] marker, same pattern as [[PAUSE]]. See
  // buildSignalMenu()/resolveSignalMarker() in server.js.
  db.run(`CREATE TABLE IF NOT EXISTS talk_signal_scripts (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    situation TEXT NOT NULL,
    skin_id TEXT,
    kind TEXT NOT NULL DEFAULT 'text',
    script_text TEXT,
    file_id TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Talk context documents (Per Bot 33s) — skin-scoped knowledge Talk
  // should be aware of (e.g. the Mare book), uploaded as a file rather
  // than hand-pasted into a system prompt string in code. Unlike signal
  // scripts, this DOES go into the system prompt in full on every turn
  // for that skin — there's no per-turn "look it up" step for background
  // knowledge the way there is for a specific practice — so size matters
  // here in a way it doesn't for the scripts above. skin_id NULL =
  // universal, same convention as everywhere else skins appear.
  //
  // Per Bot 15p — no longer injected into the live system prompt at all
  // (see the sectioned knowledge ladder below, which replaces that job
  // properly). Kept only as: (1) the source material a topic's sections
  // were generated from, for provenance, and (2) the corpus the
  // search_source_material fallback tool searches when the curated
  // ladder doesn't have something a conversation actually needs — i.e.
  // exactly the "go outside the boundary, but stay within the app's own
  // material" Per asked for. Never re-added to the always-on prompt.
  db.run(`CREATE TABLE IF NOT EXISTS talk_context_documents (
    id TEXT PRIMARY KEY,
    skin_id TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    original_filename TEXT,
    char_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Per Bot 18 — Tomte proactive tips (feature discovery, not marketing —
  // see the tip definitions in server.js for the actual scope reasoning).
  // One row per person per tip they've been shown, so nothing repeats.
  db.run(`CREATE TABLE IF NOT EXISTS tomte_tips_seen (
    user_id TEXT NOT NULL,
    tip_id TEXT NOT NULL,
    seen_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, tip_id)
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

  // ── Library file tags (Per Bot 13) ──
  // Many-to-many theme tagging for library_files, separate from the existing
  // single category_id/subcategory_id pair. Added for the WordPress content
  // migration (blog posts, poems) where one piece of writing can genuinely
  // belong to several themes (e.g. a post on setting boundaries is both
  // "Relationships & Boundaries" and "Self-Worth"), and — the actual point —
  // so the same tag vocabulary already used for the meditation-track playlists
  // (Grounding, Focus, Self-Worth, Sleep, Trauma...) can be reused across
  // content types. That shared vocabulary is what makes a real theme-based
  // slider possible later ("more like this" pulling both a blog post and a
  // meditation track tagged Self-Worth), not just a cosmetic label.
  // tag is stored as free text, not a foreign key to a fixed table — matches
  // content_kinds' philosophy of "editable list, not a hardcoded enum" without
  // needing an extra admin screen just to add one new theme.
  db.run(`CREATE TABLE IF NOT EXISTS library_file_tags (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(file_id, tag),
    FOREIGN KEY (file_id) REFERENCES library_files(id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_file_tags_tag ON library_file_tags(tag)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_file_tags_file ON library_file_tags(file_id)`);

  // ── TTS cache (Per Bot 14) ── A small number of fixed scripts (the
  // three quick-practice buttons on the calm landing) used to hit
  // ElevenLabs live every single tap, via the same path as an ordinary
  // conversational reply — slower, inconsistent phrasing risk, and pure
  // repeated cost for text that never changes. First tap generates and
  // caches the audio in R2 under a stable key; every tap after that just
  // serves the same file straight back, like any other real recording.
  db.run(`CREATE TABLE IF NOT EXISTS tts_cache (
    cache_key TEXT PRIMARY KEY,
    r2_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Translated email template cache (Per Bot 15) ── Referenced by
  // getLocalizedTemplate/sendLocalizedEmail in server.js since at least
  // Per Bot 8 (welcome emails, password reset links, admin password
  // resets), but this table and its two functions were never actually
  // created — db.getTranslatedTemplate/db.saveTranslatedTemplate have
  // been calling into nothing. For an English recipient this was
  // invisible (the function returns before ever touching the DB), but
  // any non-English recipient (e.g. language='nl') hit "db.getTranslatedTemplate
  // is not a function" — an uncaught throw, since it happens before the
  // try/catch in getLocalizedTemplate even starts, becoming an unhandled
  // promise rejection wherever the email call wasn't itself awaited.
  // One row per (template_key, language) pair, exactly like the comment
  // beside legal_translations above already assumed existed.
  db.run(`CREATE TABLE IF NOT EXISTS translated_templates (
    id TEXT PRIMARY KEY,
    template_key TEXT NOT NULL,
    language TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(template_key, language)
  )`);

  // ── Breathing patterns (Per Bot 15) ── A simple guided breathing timer,
  // deliberately much simpler than the meditation timer's bell/interval
  // options. Each pattern is a fixed phase sequence (in/hold/out, each
  // with its own seconds) repeated for a number of cycles. Talk can drop
  // a [[BREATHING:id]] marker into a reply (same convention as
  // [[SIGNAL:id]]) when someone mentions being stressed or similar —
  // server resolves it to the real pattern, client pre-loads the
  // breathing view with it. `situation` is shown only in Talk's own
  // system prompt (see prompts.js CLIENT_BREATHING_MENU), never to the
  // person directly — it's just guidance for when each pattern fits.
  // Only three spoken cues ever exist across every pattern — "Breathing
  // in", "Hold", "Breathing out" — generated once via the same
  // /api/speak-cached mechanism as the quick-practice buttons, then
  // reused for every pattern; patterns only define timing, never audio.
  db.run(`CREATE TABLE IF NOT EXISTS breathing_patterns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    situation TEXT NOT NULL DEFAULT '',
    phases TEXT NOT NULL,
    default_cycles INTEGER NOT NULL DEFAULT 6,
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Sectioned knowledge (Per Bot 15p) ──
  // Replaces Context documents as Talk's ongoing knowledge mechanism —
  // that feature stays only as historical source material now (see
  // knowledge_documents.source_note), never injected into a live
  // conversation again. The actual mechanism: every topic always carries
  // a free "Heading" (topic.menu_line, part of the topic row itself,
  // shown to Talk every turn like the Signal Script menu already is) —
  // real depth beyond that lives in knowledge_topic_content, one row per
  // (topic, level), fetched by Talk mid-reply via a tool call only when
  // a conversation actually goes there. Levels are a real table, not a
  // hardcoded enum, specifically so a new level can be added later
  // without a schema change — see knowledge_levels_config below.
  db.run(`CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_note TEXT DEFAULT '',
    raw_text TEXT DEFAULT '',
    skin_id TEXT,
    archived INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // The depth ladder itself, above Heading. sort_order controls both
  // display order and "how deep is this" for authoring guidance; the
  // description is fed to the generation prompt so it knows what each
  // level is actually for (kept here, not hardcoded in prompts.js, so a
  // newly added level's own description drives its own generation
  // without a code change).
  db.run(`CREATE TABLE IF NOT EXISTS knowledge_levels_config (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    description TEXT DEFAULT ''
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS knowledge_topics (
    id TEXT PRIMARY KEY,
    document_id TEXT,
    title TEXT NOT NULL,
    menu_line TEXT NOT NULL,
    skin_id TEXT,
    facilitator_id TEXT,
    archived INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (document_id) REFERENCES knowledge_documents(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS knowledge_topic_content (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    level_id TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(topic_id, level_id),
    FOREIGN KEY (topic_id) REFERENCES knowledge_topics(id),
    FOREIGN KEY (level_id) REFERENCES knowledge_levels_config(id)
  )`);

  // Cross-links between related topics (Per's "link material" ask) —
  // stored one-directional but always written/read as a pair, so linking
  // A to B also means B shows A as related, without needing two rows
  // maintained by hand.
  db.run(`CREATE TABLE IF NOT EXISTS knowledge_topic_links (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    linked_topic_id TEXT NOT NULL,
    UNIQUE(topic_id, linked_topic_id)
  )`);

  // ── Lesson file opens (Per Bot 13) ──
  // Tracks every time a client opens/plays a file that's part of a lesson.
  // Underlies three things at once: the green-tick "opened" marker in the
  // client player, the % complete shown per lesson (opened mandatory files
  // ÷ total mandatory files — see getLessonProgress), and gating the "mark
  // lesson complete?" prompt on mandatory files actually being opened. Not
  // deduped to one row per user/file on purpose — repeat opens are cheap to
  // store and the timestamp history is useful later (e.g. reminders built
  // on "hasn't opened anything in this lesson for two weeks").
  db.run(`CREATE TABLE IF NOT EXISTS lesson_file_opens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    opened_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lesson_file_opens_lookup ON lesson_file_opens(user_id, lesson_id, file_id)`);

  // ── Migrations — add columns to existing tables if they don't exist ──
  // This is how we handle the live database which was created before the full schema
  // above existed. The CREATE TABLE IF NOT EXISTS above handles new installs;
  // these ALTER TABLE statements handle the upgrade path for existing databases.
  const migrations = [
    // Sequencing & mandatory files (Per Bot 13). Everything defaults to
    // off/0 — existing courses are completely unaffected unless someone
    // explicitly opts a course or lesson in.
    "ALTER TABLE lesson_file_refs ADD COLUMN mandatory INTEGER DEFAULT 0",
    "ALTER TABLE courses ADD COLUMN enforce_lesson_sequence INTEGER DEFAULT 0",
    "ALTER TABLE courses ADD COLUMN enforce_file_sequence INTEGER DEFAULT 0",
    // NULL = inherit the course's enforce_file_sequence default; 0 = force
    // off for this lesson regardless of the course default; 1 = force on.
    "ALTER TABLE lessons ADD COLUMN file_sequence_override INTEGER",
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
    // Keep History (Per Bot 6) — opt-in continuity for the AUTOMATED
    // self-serve Talk conversations specifically. Deliberately separate
    // from any facilitator-led clinical relationship, which has its own
    // consent already; this toggle governs whether the automated bot may
    // read AND write an ongoing arc/summary from someone's own self-guided
    // conversations. Off by default — summarizing personal conversation
    // content across sessions is a real privacy decision, not a default.
    "ALTER TABLE users ADD COLUMN pref_keep_history INTEGER DEFAULT 0",
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
    // Lets an admin/facilitator's own phone number default the SMS
    // test-send fields the same way their email already defaults the
    // email test-send fields — there was previously nowhere on the
    // facilitators table to even store this.
    "ALTER TABLE facilitators ADD COLUMN phone TEXT",
    // Newsletter audience targeting — comma-separated segment keys (see
    // getNewsletterRecipients below), defaults to 'all' for any pre-existing
    // rows so nothing already sent silently reinterprets who it went to.
    "ALTER TABLE newsletters ADD COLUMN audience TEXT DEFAULT 'all'",
    // Per Bot 18 — ties a newsletter send to a specific offer (for
    // non-logged-in recipients, i.e. mailing-list-only contacts, whose
    // invite_link becomes a tracked /join/<token> carrying this offer's
    // code and this send's source tag) rather than the old fixed-14-day
    // claim flow, which had no connection to the offer/funnel system at
    // all. Null on every newsletter until explicitly set — existing sends
    // are unaffected.
    "ALTER TABLE newsletters ADD COLUMN offer_id TEXT",
    "ALTER TABLE newsletters ADD COLUMN source_tag TEXT",
    // Per Bot 21 — traces a sent newsletter back to the recurring
    // template that spawned it, purely for display ("this was Tuesday's
    // automatic send") — sending logic itself doesn't depend on this.
    "ALTER TABLE newsletters ADD COLUMN scheduled_message_id TEXT",
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
    // Per-user voice choice (Per Bot 7) — NULL means "use the default voice"
    // (VOICE_ID env var, Per's own cloned voice). Set once a client picks
    // something else on their My Account voice picker. Validated against
    // the live ElevenLabs voice list server-side before ever being saved —
    // see PATCH /api/account — so this column only ever holds a real,
    // currently-available voice_id, never an arbitrary string.
    "ALTER TABLE users ADD COLUMN voice_id TEXT",
    // Shared test-send destination (Per Bot 7) — previously every test-send
    // button across MOTD/Reminders/Renewal/Newsletter defaulted to the
    // logged-in admin's own email/phone, with no way to point all of them
    // at one QA inbox/number without retyping it into every single field,
    // every time. Set once here, used as the fallback everywhere a
    // test-send has no explicit override typed into that particular field.
    "ALTER TABLE app_config ADD COLUMN test_email TEXT",
    "ALTER TABLE app_config ADD COLUMN test_phone TEXT",
    // Content type + external link (Per Bot 7) — the library previously only
    // distinguished files by file_type (audio/video/document) + category.
    // That's fine for meditations, but doesn't tell "whitepaper" apart from
    // "book excerpt" apart from "blog post" — all three might be a PDF in
    // the same category. content_type is a plain string set from the admin
    // upload/edit form (e.g. 'meditation','blog','whitepaper','poem','book',
    // 'video_blog') — deliberately not an enforced SQL enum, so Per can
    // introduce a new type without a migration. external_link is for the
    // "excerpt PDF in-app, full book on Amazon" pattern — a book row can
    // carry a PDF (excerpt) AND a purchase URL at the same time; tier-gating
    // a full PDF instead is just a normal visibility value, no new column
    // needed for that (see LEVEL_RANK below).
    "ALTER TABLE library_files ADD COLUMN content_type TEXT",
    "ALTER TABLE library_files ADD COLUMN external_link TEXT",
    // Reminder/renewal message bodies (Per Bot 7) — the admin panel already
    // let Per edit the subject line and inactivity/renewal threshold, but
    // the actual message text was hardcoded in server.js with no way to
    // change it at all. These four columns make the body editable too, the
    // same way subject already was. NULL/empty means "use the built-in
    // default wording" — see buildReminderHtml/buildReminderSms/
    // buildRenewalReminderHtml/buildRenewalReminderSms in server.js, which
    // support {{name}} (all four) and {{date}} (renewal only) tokens.
    "ALTER TABLE app_config ADD COLUMN reminder_body TEXT",
    "ALTER TABLE app_config ADD COLUMN reminder_sms_body TEXT",
    "ALTER TABLE app_config ADD COLUMN renewal_reminder_body TEXT",
    "ALTER TABLE app_config ADD COLUMN renewal_reminder_sms_body TEXT",
    // Onboarding (Per Bot 7) — introduces new options gradually via a short
    // first-login stepper (notification style + optional DOB) instead of
    // dumping everything on someone at once. dob_month/dob_day only —
    // deliberately no year: a birthday message doesn't need age, and
    // skipping the year avoids storing anything that lets age be inferred.
    // Supplying a DOB at all IS the consent to send a birthday message —
    // there's no separate opt-in flag; clearing the fields is the opt-out.
    "ALTER TABLE users ADD COLUMN dob_month INTEGER",
    "ALTER TABLE users ADD COLUMN dob_day INTEGER",
    "ALTER TABLE users ADD COLUMN onboarding_completed INTEGER DEFAULT 0",
    // Backfill: existing users (as of this feature shipping) skip the
    // stepper entirely rather than being interrupted by it retroactively —
    // it's meant to greet someone new, not ambush someone who's already
    // been using the app for months. Uses a fixed cutoff date rather than
    // 'now' deliberately: this migration re-runs on every server restart
    // (see the try/catch pattern below), and 'now' would re-match and
    // silently flag any brand-new user who registered but hadn't yet seen
    // the stepper by the time of a later restart — a fixed date only ever
    // matches people who existed before this feature shipped, once.
    "UPDATE users SET onboarding_completed=1 WHERE onboarding_completed=0 AND created_at < '2026-07-06'",
    // Keep History gets asked in-context, in Talk, after a person's first
    // real exchange — not blind in the onboarding stepper, since the whole
    // point is they've now felt what the conversation is like. This flag
    // just stops it being asked more than once regardless of answer;
    // pref_keep_history itself (already existed) is the actual setting.
    "ALTER TABLE users ADD COLUMN keep_history_prompted INTEGER DEFAULT 0",
    // One-time hint pointing at the voice picker, shown after someone's
    // very first reply is spoken aloud — the first moment they've actually
    // heard a voice, which is the earliest point choosing one means anything.
    "ALTER TABLE users ADD COLUMN voice_hint_shown INTEGER DEFAULT 0",
    // Birthday messages — editable the same way reminder/renewal bodies
    // are: {{name}} token, empty means "use the built-in default wording".
    "ALTER TABLE app_config ADD COLUMN birthday_email_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN birthday_email_body TEXT",
    "ALTER TABLE app_config ADD COLUMN birthday_sms_body TEXT",
    "ALTER TABLE users ADD COLUMN last_birthday_sent_year INTEGER",
    // One-to-one content (Per Bot 7) — a file assigned to a specific
    // client bypasses the tier visibility ladder entirely: visible only to
    // that one user (matched by id, not by tier/is_client status — the
    // same login might be an Explorer today and a Client tomorrow; the
    // assignment doesn't care which) plus facilitators/admins for
    // management. NULL means "not one-to-one" — falls back to the normal
    // visibility tier as before. See canSeeFile() below.
    "ALTER TABLE library_files ADD COLUMN assigned_client_id TEXT",
    // Framework + presentation awareness (Per Bot 7) — facilitator-set
    // clinical context for Talk, distinct from pref_keep_history (which
    // governs whether the automated bot remembers casual conversations).
    // framework defaults to the full FELT·FIBRE range; presentation_flags
    // is a plain comma-separated list ('adhd,trauma' etc.) rather than
    // separate boolean columns, same reasoning as content_type earlier —
    // new presentations can be added without a migration.
    "ALTER TABLE users ADD COLUMN framework TEXT DEFAULT 'felt_fibre_full'",
    "ALTER TABLE users ADD COLUMN presentation_flags TEXT",
    // Signal rotation state (Per Bot 7) — a small JSON blob, one integer
    // index per signal category, so Talk can rotate through the variety
    // bank (see SIGNAL_VARIATIONS in prompts.js) instead of defaulting to
    // the same phrasing every session. Advances once per new Talk session,
    // never per message — see getSignalRotation() and its call site.
    "ALTER TABLE users ADD COLUMN signal_rotation_state TEXT",
    // Practices — Course/Area grouping + source tracking (Per Bot 8).
    // source_type distinguishes a client's own saved Talk moment ('talk')
    // from a practice that arrived via a released facilitator session
    // ('session'); category_id/subcategory_id let a practice be grouped
    // under a Course (Mindfulness/University/Therapy subcategories) or an
    // Area (FELT·FIBRE subcategories) in the Library UI.
    "ALTER TABLE practices ADD COLUMN source_type TEXT DEFAULT 'talk'",
    "ALTER TABLE practices ADD COLUMN category_id TEXT",
    "ALTER TABLE practices ADD COLUMN subcategory_id TEXT",
    "ALTER TABLE practices ADD COLUMN facilitator_id TEXT",
    // Password reset (Per Bot 8) — self-service "forgot password" token
    // flow plus an admin-triggered immediate reset, for both account tables.
    "ALTER TABLE users ADD COLUMN reset_token TEXT",
    "ALTER TABLE users ADD COLUMN reset_token_expires TEXT",
    "ALTER TABLE facilitators ADD COLUMN reset_token TEXT",
    "ALTER TABLE facilitators ADD COLUMN reset_token_expires TEXT",
    // Tomte personalization (Per Bot 8) — per-account, not per-deployment;
    // each person can rename/re-skin their own helper. NULL/empty means
    // "use the default" everywhere this is read, so nothing needs
    // backfilling for existing accounts.
    "ALTER TABLE users ADD COLUMN tomte_name TEXT",
    "ALTER TABLE users ADD COLUMN tomte_image_filename TEXT",
    "ALTER TABLE facilitators ADD COLUMN tomte_name TEXT",
    "ALTER TABLE facilitators ADD COLUMN tomte_image_filename TEXT",
    // Facilitators/admins never had a language column at all (only users
    // did) — needed now so Tomte can match a facilitator's own language
    // too, not just a client's.
    "ALTER TABLE facilitators ADD COLUMN language TEXT DEFAULT 'en'",
    "ALTER TABLE facilitators ADD COLUMN voice_id TEXT",
    // Tomte language-level image default (Per Bot 8) — separate from any
    // individual person's own upload. Currently just one language slot
    // (Dutch/Mare); if more get added later this can grow into a small
    // language->filename table instead of one column per language.
    "ALTER TABLE app_config ADD COLUMN tomte_nl_image_filename TEXT",
    // Message notifications (Per Bot 8) — default on, since there's no
    // settings toggle for these yet; gated on having an email/phone on
    // file at all, same as every other notification type here.
    "ALTER TABLE users ADD COLUMN pref_email_messages INTEGER DEFAULT 1",
    "ALTER TABLE users ADD COLUMN pref_sms_messages INTEGER DEFAULT 1",
    // Tomte language override (Per Bot 9) — separate from the account's own
    // `language` (which still drives emails/UI). NULL means "same as
    // account language", the same convention used everywhere else in Tomte
    // personalization. Lets an admin give someone Tomte replies/voice in a
    // different language than their account without touching their actual
    // account language. Added to facilitators too since getTomteSettings()
    // already reads from either table depending on role.
    "ALTER TABLE users ADD COLUMN tomte_language TEXT",
    "ALTER TABLE facilitators ADD COLUMN tomte_language TEXT",
    // Tomte voice-output preference, per account (Per Bot 11) — replaces the
    // old per-browser localStorage toggle. NULL means "not set yet" (widget
    // treats this as off, matching the previous default), so this doubles
    // as a nullable admin override on top of a person's own self-service
    // toggle, same NULL-means-unset convention as tomte_language above.
    "ALTER TABLE users ADD COLUMN tomte_voice_enabled INTEGER",
    "ALTER TABLE facilitators ADD COLUMN tomte_voice_enabled INTEGER",
    // App identity beyond the marketing brand name (Per Bot 11): appName is
    // the short name shown in native browser chrome — dialog titles,
    // bookmark/home-screen labels, the PWA manifest — anywhere the browser
    // would otherwise fall back to showing the raw Railway URL or a
    // generic default. Falls back to brand_name if never set. favicon_url
    // is the small square image behind that, same R2-hosted-image pattern
    // as logo_url.
    "ALTER TABLE app_config ADD COLUMN app_name TEXT",
    "ALTER TABLE app_config ADD COLUMN favicon_url TEXT",
    // Per Bot 24 — calm landing redesign. use_calm_landing is the
    // explicit rollback switch: flip to 0 and every client instantly
    // gets the original direct-into-Talk-chat landing back, no redeploy
    // needed. talk_persona_* rename "Talk" to a real person (Per, by
    // default) in the facilitator list, with their own photo — Talk
    // itself doesn't change internally, this is presentation only.
    "ALTER TABLE app_config ADD COLUMN use_calm_landing INTEGER DEFAULT 1",
    "ALTER TABLE app_config ADD COLUMN talk_persona_name TEXT",
    "ALTER TABLE app_config ADD COLUMN talk_persona_photo_url TEXT",
    // Audio-only calling (Per Bot 14) — the calls table already existed in
    // production before this, so the CREATE TABLE IF NOT EXISTS above
    // (which already lists call_type) won't retrofit it there; this does.
    "ALTER TABLE calls ADD COLUMN call_type TEXT NOT NULL DEFAULT 'video'",
    // Multi-skin branding foundation (Per Bot 20) — see the skins table
    // above for the full reasoning. Both nullable; NULL means "standard
    // Deeper Mindfulness branding", which is every existing account and
    // stays the default for anyone who doesn't arrive through a
    // skin-specific login/invite link.
    "ALTER TABLE users ADD COLUMN skin_id TEXT",
    "ALTER TABLE invitations ADD COLUMN skin_id TEXT",
    // Referrals (Per Bot 22) — see referral_events table below for the
    // fuller reasoning. referred_by is set once, at registration, from
    // whichever ?ref= link/code was used (or none). referral_rewarded is
    // the idempotency guard — flips to 1 the one time this account's
    // first-ever payment credits its referrer, and never again, so a
    // resubscribe after cancelling, or a Stripe webhook firing twice for
    // the same event, can't double-credit.
    "ALTER TABLE users ADD COLUMN referred_by TEXT",
    "ALTER TABLE users ADD COLUMN referral_rewarded INTEGER DEFAULT 0",
    // Curated "featured" shelves on the calm landing screen (Per Bot 28)
    // — deliberately manual, not automatic-by-recency, so what shows up
    // is always something actually chosen, not just whatever was
    // uploaded most recently (which could easily be an unfinished draft
    // or test file).
    "ALTER TABLE courses ADD COLUMN featured INTEGER DEFAULT 0",
    "ALTER TABLE library_files ADD COLUMN featured INTEGER DEFAULT 0",
    // Talk-eligible practices (Per Bot 33j) — separate from featured;
    // marks which library files Talk is allowed to reach for and play
    // mid-conversation. Same reasoning as featured: deliberately manual,
    // not automatic — Talk should only ever offer something Per has
    // actually approved for that in-conversation moment, never every
    // practice in the library by default.
    "ALTER TABLE library_files ADD COLUMN talk_practice INTEGER DEFAULT 0",
    // Course audience segmentation (Per Bot 33l) — restricts a course to a
    // single skin/group (e.g. a University cohort's own login), separate
    // from category (which is content organization, not access control).
    // NULL = visible to everyone, the default, same "opt-in restriction"
    // pattern as assigned_client_id on library files.
    "ALTER TABLE courses ADD COLUMN skin_id TEXT",
    // ── Per Bot 33t — full audit of course/lesson/instance/enrolment
    // tables, prompted by a real bug: lessons.visibility existed in the
    // CREATE TABLE string but had no migration, so it silently never
    // reached any database that already existed before that column was
    // added — CREATE TABLE IF NOT EXISTS only builds a table from
    // scratch; it does nothing for a table that's already there. Every
    // entry below is one of these: safe to run whether or not the column
    // is already present (the try/catch above ignores "duplicate
    // column"), and closes off this exact failure mode for the rest of
    // these tables too, not just the one that actually broke.
    "ALTER TABLE lessons ADD COLUMN visibility TEXT DEFAULT 'client'",
    "ALTER TABLE lessons ADD COLUMN sort_order INTEGER DEFAULT 0",
    "ALTER TABLE courses ADD COLUMN guest_visible INTEGER DEFAULT 0",
    "ALTER TABLE courses ADD COLUMN sort_order INTEGER DEFAULT 0",
    "ALTER TABLE lesson_file_refs ADD COLUMN sort_order INTEGER DEFAULT 0",
    "ALTER TABLE course_instances ADD COLUMN mode TEXT DEFAULT 'self_paced'",
    "ALTER TABLE course_instances ADD COLUMN start_date TEXT",
    "ALTER TABLE course_instances ADD COLUMN end_date TEXT",
    "ALTER TABLE course_instances ADD COLUMN capacity INTEGER",
    "ALTER TABLE course_instances ADD COLUMN price_cents INTEGER DEFAULT 0",
    "ALTER TABLE course_instances ADD COLUMN stripe_price_id TEXT",
    "ALTER TABLE course_instances ADD COLUMN status TEXT DEFAULT 'draft'",
    "ALTER TABLE enrolments ADD COLUMN payment_status TEXT DEFAULT 'free'",
    "ALTER TABLE enrolments ADD COLUMN amount_paid_cents INTEGER DEFAULT 0",
    "ALTER TABLE enrolments ADD COLUMN stripe_payment_intent_id TEXT",
    "ALTER TABLE enrolments ADD COLUMN status TEXT DEFAULT 'active'",
    "ALTER TABLE enrolments ADD COLUMN completed_at TEXT",
    "ALTER TABLE playlists ADD COLUMN guest_visible INTEGER DEFAULT 0",
    // Auto-caching for 'text' signal scripts (Per Bot 33z) — the first
    // time a text script is spoken in the default voice, the generated
    // ElevenLabs audio is saved here so every later play of that exact
    // script reuses it instead of paying for TTS again. Scoped to the
    // default voice only — see resolveSignalMarkers() in server.js for
    // why a client on a custom voice_id always gets live, uncached TTS.
    // cached_audio_voice_id records which voice_id the cache was made
    // for, so if the deployment's default voice ever changes, the stale
    // cache is detected and regenerated rather than served silently wrong.
    "ALTER TABLE talk_signal_scripts ADD COLUMN cached_audio_key TEXT",
    "ALTER TABLE talk_signal_scripts ADD COLUMN cached_audio_voice_id TEXT",
    // Per Bot 33aa — global on/off for whether clients may pick a custom
    // ElevenLabs voice at all. Off means everyone stays on the default
    // voice, which is also the only voice the Per Bot 33z signal-script
    // audio cache covers — so this toggle is really "how much of the
    // caching savings do we keep" as much as it's a personalization
    // setting. Deliberately app_config (global), not per-skin, for now —
    // when Rotterdam/Mare go live as real skins, this — and language
    // options — need the same per-skin treatment tomte_language_defaults
    // already has. Not built yet; flagging here so it isn't missed.
    "ALTER TABLE app_config ADD COLUMN allow_custom_voice INTEGER DEFAULT 1",
    // EPUB lazy-loading (Per Bot 14) — a book's raw .epub is a zip archive;
    // reading it in-browser via epub.js by default means downloading and
    // unzipping the WHOLE file client-side before the first page can show
    // — fine for a short excerpt, genuinely too slow/heavy for a full-
    // length book on mobile. Once unpacked server-side (see
    // unpack_epub_book.js), this stores the relative path to the real
    // content.opf inside the unpacked file tree (found via META-INF/
    // container.xml, since it isn't always at a fixed location) — lets
    // the reader fetch chapters one at a time through
    // /api/content/library/:id/epub-resource/* instead. NULL until a
    // given book has actually been unpacked.
    "ALTER TABLE library_files ADD COLUMN epub_opf_path TEXT",
    // Preview/full edition linking (Per Bot 15) — a lower-tier "preview"
    // file (e.g. visibility='registered') can point at the full edition
    // it's a preview of. Anyone whose own tier already qualifies for the
    // full version never sees the preview alongside it in a listing —
    // see suppressAccessiblePreviews below. Below that tier, the full
    // version is already inaccessible via the normal visibility gate, so
    // they only ever see the preview, same as before this feature existed.
    "ALTER TABLE library_files ADD COLUMN full_version_id TEXT",
    // Per Bot 15c — practices.filename used to always mean a path on local
    // disk (multer diskStorage, ./uploads/), which is NOT the persistent
    // volume — only the sql.js DB file has one of those. Any audio
    // practice added via the facilitator's "Add practice" feature was
    // silently gone the next time the service redeployed or restarted,
    // while its database row (and its now-broken playback) lived on
    // forever. New audio practices now go to R2 like everything else;
    // storage_type tells the playback-url route which path to resolve.
    // Existing rows default to 'disk' — most of those files are almost
    // certainly already gone by now, but this at least stops the bleeding
    // for anything added from here on.
    "ALTER TABLE practices ADD COLUMN storage_type TEXT DEFAULT 'disk'",
    // Per Bot 15h — legal documents had no way to differ by skin at all;
    // every skin showed the exact same Terms/Privacy regardless of which
    // market or jurisdiction it actually serves. NULL = the global
    // document (used by any skin without its own); set = only that
    // skin's users see this version, versioned independently of the
    // global one under the same slug.
    "ALTER TABLE legal_documents ADD COLUMN skin_id TEXT",
    // Per Bot 15o — powers the "unseen enquiries" badge; NULL means never
    // viewed in the admin People page yet. Facilitator requests don't need
    // an equivalent column since their own status field ('pending' until
    // an actual decision is made) already means the same thing more
    // usefully — viewing the list shouldn't clear that badge, only acting
    // on it should.
    "ALTER TABLE guest_leads ADD COLUMN seen_at TEXT",
    // Per Bot 16 — courses gets its own visibility column (matching
    // lessons, which already had one). Schema/cascade-default only in this
    // pass, deliberately not wired into any actual enforcement yet — see
    // the handover note on why courses/lessons need a design decision
    // before this touches the existing per-instance Stripe paywall.
    "ALTER TABLE courses ADD COLUMN visibility TEXT DEFAULT 'client'",
    // Per Bot 16 — manual admin override, separate from the tier-ladder
    // `visibility` column above (which per Per's own clarification isn't
    // needed for courses/lessons at all right now — nothing there needs
    // hiding from Explorer specifically). This is a simple three-state
    // switch any admin can set regardless of viewer tier: 'visible' (shown,
    // fully open — the default), 'locked' (still shows up so people can
    // see it exists, but can't actually be opened by anyone), 'hidden'
    // (doesn't show up at all). Applies at both the course and lesson
    // level independently.
    "ALTER TABLE courses ADD COLUMN access_status TEXT DEFAULT 'visible'",
    "ALTER TABLE lessons ADD COLUMN access_status TEXT DEFAULT 'visible'",
    // ── clients → users rename migration ──
    // SQLite cannot rename tables in older versions, so we use a copy-and-rename
    // approach via the migration block below. Handled separately after this list.
    // Per Bot 17 — Offers (promotions/campaign links). Nullable, attribution-only —
    // doesn't drive any access logic itself; setMemberTier/trial_ends_at still do that.
    "ALTER TABLE users ADD COLUMN signup_offer_id TEXT",
    // Per Bot 18 — free preview override. Lets one or two files inside an
    // otherwise-locked/enrolment-gated lesson stay openable by anyone
    // Explorer tier and up, regardless of course access_status, lesson
    // access_status, or enforce_lesson_sequence/enforce_file_sequence.
    // Off (0) by default — nothing changes for existing content until an
    // admin explicitly flags a specific file per lesson.
    "ALTER TABLE lesson_file_refs ADD COLUMN free_preview INTEGER DEFAULT 0",
    // Per Bot 18 — /promotions showcase clip. A file explicitly picked as
    // an offer's showcase (or the standing global default below) is safe
    // to serve with zero login at all — the act of an admin selecting it
    // here IS the permission, rather than adding yet another per-file
    // public flag. Nullable; the page simply shows nothing if neither
    // resolves to a file.
    "ALTER TABLE offers ADD COLUMN showcase_file_id TEXT",
    "ALTER TABLE app_config ADD COLUMN default_showcase_file_id TEXT",
    // Per Bot 18 — funnel tracking. skin_id here is reporting-only (which
    // skin this offer is primarily run under) — it never gates access,
    // unlike course_skin_id which does. signup_source carries the ?src=
    // platform/message tag from the promo link through to the account
    // that resulted from it, alongside the existing signup_offer_id.
    "ALTER TABLE offers ADD COLUMN skin_id TEXT",
    "ALTER TABLE users ADD COLUMN signup_source TEXT",
    // Per Bot 18 — course tier-hiding. Deliberately NOT reusing the
    // existing courses.visibility column here — that column defaults to
    // 'client' (rank 4, the 1:1-facilitator-client tier) on every course,
    // a legacy default from before self-registration/Explorer existed,
    // and was never actually enforced anywhere in the client-facing
    // routes. Enforcing it as-is would have silently hidden every
    // existing course from every ordinary self-registered member. This
    // is a clean, purpose-built field instead: NULL (the default) means
    // "no tier requirement" — today's actual behaviour, unchanged for
    // every course that already exists — and only ever restricts
    // anything once an admin explicitly sets it. Scale is 0-3 (Explorer
    // through Member 3), matching member_tier directly, not the
    // file-visibility ladder's client/facilitator/admin levels, which
    // aren't a meaningful concept for "hide this from a lower audience."
    "ALTER TABLE courses ADD COLUMN required_tier INTEGER",
    // 0 (default) = show locked, same as today's access_status='locked'
    // behaviour, just triggered by tier instead of an admin's manual
    // flip. 1 = don't show at all below the required tier.
    "ALTER TABLE courses ADD COLUMN hide_when_locked INTEGER DEFAULT 0",
    // Per Bot 18 — fills the untouched week between the day-3 and day-10
    // trial emails with a real mid-trial nudge.
    "ALTER TABLE users ADD COLUMN trial_email_day7_sent INTEGER DEFAULT 0",
    // Per Bot 18 — trial sequence copy, admin-editable same as the
    // existing reminder/renewal email fields below. Empty/NULL falls back
    // to the hand-written default in server.js, same fallback pattern
    // buildReminderHtml already uses.
    "ALTER TABLE app_config ADD COLUMN trial_day3_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN trial_day3_body TEXT",
    "ALTER TABLE app_config ADD COLUMN trial_day7_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN trial_day7_body TEXT",
    "ALTER TABLE app_config ADD COLUMN trial_day10_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN trial_day10_body TEXT",
    "ALTER TABLE app_config ADD COLUMN trial_day14_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN trial_day14_body TEXT",

    // Per Bot 18 — Savers Protocol. Two distinct lifecycles, both
    // per-person-triggered (not a shared campaign start date, same
    // reasoning as the trial sequence above) rather than a broadcast:
    // - 'cancellation': triggered the moment someone schedules a cancel
    //   (cancel_at_period_end flips true), not when it completes. Their
    //   already-paid time is untouched; savers_grace_ends_at is only set
    //   once that real time actually runs out (customer.subscription.
    //   deleted fires), and is a BONUS 14 days on top of what they paid
    //   for, not a replacement for it.
    // - 'payment_failure': triggered on invoice.payment_failed, but only
    //   when it's a genuine failure — i.e. NOT already mid-cancellation
    //   (see the type check in the webhook handler). savers_grace_ends_at
    //   is set immediately, a firm 14-day window from the first failure,
    //   deliberately independent of however long Stripe's own retry
    //   schedule happens to take.
    // savers_real_period_end: only meaningful for 'cancellation' — the
    // date their actually-paid time runs out, recorded at the moment
    // cancellation is scheduled so the day-0 acknowledgment email can
    // reference it accurately even though the bonus grace period hasn't
    // started yet.
    "ALTER TABLE users ADD COLUMN savers_type TEXT",
    "ALTER TABLE users ADD COLUMN savers_triggered_at TEXT",
    "ALTER TABLE users ADD COLUMN savers_real_period_end TEXT",
    // For payment_failure this equals savers_triggered_at (grace starts
    // immediately on failure). For cancellation it's set LATER, once
    // customer.subscription.deleted actually fires — savers_triggered_at
    // stays as the moment they decided to cancel, which could be months
    // earlier, while this marks when the bonus 14 days actually begins.
    // mid/final touchpoints below count from this field, not from
    // savers_triggered_at, for both types.
    "ALTER TABLE users ADD COLUMN savers_grace_started_at TEXT",
    "ALTER TABLE users ADD COLUMN savers_grace_ends_at TEXT",
    "ALTER TABLE users ADD COLUMN savers_last_prior_tier INTEGER",
    "ALTER TABLE users ADD COLUMN savers_email_day0_sent INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN savers_email_mid_sent INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN savers_email_final_sent INTEGER DEFAULT 0",
    // Admin-editable copy, same fallback-to-hand-written-default pattern
    // as the trial sequence. cancel_day0 fires at the moment of
    // cancellation itself (acknowledgment, no offer yet — their paid time
    // hasn't even started running out); cancel_grace0/mid/final are the
    // three touchpoints across the bonus 14 days once real access ends.
    // failure_day0/mid/final are the three touchpoints across the firm
    // 14-day window from a genuine payment failure.
    "ALTER TABLE app_config ADD COLUMN savers_cancel_day0_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_day0_body TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_grace0_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_grace0_body TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_mid_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_mid_body TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_final_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_final_body TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_failure_day0_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_failure_day0_body TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_failure_mid_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_failure_mid_body TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_failure_final_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN savers_failure_final_body TEXT",
    // ── Unified message editor (Per Bot 19) ── format columns, one per
    // named email step across Trial sequence, Savers Protocol, Reminder,
    // Renewal reminder, and Birthday message — the same 'plain'/'rich'
    // distinction newsletters already had (see the ADD COLUMN format on
    // the newsletters table, above). SMS bodies never get one — they stay
    // plain always, by design. campaign_steps.format and
    // campaigns.source_tag cover the two dynamic-row contexts.
    "ALTER TABLE app_config ADD COLUMN trial_day3_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN trial_day7_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN trial_day10_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN trial_day14_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_day0_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_grace0_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_mid_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN savers_cancel_final_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN savers_failure_day0_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN savers_failure_mid_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN savers_failure_final_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN reminder_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN renewal_reminder_format TEXT DEFAULT 'plain'",
    "ALTER TABLE app_config ADD COLUMN birthday_email_format TEXT DEFAULT 'plain'",
    // campaign_steps already stores content per-row (unlike the singleton
    // app_config fields above) — one format column covers every step,
    // read only when channel='email' (social steps ignore it entirely).
    "ALTER TABLE campaign_steps ADD COLUMN format TEXT DEFAULT 'plain'",
    // campaigns didn't previously carry their own source tag — email
    // steps had no way to show up distinctly in the Funnel report the way
    // every newsletter/promo link already does. Auto-filled from the
    // campaign name at creation (see createCampaign below); editable
    // later isn't built yet, not required for the unified editor itself.
    "ALTER TABLE campaigns ADD COLUMN source_tag TEXT",
    // ── Newsletter → Explorer welcome (Per Bot 19) ── the permanent,
    // warm replacement for the bare "Your account is ready" email,
    // specifically for genuine newsletter-only contacts (member_tier=0,
    // password_hash IS NULL — see NEWSLETTER_AUDIENCE_CLAUSES) becoming a
    // real account for the first time. Every other activation path
    // (facilitator adding a client, bulk import, lead conversion) keeps
    // the original emailWelcomeClient unchanged — this one is specific to
    // "was reading the newsletter, now has a real account."
    "ALTER TABLE app_config ADD COLUMN newsletter_welcome_subject TEXT",
    "ALTER TABLE app_config ADD COLUMN newsletter_welcome_body TEXT",
    "ALTER TABLE app_config ADD COLUMN newsletter_welcome_format TEXT DEFAULT 'plain'",
    // Stored email body (Per Bot 21) — the rendered HTML actually sent,
    // captured at send time in sendEmail() so the admin Email Log can show
    // "what did this actually look like" rather than just subject/status.
    // Forward-only, same as cron_log/login_log/talk_sessions before it —
    // nothing retroactive for sends that happened before this column
    // existed. Deliberately kept out of getRecentEmailLog's SELECT list
    // (see below) so the list view stays light; fetched on demand per row.
    "ALTER TABLE email_log ADD COLUMN body_html TEXT",
    // Per Bot 24 — accessibility: reversed-colour contrast mode and a
    // text-size preference, both saved to the account (not just the
    // browser) so they follow a member to whatever device they log in on.
    // a11y_contrast: 0 = normal, 1 = high contrast (colours inverted).
    // a11y_text_scale: 'normal' | 'large' | 'larger'.
    "ALTER TABLE users ADD COLUMN a11y_contrast INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN a11y_text_scale TEXT DEFAULT 'normal'",
    // Per Bot 27 — length of a signal script in minutes, for the admin
    // list's sortable Length column and so Talk's 1-min/5-min choice
    // (Writing Methodology v11 Rule 18) can filter by it directly rather
    // than guessing from the topic text. Defaults to 1 (true for nearly
    // everything already in the table). The UPDATE below runs on every
    // boot like the rest of this list, but its WHERE guard (length_minutes
    // still at the default) makes it a no-op after the first successful
    // run — catches the five-minute set bulk-imported just before this
    // column existed, identified the same way the admin panel already
    // visually flags them, by "(five minutes)" in the topic.
    "ALTER TABLE talk_signal_scripts ADD COLUMN length_minutes INTEGER DEFAULT 1",
    "UPDATE talk_signal_scripts SET length_minutes=5 WHERE topic LIKE '%(five minutes)%' AND length_minutes=1",
  ];
  migrations.forEach(sql => {
    try { db.run(sql); } catch(e) { /* column already exists — ignore */ }
  });

  // Must run after migrations, not with the other CREATE INDEX statements
  // above — invite_token doesn't exist until the migration above adds it.
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users(invite_token)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_unsubscribe_token ON users(unsubscribe_token)`);

  // ── Backfill: every Tomte photo already in use anywhere becomes a real
  // library entry (Per Bot 31) ── Before this table existed, a photo only
  // ever existed as a side-effect of being assigned somewhere — this
  // retroactively gives every one of those a proper standalone row, so
  // nothing already uploaded disappears from the new library view.
  // INSERT OR IGNORE against the UNIQUE filename constraint makes each of
  // these safe to run on every boot, not just the first one after this
  // shipped — same pattern as the client_facilitators backfill below.
  try {
    db.run(`INSERT OR IGNORE INTO tomte_image_library (id, filename)
      SELECT DISTINCT lower(hex(randomblob(16))), tomte_image_filename FROM users WHERE tomte_image_filename IS NOT NULL`);
    db.run(`INSERT OR IGNORE INTO tomte_image_library (id, filename)
      SELECT DISTINCT lower(hex(randomblob(16))), tomte_image_filename FROM facilitators WHERE tomte_image_filename IS NOT NULL`);
    db.run(`INSERT OR IGNORE INTO tomte_image_library (id, filename)
      SELECT DISTINCT lower(hex(randomblob(16))), image_filename FROM tomte_language_defaults WHERE image_filename IS NOT NULL`);
  } catch(e) { /* ignore */ }

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

  // ── Backfill: existing single facilitator_id assignments become the
  // first row in client_facilitators (Per Bot 13) ──
  // The legacy column stays authoritative for anything not yet updated to
  // use the new many-to-many table (see client_facilitators above) — this
  // just makes sure every client's existing relationship also shows up in
  // the new "list of my facilitators" view from day one, rather than
  // looking empty until someone's explicitly assigned a second one.
  // INSERT OR IGNORE makes this naturally safe to run on every boot.
  try {
    db.run(`INSERT OR IGNORE INTO client_facilitators (id, client_id, facilitator_id)
      SELECT lower(hex(randomblob(16))), id, facilitator_id FROM users WHERE facilitator_id IS NOT NULL`);
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

  // Seed content kinds if empty — same values that used to live in the
  // hardcoded CONTENT_KINDS array, so existing library_files.content_type
  // values still resolve to a real row and nothing appears unlabelled.
  const existingKinds = queryAll('SELECT id FROM content_kinds LIMIT 1');
  if (!existingKinds.length) seedContentKinds();

  // App Files category (Per Bot 7) — a home for bell/background-sound
  // uploads that don't belong in any real content category, so the
  // (otherwise mandatory) category field on upload doesn't block them.
  // INSERT OR IGNORE, unconditional — unlike seedCategories() above, this
  // must exist even on deployments that already have their own categories
  // and would never hit the "seed if empty" branch. Deliberately placed
  // AFTER that check: inserting first would make the categories table
  // non-empty and silently skip seedCategories() on a genuinely fresh install.
  db.run(`INSERT OR IGNORE INTO categories (id,name,slug,parent_id,sort_order) VALUES ('cat-appfiles','App Files','app-files',NULL,999)`);
  db.run(`INSERT OR IGNORE INTO categories (id,name,slug,parent_id,sort_order) VALUES ('sub-appfiles','App Files','app-files-sub','cat-appfiles',1)`);

  // Category tree v2 (Per Bot 8) — University / Mindfulness / FELT·FIBRE /
  // Therapy, replacing the old Mindfulness/FELT·FIBRE/Girls Programme/Therapy
  // set. Runs unconditionally on every boot, same reasoning as the App
  // Files insert above: existing deployments already have a non-empty
  // categories table and would never hit seedCategories(). Naturally
  // idempotent — INSERT OR IGNORE is safe to repeat, and the remap/delete
  // steps below become no-ops once the old ids are gone.
  migrateCategoryTreeV2(db);

  // Migrate the one-off Dutch/Mare column into the new generalized
  // language-defaults table, so the image Per already uploaded isn't lost.
  // Naturally idempotent — once migrated, the app_config column is cleared,
  // so this becomes a no-op on every subsequent boot.
  try {
    const cfg = getAppConfig();
    if (cfg && cfg.tomte_nl_image_filename) {
      db.run(`INSERT OR REPLACE INTO tomte_language_defaults (language, action, image_filename, updated_at) VALUES ('nl', 'default', ?, datetime('now'))`, [cfg.tomte_nl_image_filename]);
      db.run(`UPDATE app_config SET tomte_nl_image_filename=NULL WHERE id='default'`);
      save();
    }
  } catch(e) { console.error('[db] tomte_nl_image_filename migration error:', e.message); }

  // Seed default membership plans if empty
  const existingPlans = queryAll('SELECT id FROM membership_plans LIMIT 1');
  if (!existingPlans.length) seedMembershipPlans();

  // Seed the lines already written and approved this session (Per Bot 17
  // phase 6) so the bank isn't empty on first deploy — everything after
  // this is added either manually or via the trend-scan tool.
  const existingLines = queryAll('SELECT id FROM signal_lines LIMIT 1');
  if (!existingLines.length) {
    const seedLines = [
      { text: "You don't have to earn the right to rest.", prior_tag: 'fear' },
      { text: "You don't have to keep doing this alone.", prior_tag: 'belonging' },
      { text: "You don't have to prove you matter.", prior_tag: 'mattering' },
      { text: "You don't have to earn the right to rest — You don't have to keep doing this alone — You don't have to prove you matter.", prior_tag: 'general' },
      { text: 'The practice of being enough.', prior_tag: 'general' },
      { text: 'Nothing to earn. Nothing to prove.', prior_tag: 'general' },
      { text: 'A place to stop bracing.', prior_tag: 'fear' },
    ];
    seedLines.forEach(l => {
      db.run(
        'INSERT INTO signal_lines (id,text,prior_tag,status,source) VALUES (?,?,?,?,?)',
        [crypto.randomUUID(), l.text, l.prior_tag, 'active', 'manual']
      );
    });
    save();
  }

  // Seed the standing default offer if none exists (Per Bot 17) — formalises
  // the 14-day trial that registerUser() already granted every self-signup
  // before offers existed, so nothing changes for existing behaviour on
  // deployments that never touch the Offers admin at all.
  const existingOffers = queryAll('SELECT id FROM offers LIMIT 1');
  if (!existingOffers.length) {
    db.run(
      `INSERT INTO offers (id,name,code,headline,description,trial_days,launch_date,expiry_date,is_default,active,cloned_from)
       VALUES ('offer-default-14day','Standing 14-day trial','standing-trial','14 days full access — free, no card needed','Everything unlocked for two weeks. No payment details required.',14,NULL,NULL,1,1,NULL)`
    );
    save();
  }

  // Seed legal documents if empty
  const existingLegal = queryAll('SELECT id FROM legal_documents LIMIT 1');
  if (!existingLegal.length) seedLegalDocuments();

  // Seed default breathing patterns if empty
  const existingBreathing = queryAll('SELECT id FROM breathing_patterns LIMIT 1');
  if (!existingBreathing.length) seedBreathingPatterns();

  // Seed the default knowledge depth ladder if empty
  const existingLevels = queryAll('SELECT id FROM knowledge_levels_config LIMIT 1');
  if (!existingLevels.length) seedKnowledgeLevels();

  save();
  return db;
}

function seedCategories() {
  const cats = [
    { id:'cat-mindfulness',  name:'Mindfulness',      slug:'mindfulness',       parent_id:null,             sort_order:1 },
    { id:'cat-felt',         name:'FELT·FIBRE',        slug:'felt-fibre',        parent_id:null,             sort_order:2 },
    { id:'cat-girls',        name:'University',        slug:'university',        parent_id:null,             sort_order:3 },
    { id:'cat-therapy',      name:'Therapy',           slug:'therapy',           parent_id:null,             sort_order:4 },
    { id:'sub-mfl',          name:'Mindfulness for Life', slug:'mindfulness-for-life', parent_id:'cat-mindfulness', sort_order:1 },
    { id:'sub-mbct',         name:'MBCT',              slug:'mbct',              parent_id:'cat-mindfulness', sort_order:2 },
    { id:'sub-mbsr',         name:'MBSR',              slug:'mbsr',              parent_id:'cat-mindfulness', sort_order:3 },
    { id:'sub-finding-peace',name:'Finding Peace',     slug:'finding-peace',     parent_id:'cat-mindfulness', sort_order:4 },
    { id:'sub-deeper',       name:'Deeper Mindfulness', slug:'deeper-mindfulness',parent_id:'cat-mindfulness', sort_order:5 },
    { id:'sub-felt-facilitation', name:'Facilitation', slug:'felt-facilitation', parent_id:'cat-felt',       sort_order:1 },
    { id:'sub-felt-compassion',   name:'Compassion',   slug:'felt-compassion',   parent_id:'cat-felt',       sort_order:2 },
    { id:'sub-felt-relax',        name:'Relax',        slug:'felt-relax',        parent_id:'cat-felt',       sort_order:3 },
    { id:'sub-felt-sleep',        name:'Sleep',        slug:'felt-sleep',        parent_id:'cat-felt',       sort_order:4 },
    { id:'sub-felt-stress',       name:'Stress',       slug:'felt-stress',       parent_id:'cat-felt',       sort_order:5 },
    { id:'sub-felt-anger',        name:'Anger',        slug:'felt-anger',        parent_id:'cat-felt',       sort_order:6 },
    { id:'sub-felt-adhd',         name:'ADHD',         slug:'felt-adhd',         parent_id:'cat-felt',       sort_order:7 },
    { id:'sub-finding-calm', name:'Finding Calm',      slug:'finding-calm',      parent_id:'cat-felt',        sort_order:8 },
    { id:'sub-finding-joy',  name:'Finding Joy',       slug:'finding-joy',       parent_id:'cat-felt',        sort_order:9 },
    { id:'sub-girls-y',      name:'Younger Girls',     slug:'girls-younger',     parent_id:'cat-girls',       sort_order:1 },
    { id:'sub-girls-o',      name:'Older Girls',       slug:'girls-older',       parent_id:'cat-girls',       sort_order:2 },
    { id:'sub-student-programme', name:'Student programme', slug:'student-programme', parent_id:'cat-girls',  sort_order:3 },
    { id:'sub-felt-to-teach',     name:'FELT to Teach',     slug:'felt-to-teach',     parent_id:'cat-girls',  sort_order:4 },
    { id:'sub-childrens-book',    name:"Children's Book",   slug:'childrens-book',    parent_id:'cat-girls',  sort_order:5 },
    { id:'sub-cbt',          name:'CBT',               slug:'cbt',               parent_id:'cat-therapy',     sort_order:1 },
    { id:'sub-therapy-adhd',        name:'ADHD',         slug:'therapy-adhd',        parent_id:'cat-therapy', sort_order:2 },
    { id:'sub-therapy-audhs',       name:'AuDHS',        slug:'therapy-audhs',       parent_id:'cat-therapy', sort_order:3 },
    { id:'sub-therapy-inflammatory',name:'Inflammatory', slug:'therapy-inflammatory',parent_id:'cat-therapy', sort_order:4 },
    { id:'sub-therapy-facilitation',name:'Facilitation', slug:'therapy-facilitation',parent_id:'cat-therapy', sort_order:5 },
  ];
  cats.forEach(c => {
    db.run('INSERT OR IGNORE INTO categories (id,name,slug,parent_id,sort_order) VALUES (?,?,?,?,?)',
      [c.id, c.name, c.slug, c.parent_id, c.sort_order]);
  });
}

function seedContentKinds() {
  const kinds = [
    { id:'kind-meditation',   value:'meditation',   label:'Practice / meditation',              sort_order:1 },
    { id:'kind-course-intro', value:'course_intro', label:'Course intro video',                  sort_order:2 },
    { id:'kind-blog',         value:'blog',         label:'Blog post',                           sort_order:3 },
    { id:'kind-video-blog',   value:'video_blog',   label:'Video blog',                          sort_order:4 },
    { id:'kind-poem',         value:'poem',         label:'Poem',                                sort_order:5 },
    { id:'kind-whitepaper',   value:'whitepaper',   label:'Whitepaper',                          sort_order:6 },
    { id:'kind-book',         value:'book',         label:'Book (excerpt or full)',              sort_order:7 },
    { id:'kind-timer-bell',   value:'timer_bell',   label:'Timer — bell sound',                  sort_order:8 },
    { id:'kind-timer-music',  value:'timer_music',  label:'Timer — background sound (loops)',    sort_order:9 },
    { id:'kind-calming-sound',value:'calming_sound',label:'Calming sound (Home page)',            sort_order:10 },
    { id:'kind-other',        value:'other',        label:'Other',                               sort_order:11 },
  ];
  kinds.forEach(k => {
    db.run('INSERT OR IGNORE INTO content_kinds (id,value,label,sort_order) VALUES (?,?,?,?)',
      [k.id, k.value, k.label, k.sort_order]);
  });
}

// ── Category tree v2 migration (Per Bot 8) ──
// Retires four old subcategories (Introduction ×2, Practitioner, FELT·FIBRE
// Therapy, General) into the new named subcategories, reparents the Girls
// Programme category into University, and adds the new subcategories that
// have no old equivalent. Every content-bearing table with a category_id/
// subcategory_id column is remapped so nothing silently disappears.
function migrateCategoryTreeV2(dbHandle) {
  const NEW_SUBS = [
    ['sub-finding-peace',      'Finding Peace',  'finding-peace',       'cat-mindfulness', 4],
    ['sub-felt-facilitation', 'Facilitation',    'felt-facilitation',   'cat-felt', 1],
    ['sub-felt-compassion',   'Compassion',      'felt-compassion',     'cat-felt', 2],
    ['sub-felt-relax',        'Relax',           'felt-relax',          'cat-felt', 3],
    ['sub-felt-sleep',        'Sleep',           'felt-sleep',          'cat-felt', 4],
    ['sub-felt-stress',       'Stress',          'felt-stress',         'cat-felt', 5],
    ['sub-felt-anger',        'Anger',           'felt-anger',          'cat-felt', 6],
    ['sub-felt-adhd',         'ADHD',            'felt-adhd',           'cat-felt', 7],
    ['sub-student-programme', 'Student programme','student-programme', 'cat-girls', 3],
    ['sub-felt-to-teach',     'FELT to Teach',   'felt-to-teach',       'cat-girls', 4],
    ['sub-childrens-book',    "Children's Book", 'childrens-book',      'cat-girls', 5],
    ['sub-therapy-adhd',         'ADHD',         'therapy-adhd',        'cat-therapy', 2],
    ['sub-therapy-audhs',        'AuDHS',        'therapy-audhs',       'cat-therapy', 3],
    ['sub-therapy-inflammatory', 'Inflammatory', 'therapy-inflammatory','cat-therapy', 4],
    ['sub-therapy-facilitation', 'Facilitation', 'therapy-facilitation','cat-therapy', 5],
  ];
  try {
    // Rename Girls Programme -> University in place, so anything already
    // tagged category_id='cat-girls' repoints automatically with zero data migration.
    dbHandle.run(`UPDATE categories SET name='University', slug='university' WHERE id='cat-girls'`);

    NEW_SUBS.forEach(([id, name, slug, parent, sort]) => {
      dbHandle.run('INSERT OR IGNORE INTO categories (id,name,slug,parent_id,sort_order) VALUES (?,?,?,?,?)',
        [id, name, slug, parent, sort]);
    });

    const REMAP = [
      ['sub-mind-intro',  'sub-deeper'],
      ['sub-felt-intro',  'sub-felt-facilitation'],
      ['sub-felt-prac',   'sub-felt-facilitation'],
      ['sub-felt-therapy','sub-therapy-facilitation'],
      ['sub-therapy-gen', 'sub-therapy-inflammatory'],
    ];
    const TABLES_WITH_SUBCAT = ['library_files', 'courses', 'playlists', 'users', 'programme_assignments'];
    REMAP.forEach(([oldId, newId]) => {
      TABLES_WITH_SUBCAT.forEach(table => {
        try { dbHandle.run(`UPDATE ${table} SET subcategory_id=? WHERE subcategory_id=?`, [newId, oldId]); } catch(e) {}
      });
      try { dbHandle.run(`DELETE FROM categories WHERE id=?`, [oldId]); } catch(e) {}
    });
  } catch(e) {
    console.error('[db] migrateCategoryTreeV2 error:', e.message);
  }
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

// Six starting patterns, each a JSON phase array ({type:'in'|'hold'|'out', seconds})
// for ONE cycle — the client repeats it default_cycles times. `situation` is
// Talk-facing guidance only (see CLIENT_BREATHING_MENU in prompts.js), never
// shown to the person. Per can add, edit, or archive these from Admin —
// this seed just gives Talk something usable on day one.
function seedBreathingPatterns() {
  const patterns = [
    { id: 'box-breathing', name: 'Box Breathing', sort_order: 1, default_cycles: 6,
      situation: 'General stress or overwhelm; steadying before something specific (a meeting, a hard conversation). A solid, structured all-rounder.',
      phases: [{type:'in',seconds:4},{type:'hold',seconds:4},{type:'out',seconds:4},{type:'hold',seconds:4}] },
    { id: 'extended-exhale', name: 'Extended Exhale', sort_order: 2, default_cycles: 8,
      situation: 'Anxious, racing thoughts, needs calming down rather than energising up. The longer exhale is the active ingredient.',
      phases: [{type:'in',seconds:4},{type:'out',seconds:6}] },
    { id: '4-7-8', name: '4-7-8 Breathing', sort_order: 3, default_cycles: 5,
      situation: 'Winding down, trouble settling, especially before sleep. Slower and more demanding than the others — best when there is a little more time.',
      phases: [{type:'in',seconds:4},{type:'hold',seconds:7},{type:'out',seconds:8}] },
    { id: 'coherent-breathing', name: 'Coherent Breathing', sort_order: 4, default_cycles: 8,
      situation: 'No acute distress — a steady baseline practice, or a gentle general reset with nothing specific driving it.',
      phases: [{type:'in',seconds:5},{type:'out',seconds:5}] },
    { id: 'physiological-sigh', name: 'Physiological Sigh', sort_order: 5, default_cycles: 5,
      situation: 'A sudden stress spike, right now, in the moment — the fastest reset available. The double inhale is the whole point.',
      phases: [{type:'in',seconds:2},{type:'in',seconds:1},{type:'out',seconds:6}] },
    { id: 'quick-reset', name: 'Quick Reset', sort_order: 6, default_cycles: 6,
      situation: 'Very short window — between calls, before walking into a room. Just needs 30-40 seconds, nothing more.',
      phases: [{type:'in',seconds:3},{type:'out',seconds:3}] },
  ];
  patterns.forEach(p => {
    db.run(`INSERT OR IGNORE INTO breathing_patterns (id,name,situation,phases,default_cycles,sort_order,archived)
      VALUES (?,?,?,?,?,?,0)`, [p.id, p.name, p.situation, JSON.stringify(p.phases), p.default_cycles, p.sort_order]);
  });
}

// Per Bot 15p — the depth ladder above Heading (Heading itself is just
// topic.menu_line, always free, no row here). Each level's description
// is fed straight into the generation prompt, so it drives what gets
// written at that depth for every topic — change the description here
// and future generations follow it, without touching prompt code.
function seedKnowledgeLevels() {
  const levels = [
    { id: 'overview', name: 'Overview', sort_order: 1,
      description: 'A clear, plain-language summary of this topic — a paragraph or two. Enough for Talk to explain the idea to someone directly, in ordinary conversation, without jargon.' },
    { id: 'user', name: 'User', sort_order: 2,
      description: 'Practical, person-facing depth: how this actually shows up for someone, what it feels like, what to do about it, concrete phrases and signals to offer. Written for guiding a real person through this in conversation.' },
    { id: 'teacher', name: 'Teacher', sort_order: 3,
      description: 'The working knowledge a facilitator or teacher needs: mechanisms, sequencing, what to watch for, common mistakes, how this connects to other areas of the framework. Assumes clinical/practice familiarity.' },
    { id: 'scientist', name: 'Scientist', sort_order: 4,
      description: 'Full mechanistic and evidence depth — the underlying science, the specific pathways, supporting research, edge cases and failure modes. The fullest, most technical version of this topic.' },
  ];
  levels.forEach(l => {
    db.run(`INSERT OR IGNORE INTO knowledge_levels_config (id,name,sort_order,description) VALUES (?,?,?,?)`,
      [l.id, l.name, l.sort_order, l.description]);
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

// ── Client <-> facilitator relationships (Per Bot 13) ──
// "Talk" is deliberately never in this table — it's a synthetic id the
// API layer adds on top (see /api/client/facilitators in server.js),
// always present for every client regardless of what's in here.
function getFacilitatorsForClient(clientId) {
  return queryAll(`SELECT f.* FROM client_facilitators cf JOIN facilitators f ON cf.facilitator_id=f.id WHERE cf.client_id=? ORDER BY cf.created_at ASC`, [clientId]);
}
function isFacilitatorAssignedToClient(clientId, facilitatorId) {
  return !!queryOne(`SELECT 1 FROM client_facilitators WHERE client_id=? AND facilitator_id=?`, [clientId, facilitatorId]);
}
function addClientFacilitator(clientId, facilitatorId) {
  getDbSync().run(`INSERT OR IGNORE INTO client_facilitators (id, client_id, facilitator_id) VALUES (?, ?, ?)`, [crypto.randomUUID(), clientId, facilitatorId]);
  save();
}
function removeClientFacilitator(clientId, facilitatorId) {
  getDbSync().run(`DELETE FROM client_facilitators WHERE client_id=? AND facilitator_id=?`, [clientId, facilitatorId]);
  save();
}
function updateFacilitatorPassword(id, hash) {
  getDbSync().run('UPDATE facilitators SET password_hash=?,must_change_password=0 WHERE id=?', [hash, id]); save();
}
function setFacilitatorResetToken(id, token, expiresAt) {
  getDbSync().run('UPDATE facilitators SET reset_token=?,reset_token_expires=? WHERE id=?', [token, expiresAt, id]); save();
}
function getFacilitatorByResetToken(token) {
  return queryOne("SELECT * FROM facilitators WHERE reset_token=? AND reset_token_expires>datetime('now')", [token]);
}
function clearFacilitatorResetToken(id) {
  getDbSync().run('UPDATE facilitators SET reset_token=NULL,reset_token_expires=NULL WHERE id=?', [id]); save();
}
function adminResetFacilitatorPassword(id, hash) {
  getDbSync().run('UPDATE facilitators SET password_hash=?,must_change_password=1,reset_token=NULL,reset_token_expires=NULL WHERE id=?', [hash, id]); save();
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
// Separate from updateFacilitatorDetails above deliberately — that function
// is shared by both "admin edits another facilitator" and "I'm editing my
// own name/email", and adding phone there would mean touching both call
// sites for something that's really just a personal detail on your own
// account (used to default the SMS test-send fields).
function updateFacilitatorPhone(id, phone) {
  getDbSync().run('UPDATE facilitators SET phone=? WHERE id=?', [phone || null, id]); save();
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

// ── Content kinds ──
function getAllContentKinds() { return queryAll('SELECT * FROM content_kinds ORDER BY sort_order ASC, label ASC'); }
function createContentKind(id, value, label, sortOrder) {
  getDbSync().run('INSERT INTO content_kinds (id,value,label,sort_order) VALUES (?,?,?,?)',
    [id, value, label, sortOrder || 0]); save();
}
// Renames the label only — value is the slug stored on every existing
// library_files.content_type row, so it stays fixed for the life of the
// kind, same reasoning as a category's slug never changing on rename.
function renameContentKind(id, label) {
  getDbSync().run('UPDATE content_kinds SET label=? WHERE id=?', [label, id]); save();
}
function deleteContentKind(id) { getDbSync().run('DELETE FROM content_kinds WHERE id=?', [id]); save(); }

// ── Library files ──
function addLibraryFile(id, title, description, filename, originalName, fileType, fileSize, categoryId, subcategoryId, visibility, storageType, facilitatorResource, contentType, externalLink, assignedClientId) {
  getDbSync().run(`INSERT INTO library_files
    (id,title,description,filename,original_name,file_type,file_size,category_id,subcategory_id,visibility,storage_type,facilitator_resource,content_type,external_link,assigned_client_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, title, description||'', filename, originalName, fileType, fileSize||0,
     categoryId, subcategoryId||null, visibility||'client', storageType||'disk', facilitatorResource ? 1 : 0,
     contentType||null, externalLink||null, assignedClientId||null]);
  save();
}
function getLibraryFile(id) { return queryOne('SELECT * FROM library_files WHERE id=?', [id]); }
// Per Bot 16 — every text/html file (blog posts, poems, whitepapers —
// anything whose actual content lives in a real HTML file rather than a
// PDF/docx/audio blob), for the mojibake scan/fix tool. Includes
// archived files too, deliberately — an archived piece with corrupted
// text is still worth fixing if it ever gets unarchived later.
function getAllTextHtmlFiles() {
  return queryAll("SELECT * FROM library_files WHERE file_type='text/html'");
}
// Per Bot 16 — finds likely-duplicate library files: same content_type,
// same title once trimmed/lowercased, AND same file size. Title alone
// wasn't reliable — a course's video and its companion transcript can
// share the exact same display title while being genuinely different
// files, and matching on title alone flagged those as false duplicates.
// File size matching too is a much stronger signal that two rows are
// actually the same content uploaded twice (the failure mode from the
// rocky Per Bot 14 poem import), not just similarly named.
function findDuplicateLibraryFiles() {
  const files = queryAll(`SELECT f.*, cat.name as category_name FROM library_files f
    LEFT JOIN categories cat ON f.category_id=cat.id
    WHERE f.archived=0`);
  const groups = {};
  files.forEach(f => {
    const key = f.content_type + '::' + (f.title || '').trim().toLowerCase() + '::' + (f.file_size || 0);
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  });
  return Object.values(groups).filter(g => g.length > 1);
}

// Per Bot 21 — domain migration check: WordPress-era content (course/
// lesson/library descriptions) can carry hand-embedded absolute links
// or images pointing at the old domain, which the R2/library-file
// migration never touched since those live as free text/HTML inside
// these description fields, not as tracked file references. Read-only
// report — fixing a broken embedded link needs a human to see it in
// context, not an automated find/replace across arbitrary HTML.
function scanDescriptionsForDomainRefs(term) {
  const needle = `%${term}%`;
  const results = [];
  queryAll(`SELECT id, title, description FROM courses WHERE description LIKE ?`, [needle])
    .forEach(r => results.push({ type: 'course', id: r.id, title: r.title, snippet: extractSnippet(r.description, term) }));
  queryAll(`SELECT id, title, description FROM lessons WHERE description LIKE ?`, [needle])
    .forEach(r => results.push({ type: 'lesson', id: r.id, title: r.title, snippet: extractSnippet(r.description, term) }));
  queryAll(`SELECT id, title, description FROM library_files WHERE description LIKE ? AND archived=0`, [needle])
    .forEach(r => results.push({ type: 'library_file', id: r.id, title: r.title, snippet: extractSnippet(r.description, term) }));
  return results;
}
// A short window of text around the first match, so the admin report
// shows enough context to judge whether it matters without opening
// every single item individually.
function extractSnippet(text, term) {
  const idx = (text || '').toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + term.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
function getLibraryFiles(filters = {}) {
  let sql = `SELECT f.*,
    cat.name as category_name, sub.name as subcategory_name,
    ac.name as assigned_client_name,
    (SELECT COUNT(*) FROM lesson_file_refs WHERE file_id=f.id) +
    (SELECT COUNT(*) FROM playlist_track_refs WHERE file_id=f.id) as use_count
    FROM library_files f
    LEFT JOIN categories cat ON f.category_id=cat.id
    LEFT JOIN categories sub ON f.subcategory_id=sub.id
    LEFT JOIN users ac ON f.assigned_client_id=ac.id
    WHERE 1=1`;
  const params = [];
  if (!filters.includeArchived) sql += ' AND f.archived=0';
  if (filters.categoryId)    { sql += ' AND f.category_id=?';    params.push(filters.categoryId); }
  if (filters.subcategoryId) { sql += ' AND f.subcategory_id=?'; params.push(filters.subcategoryId); }
  if (filters.visibility)    { sql += ' AND f.visibility=?';     params.push(filters.visibility); }
  if (filters.contentType)   { sql += ' AND f.content_type=?';   params.push(filters.contentType); }
  if (filters.search)        { sql += ' AND (f.title LIKE ? OR f.original_name LIKE ?)';
    params.push('%'+filters.search+'%', '%'+filters.search+'%'); }
  sql += ' ORDER BY f.created_at DESC';
  return queryAll(sql, params);
}
function updateLibraryFile(id, fields) {
  const allowed = ['title','description','category_id','subcategory_id','visibility','content_type','external_link','assigned_client_id','featured','talk_practice','epub_opf_path','full_version_id'];
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

// ── Library file tags (Per Bot 13) ──
// addFileTag is idempotent (UNIQUE(file_id,tag) + INSERT OR IGNORE) so re-running
// an import script never duplicates a tag on the same file.
function addFileTag(fileId, tag) {
  getDbSync().run('INSERT OR IGNORE INTO library_file_tags (id,file_id,tag) VALUES (?,?,?)', [crypto.randomUUID(), fileId, tag]);
  save();
}
function removeFileTag(fileId, tag) {
  getDbSync().run('DELETE FROM library_file_tags WHERE file_id=? AND tag=?', [fileId, tag]); save();
}
function getFileTags(fileId) {
  return queryAll('SELECT tag FROM library_file_tags WHERE file_id=? ORDER BY tag', [fileId]).map(r => r.tag);
}
// Every distinct tag currently in use, with how many files carry it — powers
// an admin "browse by theme" view and eventually the theme sliders themselves.
function getAllTags() {
  return queryAll(`SELECT tag, COUNT(*) as file_count FROM library_file_tags
    GROUP BY tag ORDER BY file_count DESC, tag ASC`);
}
// All (non-archived) files carrying a given tag, across every content_type —
// this is the query a theme slider ("Self-Worth: blogs + meditations + poems")
// actually runs.
function getFilesByTag(tag) {
  return queryAll(`SELECT f.*, cat.name as category_name, sub.name as subcategory_name
    FROM library_files f
    JOIN library_file_tags t ON t.file_id = f.id
    LEFT JOIN categories cat ON f.category_id=cat.id
    LEFT JOIN categories sub ON f.subcategory_id=sub.id
    WHERE t.tag=? AND f.archived=0
    ORDER BY f.created_at DESC`, [tag]);
}
function getTtsCacheEntry(cacheKey) {
  return queryOne('SELECT * FROM tts_cache WHERE cache_key=?', [cacheKey]);
}
function setTtsCacheEntry(cacheKey, r2Key) {
  getDbSync().run('INSERT OR REPLACE INTO tts_cache (cache_key, r2_key) VALUES (?,?)', [cacheKey, r2Key]);
  save();
}
function getTranslatedTemplate(templateKey, language) {
  return queryOne('SELECT * FROM translated_templates WHERE template_key=? AND language=?', [templateKey, language]);
}
function saveTranslatedTemplate(id, templateKey, language, subject, html) {
  getDbSync().run(
    `INSERT INTO translated_templates (id,template_key,language,subject,html) VALUES (?,?,?,?,?)
     ON CONFLICT(template_key,language) DO UPDATE SET subject=excluded.subject, html=excluded.html`,
    [id, templateKey, language, subject, html]
  );
  save();
}

// ── Breathing patterns (Per Bot 15) ── phases stored as a JSON string in
// the DB, always parsed back into a real array before it leaves this file
// — nothing outside db.js should ever have to know it's stored as text.
function parseBreathingPattern(row) {
  if (!row) return row;
  let phases = [];
  try { phases = JSON.parse(row.phases); } catch (e) { phases = []; }
  return { ...row, phases };
}
function getBreathingPatterns(includeArchived) {
  const sql = includeArchived
    ? 'SELECT * FROM breathing_patterns ORDER BY sort_order ASC, name ASC'
    : 'SELECT * FROM breathing_patterns WHERE archived=0 ORDER BY sort_order ASC, name ASC';
  return queryAll(sql).map(parseBreathingPattern);
}
function getBreathingPattern(id) {
  return parseBreathingPattern(queryOne('SELECT * FROM breathing_patterns WHERE id=?', [id]));
}
// Talk-facing menu never needs anything beyond what CLIENT_BREATHING_MENU
// actually prints (id/name/situation) — kept separate from the full row
// so nothing accidentally leaks phase timing into the prompt as filler.
function getBreathingPatternMenu() {
  return queryAll('SELECT id, name, situation FROM breathing_patterns WHERE archived=0 ORDER BY sort_order ASC, name ASC');
}
function createBreathingPattern(id, name, situation, phases, defaultCycles, sortOrder) {
  getDbSync().run(
    `INSERT INTO breathing_patterns (id,name,situation,phases,default_cycles,sort_order,archived) VALUES (?,?,?,?,?,?,0)`,
    [id, name, situation || '', JSON.stringify(phases), defaultCycles || 6, sortOrder || 0]
  );
  save();
}
function updateBreathingPattern(id, fields) {
  const allowed = ['name', 'situation', 'phases', 'default_cycles', 'sort_order', 'archived'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    sets.push(`${k}=?`);
    params.push(k === 'phases' ? JSON.stringify(fields[k]) : fields[k]);
  }
  if (!sets.length) return;
  params.push(id);
  getDbSync().run(`UPDATE breathing_patterns SET ${sets.join(', ')} WHERE id=?`, params);
  save();
}
function deleteBreathingPattern(id) {
  getDbSync().run('DELETE FROM breathing_patterns WHERE id=?', [id]);
  save();
}

// ══ Sectioned knowledge (Per Bot 15p) ══

// -- Levels config --
function getKnowledgeLevels() {
  return queryAll('SELECT * FROM knowledge_levels_config ORDER BY sort_order ASC');
}
function addKnowledgeLevel(id, name, sortOrder, description) {
  getDbSync().run('INSERT INTO knowledge_levels_config (id,name,sort_order,description) VALUES (?,?,?,?)',
    [id, name, sortOrder, description || '']);
  save();
}
function updateKnowledgeLevel(id, fields) {
  const allowed = ['name', 'sort_order', 'description'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k));
  if (!sets.length) return;
  const params = sets.map(k => fields[k]);
  params.push(id);
  getDbSync().run(`UPDATE knowledge_levels_config SET ${sets.map(k => `${k}=?`).join(',')} WHERE id=?`, params);
  save();
}
function deleteKnowledgeLevel(id) {
  // Deliberately doesn't cascade-delete existing content at this level —
  // removing a level from the ladder shouldn't silently destroy work
  // already written at it; that content just becomes unreachable via the
  // tool until the level (or an equivalent one) exists again.
  getDbSync().run('DELETE FROM knowledge_levels_config WHERE id=?', [id]);
  save();
}

// -- Documents (source material only — never injected live, see schema comment) --
function createKnowledgeDocument(id, title, sourceNote, rawText, skinId) {
  getDbSync().run('INSERT INTO knowledge_documents (id,title,source_note,raw_text,skin_id) VALUES (?,?,?,?,?)',
    [id, title, sourceNote || '', rawText || '', skinId || null]);
  save();
}
function getKnowledgeDocuments() {
  return queryAll('SELECT id,title,source_note,skin_id,archived,created_at FROM knowledge_documents ORDER BY created_at DESC');
}
function getKnowledgeDocument(id) {
  return queryOne('SELECT * FROM knowledge_documents WHERE id=?', [id]);
}
function archiveKnowledgeDocument(id, archived) {
  getDbSync().run('UPDATE knowledge_documents SET archived=? WHERE id=?', [archived ? 1 : 0, id]);
  save();
}
function deleteKnowledgeDocument(id) {
  getDbSync().run('DELETE FROM knowledge_documents WHERE id=?', [id]);
  save();
}

// -- Topics --
function createKnowledgeTopic(id, documentId, title, menuLine, skinId, facilitatorId) {
  getDbSync().run(
    'INSERT INTO knowledge_topics (id,document_id,title,menu_line,skin_id,facilitator_id) VALUES (?,?,?,?,?,?)',
    [id, documentId || null, title, menuLine, skinId || null, facilitatorId || null]
  );
  save();
}
function updateKnowledgeTopic(id, fields) {
  const allowed = ['title', 'menu_line', 'skin_id', 'facilitator_id', 'archived'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k));
  if (!sets.length) return;
  const params = sets.map(k => fields[k]);
  params.push(id);
  getDbSync().run(`UPDATE knowledge_topics SET ${sets.map(k => `${k}=?`).join(',')} WHERE id=?`, params);
  save();
}
function deleteKnowledgeTopic(id) {
  getDbSync().run('DELETE FROM knowledge_topic_content WHERE topic_id=?', [id]);
  getDbSync().run('DELETE FROM knowledge_topic_links WHERE topic_id=? OR linked_topic_id=?', [id, id]);
  getDbSync().run('DELETE FROM knowledge_topics WHERE id=?', [id]);
  save();
}
// Talk-facing menu — id/title/menu_line only, scoped to skin (blank =
// universal) and facilitator (blank = every facilitator's own sessions;
// set = only that facilitator's sessions, per Per's own-knowledge ask).
// This is the ONLY thing sent on every turn; everything else is fetched
// on demand via the tool.
function getKnowledgeMenu(skinId, facilitatorId) {
  return queryAll(
    `SELECT id, title, menu_line FROM knowledge_topics
     WHERE archived=0
       AND (skin_id IS NULL OR skin_id=?)
       AND (facilitator_id IS NULL OR facilitator_id=?)
     ORDER BY title ASC`,
    [skinId || null, facilitatorId || null]
  );
}
function getKnowledgeTopic(id) {
  return queryOne('SELECT * FROM knowledge_topics WHERE id=?', [id]);
}
function getKnowledgeTopicsForDocument(documentId) {
  return queryAll('SELECT * FROM knowledge_topics WHERE document_id=? ORDER BY title ASC', [documentId]);
}
// Per Bot 15w — content_count added so the admin list can show which
// topics actually have depth content and which don't, at a glance,
// without an N+1 fetch per topic just to find out. Per hit exactly this
// gap: 13 topics existed with real titles/menu_lines but zero content
// (see the delimiter-format fix), and the list gave no visible sign of
// it — every row looked identical whether it had content or not.
function getAllKnowledgeTopicsAdmin() {
  return queryAll(`SELECT t.*, d.title as document_title, sk.name as skin_name,
    (SELECT COUNT(*) FROM knowledge_topic_content c WHERE c.topic_id=t.id AND c.content != '') as content_count
    FROM knowledge_topics t
    LEFT JOIN knowledge_documents d ON t.document_id=d.id
    LEFT JOIN skins sk ON t.skin_id=sk.id
    ORDER BY t.title ASC`);
}

// -- Content per level --
function setKnowledgeTopicContent(topicId, levelId, content) {
  getDbSync().run(
    `INSERT INTO knowledge_topic_content (id,topic_id,level_id,content) VALUES (?,?,?,?)
     ON CONFLICT(topic_id,level_id) DO UPDATE SET content=excluded.content, updated_at=datetime('now')`,
    [crypto.randomUUID(), topicId, levelId, content]
  );
  save();
}
// The actual tool-facing lookup — this is what get_knowledge resolves to.
function getKnowledgeTopicContent(topicId, levelId) {
  return queryOne('SELECT * FROM knowledge_topic_content WHERE topic_id=? AND level_id=?', [topicId, levelId]);
}
function getKnowledgeTopicAllContent(topicId) {
  return queryAll(
    `SELECT c.*, l.name as level_name, l.sort_order FROM knowledge_topic_content c
     JOIN knowledge_levels_config l ON c.level_id=l.id
     WHERE c.topic_id=? ORDER BY l.sort_order ASC`,
    [topicId]
  );
}

// -- Cross-links --
function linkKnowledgeTopics(topicId, linkedTopicId) {
  if (topicId === linkedTopicId) return;
  getDbSync().run('INSERT OR IGNORE INTO knowledge_topic_links (id,topic_id,linked_topic_id) VALUES (?,?,?)',
    [crypto.randomUUID(), topicId, linkedTopicId]);
  getDbSync().run('INSERT OR IGNORE INTO knowledge_topic_links (id,topic_id,linked_topic_id) VALUES (?,?,?)',
    [crypto.randomUUID(), linkedTopicId, topicId]);
  save();
}
function unlinkKnowledgeTopics(topicId, linkedTopicId) {
  getDbSync().run('DELETE FROM knowledge_topic_links WHERE (topic_id=? AND linked_topic_id=?) OR (topic_id=? AND linked_topic_id=?)',
    [topicId, linkedTopicId, linkedTopicId, topicId]);
  save();
}
function getLinkedKnowledgeTopics(topicId) {
  return queryAll(
    `SELECT t.id, t.title, t.menu_line FROM knowledge_topic_links kl
     JOIN knowledge_topics t ON kl.linked_topic_id=t.id
     WHERE kl.topic_id=? AND t.archived=0`,
    [topicId]
  );
}

// Curated content shelves on the calm landing screen (Per Bot 28) — same
// "explicitly marked, not automatic" reasoning as getFeaturedCourses.
// Grouped by content_type client-side (meditation/practice/etc.) into
// separate rows, so this just returns everything featured and lets the
// caller decide how to bucket it.
// Per Bot 15 — hides a preview edition from anyone whose own tier already
// qualifies for the full edition it's linked to (full_version_id). Below
// that tier the full edition is already invisible via the normal
// visibility gate (canSeeFile), so this only ever removes the preview,
// never the full edition, and never touches files with no link at all.
// A dangling link (the linked file was since deleted) is treated as "no
// link" — never hide something based on a reference that no longer
// resolves to anything.
function suppressAccessiblePreviews(files, userLevel) {
  return files.filter(f => {
    if (!f.full_version_id) return true;
    const full = getLibraryFile(f.full_version_id);
    if (!full) return true;
    const fullLevel = LEVEL_RANK[full.visibility] ?? 0;
    return userLevel < fullLevel;
  });
}

// Most recent standalone files of a given content type — "standalone"
// meaning not embedded in any course lesson (Being Here's 84 poems, for
// instance, shouldn't double up on the Home poems shelf since they're
// already reachable through that course). Powers the Poems/Posts Home
// shelves, which show automatically by recency rather than needing to be
// hand-marked Featured like courses/practices do.
// userFlags/userId (Per Bot 15) — every caller is a client-only route, so
// this always tier-filters and applies preview suppression now; passing
// no userFlags at all skips both (kept only as a defensive fallback, not
// meant to be relied on by any real caller). Limit is applied in JS,
// after filtering, rather than in the SQL query — filtering out
// inaccessible or suppressed rows AFTER a SQL-level LIMIT could silently
// hand back fewer than `limit` items even when enough visible ones exist
// further down the list.
// Per Bot 16 — tags rather than filters, same reasoning as
// getAllLibraryFilesWithAccess: Home shelves are one of the "every file
// listing everywhere" surfaces the locked-but-visible design covers, so a
// hard filter here would have quietly left this one place still hiding
// higher-tier content while everywhere else showed it locked.
function getRecentStandaloneFiles(contentType, limit, userFlags, userId) {
  const files = queryAll(`SELECT f.*, cat.name as category_name FROM library_files f
    LEFT JOIN categories cat ON f.category_id=cat.id
    WHERE f.content_type=? AND f.archived=0
      AND f.id NOT IN (SELECT file_id FROM lesson_file_refs)
    ORDER BY f.created_at DESC`, [contentType]);
  let visible = files;
  if (userFlags) {
    const level = userMaxLevel(userFlags);
    visible = suppressAccessiblePreviews(files, level).map(f => ({ ...f, accessible: canSeeFile(f, level, userId) }));
  }
  return limit ? visible.slice(0, limit) : visible;
}
function getFeaturedLibraryFiles(userFlags, userId) {
  const files = queryAll(`SELECT f.*, cat.name as category_name FROM library_files f
    LEFT JOIN categories cat ON f.category_id=cat.id
    WHERE f.featured=1 AND f.archived=0
      AND f.id NOT IN (SELECT file_id FROM lesson_file_refs)
    ORDER BY f.title`);
  let visible = files;
  if (userFlags) {
    const level = userMaxLevel(userFlags);
    visible = suppressAccessiblePreviews(files, level).map(f => ({ ...f, accessible: canSeeFile(f, level, userId) }));
  }
  return visible;
}
// Practices Talk is allowed to reach for and play mid-conversation (Per Bot
// 33j) — same "explicitly marked, not automatic" pattern as featured, kept
// as a fully separate flag since a track can be Featured, Talk-eligible,
// both, or neither, independently of each other.
function getTalkPractices() {
  return queryAll(`SELECT f.*, cat.name as category_name FROM library_files f
    LEFT JOIN categories cat ON f.category_id=cat.id
    WHERE f.talk_practice=1 AND f.archived=0 ORDER BY f.title`);
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
// Per Bot 15g — enforce_file_sequence explicitly set to 1 here rather than
// left to the column's own SQL default (which is 0, baked in permanently
// by the migration that added the column — changing that default string
// wouldn't affect any table that already exists). New lessons under a new
// course inherit this via file_sequence_override staying NULL, so a
// freshly built course now defaults to enforced sequence throughout,
// matching how it's actually meant to be used day to day; existing
// courses are unaffected and can still be toggled per-course as before.
// Per Bot 15k — enforce_lesson_sequence defaults on too now, for the same
// reason: without it, nothing stopped starting straight at Lesson 2.
function createCourse(id, title, description, categoryId, subcategoryId, guestVisible, skinId, visibility, accessStatus) {
  getDbSync().run('INSERT INTO courses (id,title,description,category_id,subcategory_id,guest_visible,skin_id,enforce_file_sequence,enforce_lesson_sequence,visibility,access_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, title, description||'', categoryId, subcategoryId||null, guestVisible?1:0, skinId||null, 1, 1, visibility||'client', accessStatus||'visible']); save();
}
function updateCourse(id, title, description, categoryId, subcategoryId, guestVisible, skinId, visibility, accessStatus) {
  getDbSync().run('UPDATE courses SET title=?,description=?,category_id=?,subcategory_id=?,guest_visible=?,skin_id=?,visibility=?,access_status=? WHERE id=?',
    [title, description||'', categoryId, subcategoryId||null, guestVisible?1:0, skinId||null, visibility||'client', accessStatus||'visible', id]); save();
}
function getCourse(id) { return queryOne('SELECT * FROM courses WHERE id=?', [id]); }
// Per Bot 18 — course tier-hiding. requiredTier: null (no requirement) or
// 0-3 (Explorer through Member 3). hideWhenLocked: 0 (show locked, same
// look as an admin-locked course) or 1 (don't show at all below tier).
function setCourseTierGating(id, requiredTier, hideWhenLocked) {
  getDbSync().run('UPDATE courses SET required_tier=?, hide_when_locked=? WHERE id=?',
    [requiredTier === null || requiredTier === '' ? null : parseInt(requiredTier, 10), hideWhenLocked ? 1 : 0, id]); save();
}
function getAllCourses(filters = {}) {
  let sql = `SELECT c.*, cat.name as category_name, sub.name as subcategory_name, sk.name as skin_name
    FROM courses c
    LEFT JOIN categories cat ON c.category_id=cat.id
    LEFT JOIN categories sub ON c.subcategory_id=sub.id
    LEFT JOIN skins sk ON c.skin_id=sk.id WHERE 1=1`;
  const params = [];
  if (filters.categoryId)    { sql += ' AND c.category_id=?';    params.push(filters.categoryId); }
  if (filters.subcategoryId) { sql += ' AND c.subcategory_id=?'; params.push(filters.subcategoryId); }
  sql += ' ORDER BY cat.sort_order, c.sort_order, c.title';
  return queryAll(sql, params);
}
function setCourseFeatured(id, featured) {
  getDbSync().run('UPDATE courses SET featured=? WHERE id=?', [featured ? 1 : 0, id]);
  save();
}
// Per Bot 17 — repurposes the existing (previously unused anywhere else)
// courses.sort_order column to drive carousel order specifically. Lower
// numbers show first — see the ORDER BY in getFeaturedCourses below, which
// already sorted by this column; nothing was ever setting it before now.
function setCourseSortOrder(id, sortOrder) {
  getDbSync().run('UPDATE courses SET sort_order=? WHERE id=?', [sortOrder, id]);
  save();
}
// Curated courses shelf on the calm landing screen (Per Bot 28) — only
// ever what's explicitly marked. Ordered purely by c.sort_order/title —
// deliberately NOT grouped by category first (unlike the plain course
// list's own ordering) since the carousel itself is a flat row with no
// category headings shown to the client; sorting by category first would
// make the up/down reorder panel silently do nothing whenever two
// adjacent courses happened to be in different categories. Joined
// through to an actual OPEN instance (what a client can actually enrol
// in — courses themselves are just the template) since a featured course
// with nothing currently open isn't something a client could do anything
// with if it showed up.
// Per Bot 18 — options are optional and default to unfiltered, since the
// admin carousel-order editor calls this with none and needs to see and
// reorder every featured course regardless of who could actually see it.
// The client-facing /api/client/featured call is the one that passes
// userTier/skinId, same tier/skin rules as the main course list.
// Per Bot 21 — added userId (optional, backward compatible) so each
// course can carry its own `enrolled` flag. Real bug this fixes:
// openFeaturedCourse (the splash-page carousel) was calling
// openCourseDetail directly with no enrolment step first, unlike the
// normal Courses tab list which always goes through enrolInCourse for
// anything not yet started — so clicking a not-yet-started course from
// the carousel just hit the raw "You are not enrolled" error instead of
// enrolling (free or Stripe checkout) and opening it.
function getFeaturedCourses({ userTier, skinId, userId } = {}) {
  const rows = queryAll(`SELECT c.*, cat.name as category_name, ci.id as instance_id
    FROM courses c
    LEFT JOIN categories cat ON c.category_id=cat.id
    JOIN course_instances ci ON ci.course_id=c.id AND ci.status='open'
    WHERE c.featured=1
    GROUP BY c.id
    ORDER BY c.sort_order, c.title`);
  const filtered = (userTier === undefined && skinId === undefined) ? rows : rows.filter(c => {
    if (c.skin_id && c.skin_id !== skinId) return false;
    if (c.required_tier !== null && c.required_tier !== undefined && (userTier || 0) < c.required_tier && c.hide_when_locked) return false;
    return true;
  });
  if (!userId) return filtered;
  return filtered.map(c => ({ ...c, enrolled: !!getEnrolmentForUserAndInstance(userId, c.instance_id) }));
}
function deleteCourse(id) {
  const lessons = queryAll('SELECT id FROM lessons WHERE course_id=?', [id]);
  lessons.forEach(l => { getDbSync().run('DELETE FROM lesson_file_refs WHERE lesson_id=?', [l.id]); });
  getDbSync().run('DELETE FROM lessons WHERE course_id=?', [id]);
  getDbSync().run('DELETE FROM courses WHERE id=?', [id]);
  save();
}
// Separate from updateCourse (rather than extending its signature) so
// existing callers — including the Being Here import scripts — don't need
// to change. enforceFileSequence is the course-wide default; individual
// lessons can override it via setLessonFileSequenceOverride.
function setCourseSequenceFlags(id, enforceLessonSequence, enforceFileSequence) {
  getDbSync().run('UPDATE courses SET enforce_lesson_sequence=?, enforce_file_sequence=? WHERE id=?',
    [enforceLessonSequence ? 1 : 0, enforceFileSequence ? 1 : 0, id]); save();
}

// Per Bot 18 — createCourse() has defaulted both sequence flags to 1 since
// Per Bot 15g/15k, but that only ever applied going forward. Courses built
// before that (and everything brought in through the WordPress import
// scripts, which insert rows directly rather than going through
// createCourse) were left at the column's original SQL default of 0. This
// brings every existing course that's still sitting at 0/0 up to the same
// default the app has used for new courses for a while now. Per-course
// toggles made afterwards through the UI are untouched either way.
function backfillCourseSequenceDefaults() {
  const rows = queryAll('SELECT id FROM courses WHERE enforce_lesson_sequence=0 OR enforce_file_sequence=0');
  rows.forEach(c => {
    getDbSync().run('UPDATE courses SET enforce_lesson_sequence=1, enforce_file_sequence=1 WHERE id=?', [c.id]);
  });
  save();
  return rows.length;
}

// ── Lessons ──
function createLesson(id, courseId, lessonNumber, title, description, visibility, accessStatus) {
  getDbSync().run('INSERT INTO lessons (id,course_id,lesson_number,title,description,visibility,access_status) VALUES (?,?,?,?,?,?,?)',
    [id, courseId, lessonNumber, title, description||'', visibility||'client', accessStatus||'visible']); save();
}
function updateLesson(id, lessonNumber, title, description, visibility, accessStatus) {
  getDbSync().run('UPDATE lessons SET lesson_number=?,title=?,description=?,visibility=?,access_status=? WHERE id=?',
    [lessonNumber, title, description||'', visibility||'client', accessStatus||'visible', id]); save();
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
// override: null (inherit the course's enforce_file_sequence default), 0
// (force off for this lesson), or 1 (force on for this lesson).
function setLessonFileSequenceOverride(id, override) {
  getDbSync().run('UPDATE lessons SET file_sequence_override=? WHERE id=?', [override, id]); save();
}

// ── Lesson file refs ──
function addLessonFileRef(id, lessonId, fileId, sortOrder, mandatory) {
  getDbSync().run('INSERT INTO lesson_file_refs (id,lesson_id,file_id,sort_order,mandatory) VALUES (?,?,?,?,?)',
    [id, lessonId, fileId, sortOrder||0, mandatory ? 1 : 0]); save();
}
function setLessonFileRefMandatory(refId, mandatory) {
  getDbSync().run('UPDATE lesson_file_refs SET mandatory=? WHERE id=?', [mandatory ? 1 : 0, refId]); save();
}
// Per Bot 18 — free preview override, same shape as the mandatory toggle
// above. Deliberately per-ref rather than per-file: the same file could be
// reused in more than one lesson, and "preview this everywhere it's used"
// isn't the intent — only the specific lesson placement someone flags.
function setLessonFileRefFreePreview(refId, freePreview) {
  getDbSync().run('UPDATE lesson_file_refs SET free_preview=? WHERE id=?', [freePreview ? 1 : 0, refId]); save();
}
function getFreePreviewRef(refId) {
  return queryOne(`SELECT r.id as ref_id, r.free_preview, r.lesson_id, f.*
    FROM lesson_file_refs r JOIN library_files f ON r.file_id=f.id
    WHERE r.id=?`, [refId]);
}
// Bulk "All" / "None" toggles for the admin lesson builder — set every file
// in one lesson, or every file across every lesson in a course, mandatory
// or not in a single call rather than checking dozens of boxes by hand.
function setAllFileRefsMandatoryForLesson(lessonId, mandatory) {
  getDbSync().run('UPDATE lesson_file_refs SET mandatory=? WHERE lesson_id=?', [mandatory ? 1 : 0, lessonId]); save();
}
function setAllFileRefsMandatoryForCourse(courseId, mandatory) {
  const lessonIds = queryAll('SELECT id FROM lessons WHERE course_id=?', [courseId]).map(l => l.id);
  if (!lessonIds.length) return;
  const placeholders = lessonIds.map(() => '?').join(',');
  getDbSync().run(`UPDATE lesson_file_refs SET mandatory=? WHERE lesson_id IN (${placeholders})`, [mandatory ? 1 : 0, ...lessonIds]);
  save();
}
function getFilesForLesson(lessonId) {
  return queryAll(`SELECT r.id as ref_id, r.sort_order, r.mandatory, r.free_preview, f.*
    FROM lesson_file_refs r JOIN library_files f ON r.file_id=f.id
    WHERE r.lesson_id=? ORDER BY r.sort_order ASC`, [lessonId]);
}
function removeLessonFileRef(refId) {
  getDbSync().run('DELETE FROM lesson_file_refs WHERE id=?', [refId]); save();
}
// Per Bot 15g — batch version for drag-and-drop: the whole new order
// arrives in one call rather than one step at a time. Only touches refs
// that actually belong to this lesson (never trusts ordering data to
// silently move a ref out from under a different lesson), and any ref
// belonging to the lesson that wasn't included in the list keeps its
// existing relative order, appended after the ones that were — so a
// stale/incomplete list can't accidentally drop files from the lesson.
function reorderLessonFileRefs(lessonId, orderedRefIds) {
  const all = queryAll('SELECT id FROM lesson_file_refs WHERE lesson_id=? ORDER BY sort_order ASC, id ASC', [lessonId]);
  const allIds = new Set(all.map(r => r.id));
  const validOrder = orderedRefIds.filter(id => allIds.has(id));
  const missing = all.map(r => r.id).filter(id => !validOrder.includes(id));
  const finalOrder = [...validOrder, ...missing];
  const dbc = getDbSync();
  finalOrder.forEach((id, i) => dbc.run('UPDATE lesson_file_refs SET sort_order=? WHERE id=?', [i, id]));
  save();
}
// Per Bot 15f — moves one file up or down within its lesson. Existing
// refs default to sort_order=0 (never set individually before now), so
// rather than trying to swap two possibly-identical values, this always
// re-numbers every ref in the lesson 0..n-1 in the new order — clean and
// distinct going forward regardless of what was there before. Ties in
// the current order break on id, just to be deterministic.
function moveLessonFileRef(refId, direction) {
  const ref = queryOne('SELECT * FROM lesson_file_refs WHERE id=?', [refId]);
  if (!ref) return;
  const all = queryAll('SELECT * FROM lesson_file_refs WHERE lesson_id=? ORDER BY sort_order ASC, id ASC', [ref.lesson_id]);
  const idx = all.findIndex(r => r.id === refId);
  if (idx === -1) return;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= all.length) return; // already at the top/bottom — nothing to do
  [all[idx], all[swapIdx]] = [all[swapIdx], all[idx]];
  const dbc = getDbSync();
  all.forEach((r, i) => dbc.run('UPDATE lesson_file_refs SET sort_order=? WHERE id=?', [i, r.id]));
  save();
}

// ── Lesson file opens / progress tracking (Per Bot 13) ──
function logFileOpen(id, userId, lessonId, fileId) {
  getDbSync().run('INSERT INTO lesson_file_opens (id,user_id,lesson_id,file_id) VALUES (?,?,?,?)',
    [id, userId, lessonId, fileId]); save();
}
// Set of file_ids this user has opened at least once within this lesson —
// used for the green-tick marker, the completion-prompt gate, and file
// sequence locking.
function getOpenedFileIds(userId, lessonId) {
  const rows = queryAll('SELECT DISTINCT file_id FROM lesson_file_opens WHERE user_id=? AND lesson_id=?', [userId, lessonId]);
  return new Set(rows.map(r => r.file_id));
}
// opened/total counts against MANDATORY files specifically, falling back
// to counting every file when nothing in the lesson has been marked
// mandatory (in practice every real lesson should have mandatory files
// set, but this keeps a freshly-built lesson from showing a misleading
// 100% or a blank percentage before anyone's gone through and set flags).
function getLessonFileProgress(userId, lessonId) {
  const files = getFilesForLesson(lessonId);
  const opened = getOpenedFileIds(userId, lessonId);
  const mandatoryFiles = files.filter(f => f.mandatory);
  const countAgainst = mandatoryFiles.length > 0 ? mandatoryFiles : files;
  const openedCount = countAgainst.filter(f => opened.has(f.id)).length;
  const total = countAgainst.length;
  return {
    opened: openedCount,
    total,
    percent: total > 0 ? Math.round((openedCount / total) * 100) : 0,
    allMandatoryOpened: mandatoryFiles.length === 0 || mandatoryFiles.every(f => opened.has(f.id)),
  };
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
    `SELECT ci.*, c.title as course_title, c.skin_id as course_skin_id
     FROM course_instances ci LEFT JOIN courses c ON ci.course_id=c.id
     WHERE ci.id=?`, [id]
  );
}
function getInstancesForCourse(courseId) {
  return queryAll('SELECT * FROM course_instances WHERE course_id=? ORDER BY created_at DESC', [courseId]);
}
function getAllCourseInstances(filters = {}) {
  let sql = `SELECT ci.*, c.title as course_title, c.skin_id as course_skin_id, c.access_status as course_access_status,
    c.required_tier as course_required_tier, c.hide_when_locked as course_hide_when_locked
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
// Per Bot 21 — true when this email also belongs to a facilitator or
// admin account (same table holds both, distinguished by role). Used to
// let a staff member's own client identity (the "choose role" duality —
// same person, two separate account rows) preview any course without
// needing a real paid/free enrolment first.
function isStaffEmail(email) {
  return !!queryOne('SELECT 1 FROM facilitators WHERE lower(email)=lower(?)', [email]);
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

// Per Bot 19 fix: only ever matched the legacy single facilitator_id
// column — a facilitator whose ONLY relationship to a client is via the
// newer client_facilitators table (see Per Bot 13) never saw them in
// their own client list at all, even after the access-control gap on
// /api/clients/:id and the messaging middleware got fixed alongside this.
// UNION rather than a JOIN so a client with both relationships (their
// legacy facilitator_id AND also explicitly added via the join table,
// which shouldn't normally happen but isn't actively prevented either)
// still only appears once.
function getAllUsers(facilitatorId, includeArchived = false) {
  const archivedClause = includeArchived ? '' : 'AND archived=0';
  return queryAll(
    `SELECT * FROM users WHERE facilitator_id=? ${archivedClause}
     UNION
     SELECT u.* FROM users u JOIN client_facilitators cf ON cf.client_id=u.id
     WHERE cf.facilitator_id=? ${archivedClause}
     ORDER BY name ASC`,
    [facilitatorId, facilitatorId]
  );
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
// Framework + presentation flags (Per Bot 7) — see the migration comment
// for why presentation_flags is a plain comma-separated string rather
// than separate boolean columns.
function updateClientClinicalContext(id, framework, presentationFlags) {
  getDbSync().run('UPDATE users SET framework=?,presentation_flags=? WHERE id=?',
    [framework || 'felt_fibre_full', presentationFlags || null, id]);
  save();
}

// Signal rotation (Per Bot 7) — computes "today's palette" (one variation
// per signal category, advanced from wherever this client left off) and
// persists the advanced state so the next NEW session picks up from there.
// variationBank is passed in from prompts.js (SIGNAL_VARIATIONS) rather
// than duplicated here, so the two stay in sync automatically as the bank
// grows — this file only ever stores indices, never the text itself.
function getSignalRotation(userId, variationBank) {
  const user = getUser(userId);
  let state = {};
  try { state = JSON.parse(user?.signal_rotation_state || '{}'); } catch(e) { state = {}; }

  const palette = {};
  const nextState = {};
  for (const key of Object.keys(variationBank)) {
    const options = variationBank[key];
    if (!options || !options.length) continue;
    const idx = Number.isInteger(state[key]) ? state[key] : 0;
    palette[key] = options[idx % options.length];
    nextState[key] = (idx + 1) % options.length;
  }

  getDbSync().run('UPDATE users SET signal_rotation_state=? WHERE id=?', [JSON.stringify(nextState), userId]);
  save();
  return palette;
}
function archiveClient(id) { getDbSync().run('UPDATE users SET archived=1-archived WHERE id=?', [id]); save(); }
function updateClientPassword(id, hash) {
  getDbSync().run('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', [hash, id]); save();
}
// ── Password reset (Per Bot 8) ──
// Self-service token flow: setUserResetToken issues a time-limited token
// (cleared on use or lookup miss/expiry via the WHERE clause below);
// adminResetUserPassword is the separate immediate-reset path an admin
// triggers directly, deliberately forcing must_change_password=1 so an
// admin-generated temp password can't quietly become a permanent one.
function setUserResetToken(id, token, expiresAt) {
  getDbSync().run('UPDATE users SET reset_token=?,reset_token_expires=? WHERE id=?', [token, expiresAt, id]); save();
}
function getUserByResetToken(token) {
  return queryOne("SELECT * FROM users WHERE reset_token=? AND reset_token_expires>datetime('now')", [token]);
}
function clearUserResetToken(id) {
  getDbSync().run('UPDATE users SET reset_token=NULL,reset_token_expires=NULL WHERE id=?', [id]); save();
}
function adminResetUserPassword(id, hash) {
  getDbSync().run('UPDATE users SET password_hash=?,must_change_password=1,reset_token=NULL,reset_token_expires=NULL WHERE id=?', [hash, id]); save();
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
// Per Bot 17 — trialDays/signupOfferId added as optional trailing params.
// Both default to the pre-Offers behaviour (14 days, no attribution) so
// every existing call site (and any deployment that never touches Offers)
// keeps working exactly as before.
function registerUser(id, name, email, passwordHash, language, consent, trialDays = 14, signupOfferId = null, signupSource = null) {
  const c = consent || {};
  const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
  getDbSync().run(
    `INSERT INTO users (id,name,email,password_hash,facilitator_id,arc,archived,must_change_password,member_tier,member_since,trial_ends_at,is_client,is_system_client,language,
       consent_given,consent_date,consent_version,lawful_basis,pref_email_news,signup_offer_id,signup_source)
     VALUES (?,?,?,NULL,NULL,'',0,0,1,datetime('now'),?,0,1,?,?,?,?,?,?,?,?)`,
    [
      id, name, email.toLowerCase(), trialEndsAt, language || 'en',
      c.consentGiven ? 1 : 0,
      c.consentGiven ? new Date().toISOString() : null,
      c.consentGiven ? (c.consentVersion || 'self-registration-v1') : null,
      c.consentGiven ? 'consent' : null,
      c.marketingOptIn ? 1 : 0,
      signupOfferId,
      signupSource,
    ]
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
     VALUES (?,?,?,NULL,NULL,'',0,0, -1,0,0, 0,0,0,1,0, 'Existing mailing list — imported, not registered via Per Bot')`,
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

// ── Trial / membership expiry ──
// Called on every login and on every /api/my/profile fetch for
// client-role users, so a long-lived session gets caught too, not only a
// fresh login. Leaves member_since alone — that's a historical fact, not
// a current-tier signal.
//
// Per Bot 18 — this used to only check trial_ends_at, which meant it
// never actually caught member_expires_at lapsing at all — the field
// People admin's manual expiry override (setMemberExpiry, used for
// honouring a carried-over legacy membership) actually writes to. Someone
// given a hand-set expiry date would never have been auto-downgraded by
// anything, ever. Now checks both.
//
// Per Bot 21 — the two now genuinely diverge, mirroring
// sweepExpiredMemberships: a trial lapsing still downgrades immediately
// (the day-14 trial email already covers that moment). A real paid-until
// date lapsing (member_expires_at — Stripe-backed or a manual/PayPal
// override, source doesn't matter) instead enters the same 14-day
// Savers grace sequence a Stripe cancellation reaching term-end already
// gets, rather than dropping someone the instant they happen to log in
// past their date. Guarded by savers_type so a session that revisits
// this mid-grace doesn't restart the clock or re-send the entry email.
function checkTrialExpiry(userId) {
  const user = getUser(userId);
  if (!user) return user;
  const hasLiveStripeSub = !!user.stripe_subscription_id;
  const trialLapsed = !user.member_expires_at && user.trial_ends_at && new Date(user.trial_ends_at) < new Date();
  const membershipLapsed = user.member_expires_at && new Date(user.member_expires_at) < new Date();

  if (trialLapsed && !hasLiveStripeSub && user.member_tier > 0) {
    getDbSync().run(
      `UPDATE users SET member_tier=0, trial_ends_at=NULL, member_expires_at=NULL WHERE id=?`,
      [userId]
    );
    save();
    return { ...getUser(userId), _justLapsed: 'trial' };
  }

  if (membershipLapsed && !hasLiveStripeSub && user.member_tier > 0 && !user.savers_type) {
    startSaversGrace(userId, 'cancellation', user.member_tier || 1);
    return { ...getUser(userId), _enteredSaversGrace: true };
  }

  return user;
}

// Per Bot 20 (rewritten Per Bot 21) — the daily, login-independent
// counterpart to checkTrialExpiry above. That function only ever runs
// when the person themselves hits /api/login or /api/my/profile —
// someone who trials in and never comes back stays at their prior tier
// indefinitely, not from the actual day their access should have
// lapsed. This finds everyone currently past their trial_ends_at or
// member_expires_at with no live Stripe subscription, calendar-
// triggered instead of visit-triggered.
//
// Per Bot 21 — these two cases now genuinely diverge, per Per's call:
// promo/trial lapsing is its own distinct pre-end process (the day
// 3/7/10/14 trial sequence already exists for that) and still downgrades
// immediately here, same as before. But a real paid-until date
// (member_expires_at) lapsing — regardless of whether that date came
// from a live Stripe subscription, a manually carried-over legacy
// subscriber, or a PayPal override entered by hand — is now treated
// exactly like a Stripe subscription reaching its natural term-end:
// it enters the same 14-day Savers grace sequence (type 'cancellation',
// reused end-to-end, same copy, same mid/final emails, same eventual
// downgrade) rather than being downgraded on the spot with a single
// one-off email. The paid-until date is what drives this now, not the
// source — source is a reporting question, answered elsewhere.
// savers_type IS NULL guards the paid-lapse branch so a daily re-run
// never restarts someone's grace clock while they're already mid-way
// through it.
function sweepExpiredMemberships() {
  const now = new Date().toISOString();

  const trialCandidates = queryAll(
    `SELECT * FROM users
     WHERE member_tier > 0
       AND member_expires_at IS NULL
       AND trial_ends_at IS NOT NULL AND trial_ends_at < ?
       AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')`,
    [now]
  );
  if (trialCandidates.length) {
    getDbSync().run(
      `UPDATE users SET member_tier=0, trial_ends_at=NULL, member_expires_at=NULL
       WHERE member_tier > 0
         AND member_expires_at IS NULL
         AND trial_ends_at IS NOT NULL AND trial_ends_at < ?
         AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')`,
      [now]
    );
    save();
  }

  const membershipCandidates = queryAll(
    `SELECT * FROM users
     WHERE member_tier > 0
       AND member_expires_at IS NOT NULL AND member_expires_at < ?
       AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')
       AND savers_type IS NULL`,
    [now]
  );
  for (const user of membershipCandidates) {
    startSaversGrace(user.id, 'cancellation', user.member_tier || 1);
  }

  return { trialLapsed: trialCandidates, enteredGrace: membershipCandidates };
}

// ── Referrals (Per Bot 22) ──
function setReferredBy(userId, referrerId) {
  getDbSync().run('UPDATE users SET referred_by=? WHERE id=?', [referrerId || null, userId]);
  save();
}
function markReferralRewarded(userId) {
  getDbSync().run('UPDATE users SET referral_rewarded=1 WHERE id=?', [userId]);
  save();
}
function createReferralEvent(id, referrerId, referredUserId, referredName, daysCredited) {
  getDbSync().run(
    'INSERT INTO referral_events (id, referrer_id, referred_user_id, referred_name, days_credited) VALUES (?,?,?,?,?)',
    [id, referrerId, referredUserId, referredName || null, daysCredited || 30]
  );
  save();
}
function getReferralEventsForReferrer(referrerId) {
  return queryAll('SELECT * FROM referral_events WHERE referrer_id=? ORDER BY created_at DESC', [referrerId]);
}
function getUnseenReferralCount(referrerId) {
  const row = queryOne('SELECT COUNT(*) as c FROM referral_events WHERE referrer_id=? AND seen_at IS NULL', [referrerId]);
  return row ? row.c : 0;
}
function markReferralEventsSeen(referrerId) {
  getDbSync().run(`UPDATE referral_events SET seen_at=datetime('now') WHERE referrer_id=? AND seen_at IS NULL`, [referrerId]);
  save();
}

// ── Membership ──
// member_tier: 0=Explorer, 1=Member1, 2=Member2, 3=Member3
// ── Bulk trial extension (Per Bot 38) — "give everyone still on trial a
// bit more time" is a real, recurring admin need (a big platform update,
// a launch delay, goodwill), and previously had no supported way to do
// it short of editing users one at a time. trial_ends_at NOT NULL and still
// in the future is enough on its own to mean "currently on an active,
// unconverted trial" — setMemberTier explicitly clears trial_ends_at to
// NULL when a trial converts to a real paid subscription, so a
// converted member is never touched by this regardless of how their old
// trial_ends_at value might otherwise look.
function countActiveTrials(userIds) {
  if (userIds && userIds.length) {
    const placeholders = userIds.map(() => '?').join(',');
    return queryOne(`SELECT COUNT(*) as n FROM users WHERE trial_ends_at IS NOT NULL AND trial_ends_at > datetime('now') AND id IN (${placeholders})`, userIds).n;
  }
  return queryOne(`SELECT COUNT(*) as n FROM users WHERE trial_ends_at IS NOT NULL AND trial_ends_at > datetime('now')`).n;
}
// Per Bot 41 — returns the affected rows (id, name, email, language, new
// trial_ends_at), not just a count, so the caller can send each of them
// a real email with their own name and their own new date rather than a
// generic blast. The WHERE clause is identical to before; this just also
// captures who matched, both before AND after the update, since SQLite's
// UPDATE doesn't return rows itself.
function extendAllActiveTrials(days, userIds) {
  const where = (userIds && userIds.length)
    ? `trial_ends_at IS NOT NULL AND trial_ends_at > datetime('now') AND id IN (${userIds.map(() => '?').join(',')})`
    : `trial_ends_at IS NOT NULL AND trial_ends_at > datetime('now')`;
  const params = (userIds && userIds.length) ? userIds : [];
  const before = queryAll(`SELECT id FROM users WHERE ${where}`, params);
  if (!before.length) return [];
  getDbSync().run(
    `UPDATE users SET trial_ends_at = datetime(trial_ends_at, '+' || ? || ' days') WHERE ${where}`,
    [days, ...params]
  );
  save();
  const ids = before.map(r => r.id);
  return queryAll(`SELECT id, name, email, language, trial_ends_at FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
}

// ── Re-grant a lapsed trial (Per Bot 40) — distinct from
// extendAllActiveTrials above: that only touches people with a
// currently-active, not-yet-expired trial_ends_at. Someone whose trial
// already lapsed has trial_ends_at cleared to NULL by the sweep (see
// sweepExpiredMemberships) along with member_tier dropping to 0 — there's
// no existing trial_ends_at left to extend, so this grants a genuinely
// fresh one instead. member_since is never cleared by the sweep, so
// "member_tier=0 AND trial_ends_at IS NULL AND member_since IS NOT NULL"
// reliably means "was on a trial or membership before, not currently."
// Deliberately requires an explicit list of IDs — no "nothing selected
// means everyone" fallback like the active-trial version has, since the
// Explorers list is mostly people who never had a trial at all (direct
// free signups), and defaulting to all of them would grant trials to
// people who never asked for or had one.
function countLapsedTrialUsers(userIds) {
  if (!userIds || !userIds.length) return 0;
  const placeholders = userIds.map(() => '?').join(',');
  return queryOne(
    `SELECT COUNT(*) as n FROM users WHERE member_tier=0 AND trial_ends_at IS NULL AND member_since IS NOT NULL AND id IN (${placeholders})`,
    userIds
  ).n;
}
// Per Bot 41 — same shift as extendAllActiveTrials above: returns the
// affected rows themselves (with their fresh trial_ends_at), not just a
// count, so each person can get their own real email.
function regrantTrialForLapsedUsers(userIds, days, tier = 1) {
  if (!userIds || !userIds.length) return [];
  const placeholders = userIds.map(() => '?').join(',');
  const before = queryAll(
    `SELECT id FROM users WHERE member_tier=0 AND trial_ends_at IS NULL AND member_since IS NOT NULL AND id IN (${placeholders})`,
    userIds
  );
  if (!before.length) return [];
  getDbSync().run(
    `UPDATE users SET member_tier=?, trial_ends_at=datetime('now', '+' || ? || ' days')
     WHERE member_tier=0 AND trial_ends_at IS NULL AND member_since IS NOT NULL AND id IN (${placeholders})`,
    [tier, days, ...userIds]
  );
  save();
  const ids = before.map(r => r.id);
  return queryAll(`SELECT id, name, email, language, trial_ends_at FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
}

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
  const allowed = ['pref_email_motd','pref_email_reminders','pref_email_renewal','pref_email_news','pref_sms','pref_sms_motd','pref_sms_reminders','pref_sms_renewal','pref_email_messages','pref_sms_messages','pref_keep_history','phone','language','motd_days','motd_hour','timezone','voice_id','dob_month','dob_day','onboarding_completed','keep_history_prompted','voice_hint_shown','tomte_name','a11y_contrast','a11y_text_scale'];
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

function canSeeFile(file, userLevel, userId) {
  // One-to-one assignment overrides the tier ladder completely — a file
  // assigned to a specific client is invisible to everyone else regardless
  // of their tier, and visible to that one person regardless of theirs.
  if (file.assigned_client_id) {
    return userId != null && file.assigned_client_id === userId;
  }
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

// Per Bot 16 — excludes anything already attached to a lesson via
// lesson_file_refs, same reasoning as getRecentStandaloneFiles below: a
// file that belongs to a course shouldn't also surface in general
// browsing (Practices, Meditations, Read & Watch) — it should only be
// reachable from within its course. This is the function behind
// /api/client/content, so the fix here covers all three of those tabs at
// once. Doesn't touch /api/content/library (the admin management list),
// which is a completely separate query — admin still needs to see and
// manage every file regardless of what it's attached to.
function getAllLibraryFilesWithAccess(userFlags, userId) {
  const level = userMaxLevel(userFlags);
  const files = queryAll(`SELECT * FROM library_files WHERE archived=0 AND facilitator_resource=0
    AND id NOT IN (SELECT file_id FROM lesson_file_refs) ORDER BY title ASC`);
  return files.map(f => ({ ...f, accessible: canSeeFile(f, level, userId) }));
}

function getFacilitatorResources() {
  return queryAll(`SELECT f.*, cat.name as category_name, sub.name as subcategory_name
    FROM library_files f
    LEFT JOIN categories cat ON f.category_id=cat.id
    LEFT JOIN categories sub ON f.subcategory_id=sub.id
    WHERE f.archived=0 AND f.facilitator_resource=1
    ORDER BY f.created_at DESC`);
}

function canAccessFile(file, userFlags, userId) {
  if (file.archived) return false;
  return canSeeFile(file, userMaxLevel(userFlags), userId);
}
// Per Bot 18 — free preview override. A file flagged free_preview=1 on any
// of its lesson_file_refs should play for any logged-in Explorer-and-up
// account regardless of the file's own visibility tier, the lesson/course
// access_status, or enrolment — used at the actual playback-url chokepoint
// rather than the course/lesson browsing routes, since that's the one
// place real file access is actually granted or refused.
function fileHasFreePreview(fileId) {
  return !!queryOne('SELECT 1 FROM lesson_file_refs WHERE file_id=? AND free_preview=1', [fileId]);
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
// Per Bot 18 — self-guided Talk sessions save as type='self' with no
// facilitator_id (see the addSession call right after a Talk session
// generates its summary). A facilitator-led session is a different type
// and shouldn't count here — this is specifically about whether the
// person has used the self-serve Talk feature, not sessions generally.
function hasEverUsedTalk(userId) {
  return !!queryOne("SELECT 1 FROM sessions WHERE client_id=? AND type='self' LIMIT 1", [userId]);
}

// ── Content shares (Per Bot 22) ── Admin (or later, facilitator) sharing
// specific library files with specific people — see content_shares table
// above. Deliberately upserts one row per (file, user) pair; sharing the
// same file with someone twice is a no-op, not a duplicate or a
// re-notification (INSERT OR IGNORE, so created_at — and therefore the
// Tomte tip's dynamic id — only moves when something is genuinely new
// for that person).
function shareContentToUsers(fileId, userIds, sharedByRole, sharedById, makeId) {
  const d = getDbSync();
  userIds.forEach(userId => {
    d.run(`INSERT OR IGNORE INTO content_shares (id, library_file_id, user_id, shared_by_role, shared_by_id) VALUES (?,?,?,?,?)`,
      [makeId(), fileId, userId, sharedByRole || null, sharedById || null]);
  });
  save();
}
function getSharedFilesForUser(userId) {
  return queryAll(
    `SELECT f.* FROM content_shares cs JOIN library_files f ON f.id=cs.library_file_id
     WHERE cs.user_id=? AND f.archived=0 ORDER BY cs.created_at DESC`,
    [userId]
  );
}
function removeContentShare(fileId, userId) {
  getDbSync().run('DELETE FROM content_shares WHERE library_file_id=? AND user_id=?', [fileId, userId]);
  save();
}
// Powers the Tomte "new practices" tip — see /api/my/tomte-tip. Folds in
// the legacy single-assignment column too (assigned_client_id), since
// from the client's point of view a facilitator assigning them
// something directly is exactly the same kind of event as an admin
// sharing something — both should surface the same "something new
// arrived" nudge, not just one of the two paths.
function getLatestPracticeArrivalAt(userId) {
  const shared = queryOne(`SELECT MAX(created_at) as t FROM content_shares WHERE user_id=?`, [userId])?.t;
  const assigned = queryOne(`SELECT MAX(created_at) as t FROM library_files WHERE assigned_client_id=?`, [userId])?.t;
  const facAdded = queryOne(`SELECT MAX(created_at) as t FROM practices WHERE client_id=? AND source_type='facilitator'`, [userId])?.t;
  return [shared, assigned, facAdded].filter(Boolean).sort().pop() || null;
}


function hasSeenTomteTip(userId, tipId) {
  return !!queryOne('SELECT 1 FROM tomte_tips_seen WHERE user_id=? AND tip_id=?', [userId, tipId]);
}
function markTomteTipSeen(userId, tipId) {
  getDbSync().run('INSERT OR IGNORE INTO tomte_tips_seen (user_id, tip_id) VALUES (?, ?)', [userId, tipId]);
  save();
}

// ── Messages (Per Bot 8) ──
function addMessage(id, clientId, facilitatorId, sessionId, senderRole, senderId, contentType, content, filename, originalFilename) {
  getDbSync().run(
    `INSERT INTO messages (id,client_id,facilitator_id,session_id,sender_role,sender_id,content_type,content,filename,original_filename)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, clientId, facilitatorId, sessionId || null, senderRole, senderId, contentType || 'text', content || '', filename || '', originalFilename || '']
  ); save();
  return queryOne('SELECT * FROM messages WHERE id=?', [id]);
}
// sessionId omitted/null → the client's general thread with this facilitator.
function getMessageThread(clientId, facilitatorId, sessionId) {
  return sessionId
    ? queryAll('SELECT * FROM messages WHERE client_id=? AND facilitator_id=? AND session_id=? ORDER BY created_at ASC', [clientId, facilitatorId, sessionId])
    : queryAll('SELECT * FROM messages WHERE client_id=? AND facilitator_id=? AND session_id IS NULL ORDER BY created_at ASC', [clientId, facilitatorId]);
}
// One row per session that actually has messages, for the thread-picker list.
function getSessionThreadsForClient(clientId, facilitatorId) {
  return queryAll(`
    SELECT s.id as session_id, s.type, s.created_at as session_created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count
    FROM sessions s
    WHERE s.client_id=? AND s.facilitator_id=? AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) > 0
    ORDER BY s.created_at DESC`, [clientId, facilitatorId]);
}
function getMessageById(id) { return queryOne('SELECT * FROM messages WHERE id=?', [id]); }
function editMessage(id, content) {
  getDbSync().run("UPDATE messages SET content=?, edited_at=datetime('now') WHERE id=?", [content, id]); save();
}
function deleteMessage(id) {
  // Soft delete — keeps the row (and its place in the thread) for the
  // clinical record, but clears the body so it renders as "Message
  // deleted" rather than actually vanishing without a trace.
  getDbSync().run("UPDATE messages SET content='', filename='', deleted_at=datetime('now') WHERE id=?", [id]); save();
}
function markThreadRead(clientId, facilitatorId, sessionId, readerRole) {
  const otherRole = readerRole === 'facilitator' ? 'client' : 'facilitator';
  if (sessionId) {
    getDbSync().run("UPDATE messages SET read_at=datetime('now') WHERE client_id=? AND facilitator_id=? AND session_id=? AND sender_role=? AND read_at IS NULL",
      [clientId, facilitatorId, sessionId, otherRole]);
  } else {
    getDbSync().run("UPDATE messages SET read_at=datetime('now') WHERE client_id=? AND facilitator_id=? AND session_id IS NULL AND sender_role=? AND read_at IS NULL",
      [clientId, facilitatorId, otherRole]);
  }
  save();
}
function getUnreadMessageCountForFacilitator(facilitatorId, clientId) {
  return queryOne('SELECT COUNT(*) as n FROM messages WHERE facilitator_id=? AND client_id=? AND sender_role=? AND read_at IS NULL',
    [facilitatorId, clientId, 'client']).n;
}
function getUnreadMessageCountForClient(clientId) {
  return queryOne('SELECT COUNT(*) as n FROM messages WHERE client_id=? AND sender_role=? AND read_at IS NULL',
    [clientId, 'facilitator']).n;
}

// ── Client journal entries ──
function addJournalEntry(id, clientId, title, content, sourceType, originalFilename, shareWithBot, shareWithFacilitator) {
  getDbSync().run(
    `INSERT INTO client_journal_entries (id,client_id,title,content,source_type,original_filename,share_with_bot,share_with_facilitator)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, clientId, title, content, sourceType || 'written', originalFilename || null, shareWithBot ? 1 : 0, shareWithFacilitator ? 1 : 0]
  );
  save();
}
// All of a client's own entries — shown only to the client themselves, so
// no filtering by sharing flags here; those flags control what OTHERS see.
function getJournalEntriesForClient(clientId) {
  return queryAll('SELECT * FROM client_journal_entries WHERE client_id=? ORDER BY created_at DESC', [clientId]);
}
// What a facilitator is allowed to see — only entries explicitly shared
// with them, never the client's private-only entries.
function getSharedJournalEntriesForFacilitator(clientId) {
  return queryAll('SELECT * FROM client_journal_entries WHERE client_id=? AND share_with_facilitator=1 ORDER BY created_at DESC', [clientId]);
}
// What the automated bot is allowed to draw on — most recent first, capped
// by the caller (see CLIENT_JOURNAL_CONTEXT in prompts.js) so a long
// journal history doesn't unboundedly grow the system prompt.
function getJournalEntriesForBot(clientId, limit) {
  return queryAll('SELECT * FROM client_journal_entries WHERE client_id=? AND share_with_bot=1 ORDER BY created_at DESC LIMIT ?', [clientId, limit || 5]);
}
function deleteJournalEntry(id, clientId) {
  getDbSync().run('DELETE FROM client_journal_entries WHERE id=? AND client_id=?', [id, clientId]);
  save();
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
function addPractice(id, clientId, title, type, content, filename, sourceType, categoryId, subcategoryId, facilitatorId, storageType) {
  getDbSync().run('INSERT INTO practices (id,client_id,title,type,content,filename,source_type,category_id,subcategory_id,facilitator_id,storage_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, clientId, title, type, content||'', filename||'', sourceType||'talk', categoryId||null, subcategoryId||null, facilitatorId||null, storageType||'disk']); save();
}
// Session notes released to a client (sessions.client_summary) are shown
// alongside self-saved Talk practices rather than duplicated into the
// practices table — a facilitator editing or unreleasing a session updates
// what the client sees here automatically, with nothing to keep in sync.
// Defaulted to FELT·FIBRE > Facilitation for Area grouping since that's
// where delivered-session material belongs until a facilitator can tag
// something more specific (not yet built).
//
// facilitatorId (Per Bot 18, optional) — omitted entirely, this returns
// EVERYTHING for the client exactly as before (the general Library
// personal-collection view, and the facilitator/admin client-detail
// views, all still want the unfiltered picture). Passed, it scopes to
// just that one relationship: 'talk' means Talk's own self-guided
// sessions specifically (facilitator_id IS NULL — Talk is never a real
// row anywhere, so NULL is how its sessions/practices are told apart
// from a real facilitator's), any other id means that real facilitator's
// own sessions/practices only. Talk is a facilitator like any other here
// — its self-guided session summaries already existed (see
// finalizeChatSession in server.js), this just makes them selectable the
// same way a real facilitator's are.
function getPracticesForClient(clientId, facilitatorId) {
  const scoped = facilitatorId !== undefined;
  const isTalk = facilitatorId === 'talk';
  const facFilter = !scoped ? '' : (isTalk ? 'IS NULL' : '=?');
  const facParams = (!scoped || isTalk) ? [] : [facilitatorId];

  const own = queryAll(`SELECT p.*, c.name as category_name, s.name as subcategory_name
    FROM practices p
    LEFT JOIN categories c ON p.category_id=c.id
    LEFT JOIN categories s ON p.subcategory_id=s.id
    WHERE p.client_id=? ${scoped ? `AND p.facilitator_id ${facFilter}` : ''}`, [clientId, ...facParams]);
  const sessionRows = queryAll(`SELECT sess.id, sess.client_id, sess.client_summary, sess.created_at, sess.facilitator_id, f.name as facilitator_name
    FROM sessions sess LEFT JOIN facilitators f ON sess.facilitator_id=f.id
    WHERE sess.client_id=? AND sess.client_summary!='' ${scoped ? `AND sess.facilitator_id ${facFilter}` : ''}`, [clientId, ...facParams]);
  const sessionAsPractices = sessionRows.map(s => ({
    id: s.id,
    client_id: s.client_id,
    title: `Session with ${s.facilitator_name || 'Talk'} · ${(s.created_at||'').slice(0,10)}`,
    type: 'text',
    content: s.client_summary,
    filename: '',
    is_favourite: 0,
    use_count: 0,
    created_at: s.created_at,
    source_type: 'session',
    category_id: 'cat-felt',
    subcategory_id: 'sub-felt-facilitation',
    category_name: 'FELT·FIBRE',
    subcategory_name: 'Facilitation',
    facilitator_id: s.facilitator_id,
  }));
  return [...own, ...sessionAsPractices].sort((a, b) => (b.created_at||'').localeCompare(a.created_at||''));
}
function getPractice(id) {
  return queryOne('SELECT * FROM practices WHERE id=?', [id]);
}
function toggleFavourite(id) { getDbSync().run('UPDATE practices SET is_favourite=1-is_favourite WHERE id=?', [id]); save(); }
function incrementUseCount(id) { getDbSync().run('UPDATE practices SET use_count=use_count+1 WHERE id=?', [id]); save(); }
// Per Bot 22 — client removing a facilitator-assigned file from their own
// My Practices. Scoped to userId matching the current assignment as a
// safety check — a stale/duplicate request can't accidentally clear
// someone else's assignment.
function unassignFileFromClient(fileId, userId) {
  getDbSync().run('UPDATE library_files SET assigned_client_id=NULL WHERE id=? AND assigned_client_id=?', [fileId, userId]);
  save();
}
function deletePractice(id) { getDbSync().run('DELETE FROM practices WHERE id=?', [id]); save(); }
// Per Bot 22 — client removing their own facilitator-added practice from
// My Practices. Scoped to client_id matching, same safety reasoning as
// unassignFileFromClient above.
function deleteOwnPractice(id, clientId) {
  getDbSync().run('DELETE FROM practices WHERE id=? AND client_id=?', [id, clientId]);
  save();
}

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
function createInvitation(id, token, facilitatorId, email, expiresAt, skinSlug) {
  getDbSync().run(
    'INSERT INTO invitations (id,token,facilitator_id,email,expires_at,skin_id) VALUES (?,?,?,?,?,?)',
    [id, token, facilitatorId, email.toLowerCase(), expiresAt, skinSlug || null]
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
// Per Bot 15o — badge count for the People nav link. "Unseen" here means
// "never opened the Enquiries list since this came in" — viewing the list
// clears it, unlike facilitator requests below (see getPendingFacilitatorRequestCount).
function getUnseenGuestLeadCount() {
  return queryOne('SELECT COUNT(*) as c FROM guest_leads WHERE seen_at IS NULL')?.c || 0;
}
function markGuestLeadsSeen() {
  getDbSync().run("UPDATE guest_leads SET seen_at=datetime('now') WHERE seen_at IS NULL");
  save();
}

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
// Per Bot 15o — badge count for the People nav link. Deliberately just a
// count of status='pending', not a separate "seen" concept — the badge
// should only clear when the request is actually acted on (approved/
// declined/deferred/archived), not just by glancing at the list.
function getPendingFacilitatorRequestCount() {
  return queryOne("SELECT COUNT(*) as c FROM facilitator_requests WHERE status='pending'")?.c || 0;
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

// ── Offers (Per Bot 17) ── Named, dated promotional campaigns; see the
// table comment in getDb() for the field meanings. `is_default` is enforced
// as single-row here (not by a DB constraint) — createOffer/updateOffer
// clear any existing default before setting a new one.
function getAllOffers() {
  return queryAll('SELECT * FROM offers ORDER BY created_at DESC');
}
function getOffer(id) {
  return queryAll('SELECT * FROM offers WHERE id=?', [id])[0] || null;
}
function getOfferByCode(code) {
  return queryAll('SELECT * FROM offers WHERE code=?', [code])[0] || null;
}
function getDefaultOffer() {
  return queryAll('SELECT * FROM offers WHERE is_default=1 LIMIT 1')[0] || null;
}
// Pure check, no DB access — active flag AND within the launch/expiry
// window (either bound can be null/open-ended). Used both server-side
// before granting anything and to decide what the promo page itself shows.
function isOfferCurrentlyValid(offer) {
  if (!offer || !offer.active) return false;
  const now = new Date();
  if (offer.launch_date && now < new Date(offer.launch_date)) return false;
  if (offer.expiry_date && now > new Date(offer.expiry_date)) return false;
  return true;
}
function createOffer(fields) {
  const id = crypto.randomUUID();
  if (fields.is_default) getDbSync().run('UPDATE offers SET is_default=0 WHERE is_default=1');
  getDbSync().run(
    `INSERT INTO offers (id,name,code,headline,description,trial_days,launch_date,expiry_date,is_default,active,cloned_from,showcase_file_id,skin_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, fields.name, fields.code,
      fields.headline || null, fields.description || null,
      Number.isFinite(fields.trial_days) ? fields.trial_days : 14,
      fields.launch_date || null, fields.expiry_date || null,
      fields.is_default ? 1 : 0,
      fields.active === false ? 0 : 1,
      fields.cloned_from || null,
      fields.showcase_file_id || null,
      fields.skin_id || null,
    ]
  );
  save();
  return id;
}
function updateOffer(id, fields) {
  const allowed = ['name','code','headline','description','trial_days','launch_date','expiry_date','is_default','active','showcase_file_id','skin_id'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  if (fields.is_default) getDbSync().run('UPDATE offers SET is_default=0 WHERE is_default=1 AND id!=?', [id]);
  const sets = keys.map(k => `${k}=?`).join(', ');
  getDbSync().run(`UPDATE offers SET ${sets} WHERE id=?`, [...keys.map(k => fields[k]), id]);
  save();
}
function deleteOffer(id) {
  getDbSync().run('UPDATE users SET signup_offer_id=NULL WHERE signup_offer_id=?', [id]);
  getDbSync().run('DELETE FROM offers WHERE id=?', [id]);
  save();
}

// ── Campaigns (Per Bot 18) ──
function getAllCampaigns() {
  return queryAll(`SELECT c.*, o.name as offer_name,
    (SELECT COUNT(*) FROM campaign_steps WHERE campaign_id=c.id) as step_count
    FROM campaigns c LEFT JOIN offers o ON c.offer_id=o.id
    ORDER BY c.created_at DESC`);
}
function getCampaign(id) { return queryOne('SELECT * FROM campaigns WHERE id=?', [id]); }
// Per Bot 19 — a campaign's email steps previously had no way to show up
// distinctly in the Funnel report the way every newsletter/promo link
// already does (no {{invite_link}} attribution at all, see
// buildMessageTokens in server.js). Auto-slugged from the name at
// creation time so there's always something sensible without asking Per
// to type one; editing it later isn't built yet.
function slugifySourceTag(name) {
  return 'campaign-' + String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function createCampaign(id, name, offerId, audience) {
  getDbSync().run('INSERT INTO campaigns (id,name,offer_id,audience,source_tag) VALUES (?,?,?,?,?)',
    [id, name, offerId || null, audience || 'all', slugifySourceTag(name)]);
  save();
  return id;
}
function updateCampaign(id, fields) {
  const allowed = ['name', 'offer_id', 'audience', 'source_tag'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(', ');
  getDbSync().run(`UPDATE campaigns SET ${sets} WHERE id=? AND status='draft'`, [...keys.map(k => fields[k]), id]);
  save();
}
// Draft -> active is one-way through this function; going live records
// started_at, which every step's offset_days counts from. Pausing stops
// the daily email-step cron from firing anything further, but doesn't
// touch social steps already scheduled with BulkPublish — those can only
// be cancelled on BulkPublish's side, a genuine limitation worth knowing.
function setCampaignStatus(id, status) {
  if (status === 'active') {
    getDbSync().run("UPDATE campaigns SET status='active', started_at=datetime('now') WHERE id=? AND status='draft'", [id]);
  } else {
    getDbSync().run('UPDATE campaigns SET status=? WHERE id=?', [status, id]);
  }
  save();
}
function deleteCampaign(id) {
  getDbSync().run('DELETE FROM campaign_steps WHERE campaign_id=?', [id]);
  getDbSync().run('DELETE FROM campaigns WHERE id=?', [id]);
  save();
}

function getCampaignSteps(campaignId) {
  return queryAll('SELECT * FROM campaign_steps WHERE campaign_id=? ORDER BY offset_days ASC, step_order ASC', [campaignId]);
}
function getCampaignStep(id) { return queryOne('SELECT * FROM campaign_steps WHERE id=?', [id]); }
function addCampaignStep(id, campaignId, offsetDays, type, channel, subject, content, lineId) {
  const order = queryOne('SELECT COALESCE(MAX(step_order),0)+1 as n FROM campaign_steps WHERE campaign_id=?', [campaignId]).n;
  getDbSync().run(
    `INSERT INTO campaign_steps (id,campaign_id,step_order,offset_days,type,channel,subject,content,line_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, campaignId, order, offsetDays, type, channel, subject || null, content || '', lineId || null]
  );
  save();
  return id;
}
function updateCampaignStep(id, fields) {
  const allowed = ['offset_days', 'type', 'channel', 'subject', 'content', 'line_id', 'format'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(', ');
  getDbSync().run(`UPDATE campaign_steps SET ${sets} WHERE id=?`, [...keys.map(k => fields[k]), id]);
  save();
}
function deleteCampaignStep(id) {
  getDbSync().run('DELETE FROM campaign_steps WHERE id=?', [id]);
  save();
}
function setCampaignStepResult(id, status, fields = {}) {
  const sets = ['status=?'];
  const vals = [status];
  if (status === 'sent' || status === 'scheduled') { sets.push('sent_at=?'); vals.push(new Date().toISOString()); }
  if (fields.externalPostId !== undefined) { sets.push('external_post_id=?'); vals.push(fields.externalPostId); }
  if (fields.error !== undefined) { sets.push('error=?'); vals.push(fields.error); }
  vals.push(id);
  getDbSync().run(`UPDATE campaign_steps SET ${sets.join(', ')} WHERE id=?`, vals);
  save();
}
// Per Bot 18 — used by the daily cron: every email step, in any active
// campaign, whose offset_days matches how many whole days have passed
// since that campaign went live, and hasn't already fired. Social steps
// are excluded here entirely — they're scheduled directly with
// BulkPublish at go-live time and need no further cron attention.
function getDueCampaignEmailSteps() {
  return queryAll(`
    SELECT s.*, c.audience, c.started_at, c.offer_id, c.source_tag
    FROM campaign_steps s JOIN campaigns c ON s.campaign_id=c.id
    WHERE c.status='active' AND s.channel='email' AND s.status='pending'
      AND s.offset_days <= CAST(julianday('now') - julianday(c.started_at) AS INTEGER)
  `);
}

// ── Savers Protocol (Per Bot 18) ──
// Starts tracking someone the moment they schedule a cancellation — their
// paid time is untouched, this is purely a record of intent so the day-0
// acknowledgment can fire and so the eventual subscription.deleted event
// (real end of term) knows to start a bonus grace period rather than
// downgrading immediately.
function startSaversCancellation(userId, realPeriodEnd, priorTier) {
  getDbSync().run(
    `UPDATE users SET savers_type='cancellation', savers_triggered_at=datetime('now'),
      savers_real_period_end=?, savers_last_prior_tier=? WHERE id=?`,
    [realPeriodEnd, priorTier, userId]
  );
  save();
}
// Called once real access has actually ended (cancellation) or the moment
// a genuine payment failure happens — either way this is what actually
// starts the 14-day countdown and both email-sent flags.
function startSaversGrace(userId, type, priorTier) {
  const graceEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  getDbSync().run(
    `UPDATE users SET savers_type=?, savers_grace_started_at=datetime('now'), savers_grace_ends_at=?,
      savers_last_prior_tier=COALESCE(savers_last_prior_tier,?),
      savers_email_day0_sent=0, savers_email_mid_sent=0, savers_email_final_sent=0
      WHERE id=?`,
    [type, graceEnds, priorTier, userId]
  );
  save();
}
// Called on any sign of real payment success (renewal, or a fresh
// checkout) — clears every Savers field so a resolved case can never be
// mistaken for still-pending, and can't accidentally get downgraded later
// by a stale grace deadline.
function clearSaversState(userId) {
  getDbSync().run(
    `UPDATE users SET savers_type=NULL, savers_triggered_at=NULL, savers_real_period_end=NULL,
      savers_grace_started_at=NULL, savers_grace_ends_at=NULL, savers_last_prior_tier=NULL,
      savers_email_day0_sent=0, savers_email_mid_sent=0, savers_email_final_sent=0
      WHERE id=?`,
    [userId]
  );
  save();
}
function markSaversEmailSent(userId, stage) {
  const col = { day0: 'savers_email_day0_sent', mid: 'savers_email_mid_sent', final: 'savers_email_final_sent' }[stage];
  if (!col) return;
  getDbSync().run(`UPDATE users SET ${col}=1 WHERE id=?`, [userId]);
  save();
}
// Cron candidates — grace already started (so day0 already fired inline
// in the webhook handler), mid/final touchpoints counted from
// savers_grace_started_at, same day-window shape for both types.
function getUsersDueForSaversEmail(stage) {
  const days = { mid: 7, final: 13 }[stage];
  const col = { mid: 'savers_email_mid_sent', final: 'savers_email_final_sent' }[stage];
  if (!days) return [];
  return queryAll(`
    SELECT * FROM users
    WHERE savers_type IS NOT NULL AND savers_grace_started_at IS NOT NULL AND ${col}=0
      AND julianday('now') - julianday(savers_grace_started_at) >= ?
  `, [days]);
}
// Cron candidates for the actual downgrade — grace window fully elapsed,
// still flagged (nobody cleared it via a real payment succeeding).
function getUsersDueForSaversDowngrade() {
  return queryAll(`
    SELECT * FROM users
    WHERE savers_type IS NOT NULL AND savers_grace_ends_at IS NOT NULL
      AND savers_grace_ends_at <= datetime('now')
  `);
}

// Per Bot 18 — resolves which file (if any) /promotions should show as its
// showcase clip. Priority: the specific offer named by the promo code's
// own showcase_file_id, then the standing default offer's, then the
// global fallback in app_config. Returns null (page shows nothing) if
// none of those resolve to a real, non-archived file.
// Per Bot 18 — one row per /promotions landing. Fire-and-forget from the
// route handler; a logging failure should never break the page itself.
function logPromoHit(offerId, promoCode, source, skinId) {
  getDbSync().run('INSERT INTO promo_hits (id,offer_id,promo_code,source,skin_id) VALUES (?,?,?,?,?)',
    [crypto.randomUUID(), offerId || null, promoCode || null, source || null, skinId || null]);
  save();
}

// Per Bot 18 — the funnel report. Hits come from promo_hits; registrations
// and paid conversions are derived from users.signup_offer_id — there's no
// separate "conversion event" table, a conversion IS just that user's
// current state, checked live rather than logged as a second event that
// could drift out of sync with reality (e.g. if someone's membership
// later lapses, a stale "converted" log entry would keep counting them
// forever; deriving live never has that problem).
// Grouped by offer first (always), then optionally further broken down by
// source and/or skin if the caller asks for it — the three dimensions
// combine freely rather than needing separate queries for each.
function getFunnelStats({ groupBySource = false, groupBySkin = false } = {}) {
  const hitDims = ['offer_id'];
  if (groupBySource) hitDims.push('source');
  if (groupBySkin) hitDims.push('skin_id');
  const hitDimSql = hitDims.join(', ');
  const hitRows = queryAll(`SELECT ${hitDimSql}, COUNT(*) as hits FROM promo_hits GROUP BY ${hitDimSql}`);

  // Registrations/trial/paid, grouped by the SAME dimensions as the hits
  // above — signup_offer_id/signup_source mirror promo_hits' own
  // offer_id/source, and skin_id here is the user's real skin assignment
  // (already set at registration from the skin the link/invite pointed
  // at), not a separate attribution field. Matching dimensions matters:
  // without this, a source/skin breakdown would attach one offer-wide
  // conversion total to every sub-row, wildly overstating each one.
  const regDims = ['signup_offer_id as offer_id'];
  if (groupBySource) regDims.push('signup_source as source');
  if (groupBySkin) regDims.push('skin_id');
  const regDimSql = regDims.join(', ');
  const groupSql = ['signup_offer_id', groupBySource ? 'signup_source' : null, groupBySkin ? 'skin_id' : null].filter(Boolean).join(', ');
  const regRows = queryAll(`
    SELECT ${regDimSql},
      COUNT(*) as registrations,
      SUM(CASE WHEN member_tier=0 AND (trial_ends_at IS NULL OR trial_ends_at > datetime('now')) THEN 1 ELSE 0 END) as trial_active,
      SUM(CASE WHEN member_tier>0 THEN 1 ELSE 0 END) as paid
    FROM users WHERE signup_offer_id IS NOT NULL GROUP BY ${groupSql}`);

  const keyOf = row => [row.offer_id || '', groupBySource ? (row.source || '') : '', groupBySkin ? (row.skin_id || '') : ''].join('::');
  const regByKey = {};
  regRows.forEach(r => { regByKey[keyOf(r)] = r; });

  const offers = getAllOffers();
  const offerById = {}; offers.forEach(o => { offerById[o.id] = o; });

  return hitRows.map(row => {
    const reg = regByKey[keyOf(row)] || { registrations: 0, trial_active: 0, paid: 0 };
    return {
      offer_id: row.offer_id,
      offer_name: row.offer_id ? (offerById[row.offer_id]?.name || '(deleted offer)') : '(no offer / direct visit)',
      source: groupBySource ? row.source : undefined,
      skin_id: groupBySkin ? row.skin_id : undefined,
      hits: row.hits,
      registrations: reg.registrations,
      trial_active: reg.trial_active,
      paid: reg.paid,
      click_to_reg_pct: row.hits > 0 ? Math.round((reg.registrations / row.hits) * 1000) / 10 : null,
      reg_to_paid_pct: reg.registrations > 0 ? Math.round((reg.paid / reg.registrations) * 1000) / 10 : null,
    };
  }).sort((a, b) => b.hits - a.hits);
}

function resolveShowcaseFile(code) {
  let fileId = null;
  if (code) {
    const offer = getOfferByCode(code);
    if (offer && isOfferCurrentlyValid(offer) && offer.showcase_file_id) fileId = offer.showcase_file_id;
  }
  if (!fileId) {
    const def = getDefaultOffer();
    if (def && isOfferCurrentlyValid(def) && def.showcase_file_id) fileId = def.showcase_file_id;
  }
  if (!fileId) {
    const config = getAppConfig();
    if (config?.default_showcase_file_id) fileId = config.default_showcase_file_id;
  }
  if (!fileId) return null;
  const file = queryOne('SELECT * FROM library_files WHERE id=?', [fileId]);
  return (file && !file.archived) ? file : null;
}
// Attribution-only — used by bulk-import to tag which offer a whole
// imported batch was assigned, and by /api/register for self-signups that
// came in via a promo code. Never read by any access-control logic.
function setSignupOfferId(userId, offerId) {
  getDbSync().run('UPDATE users SET signup_offer_id=? WHERE id=?', [offerId, userId]);
  save();
}
function setSignupSource(userId, source) {
  getDbSync().run('UPDATE users SET signup_source=? WHERE id=?', [source, userId]);
  save();
}

// Per Bot 17 (session 2) — public "what's included" listing for the
// promotions page. Deliberately broader than getFeaturedCourses above:
// this returns every free course with an open instance, not just the
// hand-curated carousel subset — the promotions page is making a
// completeness claim ("here's everything included"), so it needs the
// full list, not the curated highlight.
function getPublicOpenCourses() {
  return queryAll(`SELECT c.id, c.title, c.description, cat.name as category_name
    FROM courses c
    LEFT JOIN categories cat ON c.category_id=cat.id
    JOIN course_instances ci ON ci.course_id=c.id AND ci.status='open' AND (ci.price_cents IS NULL OR ci.price_cents=0)
    WHERE c.access_status='visible' AND (c.required_tier IS NULL OR c.required_tier=0)
    GROUP BY c.id
    ORDER BY c.sort_order, c.title`);
}

// ── Signal lines (Per Bot 17 phase 6) ──
function getAllSignalLines() {
  return queryAll('SELECT * FROM signal_lines ORDER BY created_at DESC');
}
function getActiveSignalLines() {
  return queryAll("SELECT * FROM signal_lines WHERE status='active' ORDER BY created_at DESC");
}
function getRandomActiveSignalLine() {
  const active = getActiveSignalLines();
  if (!active.length) return null;
  return active[Math.floor(Math.random() * active.length)];
}
function createSignalLine(fields) {
  const id = crypto.randomUUID();
  getDbSync().run(
    'INSERT INTO signal_lines (id,text,prior_tag,status,source,trend_context) VALUES (?,?,?,?,?,?)',
    [id, fields.text, fields.prior_tag || 'general', fields.status || 'draft', fields.source || 'manual', fields.trend_context || null]
  );
  save();
  return id;
}
function updateSignalLine(id, fields) {
  const allowed = ['text', 'prior_tag', 'status'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(', ');
  getDbSync().run(`UPDATE signal_lines SET ${sets} WHERE id=?`, [...keys.map(k => fields[k]), id]);
  save();
}
function deleteSignalLine(id) {
  getDbSync().run('DELETE FROM signal_lines WHERE id=?', [id]);
  save();
}

// ── Social posts (Per Bot 17 phase 4) ── History for the message builder.
// platforms/results are stored as JSON text and parsed back out on read —
// sql.js has no native JSON column type.
function addSocialPost(sourceText, platforms, results, offerId) {
  const id = crypto.randomUUID();
  getDbSync().run(
    'INSERT INTO social_posts (id,source_text,platforms,results,offer_id) VALUES (?,?,?,?,?)',
    [id, sourceText, JSON.stringify(platforms), JSON.stringify(results), offerId || null]
  );
  save();
  return id;
}
function getAllSocialPosts(limit = 100) {
  return queryAll('SELECT * FROM social_posts ORDER BY created_at DESC LIMIT ?', [limit])
    .map(p => ({ ...p, platforms: JSON.parse(p.platforms), results: JSON.parse(p.results) }));
}
function getSocialPost(id) {
  const row = queryAll('SELECT * FROM social_posts WHERE id=?', [id])[0];
  if (!row) return null;
  return { ...row, platforms: JSON.parse(row.platforms), results: JSON.parse(row.results) };
}
function deleteSocialPost(id) {
  getDbSync().run('DELETE FROM social_posts WHERE id=?', [id]);
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
// table comment above for why. scheduledMessageId (Per Bot 21) is set only
// when this particular row was auto-created by a recurring schedule firing
// — purely for display in the newsletters list ("from a schedule"), not
// read by the send pipeline itself.
function addNewsletter(id, subject, body, audience, format, offerId, sourceTag, scheduledMessageId) {
  getDbSync().run(
    `INSERT INTO newsletters (id,subject,body,status,audience,format,offer_id,source_tag,scheduled_message_id) VALUES (?,?,?,'draft',?,?,?,?,?)`,
    [id, subject, body, audience || 'all', format || 'plain', offerId || null, sourceTag || null, scheduledMessageId || null]
  );
  save();
}
function getNewsletter(id) { return queryOne('SELECT * FROM newsletters WHERE id=?', [id]); }
function getAllNewsletters() { return queryAll('SELECT * FROM newsletters ORDER BY created_at DESC'); }
function updateNewsletter(id, subject, body, audience, format, offerId, sourceTag) {
  getDbSync().run("UPDATE newsletters SET subject=?, body=?, audience=?, format=?, offer_id=?, source_tag=? WHERE id=? AND status='draft'",
    [subject, body, audience || 'all', format || 'plain', offerId || null, sourceTag || null, id]);
  save();
}
function deleteNewsletterDraft(id) {
  getDbSync().run("DELETE FROM newsletters WHERE id=? AND status='draft'", [id]);
  save();
}
function updateNewsletterStatus(id, status) {
  getDbSync().run("UPDATE newsletters SET status=? WHERE id=?", [status, id]);
  save();
}
function markNewsletterSent(id, recipientCount) {
  getDbSync().run("UPDATE newsletters SET status='sent', sent_at=datetime('now'), recipient_count=? WHERE id=?", [recipientCount, id]);
  save();
}

// ── Scheduled (recurring) messages (Per Bot 21) ──
function getAllScheduledMessages() { return queryAll('SELECT * FROM scheduled_messages ORDER BY created_at DESC'); }
function getScheduledMessage(id) { return queryOne('SELECT * FROM scheduled_messages WHERE id=?', [id]); }
function createScheduledMessage(id, fields) {
  getDbSync().run(
    `INSERT INTO scheduled_messages (id, subject, body, format, audience, recurrence_type, recurrence_config, send_hour, active)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, fields.subject, fields.body, fields.format || 'plain', fields.audience || 'all',
     fields.recurrence_type, JSON.stringify(fields.recurrence_config || {}), fields.send_hour ?? 7, fields.active === false ? 0 : 1]
  );
  save();
}
function updateScheduledMessage(id, fields) {
  const allowed = ['subject','body','format','audience','recurrence_type','send_hour','active'];
  const sets = [];
  const vals = [];
  allowed.forEach(k => { if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(fields[k]); } });
  if (fields.recurrence_config !== undefined) { sets.push('recurrence_config=?'); vals.push(JSON.stringify(fields.recurrence_config || {})); }
  if (!sets.length) return;
  vals.push(id);
  getDbSync().run(`UPDATE scheduled_messages SET ${sets.join(', ')} WHERE id=?`, vals);
  save();
}
function deleteScheduledMessage(id) {
  getDbSync().run('DELETE FROM scheduled_messages WHERE id=?', [id]);
  save();
}
function markScheduledMessageSent(id, dateStr) {
  getDbSync().run('UPDATE scheduled_messages SET last_sent_date=? WHERE id=?', [dateStr, id]);
  save();
}

// Per Bot 21 — the actual recurrence logic. Pure function, deliberately
// no DB/date-library dependency beyond plain Date math, so it's easy to
// test directly against known dates rather than only ever observing it
// via whether an email happened to go out. dateObj is read in UTC
// throughout — the cron tick that calls this runs in UTC, and send_hour
// is stored as a UTC hour, so every comparison here needs to agree with
// that same frame or the "which day is it" question silently drifts by
// several hours near midnight for anyone west of Greenwich.
function scheduledMessageMatchesDate(recurrenceType, config, dateObj) {
  const cfg = config || {};
  const dow = dateObj.getUTCDay();       // 0=Sun .. 6=Sat
  const dom = dateObj.getUTCDate();      // 1-31
  const month = dateObj.getUTCMonth() + 1; // 1-12
  switch (recurrenceType) {
    case 'daily':
      return true;
    case 'weekly':
      return Array.isArray(cfg.daysOfWeek) && cfg.daysOfWeek.includes(dow);
    case 'monthly_date': {
      if (cfg.dayOfMonth === 'last') {
        const lastDay = new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth() + 1, 0)).getUTCDate();
        return dom === lastDay;
      }
      return dom === Number(cfg.dayOfMonth);
    }
    case 'monthly_nth_weekday': {
      if (dow !== Number(cfg.weekday)) return false;
      if (Number(cfg.nth) === -1) {
        // "Last <weekday> of the month" — true if adding 7 days rolls
        // into next month, i.e. there's no other occurrence of this
        // weekday later in the current month.
        const nextOccurrence = new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dom + 7));
        return nextOccurrence.getUTCMonth() !== dateObj.getUTCMonth();
      }
      const occurrence = Math.ceil(dom / 7); // which occurrence of this weekday within the month (1st, 2nd, 3rd, 4th)
      return occurrence === Number(cfg.nth);
    }
    case 'yearly':
      return month === Number(cfg.month) && dom === Number(cfg.day);
    default:
      return false;
  }
}

// ── Email log (Per Bot 8) ──
// logEmailPending: written up front for a whole newsletter batch, before
// any sending starts, so a mid-batch crash still leaves every intended
// recipient on record (stuck at 'pending' rather than vanishing).
// logEmailResult: used directly by transactional sendEmail() calls, which
// have no batch to survive a crash mid-way through — one row, immediately
// resolved to its outcome, no separate pending step needed.
function logEmailPending(id, kind, email, subject, newsletterId, userId) {
  getDbSync().run(
    `INSERT INTO email_log (id,kind,email,subject,newsletter_id,user_id,status) VALUES (?,?,?,?,?,?,'pending')`,
    [id, kind, email, subject || '', newsletterId || null, userId || null]
  ); save();
}
function logEmailResult(id, kind, email, subject, newsletterId, userId, status, scalewayEmailId, error) {
  getDbSync().run(
    `INSERT INTO email_log (id,kind,email,subject,newsletter_id,user_id,status,scaleway_email_id,error,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
    [id, kind, email, subject || '', newsletterId || null, userId || null, status, scalewayEmailId || null, error || null]
  ); save();
}
// bodyHtml (Per Bot 21) — the rendered HTML this specific send used, passed
// in from sendEmail() where it's already been built. Optional so every
// existing call site keeps working unchanged; only sendEmail() actually
// has a body to pass. Stored even on a failed send — seeing what content
// failed to go out is more useful than nothing.
function updateEmailLogResult(id, status, scalewayEmailId, error, bodyHtml) {
  getDbSync().run(
    `UPDATE email_log SET status=?, scaleway_email_id=?, error=?, body_html=COALESCE(?, body_html), updated_at=datetime('now') WHERE id=?`,
    [status, scalewayEmailId || null, error || null, bodyHtml || null, id]
  ); save();
}
function getEmailLogForNewsletter(newsletterId) {
  return queryAll('SELECT * FROM email_log WHERE newsletter_id=? ORDER BY created_at ASC', [newsletterId]);
}
function getEmailLogCountsForNewsletter(newsletterId) {
  const rows = queryAll('SELECT status, COUNT(*) as n FROM email_log WHERE newsletter_id=? GROUP BY status', [newsletterId]);
  const counts = { pending: 0, sent: 0, failed: 0 };
  rows.forEach(r => { counts[r.status] = r.n; });
  return counts;
}
// General admin view across every kind of email the app sends, not just
// newsletters — welcome, password reset, reminders, renewals, alerts.
// Per Bot 21: deliberately selects columns rather than * — body_html can
// be a full rendered email per row, and this list can return up to 2000
// rows at once, so it's excluded here and fetched individually per row
// via getEmailLogById instead. has_body tells the admin UI whether a
// "View" action has anything to show.
const EMAIL_LOG_LIST_COLS = `id,kind,newsletter_id,user_id,email,subject,status,scaleway_email_id,error,created_at,updated_at,(body_html IS NOT NULL) AS has_body`;
function getRecentEmailLog(limit, kind) {
  if (kind) return queryAll(`SELECT ${EMAIL_LOG_LIST_COLS} FROM email_log WHERE kind=? ORDER BY created_at DESC LIMIT ?`, [kind, limit || 100]);
  return queryAll(`SELECT ${EMAIL_LOG_LIST_COLS} FROM email_log ORDER BY created_at DESC LIMIT ?`, [limit || 100]);
}
function getEmailLogById(id) { return queryOne('SELECT * FROM email_log WHERE id=?', [id]); }
// Per Bot 21 — clears stored bodies for anything older than daysOld,
// keeping the metadata row (subject/status/etc, still needed for the
// Migrations/Registrations-style reports) intact. Not wired into cron.js
// yet — Per's call whether/when this is needed once real volume shows
// whether body_html actually becomes a size problem.
function archiveOldEmailBodies(daysOld) {
  const days = daysOld || 90;
  getDbSync().run(`UPDATE email_log SET body_html=NULL WHERE body_html IS NOT NULL AND created_at < datetime('now','-${days} days')`);
  save();
}
function clearEmailLogForNewsletter(newsletterId) {
  getDbSync().run('DELETE FROM email_log WHERE newsletter_id=?', [newsletterId]); save();
}

// ── Cron job activity log (Per Bot 20) ──
// logCronRun: called once per scheduled job, after it finishes (success
// or failure) — deliberately a single insert rather than pending/update
// like email_log, since a cron job either completes or throws, there's
// no meaningful in-between state worth showing an admin.
function logCronRun(jobName, status, detail, error, durationMs) {
  getDbSync().run(
    `INSERT INTO cron_log (id, job_name, status, detail, error, duration_ms) VALUES (?,?,?,?,?,?)`,
    [crypto.randomUUID(), jobName, status || 'ok', detail || null, error || null, durationMs ?? null]
  );
  save();
}
function getRecentCronRuns(limit) {
  return queryAll('SELECT * FROM cron_log ORDER BY started_at DESC LIMIT ?', [limit || 200]);
}
// One row per distinct job: its most recent run, plus a rolling 7-day
// success/failure tally — enough to spot "this job has been silently
// failing every day this week" at a glance, without opening the full log.
function getCronJobSummary() {
  const jobs = queryAll(`SELECT DISTINCT job_name FROM cron_log`);
  return jobs.map(({ job_name }) => {
    const last = queryOne(`SELECT * FROM cron_log WHERE job_name=? ORDER BY started_at DESC LIMIT 1`, [job_name]);
    const counts = queryAll(
      `SELECT status, COUNT(*) as n FROM cron_log WHERE job_name=? AND started_at > datetime('now','-7 days') GROUP BY status`,
      [job_name]
    );
    const last7Days = { ok: 0, failed: 0 };
    counts.forEach(c => { last7Days[c.status] = c.n; });
    return { jobName: job_name, last, last7Days };
  }).sort((a, b) => (b.last?.started_at || '').localeCompare(a.last?.started_at || ''));
}
// Prune old rows so this stays a lightweight activity log, not an
// ever-growing table — 90 days is plenty for spotting patterns.
function pruneCronLog() {
  getDbSync().run(`DELETE FROM cron_log WHERE started_at < datetime('now','-90 days')`);
  save();
}

// ── Login activity log (Per Bot 20) ──
function logLogin(userId, role, eventType) {
  getDbSync().run(
    `INSERT INTO login_log (id, user_id, role, event_type) VALUES (?,?,?,?)`,
    [crypto.randomUUID(), userId || null, role || 'unknown', eventType || 'login']
  );
  save();
}
function pruneLoginLog() {
  getDbSync().run(`DELETE FROM login_log WHERE logged_in_at < datetime('now','-180 days')`);
  save();
}

// ── Talk-to-Per session log (Per Bot 20) ──
function startTalkSession(id, userId) {
  getDbSync().run(`INSERT INTO talk_sessions (id, user_id) VALUES (?,?)`, [id, userId]);
  save();
}
function endTalkSession(id) {
  const row = queryOne(`SELECT started_at FROM talk_sessions WHERE id=?`, [id]);
  if (!row) return;
  getDbSync().run(
    `UPDATE talk_sessions SET ended_at=datetime('now'),
       duration_seconds=CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER)
     WHERE id=?`,
    [id]
  );
  save();
}
// Talk session end/duration is set by endTalkSession() above, called from
// finalizeChatSession() in server.js — which is itself invoked either by
// the client's own leave-Talk beacon, or by the existing stale-chat-
// session cron sweep for anyone who never sent one (crashed tab, killed
// app). No separate staleness mechanism needed here.

// ── 1:1 video/audio calls (Per Bot 12) ──
function createCall(id, facilitatorId, clientId, callType) {
  getDbSync().run(
    `INSERT INTO calls (id, facilitator_id, client_id, call_type, status, started_at) VALUES (?, ?, ?, ?, 'ringing', datetime('now'))`,
    [id, facilitatorId, clientId, callType === 'audio' ? 'audio' : 'video']
  );
  save();
  return getCall(id);
}
function getCall(id) { return queryOne('SELECT * FROM calls WHERE id=?', [id]); }
// A client only ever has one call worth surfacing at a time — the most
// recent one still in 'ringing' state addressed to them. Ordered so a
// stale ring (e.g. the facilitator hung up before it was answered, but
// the row is still technically 'ringing' for a beat) can't shadow a
// genuinely new one.
function getRingingCallForClient(clientId) {
  return queryOne(`SELECT * FROM calls WHERE client_id=? AND status='ringing' ORDER BY started_at DESC LIMIT 1`, [clientId]);
}
function updateCallStatus(id, status, extraFields) {
  const fields = { status, ...(extraFields || {}) };
  const keys = Object.keys(fields);
  getDbSync().run(`UPDATE calls SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, [...keys.map(k => fields[k]), id]);
  save();
}
function setCallConsent(id, consent) {
  getDbSync().run(`UPDATE calls SET recording_consent=? WHERE id=?`, [consent, id]); save();
}
function setCallRecording(id, key, durationSeconds) {
  getDbSync().run(`UPDATE calls SET recording_key=?, recording_duration_seconds=?, transcript_status='pending' WHERE id=?`, [key, durationSeconds || null, id]);
  save();
}
function setCallTranscript(id, transcript, status) {
  getDbSync().run(`UPDATE calls SET transcript=?, transcript_status=? WHERE id=?`, [transcript || null, status, id]);
  save();
}
function setCallShared(id, shared) {
  getDbSync().run(`UPDATE calls SET shared_with_client=?, shared_at=? WHERE id=?`, [shared ? 1 : 0, shared ? new Date().toISOString() : null, id]);
  save();
}
// Facilitator's own view of a client's call history — everything,
// regardless of share status, since it's their recording to manage.
function getCallsForFacilitatorClient(facilitatorId, clientId) {
  return queryAll(`SELECT * FROM calls WHERE facilitator_id=? AND client_id=? ORDER BY started_at DESC`, [facilitatorId, clientId]);
}
// Admin equivalent — same shape, but every call for that client regardless
// of which facilitator ran it, matching the admin-sees-everything pattern
// used elsewhere (e.g. canAccessSession in server.js).
function getAllCallsForClient(clientId) {
  return queryAll(`SELECT * FROM calls WHERE client_id=? ORDER BY started_at DESC`, [clientId]);
}
// Client's own view — only calls the facilitator has explicitly shared.
function getSharedCallsForClient(clientId) {
  return queryAll(`SELECT * FROM calls WHERE client_id=? AND shared_with_client=1 ORDER BY started_at DESC`, [clientId]);
}

// ── Tomte personalization (Per Bot 8) — one pair of functions covering
// both account tables, since Tomte shows up for clients, facilitators,
// and admins alike and each personalizes independently.
function setTomteName(role, id, name) {
  const table = role === 'client' ? 'users' : 'facilitators';
  getDbSync().run(`UPDATE ${table} SET tomte_name=? WHERE id=?`, [name || null, id]); save();
}
function setTomteImage(role, id, filename) {
  const table = role === 'client' ? 'users' : 'facilitators';
  getDbSync().run(`UPDATE ${table} SET tomte_image_filename=? WHERE id=?`, [filename || null, id]); save();
}
// Voice-output preference (Per Bot 11) — self-service, any logged-in role,
// same pattern as setTomteName/setTomteImage above. NULL (never set) reads
// as off; true/false once someone's actually touched the toggle at least
// once, from either themselves or an admin override.
function setTomteVoiceEnabled(role, id, enabled) {
  const table = role === 'client' ? 'users' : 'facilitators';
  getDbSync().run(`UPDATE ${table} SET tomte_voice_enabled=? WHERE id=?`, [enabled ? 1 : 0, id]); save();
}
function getTomteSettings(role, id) {
  const table = role === 'client' ? 'users' : 'facilitators';
  // skin_id only exists on users (clients), not facilitators — selecting
  // it unconditionally would error on the facilitators table.
  const skinCol = role === 'client' ? ', skin_id' : '';
  return queryOne(`SELECT tomte_name, tomte_image_filename, language, tomte_language, voice_id, tomte_voice_enabled${skinCol} FROM ${table} WHERE id=?`, [id]) || {};
}

// ── Admin editing a user's own profile fields directly (Per Bot 8) —
// deliberately scoped to identity/contact fields plus Tomte's own
// language/voice overrides (Per Bot 9), not tier/facilitator (already has
// its own modal/flow) or anything Stripe/consent-related, which shouldn't
// be hand-edited casually.
// ── Tomte language + action image defaults (Per Bot 8) ──
function getTomteLanguageDefaults() {
  return queryAll('SELECT * FROM tomte_language_defaults ORDER BY language ASC, action ASC');
}
// Every distinct Tomte photo ever uploaded, across personal photos (users +
// facilitators) and language-default photos — lets an admin pick an
// existing image (e.g. reuse a photo already set for someone else) instead
// of always having to upload a fresh file (Per Bot 9).
// Tomte image library (Per Bot 31) — the actual pool of photos, each one
// able to exist without being assigned to anything. filename is the R2
// key (or legacy bare filename), same convention as everywhere else
// Tomte images are stored.
function getTomteImageLibrary() {
  return queryAll('SELECT * FROM tomte_image_library ORDER BY created_at DESC');
}
function addTomteImageToLibrary(id, filename, label) {
  getDbSync().run('INSERT OR IGNORE INTO tomte_image_library (id, filename, label) VALUES (?,?,?)', [id, filename, label || null]);
  save();
}
function updateTomteImageLabel(id, label) {
  getDbSync().run('UPDATE tomte_image_library SET label=? WHERE id=?', [label || null, id]);
  save();
}
// Only removes the library entry itself — never touches any
// language/action or per-person assignment that happens to reference the
// same filename. Same "graceful, non-cascading" reasoning as deleting a
// skin: an assignment pointing at a since-removed library entry just
// keeps working off the filename it already has; it only loses the
// ability to be re-picked from the library gallery going forward.
function deleteTomteImageFromLibrary(id) {
  getDbSync().run('DELETE FROM tomte_image_library WHERE id=?', [id]);
  save();
}

// Per Bot 21 — welcome tour slides. Same shape as the tomte image
// library above (upload adds a row, nothing else) but ordered by a
// deliberate sort_order rather than recency, since this is a fixed
// walkthrough sequence, not a gallery.
function getOnboardingTourSlides() {
  return queryAll('SELECT * FROM onboarding_tour_slides ORDER BY sort_order ASC, created_at ASC');
}
function addOnboardingTourSlide(id, filename, caption) {
  const existing = getOnboardingTourSlides();
  const nextOrder = existing.length ? Math.max(...existing.map(s => s.sort_order)) + 1 : 0;
  getDbSync().run('INSERT INTO onboarding_tour_slides (id, filename, caption, sort_order) VALUES (?,?,?,?)', [id, filename, caption || null, nextOrder]);
  save();
}
function updateOnboardingTourSlideCaption(id, caption) {
  getDbSync().run('UPDATE onboarding_tour_slides SET caption=? WHERE id=?', [caption || null, id]);
  save();
}
function deleteOnboardingTourSlide(id) {
  getDbSync().run('DELETE FROM onboarding_tour_slides WHERE id=?', [id]);
  save();
}
// Takes a full ordered list of slide IDs and rewrites sort_order to match
// — simplest reorder model for a small up/down-arrow admin UI, no
// drag-and-drop library needed.
function reorderOnboardingTourSlides(orderedIds) {
  const run = getDbSync();
  (orderedIds || []).forEach((id, i) => run.run('UPDATE onboarding_tour_slides SET sort_order=? WHERE id=?', [i, id]));
  save();
}
function getAllTomteImages() {
  const rows = [
    ...queryAll(`SELECT filename FROM tomte_image_library`),
    ...queryAll(`SELECT DISTINCT tomte_image_filename AS filename FROM users WHERE tomte_image_filename IS NOT NULL`),
    ...queryAll(`SELECT DISTINCT tomte_image_filename AS filename FROM facilitators WHERE tomte_image_filename IS NOT NULL`),
    ...queryAll(`SELECT DISTINCT image_filename AS filename FROM tomte_language_defaults WHERE image_filename IS NOT NULL`),
    ...queryAll(`SELECT DISTINCT image_filename AS filename FROM tomte_skin_defaults WHERE image_filename IS NOT NULL`),
  ];
  const seen = new Set();
  const filenames = [];
  for (const r of rows) {
    if (!r.filename || seen.has(r.filename)) continue;
    seen.add(r.filename);
    filenames.push(r.filename);
  }
  return filenames;
}
// Exact match only, no fallback-to-default inside this call — the caller
// (resolveTomteImage in server.js) decides what to do if nothing's found.
function getTomteLanguageDefaultImage(language, action) {
  if (!language) return null;
  const row = queryOne('SELECT image_filename FROM tomte_language_defaults WHERE language=? AND action=?', [language, action || 'default']);
  return row ? row.image_filename : null;
}
function setTomteLanguageDefaultImage(language, action, filename) {
  getDbSync().run(
    `INSERT INTO tomte_language_defaults (language, action, image_filename, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(language, action) DO UPDATE SET image_filename=excluded.image_filename, updated_at=datetime('now')`,
    [language, action || 'default', filename]
  );
  save();
}
function deleteTomteLanguageDefault(language, action) {
  getDbSync().run('DELETE FROM tomte_language_defaults WHERE language=? AND action=?', [language, action || 'default']);
  save();
}

// ── Tomte skin defaults ──
function getTomteSkinDefaults(skinId) {
  if (skinId) return queryAll('SELECT * FROM tomte_skin_defaults WHERE skin_id=? ORDER BY language ASC, action ASC', [skinId]);
  return queryAll(`SELECT sd.*, sk.name as skin_name FROM tomte_skin_defaults sd
    LEFT JOIN skins sk ON sd.skin_id=sk.id ORDER BY sk.name ASC, sd.language ASC, sd.action ASC`);
}
function getTomteSkinDefaultImage(skinId, language, action) {
  if (!skinId || !language) return null;
  const row = queryOne('SELECT image_filename FROM tomte_skin_defaults WHERE skin_id=? AND language=? AND action=?', [skinId, language, action || 'default']);
  return row ? row.image_filename : null;
}
function setTomteSkinDefaultImage(skinId, language, action, filename) {
  getDbSync().run(
    `INSERT INTO tomte_skin_defaults (skin_id, language, action, image_filename, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(skin_id, language, action) DO UPDATE SET image_filename=excluded.image_filename, updated_at=datetime('now')`,
    [skinId, language, action || 'default', filename]
  );
  save();
}
function deleteTomteSkinDefault(skinId, language, action) {
  getDbSync().run('DELETE FROM tomte_skin_defaults WHERE skin_id=? AND language=? AND action=?', [skinId, language, action || 'default']);
  save();
}

// ── Talk signal scripts ──
function getAllSignalScripts() {
  return queryAll(`SELECT s.*, sk.name as skin_name, f.title as file_title FROM talk_signal_scripts s
    LEFT JOIN skins sk ON s.skin_id=sk.id
    LEFT JOIN library_files f ON s.file_id=f.id
    ORDER BY sk.name ASC, s.sort_order ASC, s.topic ASC`);
}
// The menu Talk actually sees every turn — topic + situation only, never
// the script text or file itself. Universal (skin_id NULL) scripts plus
// whichever skin the person is on.
function getSignalScriptMenu(skinId) {
  return queryAll(
    `SELECT id, topic, situation FROM talk_signal_scripts
     WHERE skin_id IS NULL ${skinId ? 'OR skin_id=?' : ''}
     ORDER BY topic ASC`,
    skinId ? [skinId] : []
  );
}
function getSignalScript(id) {
  return queryOne(`SELECT s.*, f.filename as file_filename, f.storage_type as file_storage_type, f.archived as file_archived
    FROM talk_signal_scripts s LEFT JOIN library_files f ON s.file_id=f.id WHERE s.id=?`, [id]);
}
// Per Bot 33z — records the R2 key of a text script's auto-generated
// audio cache, and which voice_id it was generated for. Called once, the
// first time that script is spoken in the default voice; every
// subsequent call for that script checks this instead of hitting
// ElevenLabs again. See resolveSignalMarkers() in server.js.
function setSignalScriptCachedAudio(id, cachedAudioKey, voiceId) {
  getDbSync().run(
    `UPDATE talk_signal_scripts SET cached_audio_key=?, cached_audio_voice_id=?, updated_at=datetime('now') WHERE id=?`,
    [cachedAudioKey, voiceId, id]
  );
  save();
}
function createSignalScript(id, topic, situation, skinId, kind, scriptText, fileId, sortOrder, lengthMinutes) {
  getDbSync().run(
    `INSERT INTO talk_signal_scripts (id,topic,situation,skin_id,kind,script_text,file_id,sort_order,length_minutes) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, topic, situation, skinId || null, kind || 'text', scriptText || null, fileId || null, sortOrder || 0, lengthMinutes || 1]
  );
  save();
}
function updateSignalScript(id, topic, situation, skinId, kind, scriptText, fileId, lengthMinutes) {
  // Per Bot 30 — cached_audio_key used to survive an edit untouched, so
  // fixing a script's wording (or its pacing, or anything else) kept
  // serving the stale pre-edit recording indefinitely — the next play
  // would hit the cache hit branch in resolveSignalMarkers and never
  // notice anything had changed. Clearing both columns here means an
  // edited script re-synthesizes fresh on its next play, same as a
  // brand-new script's first play. Harmless for audio-kind scripts too:
  // they never populate these columns in the first place.
  getDbSync().run(
    `UPDATE talk_signal_scripts SET topic=?, situation=?, skin_id=?, kind=?, script_text=?, file_id=?, length_minutes=?, cached_audio_key=NULL, cached_audio_voice_id=NULL, updated_at=datetime('now') WHERE id=?`,
    [topic, situation, skinId || null, kind || 'text', scriptText || null, fileId || null, lengthMinutes || 1, id]
  );
  save();
}
function deleteSignalScript(id) {
  getDbSync().run('DELETE FROM talk_signal_scripts WHERE id=?', [id]);
  save();
}

// ── Talk context documents ──
function getAllContextDocuments() {
  return queryAll(`SELECT d.id, d.skin_id, d.title, d.original_filename, d.char_count, d.created_at, sk.name as skin_name
    FROM talk_context_documents d LEFT JOIN skins sk ON d.skin_id=sk.id ORDER BY sk.name ASC, d.title ASC`);
}
// Full content, for actually building a system prompt — universal
// documents plus whichever skin the person is on.
function getContextDocumentsForSkin(skinId) {
  return queryAll(
    `SELECT title, content FROM talk_context_documents
     WHERE skin_id IS NULL ${skinId ? 'OR skin_id=?' : ''}
     ORDER BY title ASC`,
    skinId ? [skinId] : []
  );
}
function createContextDocument(id, skinId, title, content, originalFilename) {
  getDbSync().run(
    `INSERT INTO talk_context_documents (id,skin_id,title,content,original_filename,char_count) VALUES (?,?,?,?,?,?)`,
    [id, skinId || null, title, content, originalFilename || null, content.length]
  );
  save();
}
function deleteContextDocument(id) {
  getDbSync().run('DELETE FROM talk_context_documents WHERE id=?', [id]);
  save();
}

function updateUserAdminDetails(id, fields) {
  const allowed = ['name', 'email', 'phone', 'language', 'tomte_language', 'voice_id', 'tomte_image_filename', 'tomte_voice_enabled'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== undefined);
  if (!keys.length) return;
  getDbSync().run(`UPDATE users SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, [...keys.map(k => fields[k]), id]);
  save();
}

// ── Newsletter audience segments ──
// Per Bot 20 — member_tier now has a genuine fourth state below Explorer:
// -1 = a raw mailing-list import, never invited. 0 = Explorer — meaning
// they've been successfully sent their personal sign-in link (whether or
// not they've actually clicked it and set a password yet). This replaced
// the old scheme (both states crammed into member_tier=0, distinguished
// only by password_hash), which meant "move to Explorer" could never be
// observed to succeed for a self-service invite: tier 0→0 is a no-op, and
// password_hash stays NULL by design (no temp password is ever emailed —
// the recipient sets their own via the invite link). The old scheme's
// "success" was therefore silently unreachable until someone clicked,
// which isn't what a "move to Explorer" action should mean. Tier is now
// the single source of truth; has_login (password_hash presence) is a
// separate, secondary fact about whether they've actually claimed it yet.
const NEWSLETTER_AUDIENCE_CLAUSES = {
  newsletter_only: `member_tier=-1`,
  explorer:        `member_tier=0`,
  member1:         `member_tier=1`,
  member2:         `member_tier=2`,
  member3:         `member_tier=3`,
};

// One-off migration (Per Bot 20) — every contact currently sitting at the
// old ambiguous member_tier=0/no-password state is genuinely still raw
// (nobody was ever actually being counted as invited under the old
// scheme), so this is a safe, one-time reclassification down to -1. Once
// this has run, the /upgrade route's success-gated invite send is what
// moves people back up to 0 — for real, the moment the email genuinely
// sends. Idempotent: running it again after it's already run is a no-op,
// since anyone already at -1, or genuinely at 0 with a password, no
// longer matches the WHERE clause.
function migrateNewsletterOnlyToRawTier() {
  const before = queryOne(`SELECT COUNT(*) as n FROM users WHERE member_tier=0 AND password_hash IS NULL`).n;
  getDbSync().run(`UPDATE users SET member_tier=-1 WHERE member_tier=0 AND password_hash IS NULL`);
  save();
  const after = queryOne(`SELECT COUNT(*) as n FROM users WHERE member_tier=0 AND password_hash IS NULL`).n;
  return { matchedBefore: before, remainingAfter: after };
}

// One-off backfill (Per Bot 20) — for contacts who've already genuinely
// received the welcome/invite email (one or more times, under the old
// broken scheme), this moves them straight to their correct current
// state with NO email sent — re-sending a third time isn't wanted here.
// emailedAddresses: array of lowercased emails known (from email_log,
// status='sent') to have actually received it. Three outcomes per person:
//   - already has a password (they clicked and set one) but tier is
//     somehow still below Member 1 — a straggler from before this fix
//     existed, since the claim route normally promotes to Member 1 with
//     a trial the moment a password is set. Corrected the same way here:
//     Member 1, fresh 14-day trial from today.
//   - never touched (still at -1) — moved straight to Explorer (0), no
//     email involved.
//   - anything else (already Explorer or higher, or already a correctly
//     set-up Member) — left untouched.
function backfillNewsletterMigrationFromLog(emailedAddresses) {
  let movedToExplorer = 0, correctedToMember = 0, alreadyFine = 0, noLongerExists = 0;
  for (const email of emailedAddresses) {
    const user = getUserByEmail(email);
    if (!user) { noLongerExists++; continue; }
    if (user.password_hash) {
      if ((user.member_tier || 0) < 1) {
        const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        setMemberTier(user.id, 1, null, trialEndsAt, null, null);
        correctedToMember++;
      } else {
        alreadyFine++;
      }
    } else if (user.member_tier === -1) {
      setMemberTier(user.id, 0, null, null, null, null);
      movedToExplorer++;
    } else {
      alreadyFine++;
    }
  }
  return { movedToExplorer, correctedToMember, alreadyFine, noLongerExists };
}

// Per Bot 19j — one real, authoritative count per level, using the exact
// same tier definitions as everything else (NEWSLETTER_AUDIENCE_CLAUSES) —
// deliberately a fresh COUNT(*) query each time rather than trusting
// whatever happens to already be loaded/filtered client-side, so it stays
// accurate through a large bulk migration in progress.
function getUserTierCounts() {
  const out = {};
  for (const [key, clause] of Object.entries(NEWSLETTER_AUDIENCE_CLAUSES)) {
    out[key] = queryOne(`SELECT COUNT(*) as n FROM users WHERE ${clause}`).n;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Reports hub (Per Bot 20) — one function per report, each returning the
// same shape: { tiles: [{label,value}], table: {columns,rows}|null,
// note: string|null }. server.js's REPORTS registry wires these to
// GET /api/admin/reports/:id; see reports.html for how they're rendered.
// Kept in db.js alongside the queries they're built from, same pattern
// as getUserTierCounts above.
// ═══════════════════════════════════════════════════════════════════

function reportMigrations() {
  const tierCounts = getUserTierCounts();
  const sendStats = queryAll(
    `SELECT status, COUNT(*) as n FROM email_log WHERE created_at > datetime('now','-30 days') GROUP BY status`
  );
  const sent = sendStats.find(r => r.status === 'sent')?.n || 0;
  const failed = sendStats.find(r => r.status === 'failed')?.n || 0;
  return {
    tiles: [
      { label: 'Newsletter only', value: tierCounts.newsletter_only },
      { label: 'Explorer', value: tierCounts.explorer },
      { label: 'Member 1', value: tierCounts.member1 },
      { label: 'Member 2', value: tierCounts.member2 },
      { label: 'Member 3', value: tierCounts.member3 },
      { label: 'Emails sent (30d)', value: sent },
      { label: 'Emails failed (30d)', value: failed },
    ],
    table: null,
    note: null,
  };
}

function reportRegistrations() {
  const since = (days) => queryOne(
    `SELECT COUNT(*) as n FROM users WHERE registered_at > datetime('now','-${days} days')`
  ).n;
  const byDay = queryAll(
    `SELECT substr(registered_at,1,10) as day, COUNT(*) as n
     FROM users WHERE registered_at > datetime('now','-30 days')
     GROUP BY day ORDER BY day DESC`
  );
  return {
    tiles: [
      { label: 'Last 7 days', value: since(7) },
      { label: 'Last 30 days', value: since(30) },
      { label: 'Last 90 days', value: since(90) },
      { label: 'All time', value: queryOne('SELECT COUNT(*) as n FROM users').n },
    ],
    table: { columns: ['Day', 'New registrations'], rows: byDay.map(r => [r.day, r.n]) },
    note: null,
  };
}

function reportMembership() {
  const tierCounts = getUserTierCounts();
  const paying = queryOne(`SELECT COUNT(*) as n FROM users WHERE member_tier >= 1`).n;
  const withStripe = queryOne(`SELECT COUNT(*) as n FROM users WHERE stripe_subscription_id IS NOT NULL`).n;
  const onTrial = queryOne(`SELECT COUNT(*) as n FROM users WHERE member_tier >= 1 AND trial_ends_at IS NOT NULL AND trial_ends_at > datetime('now')`).n;
  const expiringSoon = queryOne(`SELECT COUNT(*) as n FROM users WHERE member_tier >= 1 AND member_expires_at IS NOT NULL AND member_expires_at BETWEEN datetime('now') AND datetime('now','+30 days')`).n;
  return {
    tiles: [
      { label: 'Paying members', value: paying },
      { label: 'With active Stripe subscription', value: withStripe },
      { label: 'Currently on trial', value: onTrial },
      { label: 'Expiring within 30 days', value: expiringSoon },
      { label: 'Member 1', value: tierCounts.member1 },
      { label: 'Member 2', value: tierCounts.member2 },
      { label: 'Member 3', value: tierCounts.member3 },
    ],
    table: null,
    note: 'Real payment amounts and revenue live in Stripe, not mirrored locally — these are account/tier counts, not a revenue ledger.',
  };
}

function reportContentEngagement() {
  const totalOpens = queryOne(`SELECT COUNT(*) as n FROM lesson_file_opens`).n;
  const opens30d = queryOne(`SELECT COUNT(*) as n FROM lesson_file_opens WHERE opened_at > datetime('now','-30 days')`).n;
  const uniqueUsers = queryOne(`SELECT COUNT(DISTINCT user_id) as n FROM lesson_file_opens`).n;
  const uniqueLessonsStarted = queryOne(`SELECT COUNT(DISTINCT lesson_id) as n FROM lesson_file_opens`).n;
  const topLessons = queryAll(
    `SELECT l.title as lesson_title, COUNT(*) as opens
     FROM lesson_file_opens o LEFT JOIN lessons l ON l.id = o.lesson_id
     GROUP BY o.lesson_id ORDER BY opens DESC LIMIT 15`
  );
  return {
    tiles: [
      { label: 'Total opens (all time)', value: totalOpens },
      { label: 'Opens (last 30 days)', value: opens30d },
      { label: 'Unique users engaging', value: uniqueUsers },
      { label: 'Distinct lessons ever opened', value: uniqueLessonsStarted },
    ],
    table: { columns: ['Lesson', 'Opens'], rows: topLessons.map(r => [r.lesson_title || '(deleted lesson)', r.opens]) },
    note: 'Covers lessons and tracks opened via the library. Does not cover the live Talk-to-Per voice feature — that isn\'t instrumented yet.',
  };
}

function reportUploads() {
  const totalFiles = queryOne(`SELECT COUNT(*) as n FROM library_files WHERE archived=0`).n;
  const totalSize = queryOne(`SELECT COALESCE(SUM(file_size),0) as n FROM library_files WHERE archived=0`).n;
  const last30d = queryOne(`SELECT COUNT(*) as n FROM library_files WHERE created_at > datetime('now','-30 days')`).n;
  const recent = queryAll(
    `SELECT title, file_type, file_size, created_at FROM library_files
     WHERE archived=0 ORDER BY created_at DESC LIMIT 20`
  );
  const fmtSize = (bytes) => bytes > 1e9 ? `${(bytes/1e9).toFixed(1)} GB` : bytes > 1e6 ? `${(bytes/1e6).toFixed(1)} MB` : `${(bytes/1e3).toFixed(0)} KB`;
  return {
    tiles: [
      { label: 'Total files', value: totalFiles },
      { label: 'Total storage', value: fmtSize(totalSize) },
      { label: 'Uploaded (last 30 days)', value: last30d },
    ],
    table: { columns: ['Title', 'Type', 'Size', 'Uploaded'], rows: recent.map(r => [r.title, r.file_type, fmtSize(r.file_size || 0), (r.created_at||'').slice(0,10)]) },
    note: null,
  };
}

// Per Bot 22 — Email Log as a proper report. The email_log table and its
// two API endpoints (list + per-row body) were already fully built and
// working, logging every real send attempt with its actual error text —
// but no admin page anywhere actually displayed them, so there was no
// way to see why a send had failed short of querying the database
// directly. Reusing the Reports hub's existing generic {tiles, table,
// note} rendering rather than building a bespoke page for this.
// Per Bot 22 — jobs view. A "job" is one send action — a newsletter/
// campaign broadcast to many people, a scheduled MOTD batch, or a single
// one-off transactional email (welcome, password reset) — grouped so the
// report reads as "12 things I sent" instead of "200 individual rows to
// scroll through". Newsletter/campaign sends already share a real
// newsletter_id, used as the grouping key directly; everything else
// (no shared batch id in the schema) falls back to kind+subject+minute,
// which naturally collapses a broadcast that went out in one burst and
// just as naturally leaves a one-off personalized email as its own
// singleton "job" — no special-casing needed for either case.
function getEmailJobs(limit) {
  return queryAll(`
    SELECT
      kind, subject, newsletter_id,
      MIN(created_at) as first_at,
      MAX(created_at) as last_at,
      COUNT(*) as total,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
      MIN(email) as sole_email,
      MIN(id) as sample_id
    FROM email_log
    GROUP BY COALESCE(newsletter_id, kind || '|' || subject || '|' || strftime('%Y-%m-%d %H:%M', created_at))
    ORDER BY first_at DESC
    LIMIT ?
  `, [limit || 100]);
}
// Per-recipient rows for one job, for the "Log" drill-down. newsletterId
// is the precise match when present; otherwise kind+subject+the exact
// first/last timestamps already returned for that job by getEmailJobs
// above narrow it back down to just that batch's own rows.
function getEmailJobRows(kind, subject, fromAt, toAt, newsletterId) {
  if (newsletterId) {
    return queryAll(`SELECT id,email,status,error,created_at,(body_html IS NOT NULL) as has_body FROM email_log WHERE newsletter_id=? ORDER BY created_at DESC`, [newsletterId]);
  }
  return queryAll(`SELECT id,email,status,error,created_at,(body_html IS NOT NULL) as has_body FROM email_log WHERE kind=? AND subject=? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC`, [kind, subject, fromAt, toAt]);
}

// ── AI generate jobs (Per Bot 22) ── DB-backed replacement for the
// in-memory Map — see the ai_generate_jobs table comment above.
function createAiGenerateJob(id, type, context) {
  getDbSync().run(`INSERT INTO ai_generate_jobs (id, type, context) VALUES (?,?,?)`, [id, type, context || null]);
  save();
}
function getAiGenerateJob(id) {
  return queryOne(`SELECT * FROM ai_generate_jobs WHERE id=?`, [id]);
}
function markAiGenerateJobDone(id, { html, imageUrl }) {
  getDbSync().run(`UPDATE ai_generate_jobs SET status='done', html=?, image_url=?, updated_at=datetime('now') WHERE id=?`, [html || null, imageUrl || null, id]);
  save();
}
function markAiGenerateJobError(id, error) {
  getDbSync().run(`UPDATE ai_generate_jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?`, [error, id]);
  save();
}
// Startup recovery — anything still 'pending' when the server boots
// means the previous process died mid-generation (a restart, a deploy,
// a crash) rather than ever actually failing or finishing. See
// recoverPendingAiGenerateJobs in server.js, called once at boot.
function getPendingAiGenerateJobs() {
  return queryAll(`SELECT id, type, context FROM ai_generate_jobs WHERE status='pending'`);
}
// Light pruning — text-generator jobs (motd/limerick/haiku/poem) are
// disposable once viewed, so old ones are cleared out after a week.
// sumie rows are NEVER pruned here — those rows are the actual history
// the Generated Images report reads from, kept indefinitely on purpose.
function pruneOldAiGenerateJobs() {
  getDbSync().run(`DELETE FROM ai_generate_jobs WHERE type != 'sumie' AND created_at < datetime('now', '-7 days')`);
  save();
}
function reportGeneratedImages() {
  const rows = queryAll(`SELECT id, image_url, context, created_at FROM ai_generate_jobs WHERE type='sumie' AND status='done' AND image_url IS NOT NULL ORDER BY created_at DESC LIMIT 200`);
  return {
    tiles: [{ label: 'Images generated', value: rows.length }],
    images: rows,
    note: rows.length ? 'Click an image to view it full size.' : 'No images generated yet.',
  };
}

function reportEmailLog() {
  const jobs = getEmailJobs(100);
  const rows = getRecentEmailLog(200, null);
  const sent = rows.filter(r => r.status === 'sent').length;
  const failed = rows.filter(r => r.status === 'failed').length;
  const pending = rows.filter(r => r.status === 'pending').length;
  const missingCreds = rows.filter(r => r.status === 'failed' && (r.error || '').includes('not configured')).length;
  return {
    tiles: [
      { label: 'Sent (last 200)', value: sent },
      { label: 'Failed', value: failed },
      { label: 'Pending', value: pending },
      { label: 'Failed — missing credentials', value: missingCreds },
    ],
    jobs,
    note: missingCreds > 0
      ? 'Some recent sends failed because SCW_SECRET_KEY or SCW_PROJECT_ID wasn\'t set at send time — check those two environment variables on Railway.'
      : (failed > 0 ? 'Open a job\'s Log to see which recipients failed and why.' : 'Showing the 100 most recent send jobs.'),
  };
}


function reportCronActivity() {
  const summary = getCronJobSummary();
  const failuresLast7d = summary.reduce((sum, j) => sum + (j.last7Days.failed || 0), 0);
  const runsToday = queryOne(`SELECT COUNT(*) as n FROM cron_log WHERE started_at > datetime('now','-1 day')`).n;
  return {
    tiles: [
      { label: 'Distinct jobs tracked', value: summary.length },
      { label: 'Runs in last 24h', value: runsToday },
      { label: 'Failures in last 7 days', value: failuresLast7d },
    ],
    table: {
      columns: ['Job', 'Last run', 'Last status', 'OK (7d)', 'Failed (7d)'],
      rows: summary.map(j => [
        j.jobName,
        j.last ? j.last.started_at : '—',
        j.last ? j.last.status : '—',
        j.last7Days.ok || 0,
        j.last7Days.failed || 0,
      ]),
    },
    note: 'Only jobs that have run at least once since this tracking was added will appear here — history starts from deploy, not retroactively.',
  };
}

function reportLogins() {
  const since = (days) => queryOne(
    `SELECT COUNT(*) as n FROM login_log WHERE logged_in_at > datetime('now','-${days} days')`
  ).n;
  const uniqueUsers7d = queryOne(
    `SELECT COUNT(DISTINCT user_id) as n FROM login_log WHERE logged_in_at > datetime('now','-7 days') AND user_id IS NOT NULL`
  ).n;
  const byDay = queryAll(
    `SELECT substr(logged_in_at,1,10) as day, COUNT(*) as n
     FROM login_log WHERE logged_in_at > datetime('now','-30 days')
     GROUP BY day ORDER BY day DESC`
  );
  const byRole = queryAll(
    `SELECT role, COUNT(*) as n FROM login_log WHERE logged_in_at > datetime('now','-30 days') GROUP BY role ORDER BY n DESC`
  );
  return {
    tiles: [
      { label: 'Logins today', value: since(1) },
      { label: 'Last 7 days', value: since(7) },
      { label: 'Last 30 days', value: since(30) },
      { label: 'Unique people (7d)', value: uniqueUsers7d },
    ],
    table: {
      columns: ['Day', 'Logins', 'By role (30d, for reference)'],
      rows: byDay.map((r, i) => [r.day, r.n, i === 0 ? byRole.map(b => `${b.role}: ${b.n}`).join(', ') : '']),
    },
    note: 'Tracking started this deploy — history builds up from here, not retroactively. Covers sign-ins, registrations, and invite-link claims (anything that hands someone a session).',
  };
}

function reportTalkUsage() {
  const totalSessions = queryOne(`SELECT COUNT(*) as n FROM talk_sessions WHERE ended_at IS NOT NULL`).n;
  const totalSeconds = queryOne(`SELECT COALESCE(SUM(duration_seconds),0) as n FROM talk_sessions WHERE ended_at IS NOT NULL`).n;
  const sessions30d = queryOne(`SELECT COUNT(*) as n FROM talk_sessions WHERE started_at > datetime('now','-30 days')`).n;
  const uniqueUsers = queryOne(`SELECT COUNT(DISTINCT user_id) as n FROM talk_sessions`).n;
  const avgMinutes = totalSessions ? Math.round((totalSeconds / totalSessions) / 60 * 10) / 10 : 0;
  const fmtHours = (secs) => `${(secs / 3600).toFixed(1)} hrs`;
  const recent = queryAll(
    `SELECT u.name as user_name, t.started_at, t.duration_seconds
     FROM talk_sessions t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.ended_at IS NOT NULL ORDER BY t.started_at DESC LIMIT 20`
  );
  return {
    tiles: [
      { label: 'Total hours (all time)', value: fmtHours(totalSeconds) },
      { label: 'Sessions (last 30 days)', value: sessions30d },
      { label: 'Unique people', value: uniqueUsers },
      { label: 'Avg session length', value: `${avgMinutes} min` },
    ],
    table: { columns: ['Person', 'Started', 'Duration'], rows: recent.map(r => [r.user_name || '(deleted user)', r.started_at, r.duration_seconds != null ? `${Math.round(r.duration_seconds/60*10)/10} min` : '—']) },
    note: 'Tracking started this deploy — history builds up from here, not retroactively.',
  };
}

// segments: array of keys from NEWSLETTER_AUDIENCE_CLAUSES, or the string/array
// containing 'all' for everyone opted in regardless of tier or login status.
function getNewsletterRecipients(segments) {
  const base = `pref_email_news=1 AND email IS NOT NULL AND archived=0`;
  const list = Array.isArray(segments) ? segments : String(segments || 'all').split(',').map(s => s.trim()).filter(Boolean);
  const cols = `id, name, email, trial_ends_at, (password_hash IS NOT NULL) as has_login`;

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
// needing a fresh Stripe API call per check.
//
// Per Bot 21 — deliberately no longer requires stripe_subscription_id.
// The thing that should drive a renewal reminder is having a real
// paid-until date at all, not how that date got there — a manually
// carried-over legacy subscriber (see the manual /expiry override) needs
// exactly the same "your membership renews soon" nudge a live Stripe
// subscriber gets. Source (Stripe vs manual vs PayPal) is a reporting
// question, answered elsewhere, never a behavioural gate here.
function getUpcomingRenewals(daysBefore) {
  return queryAll(
    `SELECT id, name, email, phone, pref_email_renewal, pref_sms_renewal, member_expires_at, member_tier
     FROM users
     WHERE archived=0
       AND (pref_email_renewal=1 OR pref_sms_renewal=1)
       AND member_expires_at IS NOT NULL
       AND date(member_expires_at) = date('now', '+' || ? || ' days')
       AND (renewal_reminder_sent_for IS NULL OR renewal_reminder_sent_for != member_expires_at)`,
    [daysBefore]
  );
}

// Providing a DOB at all is the consent to send a birthday message — there's
// no separate pref flag to check here, unlike reminders/renewal/motd. Year
// is deliberately not part of the match (or stored anywhere) — month/day
// only. Dedupes on last_birthday_sent_year so a cron re-run on the same day
// can't send twice, without needing to track a specific date like renewals do.
function getUsersWithBirthdayToday(month, day) {
  return queryAll(
    `SELECT id, name, email, phone FROM users
     WHERE archived=0
       AND dob_month=? AND dob_day=?
       AND (last_birthday_sent_year IS NULL OR last_birthday_sent_year != CAST(strftime('%Y','now') AS INTEGER))`,
    [month, day]
  );
}
function markBirthdaySent(userId) {
  getDbSync().run(`UPDATE users SET last_birthday_sent_year=CAST(strftime('%Y','now') AS INTEGER) WHERE id=?`, [userId]);
  save();
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
const TRIAL_EMAIL_FLAGS = ['trial_email_day3_sent', 'trial_email_day7_sent', 'trial_email_day10_sent', 'trial_email_day14_sent'];

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

// ── Skins (Per Bot 20) ──
// slug is validated at the API layer (server.js) before it ever reaches
// here — lowercase, hyphenated, URL-safe, since it's used directly in
// paths like /login/:slug. background_images is stored as a JSON array
// (SQLite has no native array type); parsed back out here so callers
// always get a real JS array, never a raw string to remember to parse.
function getSkin(slug) {
  const row = queryOne('SELECT * FROM skins WHERE id=?', [slug]);
  if (!row) return null;
  let images = [];
  try { images = JSON.parse(row.background_images || '[]'); } catch(e) {}
  return { ...row, background_images: images };
}
function getAllSkins() {
  return queryAll('SELECT * FROM skins ORDER BY created_at DESC').map(row => {
    let images = [];
    try { images = JSON.parse(row.background_images || '[]'); } catch(e) {}
    return { ...row, background_images: images };
  });
}
function createSkin(slug, fields) {
  getDbSync().run(
    `INSERT INTO skins (id, name, logo_url, favicon_url, primary_color, contact_name, contact_email, background_images) VALUES (?,?,?,?,?,?,?,?)`,
    [slug, fields.name || slug, fields.logo_url || null, fields.favicon_url || null, fields.primary_color || null,
     fields.contact_name || null, fields.contact_email || null, JSON.stringify(fields.background_images || [])]
  );
  save();
  return getSkin(slug);
}
function updateSkin(slug, fields) {
  const allowed = ['name','logo_url','favicon_url','primary_color','contact_name','contact_email'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k));
  const params = sets.map(k => fields[k]);
  if (fields.background_images !== undefined) { sets.push('background_images'); params.push(JSON.stringify(fields.background_images)); }
  if (!sets.length) return getSkin(slug);
  getDbSync().run(`UPDATE skins SET ${sets.map(k=>`${k}=?`).join(',')} WHERE id=?`, [...params, slug]);
  save();
  return getSkin(slug);
}
function deleteSkin(slug) {
  // Never cascades into accounts already tagged with this skin — they
  // simply fall back to standard branding (skin_id pointing at a row that
  // no longer exists behaves exactly like skin_id being NULL, since every
  // lookup already handles "not found" as "use the default").
  getDbSync().run('DELETE FROM skins WHERE id=?', [slug]);
  save();
}
function setUserSkin(userId, skinSlug) {
  getDbSync().run('UPDATE users SET skin_id=? WHERE id=?', [skinSlug || null, userId]);
  save();
}

function updateAppConfig(fields) {
  const allowed = ['brand_name','tagline','primary_color','logo_url','contact_email','currency','legal_entity_name','legal_jurisdiction','payments_enabled','setup_completed','reminder_days','reminder_subject','reminder_body','reminder_sms_body','reminder_format','newsletter_footer','renewal_reminder_days','renewal_reminder_subject','renewal_reminder_body','renewal_reminder_sms_body','renewal_reminder_format','test_email','test_phone','birthday_email_subject','birthday_email_body','birthday_sms_body','birthday_email_format','tomte_nl_image_filename','app_name','favicon_url','use_calm_landing','talk_persona_name','talk_persona_photo_url','allow_custom_voice','default_showcase_file_id','trial_day3_subject','trial_day3_body','trial_day3_format','trial_day7_subject','trial_day7_body','trial_day7_format','trial_day10_subject','trial_day10_body','trial_day10_format','trial_day14_subject','trial_day14_body','trial_day14_format','savers_cancel_day0_subject','savers_cancel_day0_body','savers_cancel_day0_format','savers_cancel_grace0_subject','savers_cancel_grace0_body','savers_cancel_grace0_format','savers_cancel_mid_subject','savers_cancel_mid_body','savers_cancel_mid_format','savers_cancel_final_subject','savers_cancel_final_body','savers_cancel_final_format','savers_failure_day0_subject','savers_failure_day0_body','savers_failure_day0_format','savers_failure_mid_subject','savers_failure_mid_body','savers_failure_mid_format','savers_failure_final_subject','savers_failure_final_body','savers_failure_final_format','newsletter_welcome_subject','newsletter_welcome_body','newsletter_welcome_format'];
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

// Per Bot 15h — skinId is optional throughout. When given, a skin-specific
// published document under this slug wins; if that skin has never had its
// own version, this falls back to the global (skin_id IS NULL) one, so a
// new skin never shows "document not found" just for lacking its own copy
// yet. Version numbers are scoped per (slug, skinId) — a skin's own
// "privacy-policy" versions independently of the global one under the
// same slug, exactly as if it were its own document with a shared name.
function getLegalDocument(slug, skinId) {
  if (skinId) {
    const scoped = queryOne(
      `SELECT * FROM legal_documents WHERE slug=? AND skin_id=? AND published=1 ORDER BY version DESC LIMIT 1`,
      [slug, skinId]
    );
    if (scoped) return scoped;
  }
  return queryOne(
    `SELECT * FROM legal_documents WHERE slug=? AND skin_id IS NULL AND published=1 ORDER BY version DESC LIMIT 1`,
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

function getLegalDocumentHistory(slug, skinId) {
  return queryAll(
    skinId ? 'SELECT * FROM legal_documents WHERE slug=? AND skin_id=? ORDER BY version DESC'
           : 'SELECT * FROM legal_documents WHERE slug=? AND skin_id IS NULL ORDER BY version DESC',
    skinId ? [slug, skinId] : [slug]
  );
}

// Per Bot 15h — skinId here means "documents for this skin, falling back
// to the global set for any slug this skin has no override for" — the
// same merge logic as getLegalDocument, just for the whole list at once
// (used by the public /legal index page).
function getAllCurrentLegalDocuments(skinId) {
  const global = queryAll(
    `SELECT ld.* FROM legal_documents ld
     INNER JOIN (
       SELECT slug, MAX(version) as max_version
       FROM legal_documents WHERE published=1 AND skin_id IS NULL
       GROUP BY slug
     ) latest ON ld.slug=latest.slug AND ld.version=latest.max_version AND ld.skin_id IS NULL
     ORDER BY ld.title ASC`
  );
  if (!skinId) return global;
  const scoped = queryAll(
    `SELECT ld.* FROM legal_documents ld
     INNER JOIN (
       SELECT slug, MAX(version) as max_version
       FROM legal_documents WHERE published=1 AND skin_id=?
       GROUP BY slug
     ) latest ON ld.slug=latest.slug AND ld.version=latest.max_version AND ld.skin_id=?
     ORDER BY ld.title ASC`, [skinId, skinId]
  );
  const scopedSlugs = new Set(scoped.map(d => d.slug));
  return [...scoped, ...global.filter(d => !scopedSlugs.has(d.slug))].sort((a,b) => a.title.localeCompare(b.title));
}

function getAllLegalDocumentsAdmin() {
  return queryAll(
    `SELECT ld.*, sk.name as skin_name,
      (SELECT COUNT(*) FROM user_legal_consents WHERE slug=ld.slug AND version=ld.version) as consent_count
     FROM legal_documents ld
     LEFT JOIN skins sk ON ld.skin_id=sk.id
     ORDER BY ld.slug ASC, ld.skin_id IS NULL DESC, ld.version DESC`
  );
}

function createLegalDocument(id, slug, title, content, requiresConsent, skinId) {
  const current = skinId
    ? queryOne('SELECT MAX(version) as v FROM legal_documents WHERE slug=? AND skin_id=?', [slug, skinId])
    : queryOne('SELECT MAX(version) as v FROM legal_documents WHERE slug=? AND skin_id IS NULL', [slug]);
  const version = (current?.v || 0) + 1;
  db.run(
    `INSERT INTO legal_documents (id,slug,title,version,content,requires_consent,published,skin_id)
     VALUES (?,?,?,?,?,?,0,?)`,
    [id, slug, title, version, content, requiresConsent ? 1 : 0, skinId || null]
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
  getAppConfig, updateAppConfig, isSetupComplete, regenerateLegalDocumentsFromConfig, getUserTierCounts,
  migrateNewsletterOnlyToRawTier, backfillNewsletterMigrationFromLog,
  logCronRun, getRecentCronRuns, getCronJobSummary, pruneCronLog,
  logLogin, pruneLoginLog,
  startTalkSession, endTalkSession,
  reportMigrations, reportRegistrations, reportMembership, reportContentEngagement, reportUploads, reportCronActivity, reportLogins, reportTalkUsage, reportEmailLog,
  getDb, save,
  // Facilitators
  createFacilitator, getFacilitatorByEmail, getFacilitatorById,
  getFacilitatorsForClient, isFacilitatorAssignedToClient, addClientFacilitator, removeClientFacilitator,
  getSkin, getAllSkins, createSkin, updateSkin, deleteSkin, setUserSkin,
  setReferredBy, markReferralRewarded, createReferralEvent, getReferralEventsForReferrer,
  getUnseenReferralCount, markReferralEventsSeen,
  getAllAdmins, getAllFacilitators, updateFacilitatorPassword, updateFacilitatorDetails, updateFacilitatorPhone,
  setUserResetToken, getUserByResetToken, clearUserResetToken, adminResetUserPassword,
  setFacilitatorResetToken, getFacilitatorByResetToken, clearFacilitatorResetToken, adminResetFacilitatorPassword,
  addMessage, getMessageThread, getSessionThreadsForClient, getMessageById, editMessage, deleteMessage,
  markThreadRead, getUnreadMessageCountForFacilitator, getUnreadMessageCountForClient,
  archiveFacilitator, unarchiveFacilitator, deleteFacilitator,
  // Categories
  getAllCategories, getTopCategories, getSubcategories,
  createCategory, renameCategory, deleteCategory,
  getAllContentKinds, createContentKind, renameContentKind, deleteContentKind,
  // Library
  addLibraryFile, getLibraryFile, getLibraryFiles, updateLibraryFile, getAllTextHtmlFiles, findDuplicateLibraryFiles, scanDescriptionsForDomainRefs,
  renameLibraryFile, deleteLibraryFile, archiveLibraryFile, getFileUsage,
  addFileTag, removeFileTag, getFileTags, getAllTags, getFilesByTag, getTtsCacheEntry, setTtsCacheEntry,
  getTranslatedTemplate, saveTranslatedTemplate,
  getBreathingPatterns, getBreathingPattern, getBreathingPatternMenu, createBreathingPattern, updateBreathingPattern, deleteBreathingPattern,
  // Sectioned knowledge (Per Bot 15p)
  getKnowledgeLevels, addKnowledgeLevel, updateKnowledgeLevel, deleteKnowledgeLevel,
  createKnowledgeDocument, getKnowledgeDocuments, getKnowledgeDocument, archiveKnowledgeDocument, deleteKnowledgeDocument,
  createKnowledgeTopic, updateKnowledgeTopic, deleteKnowledgeTopic, getKnowledgeMenu, getKnowledgeTopic,
  getKnowledgeTopicsForDocument, getAllKnowledgeTopicsAdmin,
  setKnowledgeTopicContent, getKnowledgeTopicContent, getKnowledgeTopicAllContent,
  linkKnowledgeTopics, unlinkKnowledgeTopics, getLinkedKnowledgeTopics,
  // Courses
  createCourse, updateCourse, getCourse, getAllCourses, deleteCourse, setCourseFeatured, setCourseSortOrder, getFeaturedCourses, getPublicOpenCourses, getFeaturedLibraryFiles, getRecentStandaloneFiles, getTalkPractices,
  setCourseSequenceFlags,
  backfillCourseSequenceDefaults,
  setCourseTierGating,
  // Lessons
  createLesson, updateLesson, getLessonsForCourse, getLesson, deleteLesson,
  setLessonFileSequenceOverride,
  // Lesson file refs
  addLessonFileRef, getFilesForLesson, removeLessonFileRef, moveLessonFileRef, reorderLessonFileRefs, setLessonFileRefMandatory,
  setLessonFileRefFreePreview, getFreePreviewRef,
  setAllFileRefsMandatoryForLesson, setAllFileRefsMandatoryForCourse,
  // Lesson file opens / progress (Per Bot 13)
  logFileOpen, getOpenedFileIds, getLessonFileProgress,
  // Course instances
  createCourseInstance, getCourseInstance, getInstancesForCourse, getAllCourseInstances,
  updateCourseInstance, deleteCourseInstance,
  // Enrolments
  createEnrolment, getEnrolment, getEnrolmentForUserAndInstance, getEnrolmentsForUser, isStaffEmail,
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
  updateArc, archiveClient, updateClientPassword, updateClientEmail, updateClientProgramme, updateClientClinicalContext, getSignalRotation,
  updateClientDetails, updateUserName, deleteClient,
  // Membership
  setMemberTier, setMemberExpiry, upgradeToMember, downgradeToExplorer, markAsClient, markAsSystemClient,
  countActiveTrials, extendAllActiveTrials, countLapsedTrialUsers, regrantTrialForLapsedUsers,
  // Preferences
  updateUserPreferences, userFlagsFromRecord,
  // Sessions
  addSession, getSessionsForClient, getClientSessionsForClient, hasEverUsedTalk,
  hasSeenTomteTip, markTomteTipSeen,
  addJournalEntry, getJournalEntriesForClient, getSharedJournalEntriesForFacilitator, getJournalEntriesForBot, deleteJournalEntry,
  getSessionById, getSessionsForFacilitatorReview, updateSessionDraft, releaseSession, unreleaseSession,
  // Practices
  addPractice, getPracticesForClient, getPractice, toggleFavourite, incrementUseCount, deletePractice, deleteOwnPractice,
  shareContentToUsers, getSharedFilesForUser, removeContentShare, getLatestPracticeArrivalAt, unassignFileFromClient, getEmailJobRows,
  createAiGenerateJob, getAiGenerateJob, markAiGenerateJobDone, markAiGenerateJobError, getPendingAiGenerateJobs, pruneOldAiGenerateJobs, reportGeneratedImages,
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
  checkTrialExpiry, sweepExpiredMemberships,
  // Content visibility
  getLibraryFilesForUser, getAllLibraryFilesWithAccess, canAccessFile, fileHasFreePreview, getFacilitatorResources,
  userMaxLevel, LEVEL_RANK, suppressAccessiblePreviews,
  // Invitations
  createInvitation, getInvitationByToken, acceptInvitation, getInvitationsForFacilitator,
  // Guest leads
  addGuestLead, getGuestLeads, deleteGuestLead, getGuestLead, getUnseenGuestLeadCount, markGuestLeadsSeen,
  createFacilitatorRequest, getPendingFacilitatorRequestByEmail, getFacilitatorRequests,
  getFacilitatorRequestById, setFacilitatorRequestStatus, deleteFacilitatorRequest,
  getLatestFacilitatorRequestForUser, getPendingFacilitatorRequestCount,
  // Membership plans
  getMembershipPlans, updateMembershipPlan,
  // Offers (Per Bot 17)
  getAllOffers, getOffer, getOfferByCode, getDefaultOffer, isOfferCurrentlyValid, resolveShowcaseFile,
  logPromoHit, getFunnelStats,
  createOffer, updateOffer, deleteOffer, setSignupOfferId, setSignupSource,
  getAllCampaigns, getCampaign, createCampaign, updateCampaign, setCampaignStatus, deleteCampaign,
  getCampaignSteps, getCampaignStep, addCampaignStep, updateCampaignStep, deleteCampaignStep,
  setCampaignStepResult, getDueCampaignEmailSteps,
  startSaversCancellation, startSaversGrace, clearSaversState, markSaversEmailSent,
  getUsersDueForSaversEmail, getUsersDueForSaversDowngrade,
  // Social posts (Per Bot 17 phase 4)
  addSocialPost, getAllSocialPosts, getSocialPost, deleteSocialPost,
  // Signal lines (Per Bot 17 phase 6)
  getAllSignalLines, getActiveSignalLines, getRandomActiveSignalLine, createSignalLine, updateSignalLine, deleteSignalLine,
  // MOTD
  addMotd, getMotd, getAllMotd, approveMotd, updateMotd, deleteMotd,
  markMotdSent, countApprovedMotd, getNextMotdToSend, getMotdRecipients,
  getActiveMotdForDate, getStaleActiveMotd, activateMotd, getMotdNotificationCandidates, markMotdSentForUser,
  addNewsletter, getNewsletter, getAllNewsletters, updateNewsletter, deleteNewsletterDraft, markNewsletterSent, updateNewsletterStatus, getNewsletterRecipients,
  getAllScheduledMessages, getScheduledMessage, createScheduledMessage, updateScheduledMessage, deleteScheduledMessage, markScheduledMessageSent, scheduledMessageMatchesDate,
  logEmailPending, logEmailResult, updateEmailLogResult, getEmailLogForNewsletter, getEmailLogCountsForNewsletter, getRecentEmailLog, getEmailLogById, clearEmailLogForNewsletter, archiveOldEmailBodies,
  setTomteName, setTomteImage, setTomteVoiceEnabled, getTomteSettings, updateUserAdminDetails,
  createCall, getCall, getRingingCallForClient, updateCallStatus, setCallConsent, setCallRecording,
  setCallTranscript, setCallShared, getCallsForFacilitatorClient, getAllCallsForClient, getSharedCallsForClient,
  getTomteLanguageDefaults, getTomteLanguageDefaultImage, setTomteLanguageDefaultImage, deleteTomteLanguageDefault, getAllTomteImages,
  getTomteSkinDefaults, getTomteSkinDefaultImage, setTomteSkinDefaultImage, deleteTomteSkinDefault,
  getAllSignalScripts, getSignalScriptMenu, getSignalScript, createSignalScript, updateSignalScript, deleteSignalScript, setSignalScriptCachedAudio,
  getAllContextDocuments, getContextDocumentsForSkin, createContextDocument, deleteContextDocument,
  getTomteImageLibrary, addTomteImageToLibrary, updateTomteImageLabel, deleteTomteImageFromLibrary,
  getOnboardingTourSlides, addOnboardingTourSlide, updateOnboardingTourSlideCaption, deleteOnboardingTourSlide, reorderOnboardingTourSlides,
  // Reminders
  getInactiveUsers,
  markReminderSent,
  getUpcomingRenewals,
  getUsersWithBirthdayToday,
  markBirthdaySent,
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
