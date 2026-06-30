const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

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
    // ── clients → users rename migration ──
    // SQLite cannot rename tables in older versions, so we use a copy-and-rename
    // approach via the migration block below. Handled separately after this list.
  ];
  migrations.forEach(sql => {
    try { db.run(sql); } catch(e) { /* column already exists — ignore */ }
  });

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

  // Seed categories if empty
  const existing = queryAll('SELECT id FROM categories LIMIT 1');
  if (!existing.length) seedCategories();

  // Seed default membership plans if empty
  const existingPlans = queryAll('SELECT id FROM membership_plans LIMIT 1');
  if (!existingPlans.length) seedMembershipPlans();

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
function getLessonsForCourse(courseId) {
  return queryAll('SELECT * FROM lessons WHERE course_id=? ORDER BY lesson_number ASC', [courseId]);
}
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
function deleteClient(id) {
  getDbSync().run('DELETE FROM users WHERE id=?', [id]);
  save();
}

// ── Self-registration ──
function registerUser(id, name, email, passwordHash) {
  getDbSync().run(
    `INSERT INTO users (id,name,email,password_hash,facilitator_id,arc,archived,must_change_password,member_tier,is_client,is_system_client)
     VALUES (?,?,?,?,NULL,'',0,0,0,0,1)`,
    [id, name, email.toLowerCase()]
  );
  getDbSync().run('UPDATE users SET password_hash=? WHERE id=?', [passwordHash, id]);
  save();
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
  const allowed = ['pref_email_motd','pref_email_reminders','pref_email_renewal','pref_email_news','pref_sms','phone','language'];
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
function addSession(id, clientId, facilitatorId, type, summary, clientSummary) {
  getDbSync().run('INSERT INTO sessions (id,client_id,facilitator_id,type,summary,client_summary) VALUES (?,?,?,?,?,?)',
    [id, clientId, facilitatorId, type, summary, clientSummary||'']); save();
}
function getSessionsForClient(clientId) {
  return queryAll('SELECT * FROM sessions WHERE client_id=? ORDER BY created_at DESC', [clientId]);
}
function getClientSessionsForClient(clientId) {
  return queryAll('SELECT id,type,client_summary,created_at FROM sessions WHERE client_id=? AND client_summary!="" ORDER BY created_at DESC', [clientId]);
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
// Get users who haven't been active in the last N days (for reminder emails)
function getInactiveUsers(days = 4) {
  return queryAll(
    `SELECT u.id, u.name, u.email FROM users u
     WHERE u.pref_email_reminders=1
       AND u.email IS NOT NULL
       AND u.archived=0
       AND NOT EXISTS (
         SELECT 1 FROM content_history ch
         WHERE ch.user_id=u.id
           AND ch.played_at > datetime('now', '-${days} days')
       )`,
    []
  );
}

module.exports = {
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
  createCourse, getCourse, getAllCourses, deleteCourse,
  // Lessons
  createLesson, getLessonsForCourse, deleteLesson,
  // Lesson file refs
  addLessonFileRef, getFilesForLesson, removeLessonFileRef,
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
  updateClientDetails, deleteClient,
  // Membership
  setMemberTier, upgradeToMember, downgradeToExplorer, markAsClient, markAsSystemClient,
  // Preferences
  updateUserPreferences, userFlagsFromRecord,
  // Sessions
  addSession, getSessionsForClient, getClientSessionsForClient,
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
  registerUser,
  // Content visibility
  getLibraryFilesForUser, getAllLibraryFilesWithAccess, canAccessFile, getFacilitatorResources,
  userMaxLevel, LEVEL_RANK,
  // Invitations
  createInvitation, getInvitationByToken, acceptInvitation, getInvitationsForFacilitator,
  // Guest leads
  addGuestLead, getGuestLeads, deleteGuestLead, getGuestLead,
  // Membership plans
  getMembershipPlans, updateMembershipPlan,
  // MOTD
  addMotd, getMotd, getAllMotd, approveMotd, updateMotd, deleteMotd,
  markMotdSent, countApprovedMotd, getNextMotdToSend, getMotdRecipients,
  // Reminders
  getInactiveUsers,
};
