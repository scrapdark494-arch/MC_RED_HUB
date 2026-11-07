require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const multer = require('multer');
const Database = require('better-sqlite3');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('En producción define SESSION_SECRET con al menos 32 caracteres aleatorios.');
}
const ROOT = __dirname;
// STORAGE_ROOT debe apuntar al volumen persistente del proveedor en producción.
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || ROOT);
const UPLOAD_DIR = path.join(STORAGE_ROOT, 'uploads');
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'mc-red-hub.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, google_id TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
    email TEXT, avatar TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mods (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, version TEXT NOT NULL,
    category TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT, file_name TEXT, file_path TEXT,
    external_url TEXT, cover_path TEXT, file_size INTEGER, created_at TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(author_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS skins (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, author_id TEXT NOT NULL,
    file_name TEXT NOT NULL, file_path TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(author_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, port INTEGER NOT NULL,
    version TEXT NOT NULL, requirements TEXT NOT NULL, description TEXT NOT NULL,
    creator_id TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(creator_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS native_auth_tickets (ticket_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, server_id TEXT NOT NULL, user_id TEXT NOT NULL,
    message TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);
// Migración compatible con bases ya creadas por versiones anteriores.
const modColumns = db.prepare('PRAGMA table_info(mods)').all().map(column => column.name);
if (!modColumns.includes('author_name')) db.exec('ALTER TABLE mods ADD COLUMN author_name TEXT');
const GUEST_AUTHOR_ID = 'mcrh_guest_author';
db.prepare('INSERT OR IGNORE INTO users (id,google_id,display_name,email,avatar,created_at) VALUES (?,?,?,?,?,?)')
  .run(GUEST_AUTHOR_ID, 'mcrh-internal-guest-author', 'Jugador invitado', '', '', new Date().toISOString());

class SqliteSessionStore extends session.Store {
  get(sid, callback) {
    try { const row = db.prepare('SELECT sess, expire FROM sessions WHERE sid=?').get(sid);
      if (!row) return callback(null, null);
      if (row.expire <= Date.now()) { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); return callback(null, null); }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback) {
    try { const expiry = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + (sess.cookie?.maxAge || 86400000);
      db.prepare('INSERT INTO sessions (sid,sess,expire) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire')
        .run(sid, JSON.stringify(sess), expiry); callback?.(null);
    } catch (error) { callback?.(error); }
  }
  destroy(sid, callback) { try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); callback?.(null); } catch (error) { callback?.(error); } }
  touch(sid, sess, callback) { this.set(sid, sess, callback); }
}

const sessionMiddleware = session({
  store: new SqliteSessionStore(),
  secret: process.env.SESSION_SECRET || 'mc-red-hub-development-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try { done(null, db.prepare('SELECT id, display_name, email, avatar FROM users WHERE id = ?').get(id) || false); }
  catch (error) { done(error); }
});

const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
if (googleEnabled) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL || `http://localhost:${PORT}`}/auth/google/callback`
  }, (_accessToken, _refreshToken, profile, done) => {
    try {
      const now = new Date().toISOString();
      const id = `g_${profile.id}`;
      const displayName = profile.displayName || 'Jugador';
      const email = profile.emails?.[0]?.value || '';
      const avatar = profile.photos?.[0]?.value || '';
      db.prepare(`INSERT INTO users (id, google_id, display_name, email, avatar, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(google_id) DO UPDATE SET display_name=excluded.display_name, email=excluded.email, avatar=excluded.avatar`)
        .run(id, profile.id, displayName, email, avatar, now);
      done(null, db.prepare('SELECT id, display_name, email, avatar FROM users WHERE id = ?').get(id));
    } catch (error) { done(error); }
  }));
}

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated?.() && req.user) return next();
  res.status(401).json({ error: 'Debes iniciar sesión con Google para realizar esta acción.' });
};
const safeUser = user => user ? ({ id: user.id, name: user.display_name, email: user.email, avatar: user.avatar }) : null;
const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

const AV_SCANNER_BIN = process.env.CLAMSCAN_BIN || 'clamscan';
const AV_SCAN_REQUIRED = process.env.AV_SCAN_REQUIRED !== 'false';
let antivirusReady = false;
let antivirusMessage = 'ClamAV no está configurado en este servidor.';
const antivirusCheck = (async () => {
  const probePath = path.join(DATA_DIR, `.clamav-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}.txt`);
  try {
    const { stdout } = await execFileAsync(AV_SCANNER_BIN, ['--version'], { timeout: 10000, maxBuffer: 1024 * 1024 });
    fs.writeFileSync(probePath, 'MC RED HUB antivirus readiness test\n');
    // También comprueba que ClamAV pueda cargar sus firmas, no solo que el binario exista.
    await execFileAsync(AV_SCANNER_BIN, ['--no-summary', probePath], { timeout: 30000, maxBuffer: 1024 * 1024 });
    antivirusReady = true;
    antivirusMessage = `ClamAV y sus firmas están disponibles: ${String(stdout || '').trim()}`;
  } catch (error) {
    antivirusReady = false;
    antivirusMessage = `ClamAV no está listo o no puede cargar sus firmas. Las subidas se bloquean mientras el antivirus sea obligatorio. ${String(error.message || '').slice(0,120)}`;
  } finally {
    try { fs.unlinkSync(probePath); } catch {}
  }
})();
class AntivirusUnavailableError extends Error { constructor(message) { super(message); this.code = 'AV_UNAVAILABLE'; } }
class InfectedUploadError extends Error { constructor(message) { super(message); this.code = 'AV_INFECTED'; } }
class AntivirusScanError extends Error { constructor(message) { super(message); this.code = 'AV_SCAN_FAILED'; } }
async function scanUploadedFile(file) {
  await antivirusCheck;
  if (!antivirusReady) { if (AV_SCAN_REQUIRED) throw new AntivirusUnavailableError(antivirusMessage); return { scanned:false }; }
  try {
    await execFileAsync(AV_SCANNER_BIN, ['--no-summary','--infected','--scan-archive=yes','--max-filesize=100M','--max-scansize=512M','--max-recursion=10',file.path], { timeout:120000, maxBuffer:2*1024*1024 });
    return { scanned:true };
  } catch (error) {
    const output = `${error.stdout || ''} ${error.stderr || ''}`;
    if (error.code === 1 || /FOUND/i.test(output)) throw new InfectedUploadError(`ClamAV detectó contenido malicioso en ${file.originalname}.`);
    if (error.code === 'ENOENT') throw new AntivirusUnavailableError('No se encontró ClamAV en el servidor.');
    throw new AntivirusScanError(`ClamAV no pudo analizar ${file.originalname}. ${String(error.message || '').slice(0,160)}`);
  }
}
function validateUploadSignature(file, kind) {
  const fd=fs.openSync(file.path,'r'), head=Buffer.alloc(24); let bytes;
  try { bytes=fs.readSync(fd,head,0,24,0); } finally { fs.closeSync(fd); }
  const h=head.subarray(0,bytes), ext=path.extname(file.originalname).toLowerCase();
  const isPng=h.length>=24&&h.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isJpeg=h.length>=3&&h[0]===0xff&&h[1]===0xd8&&h[2]===0xff;
  const isWebp=h.length>=12&&h.toString('ascii',0,4)==='RIFF'&&h.toString('ascii',8,12)==='WEBP';
  if(kind==='mod'){
    const isZip=h.length>=4&&h[0]===0x50&&h[1]===0x4b&&((h[2]===0x03&&h[3]===0x04)||(h[2]===0x05&&h[3]===0x06)||(h[2]===0x07&&h[3]===0x08));
    if(!isZip)throw new Error('El .mcpack/.mcaddon no parece ser un paquete ZIP válido.');
  } else if(kind==='skin') {
    if(!isPng)throw new Error('La skin no contiene una imagen PNG válida.');
    const w=h.readUInt32BE(16), height=h.readUInt32BE(20);
    if(!((w===64&&height===64)||(w===64&&height===32)))throw new Error('La skin PNG debe medir 64×64 o 64×32 píxeles.');
  } else if(kind==='image') {
    if((ext==='.png'&&!isPng)||(['.jpg','.jpeg'].includes(ext)&&!isJpeg)||(ext==='.webp'&&!isWebp))throw new Error('La portada no coincide con el formato de imagen declarado.');
  }
}
function removeUploadedFiles(files){for(const file of files||[]){if(file?.path){try{fs.unlinkSync(file.path);}catch{}}}}
const modUploadWindows=new Map();
function limitGuestModUploads(req,res,next){
  const ip=String(req.ip||req.socket?.remoteAddress||'unknown'), timestamp=Date.now(), windowMs=60*60*1000, maxUploads=req.user?12:4;
  const recent=(modUploadWindows.get(ip)||[]).filter(time=>timestamp-time<windowMs);
  if(recent.length>=maxUploads)return res.status(429).json({error:'Límite de publicaciones alcanzado. Intenta de nuevo dentro de una hora.'});
  recent.push(timestamp);modUploadWindows.set(ip,recent);
  if(modUploadWindows.size>5000)for(const [key,times] of modUploadWindows)if(!times.length||timestamp-times[times.length-1]>windowMs)modUploadWindows.delete(key);
  next();
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 2, fields: 12, parts: 16, fieldSize: 64 * 1024 },
  fileFilter: (req, file, cb) => {
    const kind = req.route?.path;
    if (!file.originalname) return cb(null, false);
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = kind === '/api/skins' ? ['.png'] : (file.fieldname === 'cover' ? ['.png', '.jpg', '.jpeg', '.webp'] : ['.mcpack', '.mcaddon']);
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Formato no permitido. Se acepta: ${allowed.join(', ')}`));
  }
});

const PUBLIC_BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ANDROID_GOOGLE_CALLBACK = `${PUBLIC_BASE_URL}/auth/google/android/callback`;
app.get('/auth/google', (req, res, next) => {
  if (!googleEnabled) return res.status(503).send('El inicio con Google aún no está configurado. Revisa README.md y las variables del servidor.');
  const isAndroid = req.query.client === 'android';
  const options = { scope: ['openid', 'profile', 'email'], state: true };
  if (isAndroid) options.callbackURL = ANDROID_GOOGLE_CALLBACK;
  passport.authenticate('google', options)(req, res, next);
});
function handleGoogleCallback(req, res, next) {
  if (!googleEnabled) return res.redirect('/?auth=not-configured');
  passport.authenticate('google', { failureRedirect: '/?auth=failed' })(req, res, () => {
    if (req.path === '/auth/google/android/callback' && req.user) {
      const ticket = crypto.randomBytes(32).toString('hex');
      const hash = crypto.createHash('sha256').update(ticket).digest('hex');
      db.prepare('INSERT INTO native_auth_tickets (ticket_hash,user_id,expires_at) VALUES (?,?,?)').run(hash, req.user.id, Date.now()+2*60*1000);
      db.prepare('DELETE FROM native_auth_tickets WHERE expires_at < ?').run(Date.now());
      return req.session.save(err => err ? next(err) : res.redirect(`mcredhub://auth?ticket=${ticket}`));
    }
    res.redirect('/');
  });
}
app.get('/auth/google/callback', handleGoogleCallback);
app.get('/auth/google/android/callback', handleGoogleCallback);
app.post('/auth/native/exchange', (req, res, next) => {
  const ticket = String(req.body?.ticket || '');
  if (!/^[a-f0-9]{64}$/.test(ticket)) return res.status(400).json({ error: 'Código de acceso no válido.' });
  const hash = crypto.createHash('sha256').update(ticket).digest('hex');
  const row = db.prepare('SELECT user_id,expires_at FROM native_auth_tickets WHERE ticket_hash=?').get(hash);
  if (!row || row.expires_at < Date.now()) { db.prepare('DELETE FROM native_auth_tickets WHERE ticket_hash=?').run(hash); return res.status(401).json({ error: 'El enlace de Google venció. Vuelve a iniciar sesión.' }); }
  db.prepare('DELETE FROM native_auth_tickets WHERE ticket_hash=?').run(hash);
  const user = db.prepare('SELECT id,display_name,email,avatar FROM users WHERE id=?').get(row.user_id);
  if (!user) return res.status(401).json({ error: 'La cuenta de Google ya no está disponible.' });
  req.login(user, err => { if (err) return next(err); req.session.save(saveError => saveError ? next(saveError) : res.json({ ok:true, user:safeUser(user) })); });
});
app.post('/auth/logout', (req, res, next) => req.logout(err => {
  if (err) return next(err);
  req.session.destroy(() => res.json({ ok: true }));
}));

app.get('/api/config', async (_req, res) => { await antivirusCheck; res.json({ googleAuthEnabled: googleEnabled, antivirus: { ready: antivirusReady, required: AV_SCAN_REQUIRED, message: antivirusMessage } }); });
app.get('/api/me', (req, res) => res.json({ user: safeUser(req.user) }));

app.get('/api/mods', (req, res) => {
  const q = String(req.query.q || '').trim();
  const version = String(req.query.version || '').trim();
  const category = String(req.query.category || '').trim();
  const sort = req.query.sort === 'downloads' ? 'downloads DESC, created_at DESC' : 'created_at DESC';
  let sql = `SELECT m.id, m.title, m.description, m.version, m.category, m.file_name,
    m.external_url, m.cover_path, m.file_size, m.created_at, m.downloads, COALESCE(NULLIF(m.author_name,''),u.display_name) AS author
    FROM mods m JOIN users u ON u.id=m.author_id WHERE 1=1`;
  const args = [];
  if (q) { sql += ' AND (m.title LIKE ? OR m.description LIKE ? OR u.display_name LIKE ? OR m.author_name LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (version) { sql += ' AND m.version LIKE ?'; args.push(`%${version}%`); }
  if (category) { sql += ' AND m.category = ?'; args.push(category); }
  sql += ` ORDER BY ${sort} LIMIT 100`;
  res.json({ mods: db.prepare(sql).all(...args).map(m => ({ ...m, coverUrl: m.cover_path ? `/api/mods/${m.id}/cover` : null, downloadUrl: `/api/mods/${m.id}/download` })) });
});
app.post('/api/mods', limitGuestModUploads, upload.fields([{ name:'file',maxCount:1 },{ name:'cover',maxCount:1 }]), async (req,res) => {
  const uploaded=[...(req.files?.file||[]),...(req.files?.cover||[])];
  try {
    const {title,description,version,category,externalUrl,creatorName}=req.body;
    if(!title?.trim()||!description?.trim()||!version?.trim()||!category?.trim()){removeUploadedFiles(uploaded);return res.status(400).json({error:'Completa nombre, descripción, versión y categoría.'});}
    const modFile=req.files?.file?.[0],coverFile=req.files?.cover?.[0];
    if(!modFile&&!externalUrl?.trim()){removeUploadedFiles(uploaded);return res.status(400).json({error:'Adjunta un .mcpack/.mcaddon o escribe un enlace de descarga.'});}
    if(externalUrl&&!/^https:\/\//i.test(externalUrl)){removeUploadedFiles(uploaded);return res.status(400).json({error:'El enlace externo debe comenzar con https://.'});}
    if(modFile){validateUploadSignature(modFile,'mod');await scanUploadedFile(modFile);}
    if(coverFile){validateUploadSignature(coverFile,'image');await scanUploadedFile(coverFile);}
    const id=makeId(),authorId=req.user?.id||GUEST_AUTHOR_ID,authorName=String(creatorName||'').trim().slice(0,60)||null;
    db.prepare(`INSERT INTO mods (id,title,description,version,category,author_id,author_name,file_name,file_path,external_url,cover_path,file_size,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,title.trim(),description.trim(),version.trim(),category.trim(),authorId,authorName,modFile?.originalname||null,modFile?.path||null,externalUrl?.trim()||null,coverFile?.path||null,modFile?.size||null,now());
    res.status(201).json({ok:true,id,author:authorName||req.user?.display_name||'Jugador invitado'});
  } catch(error) {
    removeUploadedFiles(uploaded);
    if(error.code==='AV_UNAVAILABLE')return res.status(503).json({error:error.message});
    if(error.code==='AV_INFECTED')return res.status(422).json({error:error.message});
    if(error.code==='AV_SCAN_FAILED')return res.status(503).json({error:error.message});
    res.status(400).json({error:error.message||'No se pudo publicar el complemento.'});
  }
});
app.get('/api/mods/:id/cover', (req, res) => {
  const mod = db.prepare('SELECT cover_path FROM mods WHERE id=?').get(req.params.id);
  if (!mod?.cover_path || !fs.existsSync(mod.cover_path)) return res.status(404).send('Portada no disponible.');
  res.sendFile(path.resolve(mod.cover_path));
});
app.get('/api/mods/:id/download', (req, res) => {
  const mod = db.prepare('SELECT * FROM mods WHERE id=?').get(req.params.id);
  if (!mod) return res.status(404).send('Complemento no encontrado.');
  db.prepare('UPDATE mods SET downloads=downloads+1 WHERE id=?').run(mod.id);
  if (mod.file_path && fs.existsSync(mod.file_path)) return res.download(mod.file_path, mod.file_name || path.basename(mod.file_path));
  if (mod.external_url) return res.redirect(mod.external_url);
  res.status(404).send('El archivo ya no está disponible.');
});

app.get('/api/skins', (_req, res) => {
  const skins = db.prepare(`SELECT s.id, s.name, s.file_name, s.created_at, u.display_name AS author
    FROM skins s JOIN users u ON u.id=s.author_id ORDER BY s.created_at DESC LIMIT 100`).all()
    .map(s => ({ ...s, imageUrl: `/api/skins/${s.id}/image`, downloadUrl: `/api/skins/${s.id}/download` }));
  res.json({ skins });
});
app.post('/api/skins', requireAuth, upload.single('file'), async (req,res) => {
  if(!req.file)return res.status(400).json({error:'Selecciona una imagen PNG de skin.'});
  try {
    validateUploadSignature(req.file,'skin');await scanUploadedFile(req.file);
    const name=String(req.body.name||'Skin sin nombre').trim().slice(0,80),id=makeId();
    db.prepare('INSERT INTO skins (id,name,author_id,file_name,file_path,created_at) VALUES (?,?,?,?,?,?)').run(id,name,req.user.id,req.file.originalname,req.file.path,now());
    res.status(201).json({ok:true,id});
  } catch(error) {
    removeUploadedFiles([req.file]);
    if(error.code==='AV_UNAVAILABLE')return res.status(503).json({error:error.message});
    if(error.code==='AV_INFECTED')return res.status(422).json({error:error.message});
    if(error.code==='AV_SCAN_FAILED')return res.status(503).json({error:error.message});
    res.status(400).json({error:error.message||'No se pudo publicar la skin.'});
  }
});
app.get('/api/skins/:id/image', (req, res) => {
  const skin = db.prepare('SELECT * FROM skins WHERE id=?').get(req.params.id);
  if (!skin || !fs.existsSync(skin.file_path)) return res.status(404).send('Skin no encontrada.');
  res.type('png').sendFile(path.resolve(skin.file_path));
});
app.get('/api/skins/:id/download', (req, res) => {
  const skin = db.prepare('SELECT * FROM skins WHERE id=?').get(req.params.id);
  if (!skin || !fs.existsSync(skin.file_path)) return res.status(404).send('Skin no encontrada.');
  res.download(skin.file_path, skin.file_name);
});

app.get('/api/servers', (_req, res) => {
  const servers = db.prepare(`SELECT s.id,s.name,s.address,s.port,s.version,s.requirements,s.description,s.created_at,
    s.creator_id,u.display_name AS creator FROM servers s JOIN users u ON u.id=s.creator_id ORDER BY s.created_at DESC LIMIT 100`).all();
  res.json({ servers });
});
app.post('/api/servers', requireAuth, (req, res) => {
  const { name, address, port, version, requirements, description } = req.body;
  const p = Number(port || 19132);
  if (!name?.trim() || !address?.trim() || !version?.trim() || !description?.trim()) return res.status(400).json({ error: 'Completa nombre, dirección, versión y descripción.' });
  if (!Number.isInteger(p) || p < 1 || p > 65535) return res.status(400).json({ error: 'El puerto debe estar entre 1 y 65535.' });
  const id = makeId();
  db.prepare(`INSERT INTO servers (id,name,address,port,version,requirements,description,creator_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, name.trim(), address.trim(), p, version.trim(), String(requirements || '').trim(), description.trim(), req.user.id, now());
  res.status(201).json({ ok: true, id });
});

app.get('/api/chat/:serverId', requireAuth, (req, res) => {
  const exists = db.prepare('SELECT id FROM servers WHERE id=?').get(req.params.serverId);
  if (!exists) return res.status(404).json({ error: 'Servidor no encontrado.' });
  const messages = db.prepare(`SELECT m.id,m.message,m.created_at,u.id AS user_id,u.display_name AS user_name,u.avatar,
    s.creator_id FROM messages m JOIN users u ON u.id=m.user_id JOIN servers s ON s.id=m.server_id
    WHERE m.server_id=? ORDER BY m.created_at DESC LIMIT 100`).all(req.params.serverId).reverse()
    .map(m => ({ id:m.id, text:m.message, createdAt:m.created_at, userId:m.user_id, userName:m.user_name, avatar:m.avatar, isCreator:m.user_id===m.creator_id }));
  res.json({ messages });
});

// Socket.IO comparte la sesión de Express: solo usuarios con sesión Google pueden entrar al chat.
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const userId = socket.request.session?.passport?.user;
  if (!userId) return next(new Error('Inicia sesión con Google para usar el chat.'));
  const user = db.prepare('SELECT id,display_name,avatar FROM users WHERE id=?').get(userId);
  if (!user) return next(new Error('Sesión no válida. Vuelve a iniciar sesión.'));
  socket.user = user;
  next();
});
io.on('connection', socket => {
  socket.on('chat:join', serverId => {
    const serverRow = db.prepare('SELECT id FROM servers WHERE id=?').get(String(serverId));
    if (!serverRow) return socket.emit('chat:error', 'Servidor no encontrado.');
    for (const room of socket.rooms) if (room.startsWith('server:')) socket.leave(room);
    socket.join(`server:${serverId}`);
    const messages = db.prepare(`SELECT m.id,m.message,m.created_at,u.id AS user_id,u.display_name AS user_name,u.avatar,
      s.creator_id FROM messages m JOIN users u ON u.id=m.user_id JOIN servers s ON s.id=m.server_id
      WHERE m.server_id=? ORDER BY m.created_at DESC LIMIT 100`).all(serverId).reverse()
      .map(m => ({ id:m.id, text:m.message, createdAt:m.created_at, userId:m.user_id, userName:m.user_name, avatar:m.avatar, isCreator:m.user_id===m.creator_id }));
    socket.emit('chat:history', messages);
  });
  socket.on('chat:message', payload => {
    const serverId = String(payload?.serverId || '');
    const message = String(payload?.text || '').trim().slice(0, 1000);
    if (!message) return;
    const serverRow = db.prepare('SELECT id,creator_id FROM servers WHERE id=?').get(serverId);
    if (!serverRow) return socket.emit('chat:error', 'Servidor no encontrado.');
    const id = makeId(); const createdAt = now();
    db.prepare('INSERT INTO messages (id,server_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
      .run(id, serverId, socket.user.id, message, createdAt);
    io.to(`server:${serverId}`).emit('chat:message', {
      id, text:message, createdAt, userId:socket.user.id, userName:socket.user.display_name,
      avatar:socket.user.avatar, isCreator:socket.user.id===serverRow.creator_id
    });
  });
});

app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false }));
app.use(express.static(path.join(ROOT, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.use((error,_req,res,_next)=>{
  console.error(error);
  if(error instanceof multer.MulterError)return res.status(400).json({error:error.message});
  if(error.code==='AV_UNAVAILABLE'||error.code==='AV_SCAN_FAILED')return res.status(503).json({error:error.message});
  if(error.code==='AV_INFECTED')return res.status(422).json({error:error.message});
  res.status(400).json({error:error.message||'Ocurrió un error.'});
});

server.listen(PORT, () => console.log(`MC RED HUB activo en http://localhost:${PORT}`));
