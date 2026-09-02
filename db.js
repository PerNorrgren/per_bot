// ── db.js — Mare companion app ──
// sql.js (in-process SQLite), same pattern as per_bot: load the file into
// memory on boot, run everything against the in-memory db, export+write
// the whole file back to disk after every write. Fully separate database
// from per_bot — no shared users, no shared tables. Deployed as its own
// Railway service, its own Dockerfile, its own deploy.sh.

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'db', 'mare.db');
let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  // ── App configuration — single row, brand identity for this app ──
  db.run(`CREATE TABLE IF NOT EXISTS app_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    brand_name TEXT NOT NULL DEFAULT 'Mare',
    tagline TEXT,
    primary_color TEXT,
    logo_url TEXT,
    contact_email TEXT,
    currency TEXT NOT NULL DEFAULT 'gbp',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`INSERT OR IGNORE INTO app_config (id) VALUES ('default')`);

  // ── Parents — the real accounts. Children are profiles underneath, not
  // separate logins (no password for a child to forget). ──
  db.run(`CREATE TABLE IF NOT EXISTS parents (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    birthday_month INTEGER, -- month/day only, no year — same privacy-conscious pattern as per_bot's birthday-message feature, applied consistently here for parents too
    birthday_day INTEGER,
    email_opt_in INTEGER NOT NULL DEFAULT 0,
    email_frequency TEXT DEFAULT 'weekly', -- 'daily' | 'weekly'
    preferred_locale TEXT NOT NULL DEFAULT 'en', -- for future locale-aware emails/UI persistence
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run(`ALTER TABLE parents ADD COLUMN birthday_month INTEGER`); } catch {}
  try { db.run(`ALTER TABLE parents ADD COLUMN birthday_day INTEGER`); } catch {}

  // ── Children — a profile can belong to more than one parent/carer.
  // parent_id stays as the PRIMARY parent (whoever created the profile —
  // the one who can remove carers or delete the child outright); the
  // child_carers table below adds any additional linked parents. Every
  // ownership check in server.js goes through canParentAccessChild(),
  // which checks both, so nothing downstream (Talk sessions, etc.) needs
  // to know or care which kind of access a given parent has. ──
  db.run(`CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL, -- primary parent — see comment above
    name TEXT NOT NULL,
    avatar_key TEXT,
    age_band TEXT, -- '6-8' | '9-11' | '12-15' — nullable (not set at signup); Talk falls back to the middle register until a parent sets this, rather than guessing
    birthday_month INTEGER, -- month/day only, no year — deliberately not full DOB for a child's profile
    birthday_day INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run(`ALTER TABLE children ADD COLUMN age_band TEXT`); } catch {}
  try { db.run(`ALTER TABLE children ADD COLUMN birthday_month INTEGER`); } catch {}
  try { db.run(`ALTER TABLE children ADD COLUMN birthday_day INTEGER`); } catch {}

  // ── Additional parents/carers linked to a child, beyond the primary
  // parent_id on the children row itself. Per's requirement: a child can
  // have N parents/carers. Adding a carer requires that person to
  // already have a Mare parent account (looked up by email) — inviting
  // someone who doesn't have an account yet is a real feature (an email
  // invite flow) deliberately left for later rather than half-built
  // here. Only the primary parent can remove a carer or delete the
  // child — see the requireCanManageChild vs requireCanAccessChild
  // distinction in server.js. ──
  db.run(`CREATE TABLE IF NOT EXISTS child_carers (
    id TEXT PRIMARY KEY,
    child_id TEXT NOT NULL,
    parent_id TEXT NOT NULL, -- the carer's own parent account id
    relationship TEXT, -- optional free-text label, e.g. 'Dad', 'Grandma', 'Childminder'
    added_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Addresses — a generic, owner-agnostic table rather than fixed
  // columns on parents/children, because Per's requirement is N
  // addresses per parent AND N addresses per child (e.g. two homes after
  // a separation, a grandparent's address for gift shipping). owner_type
  // + owner_id follows the same app-level-ownership-check convention
  // already used everywhere else in this file (no real FOREIGN KEY
  // constraints anywhere in this schema — ownership is always verified
  // in server.js, not enforced by SQLite). This is an address BOOK —
  // wiring a chosen address into actual Stripe checkout is a separate,
  // later task, not done here. ──
  db.run(`CREATE TABLE IF NOT EXISTS addresses (
    id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL, -- 'parent' | 'child'
    owner_id TEXT NOT NULL,
    label TEXT, -- optional, e.g. 'Home', 'Mum's house'
    recipient_name TEXT,
    line1 TEXT NOT NULL,
    line2 TEXT,
    city TEXT NOT NULL,
    postcode TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'GB',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Teachers — separate top-level account type, own login. Not tied to
  // a parent record. school/class fields are optional now, ready for
  // school-scoping later (the Patricia/RAAK network makes this plausible). ──
  db.run(`CREATE TABLE IF NOT EXISTS teachers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    school TEXT,
    preferred_locale TEXT NOT NULL DEFAULT 'en',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Admin — Per's own login, plus 'support' as a second staff role on
  // the same table (same login flow, same accounts list) rather than a
  // separate table — support is admin-lite (content + helping parents/
  // teachers), not a different kind of account. role column distinguishes
  // 'admin' (full, including products/payments) from 'support' (everything
  // except products/payments — enforced route-by-route in server.js). ──
  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin', -- 'admin' | 'support'
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run(`ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`); } catch {}

  // ── Teacher resources — documents/tools/links shown in the teacher hub
  // (public/teacher.html once logged in). Admin and support can both
  // manage this (it's content, not payments). ──
  db.run(`CREATE TABLE IF NOT EXISTS teacher_resources (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'document', -- 'document' | 'tool' | 'link'
    file_key TEXT, -- R2 key, for category='document'
    external_url TEXT, -- for category='tool' | 'link'
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── App pages directory — admin's "Pages" tab. This app has no
  // page-routing framework to introspect (every page is a static file
  // served by express.static — there's no router to walk), so rather
  // than a fragile auto-crawl this is a maintained directory: seeded
  // with the pages known at build time, kept current by whoever's
  // managing content (admin or support). Covers both internal app pages
  // (url is a path like '/teacher.html') and external references (url is
  // a full https:// link — Railway dashboard, GitHub repo, the live
  // per_bot site, etc.) in one list rather than two separate tables,
  // since from the admin's point of view they're both just "places this
  // project lives". ──
  db.run(`CREATE TABLE IF NOT EXISTS app_pages (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'internal', -- 'internal' | 'external'
    status TEXT NOT NULL DEFAULT 'live', -- 'live' | 'planned' | 'stub'
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Seed once, keyed by url so re-running never duplicates rows and
  // never overwrites anything an admin has since edited or deleted.
  const PAGE_SEED = [
    { label: 'Story Corner (splash)', url: '/', kind: 'internal', status: 'live', description: "The public landing page — book shelf, Club Mare and Shop tiles.", sortOrder: 0 },
    { label: 'Sign in / create account (Parent)', url: '/login.html', kind: 'internal', status: 'live', description: 'Parent-only login + signup. Teachers use their own separate page (see below).', sortOrder: 10 },
    { label: 'Teacher sign in / create account', url: '/teacher-login.html', kind: 'internal', status: 'live', description: 'Dedicated teacher login + signup, separate from the parent page.', sortOrder: 15 },
    { label: 'For Teachers', url: '/teacher.html', kind: 'internal', status: 'live', description: 'Public teacher splash when signed out; resources + What\u2019s New hub when signed in as a teacher.', sortOrder: 20 },
    { label: 'Talk to Mare', url: '/talk.html', kind: 'internal', status: 'live', description: 'The real experience: child picker, then a full-screen glowing-orb conversation with Mare. Reachable from the Story Corner\u2019s Talk to Mare tile.', sortOrder: 25 },
    { label: 'Admin', url: '/admin.html', kind: 'internal', status: 'live', description: 'Staff login and dashboard (this page).', sortOrder: 30 },
    { label: 'Reader', url: '/reader.html', kind: 'internal', status: 'planned', description: 'The audio-follows-text reading experience — not built yet, the core still-open piece.', sortOrder: 40 },
    { label: 'Club Mare', url: '/club-mare.html', kind: 'internal', status: 'planned', description: 'Member posts, gated by tier.', sortOrder: 50 },
    { label: 'Merchandise', url: '/merchandise.html', kind: 'internal', status: 'planned', description: 'Shop browsing + Stripe checkout.', sortOrder: 60 },
    { label: 'Account', url: '/account.html', kind: 'internal', status: 'live', description: 'Parent account settings: profile, birthday, email preferences, addresses, children (with multi-parent/carer support), password, account deletion.', sortOrder: 70 },
    { label: 'GitHub repo', url: 'https://github.com/PerNorrgren/mare_app', kind: 'external', status: 'live', description: 'Source code.', sortOrder: 100 },
    { label: 'Railway (production)', url: 'https://mareapp-production.up.railway.app', kind: 'external', status: 'live', description: 'Live deployment.', sortOrder: 110 },
  ];
  for (const p of PAGE_SEED) {
    if (!get(`SELECT id FROM app_pages WHERE url = ?`, [p.url])) {
      run(`INSERT INTO app_pages (id, label, url, kind, status, description, sort_order) VALUES (?,?,?,?,?,?,?)`,
        [uuid(), p.label, p.url, p.kind, p.status, p.description, p.sortOrder]);
    }
  }

  // ── Talk to Mare — a live conversation between a child and Mare.
  // Ported architecture from per_bot's Talk feature: a raw Deepgram STT
  // proxy over its own websocket (the same '/listen — Deepgram STT proxy
  // (Mare Bot architecture)' pattern per_bot itself borrowed from the
  // original standalone Mare Bot prototype), plain HTTP for the Claude
  // reply, and the existing /api/speak endpoint for ElevenLabs TTS — no
  // new TTS plumbing needed since that already exists in this app.
  //
  // What's deliberately NOT ported from per_bot's Talk: the arc/history
  // summarisation pipeline (GENERATE_SESSION_SUMMARY, arc updates across
  // sessions) and the get_knowledge tool-use knowledge base. Those exist
  // in per_bot because Talk there supports an ongoing clinical
  // relationship across months. Talk to Mare, for now, is a single
  // conversation with no memory carried between sessions — a much
  // smaller, safer surface for a first version with a child audience.
  // Revisit that decision explicitly later if session-to-session memory
  // is wanted; don't add it by extending this table's meaning quietly.
  //
  // Full transcript is NOT persisted to the database in this pass either
  // — only session metadata (who, when, how long) is stored here; the
  // actual back-and-forth lives in memory for the life of the
  // conversation only (see server.js talkSessions Map) and is gone once
  // it ends. Whether to store full transcripts for parent review or
  // safety audit is a real data-retention decision for a children's
  // product, not something to default into silently — flagging this
  // explicitly rather than deciding it here.
  db.run(`CREATE TABLE IF NOT EXISTS talk_sessions (
    id TEXT PRIMARY KEY,
    child_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en',
    turn_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    last_activity_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT
  )`);

  // ── Social links — Mare's own account URLs (Facebook, Instagram,
  // etc.), shown in the public site footer and manageable from the
  // admin Marketing tab. Separate from the app_pages directory
  // deliberately: app_pages is an internal reference list for staff,
  // this is public-facing brand presence — different audience, and
  // conflating the two would bury the socials admin actually wants
  // prominent inside a generic "pages" list. ──
  db.run(`CREATE TABLE IF NOT EXISTS social_links (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL, -- 'facebook' | 'instagram' | 'tiktok' | 'linkedin' | 'threads' | 'x' | 'youtube' | 'other'
    url TEXT NOT NULL,
    label TEXT, -- optional override, e.g. '@marethestorycorner' — falls back to the platform name if blank
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Marketing post history — every "reformat for social" generation,
  // kept so admin/support can find something they generated before
  // rather than regenerating from scratch. Mirrors per_bot's own
  // message-builder History modal. results_json shape:
  // { platform: postText, ... } — same keys as MARKETING_PLATFORM_KEYS. ──
  db.run(`CREATE TABLE IF NOT EXISTS marketing_posts (
    id TEXT PRIMARY KEY,
    source_text TEXT NOT NULL,
    platforms_json TEXT NOT NULL,
    results_json TEXT NOT NULL,
    included_cta INTEGER NOT NULL DEFAULT 0,
    created_by_id TEXT,
    created_by_role TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Books, chapters, scenes ──
  // A "scene" is one image (chapter opening or chapter ending) plus its
  // own narration audio, its own sentence timings, its own hotspots, and
  // its own audio cues (music bed / SFX). This is the atomic unit the
  // reader steps through.
  db.run(`CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    group_slug TEXT NOT NULL DEFAULT '', -- links locale variants of the same book together (e.g. 'mare' for both mare/mare-nl)
    locale TEXT NOT NULL DEFAULT 'en', -- 'en' | 'nl' — each locale is its own full book row: chapters/scenes/art genuinely differ per language, not just swapped text (Dutch images have Dutch in-image text)
    description TEXT,
    splash_icon_key TEXT, -- R2 key, large splash-page icon
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'opening', -- 'opening' | 'ending' — more kinds later if needed
    image_key TEXT, -- R2 key
    narration_audio_key TEXT, -- R2 key, the raw uploaded narration for this scene
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Sentence-level sync data, produced from Deepgram word timestamps and
  // reviewable/nudgeable in admin before publishing.
  db.run(`CREATE TABLE IF NOT EXISTS narration_sentences (
    id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL,
    text TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);

  // Hotspots — normalized 0-1 coordinates (not pixels) so placement holds
  // up across screen sizes. type/payload_json kept generic on purpose:
  // more hotspot behaviours are coming (animation, sound-effect, popup),
  // and a generic payload avoids adding a new column/table per new type.
  db.run(`CREATE TABLE IF NOT EXISTS hotspots (
    id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL,
    x REAL NOT NULL, -- 0.0-1.0, normalized to image width
    y REAL NOT NULL, -- 0.0-1.0, normalized to image height
    w REAL NOT NULL DEFAULT 0.08,
    h REAL NOT NULL DEFAULT 0.08,
    type TEXT NOT NULL, -- 'popup' | 'animation' | 'sound' | more later
    payload_json TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  )`);

  // Music beds and point-in-time sound effects, layered under narration.
  // kind='music' loops as a bed (volume typically ducked under narration
  // client-side); kind='sfx' fires once at start_ms (dog bark, car,
  // classroom murmur, etc.).
  db.run(`CREATE TABLE IF NOT EXISTS audio_cues (
    id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL,
    kind TEXT NOT NULL, -- 'music' | 'sfx'
    audio_key TEXT NOT NULL, -- R2 key
    start_ms INTEGER NOT NULL DEFAULT 0,
    volume REAL NOT NULL DEFAULT 1.0,
    loop_audio INTEGER NOT NULL DEFAULT 0,
    label TEXT
  )`);

  // ── Activities — quizzes, puzzles, number games, mind games. type +
  // payload_json kept generic for the same reason as hotspots: more
  // activity types are coming and shouldn't need new tables each time.
  // chapter_id nullable — an activity can live loose in the Mare hub
  // rather than being tied to a specific chapter. ──
  db.run(`CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    book_id TEXT,
    chapter_id TEXT,
    type TEXT NOT NULL, -- 'quiz' | 'puzzle' | 'number_game' | more later
    title TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Club Mare — membership tiers. Per's convention: never start
  // numbering at 0. tier 1 = free member, tier 2 = paid member. A parent
  // with no row here at all is simply not a member. ──
  db.run(`CREATE TABLE IF NOT EXISTS club_mare_members (
    id TEXT PRIMARY KEY,
    parent_id TEXT UNIQUE NOT NULL,
    tier INTEGER NOT NULL DEFAULT 1, -- 1 = free, 2 = paid
    stripe_subscription_id TEXT,
    joined_at TEXT DEFAULT (datetime('now'))
  )`);

  // Club Mare exclusive content — separate from books/activities so it
  // can be gated purely on club_mare_members without touching the main
  // reading content's visibility rules at all.
  db.run(`CREATE TABLE IF NOT EXISTS club_mare_posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT,
    image_key TEXT,
    min_tier INTEGER NOT NULL DEFAULT 1,
    published_at TEXT DEFAULT (datetime('now')),
    active INTEGER NOT NULL DEFAULT 1
  )`);

  // ── Merchandise — real in-app Stripe checkout, not a link-out. ──
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'gbp',
    image_key TEXT,
    image_keys_json TEXT, -- ordered array of R2 keys for the 360° spin viewer; image_key (above) is the cover/fallback shown before the viewer loads, and doubles as frame 0 if this is empty
    video_key TEXT,
    variant_options_json TEXT, -- e.g. sizes: {"size": ["S","M","L"]}
    stock INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  try { db.run(`ALTER TABLE products ADD COLUMN image_keys_json TEXT`); } catch {}
  try { db.run(`ALTER TABLE products ADD COLUMN video_key TEXT`); } catch {}

  // ── Broadcasts — admin-composed messages to parents/teachers (the
  // "comms" system). One row per message, whatever state it's in.
  // body_html is the rich-editor output; body_text is a plain fallback
  // for the email's text/plain part (same htmlToText derivation email.js
  // already does for other sends, just persisted here too so the admin
  // list can show a clean preview without re-parsing HTML). recipient/
  // sent/failed counts are snapshotted at send time — not live-queried
  // against email_log — so a broadcast's own history page reads instantly
  // and stays accurate even if email_log is later pruned. ──
  db.run(`CREATE TABLE IF NOT EXISTS broadcasts (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    body_text TEXT,
    audience TEXT NOT NULL DEFAULT 'parents', -- 'parents' | 'teachers' | 'both'
    status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
    scheduled_for TEXT,
    sent_at TEXT,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    created_by_id TEXT,
    created_by_role TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Offers — discount codes, built ahead of the merchandise storefront
  // UI existing yet (checkout only takes a raw product list right now).
  // This is the admin-side infrastructure so codes can be created and
  // ready the moment a storefront applies them — not wired into
  // /api/checkout itself in this pass, since there's no live consumer
  // of a code field yet and wiring it in speculatively risks drifting
  // from whatever the actual storefront design ends up needing. ──
  // ── Splash page content — the public showcase landing page's content
  // is fully admin-managed rather than hardcoded, per Per's request:
  // welcome message, Talk to Mare sample phrases (spoken/shown in the
  // demo tile), showcase tiles (read/listen/view/buy icons), and the
  // intro video slot. Singleton row (id='default') for the parts that
  // are just "the current text", separate tables for the parts that
  // are genuinely lists an admin adds to and reorders. ──
  db.run(`CREATE TABLE IF NOT EXISTS showcase_content (
    id TEXT PRIMARY KEY DEFAULT 'default',
    welcome_message_en TEXT,
    welcome_message_nl TEXT,
    video_key TEXT, -- R2 key once a real video is uploaded; NULL = placeholder state
    video_status TEXT NOT NULL DEFAULT 'placeholder', -- 'placeholder' | 'ready'
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS showcase_talk_phrases (
    id TEXT PRIMARY KEY,
    phrase_en TEXT NOT NULL,
    phrase_nl TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS showcase_tiles (
    id TEXT PRIMARY KEY,
    tile_type TEXT NOT NULL, -- 'read' | 'listen' | 'view' | 'buy' | 'talk' | 'custom'
    label_en TEXT NOT NULL,
    label_nl TEXT,
    icon TEXT, -- emoji or short icon key, kept simple rather than an icon-library dependency
    link_type TEXT NOT NULL DEFAULT 'internal', -- 'book' | 'audio' | 'video' | 'external' | 'talk_demo' | 'register' | 'login'
    link_value TEXT, -- book id / audio R2 key / URL, depending on link_type
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Bulk school onboarding — one row per import run (for audit/
  // troubleshooting "did that school's signup actually work"), one row
  // per person in bulk_import_rows (for per-row pass/fail detail, since
  // a batch of 30 rows partially failing needs to say exactly which
  // three didn't work and why, not just an aggregate count). ──
  db.run(`CREATE TABLE IF NOT EXISTS bulk_imports (
    id TEXT PRIMARY KEY,
    school_name TEXT,
    initiated_by_id TEXT,
    row_count INTEGER NOT NULL DEFAULT 0,
    created_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bulk_import_rows (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    role TEXT NOT NULL, -- 'teacher' | 'parent' | 'child'
    name TEXT,
    email TEXT,
    extra TEXT, -- school (teacher) | parent email to link to (child) | unused (parent)
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'created' | 'failed' | 'skipped'
    error TEXT,
    created_user_id TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    description TEXT,
    discount_type TEXT NOT NULL DEFAULT 'percent', -- 'percent' | 'fixed'
    discount_value INTEGER NOT NULL DEFAULT 0, -- percent (1-100) or cents, per discount_type
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    stripe_checkout_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'failed'
    total_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'gbp',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    variant_json TEXT,
    qty INTEGER NOT NULL DEFAULT 1,
    price_cents INTEGER NOT NULL
  )`);

  // ── Reading progress — "continue where you left off," keyed by parent
  // + book rather than by child. This is a shared-family-device reader
  // (a child has no login of their own — see the children table
  // comment), so there's no reliable "which child is reading right now"
  // signal without adding friction (a child-picker before every book
  // open) nobody asked for. One row per parent+book, upserted on every
  // scene change. ──
  db.run(`CREATE TABLE IF NOT EXISTS reading_progress (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    scene_id TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── What's New — Parent/Teacher facing only. Same shape as per_bot's
  // What's New: can link to an external URL or an in-app action/page. ──
  db.run(`CREATE TABLE IF NOT EXISTS whats_new (
    id TEXT PRIMARY KEY,
    audience TEXT NOT NULL DEFAULT 'both', -- 'parent' | 'teacher' | 'both'
    title TEXT NOT NULL,
    body TEXT,
    link_type TEXT, -- 'url' | 'action' | NULL
    link_value TEXT,
    published_at TEXT DEFAULT (datetime('now')),
    active INTEGER NOT NULL DEFAULT 1
  )`);

  // ── "Messages from Mare" — email opt-in cron, same shape as per_bot's
  // custom_reminders (hourly cron tick, per-frequency, dedup via
  // last_sent_date_str). frequency lives on parents.email_frequency;
  // this table is deliberately NOT duplicating that — parents row is
  // already the one place it's set (Signup/Account settings), avoiding
  // the exact kind of two-places-to-update drift per_bot has hit before. ──
  db.run(`CREATE TABLE IF NOT EXISTS mare_message_log (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    sent_date_str TEXT NOT NULL -- dedup key, e.g. '2026-08-20'
  )`);

  // ── Email log — every outbound email (welcome, password reset, and
  // whatever's added later) gets a row here, same pattern as per_bot's
  // own email log: a 'pending' row written before the send attempt, then
  // updated to 'sent' or 'failed' once the Scaleway call resolves. This
  // is what the admin Overview report reads for delivery stats, and
  // what an admin can check when a parent says "I never got the email". ──
  db.run(`CREATE TABLE IF NOT EXISTS email_log (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL, -- 'welcome_parent' | 'welcome_teacher' | 'password_reset' | 'other'
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
    provider_id TEXT, -- Scaleway's own email id, once sent
    error TEXT,
    user_id TEXT, -- parent/teacher/admin id this email was about, if any
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Password reset tokens — one-time-use, short-lived. role is stored
  // alongside the token because the same email address could in theory
  // exist in more than one of parents/teachers/admins, and the reset
  // link has to resolve back to exactly the account the request came
  // from, not guess by trying each table in turn. ──
  db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    role TEXT NOT NULL, -- 'parent' | 'teacher' | 'admin'
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Account status — lets an admin suspend a parent/teacher account
  // (blocks login; doesn't delete data) without needing the heavier,
  // irreversible deleteParentAccount path. Added via ALTER on an
  // existing DB, same migration pattern as the columns just below. ──
  try { db.run(`ALTER TABLE parents ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch {}
  try { db.run(`ALTER TABLE teachers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch {}

  // ── Migration: the 'locale'/'group_slug' columns on books didn't exist
  // in the first two deployed versions of this app — CREATE TABLE IF NOT
  // EXISTS above only applies to a brand-new database, so a live Railway
  // deploy that already booted once needs these added explicitly. Wrapped
  // in try/catch because a fresh database (where the CREATE TABLE above
  // already included these columns) will correctly fail here with
  // "duplicate column" — that failure is expected and safe to ignore.
  try { db.run(`ALTER TABLE books ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'`); } catch {}
  try { db.run(`ALTER TABLE books ADD COLUMN group_slug TEXT NOT NULL DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE parents ADD COLUMN preferred_locale TEXT NOT NULL DEFAULT 'en'`); } catch {}
  try { db.run(`ALTER TABLE teachers ADD COLUMN preferred_locale TEXT NOT NULL DEFAULT 'en'`); } catch {}
  // Backfill: any book row from before group_slug existed (or with the
  // column's own default '') gets its own slug as its group — correct
  // for the original single-locale 'mare' row, and harmless for anything
  // already set correctly.
  run(`UPDATE books SET group_slug = slug WHERE group_slug IS NULL OR group_slug = ''`);

  // ── Seed content — keyed by slug (idempotent) rather than a row-count
  // check, so re-running this after adding a new locale or a new book
  // later doesn't require touching this function's logic each time. ──
  if (!get(`SELECT id FROM books WHERE slug = 'mare'`)) {
    run(`INSERT INTO books (id, title, slug, group_slug, locale, description, sort_order) VALUES (?,?,?,?,?,?,0)`,
      [uuid(), 'Mare and the Whispering Woods of Words', 'mare', 'mare', 'en',
       'Mare finds a path into a wood where the trees remember every word ever spoken.']);
  }
  if (!get(`SELECT id FROM books WHERE slug = 'mare-nl'`)) {
    run(`INSERT INTO books (id, title, slug, group_slug, locale, description, sort_order) VALUES (?,?,?,?,?,?,0)`,
      [uuid(), 'Mare en het fluisterbos van woorden', 'mare-nl', 'mare', 'nl',
       'Mare vindt een pad naar een bos waar de bomen elk woord onthouden dat ooit is gezegd.']);
  }

  save();
  return db;
}

function save() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function uuid() { return crypto.randomUUID(); }
// Normalizes any JS Date-parseable input to SQLite's own datetime format
// ('YYYY-MM-DD HH:MM:SS', UTC, space not 'T') so it compares correctly
// against datetime('now') and other SQLite-generated timestamps — see
// the comment on createPasswordResetToken for why this matters: a raw
// ISO string ('...T...Z') sorts after SQLite's own format regardless of
// actual time, silently breaking any '>' or '<=' comparison between them.
function toSqliteDatetime(input) {
  const d = input instanceof Date ? input : new Date(input);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── Parents ──
function getParentByEmail(email) {
  return get(`SELECT * FROM parents WHERE email = ?`, [email.toLowerCase().trim()]);
}
function getParentById(id) {
  return get(`SELECT * FROM parents WHERE id = ?`, [id]);
}
function createParent({ email, passwordHash, name }) {
  const id = uuid();
  run(`INSERT INTO parents (id, email, password_hash, name) VALUES (?,?,?,?)`,
    [id, email.toLowerCase().trim(), passwordHash, name]);
  return id;
}
function setParentEmailPrefs(parentId, optIn, frequency) {
  run(`UPDATE parents SET email_opt_in = ?, email_frequency = ? WHERE id = ?`,
    [optIn ? 1 : 0, frequency, parentId]);
}
function updateParentProfile(parentId, { name, birthdayMonth, birthdayDay, preferredLocale }) {
  const existing = getParentById(parentId);
  if (!existing) return false;
  run(`UPDATE parents SET name=?, birthday_month=?, birthday_day=?, preferred_locale=? WHERE id=?`,
    [
      name ?? existing.name,
      birthdayMonth === undefined ? existing.birthday_month : birthdayMonth,
      birthdayDay === undefined ? existing.birthday_day : birthdayDay,
      preferredLocale ?? existing.preferred_locale,
      parentId,
    ]);
  return true;
}
function updateParentPasswordHash(parentId, passwordHash) {
  run(`UPDATE parents SET password_hash = ? WHERE id = ?`, [passwordHash, parentId]);
}
// A parent can only delete their own account if they aren't the primary
// parent for any child — deleting them would either orphan that child
// or silently promote a carer to primary, and neither should happen
// without a real, deliberate "transfer primary" step this app doesn't
// have yet. Blocking is the safe default until that exists.
function primaryChildrenCountForParent(parentId) {
  const row = get(`SELECT COUNT(*) as n FROM children WHERE parent_id = ?`, [parentId]);
  return row ? row.n : 0;
}
function deleteParentAccount(parentId) {
  // Carer links (this parent as someone else's linked carer) and this
  // parent's own addresses are safe to remove outright. club_mare_members
  // is this account's own membership row. Orders/order_items are
  // deliberately NOT touched — those are financial records and should
  // outlive the account, same as most real-world account deletions.
  run(`DELETE FROM child_carers WHERE parent_id = ?`, [parentId]);
  run(`DELETE FROM addresses WHERE owner_type = 'parent' AND owner_id = ?`, [parentId]);
  run(`DELETE FROM club_mare_members WHERE parent_id = ?`, [parentId]);
  run(`DELETE FROM parents WHERE id = ?`, [parentId]);
}

// ── Children (profiles that can belong to more than one parent/carer —
// see the child_carers schema comment for the ownership model). ──
function getChildrenByParent(parentId) {
  // Primary parent OR linked carer — either way this is a child the
  // signed-in parent should see. UNION rather than a JOIN+OR keeps this
  // readable and correct even though children could theoretically appear
  // via both paths (they can't in practice — addCarerToChild refuses to
  // link the primary parent as a carer too — but UNION, not UNION ALL,
  // means this stays correct even if that ever changed).
  return all(
    `SELECT * FROM children WHERE parent_id = ?
     UNION
     SELECT c.* FROM children c JOIN child_carers cc ON cc.child_id = c.id WHERE cc.parent_id = ?
     ORDER BY sort_order, created_at`,
    [parentId, parentId]
  );
}
function createChild(parentId, name, avatarKey) {
  const id = uuid();
  run(`INSERT INTO children (id, parent_id, name, avatar_key) VALUES (?,?,?,?)`,
    [id, parentId, name, avatarKey || null]);
  return id;
}
function getChild(childId) {
  return get(`SELECT * FROM children WHERE id = ?`, [childId]);
}
function setChildAgeBand(childId, ageBand) {
  const valid = ['6-8', '9-11', '12-15'];
  if (!valid.includes(ageBand)) throw new Error('Invalid age band');
  run(`UPDATE children SET age_band = ? WHERE id = ?`, [ageBand, childId]);
}
function updateChild(childId, { name, avatarKey, ageBand, birthdayMonth, birthdayDay }) {
  const existing = getChild(childId);
  if (!existing) return false;
  if (ageBand !== undefined && ageBand !== null && !['6-8', '9-11', '12-15'].includes(ageBand)) {
    throw new Error('Invalid age band');
  }
  run(`UPDATE children SET name=?, avatar_key=?, age_band=?, birthday_month=?, birthday_day=? WHERE id=?`,
    [
      name ?? existing.name,
      avatarKey === undefined ? existing.avatar_key : avatarKey,
      ageBand === undefined ? existing.age_band : ageBand,
      birthdayMonth === undefined ? existing.birthday_month : birthdayMonth,
      birthdayDay === undefined ? existing.birthday_day : birthdayDay,
      childId,
    ]);
  return true;
}
function deleteChild(childId) {
  run(`DELETE FROM children WHERE id = ?`, [childId]);
  run(`DELETE FROM child_carers WHERE child_id = ?`, [childId]);
  run(`DELETE FROM addresses WHERE owner_type = 'child' AND owner_id = ?`, [childId]);
}

// ── Child carers — additional parents linked to a child beyond the
// primary parent_id. canParentAccessChild is the one function every
// ownership check in server.js should call — nothing else needs to know
// whether access comes from being primary or being a linked carer. ──
function canParentAccessChild(parentId, childId) {
  const child = getChild(childId);
  if (!child) return false;
  if (child.parent_id === parentId) return true;
  return !!get(`SELECT id FROM child_carers WHERE child_id = ? AND parent_id = ?`, [childId, parentId]);
}
function isPrimaryParentOfChild(parentId, childId) {
  const child = getChild(childId);
  return !!child && child.parent_id === parentId;
}
function getCarersForChild(childId) {
  return all(
    `SELECT cc.id as carer_link_id, cc.relationship, cc.added_at, p.id, p.name, p.email
     FROM child_carers cc JOIN parents p ON p.id = cc.parent_id
     WHERE cc.child_id = ? ORDER BY cc.added_at`,
    [childId]
  );
}
// Adding a carer requires that person to already have a parent account
// (looked up by email) — inviting someone with no account yet is a real
// feature (an email-invite flow) deliberately left for later rather than
// half-built here. Returns the new link id, or throws with a message
// safe to show the requesting parent directly.
function addCarerToChild(childId, carerEmail, relationship) {
  const child = getChild(childId);
  if (!child) throw new Error('Child not found');
  const carer = getParentByEmail(carerEmail);
  if (!carer) throw new Error('No Mare parent account found with that email — they need to create one first.');
  if (carer.id === child.parent_id) throw new Error('That\u2019s already the primary parent for this child.');
  const already = get(`SELECT id FROM child_carers WHERE child_id = ? AND parent_id = ?`, [childId, carer.id]);
  if (already) throw new Error('Already linked to this child.');
  const id = uuid();
  run(`INSERT INTO child_carers (id, child_id, parent_id, relationship) VALUES (?,?,?,?)`,
    [id, childId, carer.id, relationship || null]);
  return id;
}
function removeCarerFromChild(carerLinkId) {
  run(`DELETE FROM child_carers WHERE id = ?`, [carerLinkId]);
}

// ── Addresses — owner-agnostic (see schema comment). N per parent, N
// per child. ──
function getAddressesForOwner(ownerType, ownerId) {
  return all(`SELECT * FROM addresses WHERE owner_type = ? AND owner_id = ? ORDER BY is_default DESC, created_at`, [ownerType, ownerId]);
}
function getAddress(id) {
  return get(`SELECT * FROM addresses WHERE id = ?`, [id]);
}
function createAddress(ownerType, ownerId, { label, recipientName, line1, line2, city, postcode, country, isDefault }) {
  const id = uuid();
  if (isDefault) run(`UPDATE addresses SET is_default = 0 WHERE owner_type = ? AND owner_id = ?`, [ownerType, ownerId]);
  run(`INSERT INTO addresses (id, owner_type, owner_id, label, recipient_name, line1, line2, city, postcode, country, is_default) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, ownerType, ownerId, label || null, recipientName || null, line1, line2 || null, city, postcode, country || 'GB', isDefault ? 1 : 0]);
  return id;
}
function updateAddress(id, { label, recipientName, line1, line2, city, postcode, country, isDefault }) {
  const existing = getAddress(id);
  if (!existing) return false;
  if (isDefault) run(`UPDATE addresses SET is_default = 0 WHERE owner_type = ? AND owner_id = ?`, [existing.owner_type, existing.owner_id]);
  run(`UPDATE addresses SET label=?, recipient_name=?, line1=?, line2=?, city=?, postcode=?, country=?, is_default=? WHERE id=?`,
    [
      label ?? existing.label,
      recipientName ?? existing.recipient_name,
      line1 ?? existing.line1,
      line2 === undefined ? existing.line2 : line2,
      city ?? existing.city,
      postcode ?? existing.postcode,
      country ?? existing.country,
      isDefault === undefined ? existing.is_default : (isDefault ? 1 : 0),
      id,
    ]);
  return true;
}
function deleteAddress(id) {
  run(`DELETE FROM addresses WHERE id = ?`, [id]);
}

// ── Teachers ──
function getTeacherByEmail(email) {
  return get(`SELECT * FROM teachers WHERE email = ?`, [email.toLowerCase().trim()]);
}
function createTeacher({ email, passwordHash, name, school }) {
  const id = uuid();
  run(`INSERT INTO teachers (id, email, password_hash, name, school) VALUES (?,?,?,?,?)`,
    [id, email.toLowerCase().trim(), passwordHash, name, school || null]);
  return id;
}
function updateTeacherPasswordHash(teacherId, passwordHash) {
  run(`UPDATE teachers SET password_hash = ? WHERE id = ?`, [passwordHash, teacherId]);
}

// ── Admins / Support (same table, role column distinguishes them) ──
function getAdminByEmail(email) {
  return get(`SELECT * FROM admins WHERE email = ?`, [email.toLowerCase().trim()]);
}
function createAdmin({ email, passwordHash, name, role }) {
  const id = uuid();
  run(`INSERT INTO admins (id, email, password_hash, name, role) VALUES (?,?,?,?,?)`,
    [id, email.toLowerCase().trim(), passwordHash, name, role === 'support' ? 'support' : 'admin']);
  return id;
}
function updateAdminPasswordHash(adminId, passwordHash) {
  run(`UPDATE admins SET password_hash = ? WHERE id = ?`, [passwordHash, adminId]);
}
function getAllStaff() {
  return all(`SELECT id, email, name, role, created_at FROM admins ORDER BY role, created_at`);
}

// ── Directory lookups for support/admin to help troubleshoot parent and
// teacher accounts. password_hash deliberately excluded from these. ──
function getAllParentsDirectory() {
  return all(`SELECT id, email, name, email_opt_in, email_frequency, preferred_locale, status, created_at FROM parents ORDER BY created_at DESC`);
}
function getAllTeachersDirectory() {
  return all(`SELECT id, email, name, school, preferred_locale, status, created_at FROM teachers ORDER BY created_at DESC`);
}
function setParentStatus(id, status) {
  run(`UPDATE parents SET status = ? WHERE id = ?`, [status === 'suspended' ? 'suspended' : 'active', id]);
}
function setTeacherStatus(id, status) {
  run(`UPDATE teachers SET status = ? WHERE id = ?`, [status === 'suspended' ? 'suspended' : 'active', id]);
}

// ── Books / chapters / scenes ──
function getActiveBooks() {
  return all(`SELECT * FROM books WHERE active = 1 ORDER BY sort_order, created_at`);
}

// Returns one book per group_slug, in the requested locale where that
// translation exists, otherwise falling back to 'en', otherwise
// whatever locale is available — so a book never vanishes from the
// splash page just because its Dutch (or next language's) content
// hasn't been written yet.
function getActiveBooksForLocale(locale) {
  const rows = all(`SELECT * FROM books WHERE active = 1 ORDER BY sort_order, created_at`);
  const byGroup = new Map();
  for (const row of rows) {
    const key = row.group_slug || row.slug;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(row);
  }
  const result = [];
  for (const variants of byGroup.values()) {
    const match = variants.find(b => b.locale === locale)
      || variants.find(b => b.locale === 'en')
      || variants[0];
    result.push(match);
  }
  result.sort((a, b) => a.sort_order - b.sort_order);
  return result;
}
function getAllBooks() {
  return all(`SELECT * FROM books ORDER BY sort_order, created_at`);
}
function getBook(id) {
  return get(`SELECT * FROM books WHERE id = ?`, [id]);
}
function getBookBySlug(slug) {
  return get(`SELECT * FROM books WHERE slug = ?`, [slug]);
}
function createBook({ title, slug, description, splashIconKey, locale, groupSlug }) {
  const id = uuid();
  run(`INSERT INTO books (id, title, slug, group_slug, locale, description, splash_icon_key) VALUES (?,?,?,?,?,?,?)`,
    [id, title, slug, groupSlug || slug, locale || 'en', description || null, splashIconKey || null]);
  return id;
}
function updateBook(id, { title, description, splashIconKey, active }) {
  const existing = getBook(id);
  if (!existing) return false;
  run(`UPDATE books SET title=?, description=?, splash_icon_key=?, active=? WHERE id=?`,
    [
      title ?? existing.title,
      description === undefined ? existing.description : description,
      splashIconKey === undefined ? existing.splash_icon_key : splashIconKey,
      active === undefined ? existing.active : (active ? 1 : 0),
      id,
    ]);
  return true;
}

function getChaptersByBook(bookId) {
  return all(`SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order`, [bookId]);
}
function getChapter(id) {
  return get(`SELECT * FROM chapters WHERE id = ?`, [id]);
}
function createChapter(bookId, title, sortOrder) {
  const id = uuid();
  // Default new chapters to the end of the book rather than 0 — 0 would
  // silently jump a newly-added chapter to the front of the list, which
  // is never what "add a chapter" means in practice.
  const order = sortOrder ?? ((get(`SELECT MAX(sort_order) as m FROM chapters WHERE book_id = ?`, [bookId])?.m ?? -1) + 1);
  run(`INSERT INTO chapters (id, book_id, title, sort_order) VALUES (?,?,?,?)`,
    [id, bookId, title, order]);
  return id;
}
function updateChapter(id, { title }) {
  const existing = getChapter(id);
  if (!existing) return false;
  run(`UPDATE chapters SET title = ? WHERE id = ?`, [title ?? existing.title, id]);
  return true;
}
function deleteChapter(id) {
  const scenes = getScenesByChapter(id);
  scenes.forEach(s => deleteScene(s.id));
  run(`DELETE FROM chapters WHERE id = ?`, [id]);
}
function reorderChapters(bookId, orderedIds) {
  orderedIds.forEach((chapterId, i) => {
    run(`UPDATE chapters SET sort_order = ? WHERE id = ? AND book_id = ?`, [i, chapterId, bookId]);
  });
}

function getScenesByChapter(chapterId) {
  return all(`SELECT * FROM scenes WHERE chapter_id = ? ORDER BY sort_order`, [chapterId]);
}
function getScene(id) {
  return get(`SELECT * FROM scenes WHERE id = ?`, [id]);
}
function createScene(chapterId, kind, sortOrder) {
  const id = uuid();
  const order = sortOrder ?? ((get(`SELECT MAX(sort_order) as m FROM scenes WHERE chapter_id = ?`, [chapterId])?.m ?? -1) + 1);
  run(`INSERT INTO scenes (id, chapter_id, kind, sort_order) VALUES (?,?,?,?)`,
    [id, chapterId, kind, order]);
  return id;
}
function updateSceneKind(id, kind) {
  run(`UPDATE scenes SET kind = ? WHERE id = ?`, [kind, id]);
}
function deleteScene(id) {
  run(`DELETE FROM hotspots WHERE scene_id = ?`, [id]);
  run(`DELETE FROM audio_cues WHERE scene_id = ?`, [id]);
  run(`DELETE FROM narration_sentences WHERE scene_id = ?`, [id]);
  run(`DELETE FROM scenes WHERE id = ?`, [id]);
}
function reorderScenes(chapterId, orderedIds) {
  orderedIds.forEach((sceneId, i) => {
    run(`UPDATE scenes SET sort_order = ? WHERE id = ? AND chapter_id = ?`, [i, sceneId, chapterId]);
  });
}
function setSceneImage(sceneId, imageKey) {
  run(`UPDATE scenes SET image_key = ? WHERE id = ?`, [imageKey, sceneId]);
}
function setSceneNarrationAudio(sceneId, audioKey) {
  run(`UPDATE scenes SET narration_audio_key = ? WHERE id = ?`, [audioKey, sceneId]);
}

// ── Narration sentences ──
function replaceNarrationSentences(sceneId, sentences) {
  // sentences: [{ text, startMs, endMs }], already in order
  run(`DELETE FROM narration_sentences WHERE scene_id = ?`, [sceneId]);
  sentences.forEach((s, i) => {
    run(`INSERT INTO narration_sentences (id, scene_id, text, start_ms, end_ms, sort_order) VALUES (?,?,?,?,?,?)`,
      [uuid(), sceneId, s.text, s.startMs, s.endMs, i]);
  });
}
function getNarrationSentences(sceneId) {
  return all(`SELECT * FROM narration_sentences WHERE scene_id = ? ORDER BY sort_order`, [sceneId]);
}

// ── Full book text, for Talk to Mare's system prompt ──
// Walks chapters (in order) -> scenes (in order) -> narration
// sentences (in order) and joins them into one plain-text block, so
// Mare can be given the whole story to draw on rather than having no
// story awareness at all. Cached in memory per book — this is a real
// multi-table join, and the underlying content is static, admin-edited
// narration that changes rarely, not something worth re-assembling on
// every single chat turn (the system prompt is resent to the model on
// every turn regardless, since the API itself is stateless — this
// cache is what keeps that cheap). Invalidated explicitly by
// invalidateBookTextCache() wherever narration is actually edited,
// rather than left to go stale silently — see the two call sites in
// server.js's narration-sentence edit routes.
const bookTextCache = new Map(); // bookId -> assembled text
function getFullBookText(bookId) {
  if (bookTextCache.has(bookId)) return bookTextCache.get(bookId);
  const book = getBook(bookId);
  if (!book) return '';
  const chapters = getChaptersByBook(bookId);
  const parts = [];
  for (const chapter of chapters) {
    const scenes = getScenesByChapter(chapter.id);
    const chapterLines = [];
    for (const scene of scenes) {
      const sentences = getNarrationSentences(scene.id);
      if (sentences.length) chapterLines.push(sentences.map(s => s.text).join(' '));
    }
    if (chapterLines.length) parts.push(`Chapter: ${chapter.title}\n${chapterLines.join('\n\n')}`);
  }
  const text = parts.join('\n\n');
  bookTextCache.set(bookId, text);
  return text;
}
function invalidateBookTextCache(bookId) {
  bookTextCache.delete(bookId);
}
// Clears every book's cached text, used by narration-edit routes that
// only have a sentence/scene id in hand, not the book id — resolving
// that full chain on every edit for the sake of a more targeted clear
// isn't worth it given how rare these edits are and how cheap this
// cache is to rebuild on next use.
function clearAllBookTextCache() {
  bookTextCache.clear();
}
function updateNarrationSentenceTiming(id, startMs, endMs) {
  run(`UPDATE narration_sentences SET start_ms = ?, end_ms = ? WHERE id = ?`, [startMs, endMs, id]);
}
function updateNarrationSentenceText(id, text) {
  run(`UPDATE narration_sentences SET text = ? WHERE id = ?`, [text, id]);
}

// ── Hotspots ──
function getHotspotsByScene(sceneId) {
  return all(`SELECT * FROM hotspots WHERE scene_id = ? AND active = 1 ORDER BY sort_order`, [sceneId]);
}
function getAllHotspotsByScene(sceneId) {
  return all(`SELECT * FROM hotspots WHERE scene_id = ? ORDER BY sort_order`, [sceneId]);
}
function getHotspot(id) {
  return get(`SELECT * FROM hotspots WHERE id = ?`, [id]);
}
function createHotspot(sceneId, { x, y, w, h, type, payload }) {
  const id = uuid();
  run(`INSERT INTO hotspots (id, scene_id, x, y, w, h, type, payload_json) VALUES (?,?,?,?,?,?,?,?)`,
    [id, sceneId, x, y, w || 0.08, h || 0.08, type, JSON.stringify(payload || {})]);
  return id;
}
function updateHotspot(id, { x, y, w, h, type, payload, active }) {
  const existing = getHotspot(id);
  if (!existing) return false;
  run(`UPDATE hotspots SET x=?, y=?, w=?, h=?, type=?, payload_json=?, active=? WHERE id=?`,
    [
      x ?? existing.x,
      y ?? existing.y,
      w ?? existing.w,
      h ?? existing.h,
      type ?? existing.type,
      payload === undefined ? existing.payload_json : JSON.stringify(payload),
      active === undefined ? existing.active : (active ? 1 : 0),
      id,
    ]);
  return true;
}
function deleteHotspot(id) {
  run(`DELETE FROM hotspots WHERE id = ?`, [id]);
}

// ── Audio cues ──
function getAudioCuesByScene(sceneId) {
  return all(`SELECT * FROM audio_cues WHERE scene_id = ? ORDER BY start_ms`, [sceneId]);
}
function getAudioCue(id) {
  return get(`SELECT * FROM audio_cues WHERE id = ?`, [id]);
}
function createAudioCue(sceneId, { kind, audioKey, startMs, volume, loop }) {
  const id = uuid();
  run(`INSERT INTO audio_cues (id, scene_id, kind, audio_key, start_ms, volume, loop_audio) VALUES (?,?,?,?,?,?,?)`,
    [id, sceneId, kind, audioKey, startMs || 0, volume ?? 1.0, loop ? 1 : 0]);
  return id;
}
function updateAudioCue(id, { kind, audioKey, startMs, volume, loop, label }) {
  const existing = getAudioCue(id);
  if (!existing) return false;
  run(`UPDATE audio_cues SET kind=?, audio_key=?, start_ms=?, volume=?, loop_audio=?, label=? WHERE id=?`,
    [
      kind ?? existing.kind,
      audioKey ?? existing.audio_key,
      startMs === undefined ? existing.start_ms : startMs,
      volume === undefined ? existing.volume : volume,
      loop === undefined ? existing.loop_audio : (loop ? 1 : 0),
      label === undefined ? existing.label : label,
      id,
    ]);
  return true;
}
function deleteAudioCue(id) {
  run(`DELETE FROM audio_cues WHERE id = ?`, [id]);
}

// ── Full book tree — everything the content admin editor needs in one
// call, rather than N+1 round trips per scene. Includes inactive
// hotspots too (unlike the public getHotspotsByScene) since the admin
// editor needs to show/toggle them, not just render live ones. ──
function getBookFullTree(bookId) {
  const book = getBook(bookId);
  if (!book) return null;
  const chapters = getChaptersByBook(bookId).map(ch => ({
    ...ch,
    scenes: getScenesByChapter(ch.id).map(scene => ({
      ...scene,
      hotspots: getAllHotspotsByScene(scene.id),
      audioCues: getAudioCuesByScene(scene.id),
      sentences: getNarrationSentences(scene.id),
    })),
  }));
  return { book, chapters };
}


function getActivitiesForBook(bookId) {
  return all(`SELECT * FROM activities WHERE book_id = ? AND active = 1 ORDER BY sort_order`, [bookId]);
}
function getActivitiesForChapter(chapterId) {
  return all(`SELECT * FROM activities WHERE chapter_id = ? AND active = 1 ORDER BY sort_order`, [chapterId]);
}
function createActivity({ bookId, chapterId, type, title, payload }) {
  const id = uuid();
  run(`INSERT INTO activities (id, book_id, chapter_id, type, title, payload_json) VALUES (?,?,?,?,?,?)`,
    [id, bookId || null, chapterId || null, type, title, JSON.stringify(payload || {})]);
  return id;
}

// ── Club Mare ── tier 1 = free, tier 2 = paid. Never 0.
function getClubMareMembership(parentId) {
  return get(`SELECT * FROM club_mare_members WHERE parent_id = ?`, [parentId]);
}
function joinClubMareFree(parentId) {
  const existing = getClubMareMembership(parentId);
  if (existing) return existing.id;
  const id = uuid();
  run(`INSERT INTO club_mare_members (id, parent_id, tier) VALUES (?,?,1)`, [id, parentId]);
  return id;
}
function upgradeClubMareToPaid(parentId, stripeSubscriptionId) {
  run(`UPDATE club_mare_members SET tier = 2, stripe_subscription_id = ? WHERE parent_id = ?`,
    [stripeSubscriptionId, parentId]);
}
function getClubMarePosts(maxTierVisible) {
  return all(`SELECT * FROM club_mare_posts WHERE active = 1 AND min_tier <= ? ORDER BY published_at DESC`,
    [maxTierVisible]);
}

// ── Club Mare admin ──
// Joined against parents for name/email — admin needs to see who a
// member actually is, not just a bare parent_id. LEFT JOIN rather than
// INNER, defensively: a membership row should never outlive its parent
// (deleteParentAccount cleans these up — see the comment near there),
// but a LEFT JOIN means this list degrades gracefully instead of
// silently hiding a row if that invariant is ever violated.
function getAllClubMareMembersAdmin() {
  return all(`
    SELECT cm.*, p.name as parent_name, p.email as parent_email
    FROM club_mare_members cm
    LEFT JOIN parents p ON p.id = cm.parent_id
    ORDER BY cm.joined_at DESC
  `);
}
// Admin-side manual tier override — comping someone to paid, or
// stepping a paid member back to free, without touching Stripe at all.
// Deliberately does NOT clear stripe_subscription_id when downgrading
// to free — if a real Stripe subscription is still live underneath,
// that's a billing question for Stripe/the checkout flow to resolve on
// its own next sync, not something this override should silently erase
// and lose track of.
function setClubMareMemberTier(parentId, tier) {
  run(`UPDATE club_mare_members SET tier = ? WHERE parent_id = ?`, [tier === 2 ? 2 : 1, parentId]);
}
function removeClubMareMembership(parentId) {
  run(`DELETE FROM club_mare_members WHERE parent_id = ?`, [parentId]);
}

function getAllClubMarePostsAdmin() {
  return all(`SELECT * FROM club_mare_posts ORDER BY published_at DESC`);
}
function createClubMarePost({ title, body, imageKey, minTier }) {
  const id = uuid();
  run(`INSERT INTO club_mare_posts (id, title, body, image_key, min_tier) VALUES (?,?,?,?,?)`,
    [id, title, body || null, imageKey || null, minTier === 2 ? 2 : 1]);
  return id;
}
function updateClubMarePost(id, { title, body, imageKey, minTier, active }) {
  run(`UPDATE club_mare_posts SET title=?, body=?, image_key=?, min_tier=?, active=? WHERE id=?`,
    [title, body || null, imageKey || null, minTier === 2 ? 2 : 1, active ? 1 : 0, id]);
}
function deleteClubMarePost(id) {
  run(`DELETE FROM club_mare_posts WHERE id = ?`, [id]);
}

// ── Merchandise ──
// image_keys_json is parsed here (not left as a raw string) for the
// same reason recurrence_config is parsed before responding elsewhere
// in this app — the frontend consumes it as a real array, not JSON
// text it has to remember to parse itself.
function parseProductRow(row) {
  if (!row) return row;
  let imageKeys = [];
  try { imageKeys = row.image_keys_json ? JSON.parse(row.image_keys_json) : []; } catch { imageKeys = []; }
  let variantOptions = {};
  try { variantOptions = row.variant_options_json ? JSON.parse(row.variant_options_json) : {}; } catch { variantOptions = {}; }
  return { ...row, image_keys: imageKeys, variant_options: variantOptions };
}
function getActiveProducts() {
  return all(`SELECT * FROM products WHERE active = 1 ORDER BY sort_order`).map(parseProductRow);
}
function getProduct(id) {
  return parseProductRow(get(`SELECT * FROM products WHERE id = ?`, [id]));
}
function getAllProductsAdmin() {
  return all(`SELECT * FROM products ORDER BY sort_order, name`).map(parseProductRow);
}
function createProduct({ name, description, priceCents, currency, imageKey, imageKeys, videoKey, variantOptions, stock, sortOrder }) {
  const id = uuid();
  run(
    `INSERT INTO products (id, name, description, price_cents, currency, image_key, image_keys_json, video_key, variant_options_json, stock, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, name, description || null, priceCents, currency || 'gbp',
     imageKey || (imageKeys && imageKeys[0]) || null,
     JSON.stringify(imageKeys || []), videoKey || null,
     JSON.stringify(variantOptions || {}), stock ?? null, sortOrder || 0]
  );
  return id;
}
function updateProduct(id, { name, description, priceCents, currency, imageKey, imageKeys, videoKey, variantOptions, stock, active, sortOrder }) {
  run(
    `UPDATE products SET name=?, description=?, price_cents=?, currency=?, image_key=?, image_keys_json=?, video_key=?, variant_options_json=?, stock=?, active=?, sort_order=? WHERE id=?`,
    [name, description || null, priceCents, currency || 'gbp',
     imageKey || (imageKeys && imageKeys[0]) || null,
     JSON.stringify(imageKeys || []), videoKey || null,
     JSON.stringify(variantOptions || {}), stock ?? null, active ? 1 : 0, sortOrder || 0, id]
  );
}
function deleteProduct(id) {
  run(`DELETE FROM products WHERE id = ?`, [id]);
}
function createOrder(parentId, totalCents, currency) {
  const id = uuid();
  run(`INSERT INTO orders (id, parent_id, total_cents, currency) VALUES (?,?,?,?)`,
    [id, parentId, totalCents, currency || 'gbp']);
  return id;
}
function setOrderStripeSession(orderId, sessionId) {
  run(`UPDATE orders SET stripe_checkout_session_id = ? WHERE id = ?`, [sessionId, orderId]);
}
function markOrderPaid(stripeSessionId) {
  run(`UPDATE orders SET status = 'paid' WHERE stripe_checkout_session_id = ?`, [stripeSessionId]);
}
function addOrderItem(orderId, productId, variant, qty, priceCents) {
  run(`INSERT INTO order_items (id, order_id, product_id, variant_json, qty, price_cents) VALUES (?,?,?,?,?,?)`,
    [uuid(), orderId, productId, JSON.stringify(variant || {}), qty, priceCents]);
}

// ── Reading progress ──
function getReadingProgress(parentId, bookId) {
  return get(`SELECT * FROM reading_progress WHERE parent_id = ? AND book_id = ?`, [parentId, bookId]);
}
function upsertReadingProgress(parentId, bookId, chapterId, sceneId) {
  const existing = getReadingProgress(parentId, bookId);
  if (existing) {
    run(`UPDATE reading_progress SET chapter_id = ?, scene_id = ?, updated_at = datetime('now') WHERE id = ?`,
      [chapterId, sceneId, existing.id]);
    return existing.id;
  }
  const id = uuid();
  run(`INSERT INTO reading_progress (id, parent_id, book_id, chapter_id, scene_id) VALUES (?,?,?,?,?)`,
    [id, parentId, bookId, chapterId, sceneId]);
  return id;
}

// ── Teacher resources ──
function getActiveTeacherResources() {
  return all(`SELECT * FROM teacher_resources WHERE active = 1 ORDER BY sort_order, created_at`);
}
function getAllTeacherResources() {
  return all(`SELECT * FROM teacher_resources ORDER BY sort_order, created_at`);
}
function createTeacherResource({ title, description, category, fileKey, externalUrl, sortOrder }) {
  const id = uuid();
  run(`INSERT INTO teacher_resources (id, title, description, category, file_key, external_url, sort_order) VALUES (?,?,?,?,?,?,?)`,
    [id, title, description || null, category || 'document', fileKey || null, externalUrl || null, sortOrder || 0]);
  return id;
}
function updateTeacherResource(id, { title, description, category, fileKey, externalUrl, sortOrder, active }) {
  const existing = get(`SELECT * FROM teacher_resources WHERE id = ?`, [id]);
  if (!existing) return false;
  run(`UPDATE teacher_resources SET title=?, description=?, category=?, file_key=?, external_url=?, sort_order=?, active=? WHERE id=?`,
    [
      title ?? existing.title,
      description ?? existing.description,
      category ?? existing.category,
      fileKey ?? existing.file_key,
      externalUrl ?? existing.external_url,
      sortOrder ?? existing.sort_order,
      active === undefined ? existing.active : (active ? 1 : 0),
      id,
    ]);
  return true;
}
function deleteTeacherResource(id) {
  run(`DELETE FROM teacher_resources WHERE id = ?`, [id]);
}

// ── App pages directory ──
function getActiveAppPages() {
  return all(`SELECT * FROM app_pages WHERE active = 1 ORDER BY sort_order, created_at`);
}
function getAllAppPages() {
  return all(`SELECT * FROM app_pages ORDER BY sort_order, created_at`);
}
function createAppPage({ label, url, kind, status, description, sortOrder }) {
  const id = uuid();
  run(`INSERT INTO app_pages (id, label, url, kind, status, description, sort_order) VALUES (?,?,?,?,?,?,?)`,
    [id, label, url, kind === 'external' ? 'external' : 'internal', status || 'live', description || null, sortOrder || 0]);
  return id;
}
function updateAppPage(id, { label, url, kind, status, description, sortOrder, active }) {
  const existing = get(`SELECT * FROM app_pages WHERE id = ?`, [id]);
  if (!existing) return false;
  run(`UPDATE app_pages SET label=?, url=?, kind=?, status=?, description=?, sort_order=?, active=? WHERE id=?`,
    [
      label ?? existing.label,
      url ?? existing.url,
      kind ?? existing.kind,
      status ?? existing.status,
      description ?? existing.description,
      sortOrder ?? existing.sort_order,
      active === undefined ? existing.active : (active ? 1 : 0),
      id,
    ]);
  return true;
}
function deleteAppPage(id) {
  run(`DELETE FROM app_pages WHERE id = ?`, [id]);
}

// ── Talk to Mare — session metadata only (no transcript persistence,
// see the schema comment above for why). ──
function createTalkSession(childId, parentId, locale) {
  const id = uuid();
  run(`INSERT INTO talk_sessions (id, child_id, parent_id, locale) VALUES (?,?,?,?)`,
    [id, childId, parentId, locale || 'en']);
  return id;
}
function getTalkSession(id) {
  return get(`SELECT * FROM talk_sessions WHERE id = ?`, [id]);
}
function touchTalkSession(id) {
  run(`UPDATE talk_sessions SET last_activity_at = datetime('now'), turn_count = turn_count + 1 WHERE id = ?`, [id]);
}
function endTalkSession(id) {
  run(`UPDATE talk_sessions SET ended_at = datetime('now') WHERE id = ?`, [id]);
}

// ── Social links ──
function getActiveSocialLinks() {
  return all(`SELECT * FROM social_links WHERE active = 1 ORDER BY sort_order, created_at`);
}
function getAllSocialLinks() {
  return all(`SELECT * FROM social_links ORDER BY sort_order, created_at`);
}
function createSocialLink({ platform, url, label, sortOrder }) {
  const id = uuid();
  run(`INSERT INTO social_links (id, platform, url, label, sort_order) VALUES (?,?,?,?,?)`,
    [id, platform, url, label || null, sortOrder || 0]);
  return id;
}
function updateSocialLink(id, { platform, url, label, sortOrder, active }) {
  const existing = get(`SELECT * FROM social_links WHERE id = ?`, [id]);
  if (!existing) return false;
  run(`UPDATE social_links SET platform=?, url=?, label=?, sort_order=?, active=? WHERE id=?`,
    [
      platform ?? existing.platform,
      url ?? existing.url,
      label === undefined ? existing.label : label,
      sortOrder === undefined ? existing.sort_order : sortOrder,
      active === undefined ? existing.active : (active ? 1 : 0),
      id,
    ]);
  return true;
}
function deleteSocialLink(id) {
  run(`DELETE FROM social_links WHERE id = ?`, [id]);
}

// ── Marketing post history ──
function createMarketingPost({ sourceText, platforms, results, includedCta, createdById, createdByRole }) {
  const id = uuid();
  run(`INSERT INTO marketing_posts (id, source_text, platforms_json, results_json, included_cta, created_by_id, created_by_role) VALUES (?,?,?,?,?,?,?)`,
    [id, sourceText, JSON.stringify(platforms), JSON.stringify(results), includedCta ? 1 : 0, createdById || null, createdByRole || null]);
  return id;
}
function getMarketingHistory(limit) {
  return all(`SELECT * FROM marketing_posts ORDER BY created_at DESC LIMIT ?`, [limit || 30]);
}
function deleteMarketingPost(id) {
  run(`DELETE FROM marketing_posts WHERE id = ?`, [id]);
}

// ── What's New ──
function getWhatsNew(audience) {
  return all(`SELECT * FROM whats_new WHERE active = 1 AND (audience = ? OR audience = 'both') ORDER BY published_at DESC`,
    [audience]);
}
function createWhatsNew({ audience, title, body, linkType, linkValue }) {
  const id = uuid();
  run(`INSERT INTO whats_new (id, audience, title, body, link_type, link_value) VALUES (?,?,?,?,?,?)`,
    [id, audience || 'both', title, body || null, linkType || null, linkValue || null]);
  return id;
}
// ── Admin management — unlike getWhatsNew() above (public-facing, active
// items only), this returns every item regardless of active status, so
// the admin list can show and toggle drafts/retired items too. ──
function getAllWhatsNewAdmin() {
  return all(`SELECT * FROM whats_new ORDER BY published_at DESC`);
}
function updateWhatsNew(id, { audience, title, body, linkType, linkValue, active }) {
  run(`UPDATE whats_new SET audience=?, title=?, body=?, link_type=?, link_value=?, active=? WHERE id=?`,
    [audience || 'both', title, body || null, linkType || null, linkValue || null, active ? 1 : 0, id]);
}
function deleteWhatsNew(id) {
  run(`DELETE FROM whats_new WHERE id = ?`, [id]);
}

// ── Mare email messages (dedup log for the cron) ──
function hasSentMareMessageToday(parentId, dateStr) {
  return !!get(`SELECT id FROM mare_message_log WHERE parent_id = ? AND sent_date_str = ?`, [parentId, dateStr]);
}
function logMareMessageSent(parentId, dateStr) {
  run(`INSERT INTO mare_message_log (id, parent_id, sent_date_str) VALUES (?,?,?)`, [uuid(), parentId, dateStr]);
}
function getEmailOptInParents(frequency) {
  return all(`SELECT * FROM parents WHERE email_opt_in = 1 AND email_frequency = ?`, [frequency]);
}

// ── Password reset tokens ──
// 1-hour expiry, single use (used_at set the moment it's redeemed, and
// getValidPasswordResetToken excludes anything already used or expired
// so a captured/reused link can't work twice or after the window closes).
// The expiry is computed by SQLite's own datetime('now', '+1 hour')
// rather than a JS Date().toISOString() string — a JS ISO string
// ('2026-08-22T10:00:00.000Z') sorts LEXICOGRAPHICALLY AFTER SQLite's
// own datetime('now') format ('2026-08-22 10:00:00', space not 'T')
// because 'T' (char code 84) is greater than ' ' (char code 32). That
// mismatch meant expires_at > datetime('now') was true for EVERY row
// regardless of actual time — tokens never actually expired via this
// check, only via the separate single-use guard. Confirmed and fixed
// by keeping both sides of every such comparison in SQLite's own format.
function createPasswordResetToken(role, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run(`INSERT INTO password_reset_tokens (token, role, user_id, expires_at) VALUES (?,?,?, datetime('now', '+1 hour'))`,
    [token, role, userId]);
  return token;
}
function getValidPasswordResetToken(token) {
  return get(
    `SELECT * FROM password_reset_tokens WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    [token]
  );
}
function markPasswordResetTokenUsed(token) {
  run(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE token = ?`, [token]);
}

// ── Email log — for the admin Overview report and per-account "did this
// email actually go out" troubleshooting. ──
function getRecentEmailLog(limit) {
  return all(`SELECT id, kind, to_email, subject, status, error, created_at FROM email_log ORDER BY created_at DESC LIMIT ?`, [limit || 50]);
}
function getEmailStats() {
  const rows = all(`SELECT status, COUNT(*) as count FROM email_log GROUP BY status`);
  const stats = { sent: 0, failed: 0, pending: 0 };
  rows.forEach(r => { stats[r.status] = r.count; });
  return stats;
}

// ── Admin overview report — the counts an admin actually wants to see
// at a glance. Kept as simple, cheap COUNT(*) queries (this app's tables
// are small) rather than a maintained summary table, matching sql.js's
// whole-file-in-memory model where a full scan of these tables costs
// nothing. ──
function getAdminOverviewStats() {
  const parents = get(`SELECT COUNT(*) as c FROM parents`).c;
  const suspendedParents = get(`SELECT COUNT(*) as c FROM parents WHERE status = 'suspended'`).c;
  const children = get(`SELECT COUNT(*) as c FROM children`).c;
  const teachers = get(`SELECT COUNT(*) as c FROM teachers`).c;
  const suspendedTeachers = get(`SELECT COUNT(*) as c FROM teachers WHERE status = 'suspended'`).c;
  const talkSessionsTotal = get(`SELECT COUNT(*) as c FROM talk_sessions`).c;
  const talkSessions7d = get(`SELECT COUNT(*) as c FROM talk_sessions WHERE started_at > datetime('now', '-7 days')`).c;
  const ordersTotal = get(`SELECT COUNT(*) as c FROM orders`).c;
  const ordersPaid = get(`SELECT COUNT(*) as c FROM orders WHERE status = 'paid'`).c;
  const clubMembers = get(`SELECT COUNT(*) as c FROM club_mare_members`).c;
  return {
    parents, suspendedParents, children, teachers, suspendedTeachers,
    talkSessionsTotal, talkSessions7d,
    ordersTotal, ordersPaid,
    clubMembers,
    email: getEmailStats(),
  };
}

// ── Broadcasts (comms) ──
function createBroadcast({ subject, bodyHtml, bodyText, audience, createdById, createdByRole }) {
  const id = uuid();
  run(`INSERT INTO broadcasts (id, subject, body_html, body_text, audience, created_by_id, created_by_role) VALUES (?,?,?,?,?,?,?)`,
    [id, subject, bodyHtml, bodyText || null, audience || 'parents', createdById || null, createdByRole || null]);
  return id;
}
function getBroadcast(id) {
  return get(`SELECT * FROM broadcasts WHERE id = ?`, [id]);
}
function getAllBroadcasts() {
  return all(`SELECT * FROM broadcasts ORDER BY created_at DESC`);
}
function updateBroadcastContent(id, { subject, bodyHtml, bodyText, audience }) {
  run(`UPDATE broadcasts SET subject=?, body_html=?, body_text=?, audience=?, updated_at=datetime('now') WHERE id=? AND status='draft'`,
    [subject, bodyHtml, bodyText || null, audience || 'parents', id]);
}
function scheduleBroadcast(id, scheduledFor) {
  run(`UPDATE broadcasts SET status='scheduled', scheduled_for=?, updated_at=datetime('now') WHERE id=?`, [toSqliteDatetime(scheduledFor), id]);
}
function unscheduleBroadcast(id) {
  run(`UPDATE broadcasts SET status='draft', scheduled_for=NULL, updated_at=datetime('now') WHERE id=?`, [id]);
}
function deleteBroadcast(id) {
  run(`DELETE FROM broadcasts WHERE id = ? AND status IN ('draft','scheduled')`, [id]);
}
function getDueScheduledBroadcasts() {
  return all(`SELECT * FROM broadcasts WHERE status='scheduled' AND scheduled_for <= datetime('now')`);
}
function markBroadcastSending(id) {
  run(`UPDATE broadcasts SET status='sending', updated_at=datetime('now') WHERE id=?`, [id]);
}
function markBroadcastSent(id, { recipientCount, sentCount, failedCount }) {
  run(`UPDATE broadcasts SET status='sent', sent_at=datetime('now'), recipient_count=?, sent_count=?, failed_count=?, updated_at=datetime('now') WHERE id=?`,
    [recipientCount, sentCount, failedCount, id]);
}
function getBroadcastAudienceEmails(audience) {
  const parents = (audience === 'parents' || audience === 'both')
    ? all(`SELECT id, email, name FROM parents WHERE status != 'suspended'`) : [];
  const teachers = (audience === 'teachers' || audience === 'both')
    ? all(`SELECT id, email, name FROM teachers WHERE status != 'suspended'`) : [];
  return [...parents, ...teachers];
}

// ── Offers (sales & marketing) ──
function getAllOffers() {
  return all(`SELECT * FROM offers ORDER BY created_at DESC`);
}
function getOfferByCode(code) {
  return get(`SELECT * FROM offers WHERE code = ?`, [code.toUpperCase().trim()]);
}
function createOffer({ code, description, discountType, discountValue, expiresAt }) {
  const id = uuid();
  run(`INSERT INTO offers (id, code, description, discount_type, discount_value, expires_at) VALUES (?,?,?,?,?,?)`,
    [id, code.toUpperCase().trim(), description || null, discountType === 'fixed' ? 'fixed' : 'percent', discountValue || 0, expiresAt || null]);
  return id;
}
function updateOffer(id, { description, discountType, discountValue, active, expiresAt }) {
  run(`UPDATE offers SET description=?, discount_type=?, discount_value=?, active=?, expires_at=? WHERE id=?`,
    [description || null, discountType === 'fixed' ? 'fixed' : 'percent', discountValue || 0, active ? 1 : 0, expiresAt || null, id]);
}
function deleteOffer(id) {
  run(`DELETE FROM offers WHERE id = ?`, [id]);
}

// ── Splash content ──
function getShowcaseContent() {
  let row = get(`SELECT * FROM showcase_content WHERE id = 'default'`);
  if (!row) {
    run(`INSERT INTO showcase_content (id) VALUES ('default')`);
    row = get(`SELECT * FROM showcase_content WHERE id = 'default'`);
  }
  return row;
}
function updateShowcaseContent({ welcomeMessageEn, welcomeMessageNl }) {
  getShowcaseContent(); // ensure the row exists first
  run(`UPDATE showcase_content SET welcome_message_en=?, welcome_message_nl=?, updated_at=datetime('now') WHERE id='default'`,
    [welcomeMessageEn || null, welcomeMessageNl || null]);
}
function setShowcaseVideo(videoKey) {
  getShowcaseContent();
  run(`UPDATE showcase_content SET video_key=?, video_status='ready', updated_at=datetime('now') WHERE id='default'`, [videoKey]);
}
function clearShowcaseVideo() {
  getShowcaseContent();
  run(`UPDATE showcase_content SET video_key=NULL, video_status='placeholder', updated_at=datetime('now') WHERE id='default'`);
}

function getAllShowcasePhrasesAdmin() {
  return all(`SELECT * FROM showcase_talk_phrases ORDER BY sort_order ASC, created_at ASC`);
}
function getActiveShowcasePhrases() {
  return all(`SELECT * FROM showcase_talk_phrases WHERE active = 1 ORDER BY sort_order ASC, created_at ASC`);
}
function createShowcasePhrase({ phraseEn, phraseNl, sortOrder }) {
  const id = uuid();
  run(`INSERT INTO showcase_talk_phrases (id, phrase_en, phrase_nl, sort_order) VALUES (?,?,?,?)`,
    [id, phraseEn, phraseNl || null, sortOrder || 0]);
  return id;
}
function updateShowcasePhrase(id, { phraseEn, phraseNl, sortOrder, active }) {
  run(`UPDATE showcase_talk_phrases SET phrase_en=?, phrase_nl=?, sort_order=?, active=? WHERE id=?`,
    [phraseEn, phraseNl || null, sortOrder || 0, active ? 1 : 0, id]);
}
function deleteShowcasePhrase(id) {
  run(`DELETE FROM showcase_talk_phrases WHERE id = ?`, [id]);
}

function getAllShowcaseTilesAdmin() {
  return all(`SELECT * FROM showcase_tiles ORDER BY sort_order ASC, created_at ASC`);
}
function getActiveShowcaseTiles() {
  return all(`SELECT * FROM showcase_tiles WHERE active = 1 ORDER BY sort_order ASC, created_at ASC`);
}
function createShowcaseTile({ tileType, labelEn, labelNl, icon, linkType, linkValue, sortOrder }) {
  const id = uuid();
  run(`INSERT INTO showcase_tiles (id, tile_type, label_en, label_nl, icon, link_type, link_value, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
    [id, tileType || 'custom', labelEn, labelNl || null, icon || null, linkType || 'internal', linkValue || null, sortOrder || 0]);
  return id;
}
function updateShowcaseTile(id, { tileType, labelEn, labelNl, icon, linkType, linkValue, sortOrder, active }) {
  run(`UPDATE showcase_tiles SET tile_type=?, label_en=?, label_nl=?, icon=?, link_type=?, link_value=?, sort_order=?, active=? WHERE id=?`,
    [tileType || 'custom', labelEn, labelNl || null, icon || null, linkType || 'internal', linkValue || null, sortOrder || 0, active ? 1 : 0, id]);
}
function deleteShowcaseTile(id) {
  run(`DELETE FROM showcase_tiles WHERE id = ?`, [id]);
}

// ── Bulk school onboarding ──
function createBulkImport({ schoolName, initiatedById, rowCount }) {
  const id = uuid();
  run(`INSERT INTO bulk_imports (id, school_name, initiated_by_id, row_count) VALUES (?,?,?,?)`,
    [id, schoolName || null, initiatedById || null, rowCount || 0]);
  return id;
}
function addBulkImportRow(importId, { rowNumber, role, name, email, extra }) {
  const id = uuid();
  run(`INSERT INTO bulk_import_rows (id, import_id, row_number, role, name, email, extra) VALUES (?,?,?,?,?,?,?)`,
    [id, importId, rowNumber, role, name || null, email || null, extra || null]);
  return id;
}
function markBulkImportRowResult(rowId, { status, error, createdUserId }) {
  run(`UPDATE bulk_import_rows SET status=?, error=?, created_user_id=? WHERE id=?`,
    [status, error || null, createdUserId || null, rowId]);
}
function finishBulkImport(importId, { createdCount, failedCount }) {
  run(`UPDATE bulk_imports SET created_count=?, failed_count=? WHERE id=?`, [createdCount, failedCount, importId]);
}
function getBulkImport(id) {
  return get(`SELECT * FROM bulk_imports WHERE id = ?`, [id]);
}
function getBulkImportRows(importId) {
  return all(`SELECT * FROM bulk_import_rows WHERE import_id = ? ORDER BY row_number ASC`, [importId]);
}
function getAllBulkImports() {
  return all(`SELECT * FROM bulk_imports ORDER BY created_at DESC`);
}

module.exports = {
  getDb, save, uuid, run, get, all,
  getParentByEmail, getParentById, createParent, setParentEmailPrefs, updateParentProfile,
  updateParentPasswordHash, primaryChildrenCountForParent, deleteParentAccount,
  getChildrenByParent, createChild, getChild, setChildAgeBand, updateChild, deleteChild,
  canParentAccessChild, isPrimaryParentOfChild, getCarersForChild, addCarerToChild, removeCarerFromChild,
  getAddressesForOwner, getAddress, createAddress, updateAddress, deleteAddress,
  getTeacherByEmail, createTeacher, updateTeacherPasswordHash,
  getAdminByEmail, createAdmin, updateAdminPasswordHash, getAllStaff,
  getAllParentsDirectory, getAllTeachersDirectory, setParentStatus, setTeacherStatus,
  createPasswordResetToken, getValidPasswordResetToken, markPasswordResetTokenUsed,
  getRecentEmailLog, getEmailStats, getAdminOverviewStats,
  getActiveTeacherResources, getAllTeacherResources,
  createTeacherResource, updateTeacherResource, deleteTeacherResource,
  getActiveAppPages, getAllAppPages, createAppPage, updateAppPage, deleteAppPage,
  createTalkSession, getTalkSession, touchTalkSession, endTalkSession,
  getActiveSocialLinks, getAllSocialLinks, createSocialLink, updateSocialLink, deleteSocialLink,
  createMarketingPost, getMarketingHistory, deleteMarketingPost,
  getActiveBooks, getActiveBooksForLocale, getAllBooks, getBook, getBookBySlug, createBook, updateBook,
  getChaptersByBook, getChapter, createChapter, updateChapter, deleteChapter, reorderChapters,
  getScenesByChapter, getScene, createScene, updateSceneKind, deleteScene, reorderScenes, setSceneImage, setSceneNarrationAudio,
  replaceNarrationSentences, getNarrationSentences, updateNarrationSentenceTiming, updateNarrationSentenceText,
  getFullBookText, invalidateBookTextCache, clearAllBookTextCache,
  getHotspotsByScene, getAllHotspotsByScene, getHotspot, createHotspot, updateHotspot, deleteHotspot,
  getAudioCuesByScene, getAudioCue, createAudioCue, updateAudioCue, deleteAudioCue,
  getBookFullTree,
  getActivitiesForBook, getActivitiesForChapter, createActivity,
  getClubMareMembership, joinClubMareFree, upgradeClubMareToPaid, getClubMarePosts,
  getAllClubMareMembersAdmin, setClubMareMemberTier, removeClubMareMembership,
  getAllClubMarePostsAdmin, createClubMarePost, updateClubMarePost, deleteClubMarePost,
  getActiveProducts, getProduct, getAllProductsAdmin, createProduct, updateProduct, deleteProduct,
  createOrder, setOrderStripeSession, markOrderPaid, addOrderItem,
  getReadingProgress, upsertReadingProgress,
  getWhatsNew, createWhatsNew, getAllWhatsNewAdmin, updateWhatsNew, deleteWhatsNew,
  hasSentMareMessageToday, logMareMessageSent, getEmailOptInParents,
  createBroadcast, getBroadcast, getAllBroadcasts, updateBroadcastContent,
  scheduleBroadcast, unscheduleBroadcast, deleteBroadcast, getDueScheduledBroadcasts,
  markBroadcastSending, markBroadcastSent, getBroadcastAudienceEmails,
  getAllOffers, getOfferByCode, createOffer, updateOffer, deleteOffer,
  getShowcaseContent, updateShowcaseContent, setShowcaseVideo, clearShowcaseVideo,
  getAllShowcasePhrasesAdmin, getActiveShowcasePhrases, createShowcasePhrase, updateShowcasePhrase, deleteShowcasePhrase,
  getAllShowcaseTilesAdmin, getActiveShowcaseTiles, createShowcaseTile, updateShowcaseTile, deleteShowcaseTile,
  createBulkImport, addBulkImportRow, markBulkImportRowResult, finishBulkImport,
  getBulkImport, getBulkImportRows, getAllBulkImports,
};
