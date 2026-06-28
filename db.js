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

  // ── Clients ──
  db.run(`CREATE TABLE IF NOT EXISTS clients (
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
    created_at TEXT DEFAULT (datetime('now')),
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
    FOREIGN KEY (client_id) REFERENCES clients(id)
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
    FOREIGN KEY (client_id) REFERENCES clients(id)
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

  // ── Content play history ──
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

  // ── Migrations — add columns if they don't exist ──
  const migrations = [
    "ALTER TABLE clients ADD COLUMN category_id TEXT",
    "ALTER TABLE clients ADD COLUMN subcategory_id TEXT",
    "ALTER TABLE clients ADD COLUMN must_change_password INTEGER DEFAULT 1",
    "ALTER TABLE facilitators ADD COLUMN must_change_password INTEGER DEFAULT 1",
    "ALTER TABLE sessions ADD COLUMN facilitator_id TEXT",
    "ALTER TABLE sessions ADD COLUMN client_summary TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN is_system_client INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN is_member INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN membership_level TEXT DEFAULT 'registered'",
    "ALTER TABLE clients ADD COLUMN is_client INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN registered_at TEXT DEFAULT (datetime('now'))",
    "ALTER TABLE library_files ADD COLUMN visibility_registered INTEGER DEFAULT 0",
    "ALTER TABLE library_files ADD COLUMN visibility_member INTEGER DEFAULT 0",
    "ALTER TABLE library_files ADD COLUMN visibility_client INTEGER DEFAULT 1",
    "ALTER TABLE library_files ADD COLUMN visibility_facilitator INTEGER DEFAULT 0",
  ];
  migrations.forEach(sql => {
    try { db.run(sql); } catch(e) { /* column already exists — ignore */ }
  });

  // Seed categories if empty
  const existing = queryAll('SELECT id FROM categories LIMIT 1');
  if (!existing.length) seedCategories();

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
function addLibraryFile(id, title, description, filename, originalName, fileType, fileSize, categoryId, subcategoryId, visibility) {
  getDbSync().run(`INSERT INTO library_files 
    (id,title,description,filename,original_name,file_type,file_size,category_id,subcategory_id,visibility)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, title, description||'', filename, originalName, fileType, fileSize||0,
     categoryId, subcategoryId||null, visibility||'client']);
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
  getDbSync().run('UPDATE library_files SET filename=? WHERE id=?', [filename, id]);
  save();
}

function deleteLibraryFile(id) {
  // Remove refs first
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

// ── Clients ──
function createClient(id, name, facilitatorId, email, passwordHash, categoryId, subcategoryId) {
  getDbSync().run('INSERT INTO clients (id,name,facilitator_id,email,password_hash,category_id,subcategory_id) VALUES (?,?,?,?,?,?,?)',
    [id, name, facilitatorId, email||null, passwordHash||null, categoryId||null, subcategoryId||null]); save();
}
function getClient(id) { return queryOne('SELECT * FROM clients WHERE id=?', [id]); }
function getClientByEmail(email) {
  if (!email) return null;
  return queryOne('SELECT * FROM clients WHERE email=?', [email.toLowerCase()]);
}
function getAllClients(facilitatorId, includeArchived = false) {
  const sql = includeArchived
    ? 'SELECT * FROM clients WHERE facilitator_id=? ORDER BY name ASC'
    : 'SELECT * FROM clients WHERE facilitator_id=? AND archived=0 ORDER BY name ASC';
  return queryAll(sql, [facilitatorId]);
}
function getAllClientsAdmin(includeArchived = false) {
  const where = includeArchived ? '' : 'WHERE c.archived=0';
  return queryAll(`SELECT c.*, f.name as facilitator_name, cat.name as category_name, sub.name as subcategory_name
    FROM clients c LEFT JOIN facilitators f ON c.facilitator_id=f.id
    LEFT JOIN categories cat ON c.category_id=cat.id
    LEFT JOIN categories sub ON c.subcategory_id=sub.id ${where} ORDER BY c.name ASC`);
}
function updateArc(clientId, arc) { getDbSync().run('UPDATE clients SET arc=? WHERE id=?', [arc, clientId]); save(); }
function archiveClient(id) { getDbSync().run('UPDATE clients SET archived=1-archived WHERE id=?', [id]); save(); }
function updateClientPassword(id, hash) {
  getDbSync().run('UPDATE clients SET password_hash=?,must_change_password=0 WHERE id=?', [hash, id]); save();
}
function updateClientEmail(id, email) { getDbSync().run('UPDATE clients SET email=? WHERE id=?', [email.toLowerCase(), id]); save(); }
function updateClientProgramme(id, categoryId, subcategoryId) {
  getDbSync().run('UPDATE clients SET category_id=?,subcategory_id=? WHERE id=?', [categoryId, subcategoryId||null, id]); save();
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
  getDbSync().run('INSERT INTO content_history (id,user_id,user_type,content_type,content_id) VALUES (?,?,?,?,?)',
    [id, userId, userType, contentType, contentId]); save();
}

// ── Self-registration ──
function registerUser(id, name, email, passwordHash) {
  getDbSync().run(
    `INSERT INTO clients (id,name,email,password_hash,facilitator_id,arc,archived,must_change_password,is_member,membership_level,is_client,is_system_client)
     VALUES (?,?,?,?,NULL,'',0,0,0,'registered',0,1)`,
    [id, name, email.toLowerCase()]
  );
  // Set password separately since it's optional in some flows
  getDbSync().run('UPDATE clients SET password_hash=? WHERE id=?', [passwordHash, id]);
  save();
}

function getUserByEmail(email) {
  return queryOne('SELECT * FROM clients WHERE email=? AND archived=0', [email.toLowerCase()]);
}

function upgradeToMember(clientId, level = 'member') {
  getDbSync().run('UPDATE clients SET is_member=1, membership_level=? WHERE id=?', [level, clientId]);
  save();
}

function markAsClient(clientId, facilitatorId) {
  getDbSync().run('UPDATE clients SET is_client=1, facilitator_id=? WHERE id=?', [facilitatorId, clientId]);
  save();
}

// ── System client flag ──
function markAsSystemClient(id) {
  getDbSync().run('UPDATE clients SET is_system_client=1, facilitator_id=NULL WHERE id=?', [id]);
  save();
}

// ── Content visibility — filter by user access flags ──
function getLibraryFilesForUser(userFlags) {
  // userFlags: { isRegistered, isMember, isClient, isFacilitator, isAdmin }
  const files = queryAll('SELECT * FROM library_files WHERE 1=1 ORDER BY title ASC');
  return files.filter(f => {
    if (userFlags.isAdmin)       return true;
    if (userFlags.isFacilitator) return true;
    if (f.visibility_client      && userFlags.isClient)     return true;
    if (f.visibility_member      && userFlags.isMember)     return true;
    if (f.visibility_registered  && userFlags.isRegistered) return true;
    return false;
  }).map(f => ({
    ...f,
    accessible: true // all returned files are accessible to this user
  }));
}

function getAllLibraryFilesWithAccess(userFlags) {
  // Returns all files, marks each with accessibility — for guest/explore view
  const files = queryAll('SELECT * FROM library_files ORDER BY title ASC');
  return files.map(f => ({
    ...f,
    accessible: (
      userFlags.isAdmin ||
      userFlags.isFacilitator ||
      (f.visibility_client     && userFlags.isClient) ||
      (f.visibility_member     && userFlags.isMember) ||
      (f.visibility_registered && userFlags.isRegistered)
    )
  }));
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
function getGuestLeads() {
  return queryAll('SELECT * FROM guest_leads ORDER BY created_at DESC');
}
function deleteGuestLead(id) {
  getDbSync().run('DELETE FROM guest_leads WHERE id=?', [id]);
  save();
}
function getGuestLead(id) {
  return queryOne('SELECT * FROM guest_leads WHERE id=?', [id]);
}
function updateClientDetails(id, name, email, facilitatorId) {
  getDbSync().run('UPDATE clients SET name=?,email=?,facilitator_id=? WHERE id=?',
    [name, email||null, facilitatorId||null, id]);
  save();
}
function deleteClient(id) {
  getDbSync().run('DELETE FROM clients WHERE id=?', [id]);
  save();
}

module.exports = {
  getDb, save,
  // Facilitators
  createFacilitator, getFacilitatorByEmail, getFacilitatorById,
  getAllFacilitators, updateFacilitatorPassword, updateFacilitatorDetails,
  archiveFacilitator, unarchiveFacilitator, deleteFacilitator,
  // Categories
  getAllCategories, getTopCategories, getSubcategories,
  createCategory, renameCategory, deleteCategory,
  // Library
  addLibraryFile, getLibraryFile, getLibraryFiles, updateLibraryFile,
  renameLibraryFile, deleteLibraryFile, getFileUsage,
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
  // Clients
  createClient, getClient, getClientByEmail, getAllClients, getAllClientsAdmin,
  updateArc, archiveClient, updateClientPassword, updateClientEmail, updateClientProgramme,
  // Sessions
  addSession, getSessionsForClient, getClientSessionsForClient,
  // Practices
  addPractice, getPracticesForClient, toggleFavourite, incrementUseCount, deletePractice,
  // Programmes
  assignProgramme, getProgrammesForUser,
  // History
  recordPlay,
  // Registration
  registerUser, getUserByEmail, upgradeToMember, markAsClient,
  // Content visibility
  getLibraryFilesForUser, getAllLibraryFilesWithAccess,
  // System client
  markAsSystemClient,
  // Invitations
  createInvitation, getInvitationByToken, acceptInvitation, getInvitationsForFacilitator,
  // Guest leads
  addGuestLead, getGuestLeads, deleteGuestLead, getGuestLead,
  // Client management
  updateClientDetails, deleteClient,
};
