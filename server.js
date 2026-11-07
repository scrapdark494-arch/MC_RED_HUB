require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUCKET = process.env.SUPABASE_BUCKET || 'mcrh-files';
const MAX_FILE_MB = Math.min(50, Math.max(1, Number(process.env.MAX_FILE_MB || 50)));
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. Configúralas en las variables de entorno del servidor.');
}
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
// La interfaz web pública también se sirve desde este host; el APK puede usar su copia local. El dominio funciona como API y permite
// llamadas desde el origen local del WebView (Origin: null), siempre con token por perfil.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 2, fields: 20, parts: 24 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.mcpack', '.mcaddon', '.mcworld', '.zip', '.png', '.jpg', '.jpeg', '.webp'];
    if (!allowed.includes(ext)) return cb(new Error('Formato no permitido.'));
    cb(null, true);
  }
});

const makeId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const fileSafe = name => String(name || 'archivo').normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'archivo';
const profileView = async profile => {
  let avatarUrl = null;
  if (profile?.avatar_path && supabase) avatarUrl = await signedUrl(profile.avatar_path, false);
  return profile ? { id: profile.id, name: profile.username, avatar: avatarUrl, created_at: profile.created_at } : null;
};
function ensureSupabase(_req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'El servidor aún no está conectado a la base de datos central.' });
  next();
}

async function logActivity({ action, type, id = null, item, userId = null, userName = 'Comunidad' }) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('activity').insert({
      id: makeId(), action, content_type: type, content_id: id,
      content_name: String(item || '').slice(0, 140), user_id: userId,
      user_name: String(userName || 'Comunidad').slice(0, 40), created_at: now()
    });
    if (error) console.error('No se pudo guardar la actividad:', error.message);
  } catch (error) { console.error('No se pudo guardar la actividad:', error.message); }
}
async function signedUrl(filePath, asDownload = false, fileName = undefined) {
  if (!filePath || !supabase) return null;
  const options = asDownload ? { download: fileName || true } : undefined;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 3600, options);
  if (error) throw error;
  return data.signedUrl;
}
function validateFile(file, kind) {
  if (!file?.buffer?.length) throw new Error('No se recibió ningún archivo.');
  const b = file.buffer;
  const ext = path.extname(file.originalname || '').toLowerCase();
  const isPng = b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isJpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isWebp = b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && [0x03,0x05,0x07].includes(b[2]);
  if (kind === 'image' && !((ext === '.png' && isPng) || (['.jpg','.jpeg'].includes(ext) && isJpeg) || (ext === '.webp' && isWebp))) {
    throw new Error('La imagen no coincide con un PNG, JPG o WEBP válido.');
  }
  if (['mod','world'].includes(kind) && !(['.mcpack','.mcaddon','.mcworld','.zip'].includes(ext) && isZip)) {
    throw new Error('El archivo debe ser un paquete o mundo ZIP válido de Minecraft.');
  }
  if (kind === 'skin' && !(ext === '.png' && isPng)) throw new Error('La skin debe ser un PNG válido.');
}
async function storeFile(file, folder, kind) {
  validateFile(file, kind);
  const key = `${folder}/${makeId()}-${fileSafe(file.originalname)}`;
  const contentType = file.mimetype || 'application/octet-stream';
  const { error } = await supabase.storage.from(BUCKET).upload(key, file.buffer, { contentType, upsert: false });
  if (error) throw error;
  return key;
}
async function removeFile(key) {
  if (!key || !supabase) return;
  try { await supabase.storage.from(BUCKET).remove([key]); } catch {}
}
async function getProfileForToken(token) {
  if (!token || !supabase) return null;
  const hash = tokenHash(token);
  const { data: tokenRow, error: tokenError } = await supabase.from('api_tokens').select('user_id').eq('token_hash', hash).maybeSingle();
  if (tokenError) throw tokenError;
  if (!tokenRow) return null;
  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', tokenRow.user_id).maybeSingle();
  if (error) throw error;
  return profile ? { ...profile, token_hash: hash } : null;
}
async function authMiddleware(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Crea o conecta tu perfil de MC RED HUB para continuar.' });
    const profile = await getProfileForToken(token);
    if (!profile) return res.status(401).json({ error: 'La sesión de este dispositivo ya no es válida. Recupera tu perfil.' });
    req.user = profile;
    next();
  } catch (error) { next(error); }
}
const signupAttempts = new Map();
function limitSignup(req, res, next) {
  const ip = String(req.ip || 'unknown');
  const t = Date.now();
  const list = (signupAttempts.get(ip) || []).filter(x => t - x < 60 * 60 * 1000);
  if (list.length >= 8) return res.status(429).json({ error: 'Has creado demasiados perfiles desde esta conexión. Inténtalo más tarde.' });
  list.push(t); signupAttempts.set(ip, list); next();
}

app.get('/api/health', ensureSupabase, async (_req, res) => {
  const { error } = await supabase.from('profiles').select('id').limit(1);
  if (error) return res.status(503).json({ error: `No se pudo conectar con la base de datos: ${error.message}` });
  const { error: storageError } = await supabase.storage.getBucket(BUCKET);
  if (storageError) return res.status(503).json({ error: `La base de datos responde, pero Storage no está disponible: ${storageError.message}` });
  res.json({ ok: true, service: 'MC RED HUB', onlineRequired: true, database: 'connected', storage: 'connected' });
});
app.get('/api/config', ensureSupabase, (_req, res) => res.json({ authMode: 'nickname-avatar-device-token', onlineRequired: true, maxUploadMb: MAX_FILE_MB, storage: 'private-cloud-bucket' }));


// Panel público de solo lectura: no contiene contraseñas, tokens ni rutas privadas.
app.get('/api/public/dashboard', ensureSupabase, async (_req, res, next) => {
  try {
    const [usersQ, modsQ, skinsQ, worldsQ, serversQ, reviewsQ, messagesQ, activityQ] = await Promise.all([
      supabase.from('profiles').select('id,username,avatar_path,created_at').order('created_at',{ascending:false}).limit(250),
      supabase.from('mods').select('id,title,author_name,file_name,file_path,external_url,cover_path,file_size,created_at,downloads').order('created_at',{ascending:false}).limit(250),
      supabase.from('skins').select('id,name,author_name,file_name,file_path,created_at,downloads').order('created_at',{ascending:false}).limit(250),
      supabase.from('worlds').select('id,name,author_name,file_name,file_path,file_size,created_at,downloads').order('created_at',{ascending:false}).limit(250),
      supabase.from('servers').select('id,name,address,port,version,creator,created_at').order('created_at',{ascending:false}).limit(250),
      supabase.from('reviews').select('id,target_type,target_name,user_name,rating,comment,created_at').order('created_at',{ascending:false}).limit(250),
      supabase.from('messages').select('id,server_id,user_name,message,created_at').order('created_at',{ascending:false}).limit(150),
      supabase.from('activity').select('id,action,content_type,content_name,user_name,created_at').order('created_at',{ascending:false}).limit(250)
    ]);
    for (const q of [usersQ,modsQ,skinsQ,worldsQ,serversQ,reviewsQ,messagesQ,activityQ]) if (q.error) throw q.error;
    const users = await Promise.all((usersQ.data||[]).map(async u => ({
      id: String(u.id).slice(0,8), name:u.username, photo:await signedUrl(u.avatar_path), date:u.created_at
    })));
    const mods=await Promise.all((modsQ.data||[]).map(async x=>({name:x.title,creator:x.author_name,file:x.file_name||'Enlace externo',downloadUrl:x.file_path?await signedUrl(x.file_path,true,x.file_name):x.external_url,uploads:1,downloads:Number(x.downloads||0),date:x.created_at})));
    const skins=await Promise.all((skinsQ.data||[]).map(async x=>({name:x.name,creator:x.author_name,file:x.file_name,downloadUrl:await signedUrl(x.file_path,true,x.file_name),uploads:1,downloads:Number(x.downloads||0),date:x.created_at})));
    const worlds=await Promise.all((worldsQ.data||[]).map(async x=>({name:x.name,creator:x.author_name,file:x.file_name,downloadUrl:await signedUrl(x.file_path,true,x.file_name),size:`${(Number(x.file_size||0)/1048576).toFixed(1)} MB`,downloads:Number(x.downloads||0),date:x.created_at})));
    const servers=(serversQ.data||[]).map(x=>({name:x.name,ip:x.address,port:x.port,version:x.version,addedBy:x.creator,date:x.created_at}));
    const reviews=(reviewsQ.data||[]).map(x=>({type:x.target_type,item:x.target_name,user:x.user_name,rating:x.rating,comment:x.comment,date:x.created_at}));
    const serverNames=new Map((serversQ.data||[]).map(s=>[s.id,s.name]));
    const chats=(messagesQ.data||[]).map(x=>({user:x.user_name,server:serverNames.get(x.server_id)||'Servidor',message:x.message,date:x.created_at}));
    const activity=(activityQ.data||[]).map(x=>({action:x.action,type:x.content_type,item:x.content_name,user:x.user_name,date:x.created_at}));
    const downloads=[...mods,...skins,...worlds].reduce((sum,x)=>sum+x.downloads,0);
    res.setHeader('Cache-Control','no-store');
    res.json({ok:true,generatedAt:now(),stats:{users:users.length,mods:mods.length,skins:skins.length,worlds:worlds.length,servers:servers.length,reviews:reviews.length,messages:chats.length,downloads},users,mods,skins,worlds,servers,reviews,chats,activity});
  } catch (error) { next(error); }
});

app.post('/api/auth/register', ensureSupabase, limitSignup, upload.single('avatar'), async (req, res, next) => {
  let avatarPath = null;
  try {
    const username = String(req.body.username || '').trim().replace(/\s+/g, ' ');
    if (username.length < 3 || username.length > 24 || !/^[\p{L}\p{N} _.-]+$/u.test(username)) return res.status(400).json({ error: 'El Nick debe tener entre 3 y 24 caracteres. Usa letras, números, espacios, guion, punto o guion bajo.' });
    if (!req.file) return res.status(400).json({ error: 'Selecciona una foto para tu perfil.' });
    if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'La foto de perfil no puede superar 2 MB.' });
    validateFile(req.file, 'image');
    const usernameNorm = username.toLocaleLowerCase('es');
    const { data: existing, error: findError } = await supabase.from('profiles').select('id').eq('username_norm', usernameNorm).maybeSingle();
    if (findError) throw findError;
    if (existing) return res.status(409).json({ error: 'Ese Nick ya está ocupado. Elige otro.' });
    const id = makeId();
    avatarPath = await storeFile(req.file, `profiles/${id}`, 'image');
    const { data: profile, error: profileError } = await supabase.from('profiles').insert({ id, username, username_norm: usernameNorm, avatar_path: avatarPath, password_hash: null, created_at: now() }).select('*').single();
    if (profileError) throw profileError;
    const token = crypto.randomBytes(32).toString('base64url');
    const { error: tokenError } = await supabase.from('api_tokens').insert({ user_id: id, token_hash: tokenHash(token), created_at: now() });
    if (tokenError) { await supabase.from('profiles').delete().eq('id', id); await removeFile(avatarPath); throw tokenError; }
    await logActivity({ action:'Registro', type:'Perfil', id, item:username, userId:id, userName:username });
    res.status(201).json({ ok: true, token, user: await profileView(profile), identity: 'device-bound' });
  } catch (error) { if (avatarPath) await removeFile(avatarPath); next(error); }
});

// No se admiten flujos de Google ni contraseñas en MC RED HUB 4.0.
app.all('/api/auth/login', (_req, res) => res.status(410).json({ error: 'Este servicio no admite inicio de sesión por contraseña. Crea tu perfil con Nick y foto desde la aplicación.' }));

app.get('/api/me', ensureSupabase, async (req, res, next) => {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.json({ user: null });
    const profile = await getProfileForToken(token);
    res.json({ user: await profileView(profile) });
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', (_req, res) => res.status(410).json({ error: 'La sesión del dispositivo se mantiene para sincronizar automáticamente.' }));
app.put('/api/profile', ensureSupabase, authMiddleware, upload.single('avatar'), async (req, res, next) => {
  let newAvatar = null;
  try {
    const updates = {};
    const username = String(req.body.username || '').trim().replace(/\s+/g, ' ');
    if (username) {
      if (username.length < 3 || username.length > 24 || !/^[\p{L}\p{N} _.-]+$/u.test(username)) return res.status(400).json({ error: 'Nick no válido.' });
      const norm = username.toLocaleLowerCase('es');
      const { data: other, error } = await supabase.from('profiles').select('id').eq('username_norm', norm).neq('id', req.user.id).maybeSingle();
      if (error) throw error;
      if (other) return res.status(409).json({ error: 'Ese Nick ya está ocupado.' });
      updates.username = username; updates.username_norm = norm;
    }
    if (req.file) {
      if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'La imagen no puede superar 2 MB.' });
      newAvatar = await storeFile(req.file, `profiles/${req.user.id}`, 'image');
      updates.avatar_path = newAvatar;
    }
    if (!Object.keys(updates).length) return res.json({ ok: true, user: await profileView(req.user) });
    const { data, error } = await supabase.from('profiles').update(updates).eq('id', req.user.id).select('*').single();
    if (error) throw error;
    if (newAvatar && req.user.avatar_path) await removeFile(req.user.avatar_path);
    await logActivity({ action:'Perfil actualizado', type:'Perfil', id:req.user.id, item:data.username, userId:req.user.id, userName:data.username });
    res.json({ ok: true, user: await profileView(data) });
  } catch (error) { if (newAvatar) await removeFile(newAvatar); next(error); }
});

app.get('/api/mods', ensureSupabase, authMiddleware, async (req, res, next) => {
  try {
    let query = supabase.from('mods').select('*').order(req.query.sort === 'downloads' ? 'downloads' : 'created_at', { ascending: false }).limit(100);
    if (req.query.q) query = query.or(`title.ilike.%${String(req.query.q).replace(/[(),]/g,' ')}%,description.ilike.%${String(req.query.q).replace(/[(),]/g,' ')}%,author_name.ilike.%${String(req.query.q).replace(/[(),]/g,' ')}%`);
    if (req.query.version) query = query.ilike('version', `%${req.query.version}%`);
    if (req.query.category) query = query.eq('category', req.query.category);
    const { data, error } = await query;
    if (error) throw error;
    const mods = await Promise.all((data || []).map(async m => ({ ...m, author: m.author_name, coverUrl: await signedUrl(m.cover_path), downloadUrl: m.file_path ? await signedUrl(m.file_path, true, m.file_name) : m.external_url })));
    res.json({ mods });
  } catch (error) { next(error); }
});
app.post('/api/mods', ensureSupabase, authMiddleware, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res, next) => {
  let storedFile = null, storedCover = null;
  try {
    const { title, description, version, category, externalUrl } = req.body;
    const modFile = req.files?.file?.[0], coverFile = req.files?.cover?.[0];
    if (!String(title || '').trim() || !String(description || '').trim() || !String(version || '').trim() || !String(category || '').trim()) return res.status(400).json({ error: 'Completa nombre, descripción, versión y categoría.' });
    if (!modFile && !String(externalUrl || '').trim()) return res.status(400).json({ error: 'Adjunta un .mcpack/.mcaddon o un enlace HTTPS.' });
    if (externalUrl && !/^https:\/\//i.test(externalUrl)) return res.status(400).json({ error: 'El enlace externo debe comenzar con https://.' });
    if (modFile) storedFile = await storeFile(modFile, 'mods', 'mod');
    if (coverFile) { if (coverFile.size > 5 * 1024 * 1024) throw new Error('La portada no puede superar 5 MB.'); storedCover = await storeFile(coverFile, 'covers', 'image'); }
    const id = makeId();
    const row = { id, title: String(title).trim().slice(0,100), description: String(description).trim().slice(0,5000), version: String(version).trim().slice(0,40), category: String(category).trim().slice(0,50), author_id: req.user.id, author_name: req.user.username, author_avatar_path: req.user.avatar_path, file_name: modFile?.originalname || null, file_path: storedFile, external_url: String(externalUrl || '').trim() || null, cover_path: storedCover, file_size: modFile?.size || null, created_at: now(), downloads: 0 };
    const { error } = await supabase.from('mods').insert(row);
    if (error) throw error;
    await logActivity({ action:'Subida', type:'Mod', id, item:row.title, userId:req.user.id, userName:req.user.username });
    res.status(201).json({ ok: true, id, author: req.user.username });
  } catch (error) { await removeFile(storedFile); await removeFile(storedCover); next(error); }
});

app.get('/api/skins', ensureSupabase, authMiddleware, async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from('skins').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    const skins = await Promise.all((data || []).map(async s => ({ ...s, author: s.author_name, imageUrl: await signedUrl(s.file_path), downloadUrl: await signedUrl(s.file_path, true, s.file_name) })));
    res.json({ skins });
  } catch (error) { next(error); }
});
app.post('/api/skins', ensureSupabase, authMiddleware, upload.single('file'), async (req, res, next) => {
  let stored = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona una imagen PNG de skin.' });
    validateFile(req.file, 'skin');
    if (req.file.size > 5 * 1024 * 1024) throw new Error('La skin no puede superar 5 MB.');
    stored = await storeFile(req.file, 'skins', 'skin');
    const row = { id: makeId(), name: String(req.body.name || 'Skin de la comunidad').trim().slice(0,80), author_id: req.user.id, author_name: req.user.username, author_avatar_path: req.user.avatar_path, file_name: fileSafe(req.file.originalname), file_path: stored, created_at: now() };
    const { error } = await supabase.from('skins').insert(row);
    if (error) throw error;
    await logActivity({ action:'Subida', type:'Skin', id:row.id, item:row.name, userId:req.user.id, userName:req.user.username });
    res.status(201).json({ ok: true, id: row.id });
  } catch (error) { await removeFile(stored); next(error); }
});

app.get('/api/servers', ensureSupabase, authMiddleware, async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from('servers').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ servers: data || [] });
  } catch (error) { next(error); }
});
app.post('/api/servers', ensureSupabase, authMiddleware, async (req, res, next) => {
  try {
    const { name, address, port, version, requirements = '', description } = req.body || {};
    const portNum = Number(port || 19132);
    if (!String(name || '').trim() || !String(address || '').trim() || !String(version || '').trim() || !String(description || '').trim() || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return res.status(400).json({ error: 'Completa nombre, IP, puerto, versión y descripción.' });
    const row = { id: makeId(), name: String(name).trim().slice(0,100), address: String(address).trim().slice(0,255), port: portNum, version: String(version).trim().slice(0,40), requirements: String(requirements).trim().slice(0,1000), description: String(description).trim().slice(0,5000), creator_id: req.user.id, creator: req.user.username, creator_avatar: req.user.avatar_path, created_at: now() };
    const { error } = await supabase.from('servers').insert(row);
    if (error) throw error;
    await logActivity({ action:'Publicación', type:'Servidor', id:row.id, item:row.name, userId:req.user.id, userName:req.user.username });
    res.status(201).json({ ok: true, id: row.id });
  } catch (error) { next(error); }
});

app.get('/api/worlds', ensureSupabase, authMiddleware, async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from('worlds').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    const worlds = await Promise.all((data || []).map(async w => ({ ...w, downloadUrl: await signedUrl(w.file_path, true, w.file_name) })));
    res.json({ worlds });
  } catch (error) { next(error); }
});
app.post('/api/worlds', ensureSupabase, authMiddleware, upload.single('file'), async (req, res, next) => {
  let stored = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo .mcworld o .zip.' });
    validateFile(req.file, 'world');
    stored = await storeFile(req.file, 'worlds', 'world');
    const row = { id: makeId(), name: String(req.body.name || path.basename(req.file.originalname, path.extname(req.file.originalname))).trim().slice(0,100), file_name: fileSafe(req.file.originalname), file_path: stored, file_size: req.file.size, author_id: req.user.id, author_name: req.user.username, created_at: now(), downloads: 0 };
    const { error } = await supabase.from('worlds').insert(row);
    if (error) throw error;
    await logActivity({ action:'Subida', type:'Mundo', id:row.id, item:row.name, userId:req.user.id, userName:req.user.username });
    res.status(201).json({ ok: true, id: row.id });
  } catch (error) { await removeFile(stored); next(error); }
});
app.delete('/api/worlds/:id', ensureSupabase, authMiddleware, async (req, res, next) => {
  try {
    const { data: row, error: findError } = await supabase.from('worlds').select('*').eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!row) return res.status(404).json({ error: 'Mundo no encontrado.' });
    if (row.author_id !== req.user.id) return res.status(403).json({ error: 'Solo el creador puede eliminar este mundo.' });
    const { error } = await supabase.from('worlds').delete().eq('id', row.id);
    if (error) throw error;
    await logActivity({ action:'Eliminación', type:'Mundo', id:row.id, item:row.name, userId:req.user.id, userName:req.user.username });
    await removeFile(row.file_path);
    res.json({ ok: true });
  } catch (error) { next(error); }
});


// Reseñas compartidas: cada usuario puede mantener una reseña por contenido.
app.get('/api/reviews', ensureSupabase, authMiddleware, async (req,res,next) => {
  try {
    let query=supabase.from('reviews').select('id,target_type,target_id,target_name,user_name,rating,comment,created_at').order('created_at',{ascending:false}).limit(100);
    if(req.query.targetType) query=query.eq('target_type',String(req.query.targetType));
    if(req.query.targetId) query=query.eq('target_id',String(req.query.targetId));
    const {data,error}=await query; if(error) throw error;
    res.json({reviews:data||[]});
  } catch(error){next(error);}
});
app.post('/api/reviews', ensureSupabase, authMiddleware, async (req,res,next) => {
  try {
    const targetType=String(req.body?.targetType||'').toLowerCase();
    const targetId=String(req.body?.targetId||'');
    const rating=Number(req.body?.rating);
    const comment=String(req.body?.comment||'').trim().slice(0,1000);
    const targets={mod:{table:'mods',name:'title'},skin:{table:'skins',name:'name'},world:{table:'worlds',name:'name'},server:{table:'servers',name:'name'}};
    if(!targets[targetType]||!targetId||!Number.isInteger(rating)||rating<1||rating>5||comment.length<2) return res.status(400).json({error:'Selecciona una puntuación de 1 a 5 y escribe un comentario de al menos 2 caracteres.'});
    const t=targets[targetType];
    const {data:target,error:targetError}=await supabase.from(t.table).select(`id,${t.name}`).eq('id',targetId).maybeSingle();
    if(targetError) throw targetError;
    if(!target) return res.status(404).json({error:'El contenido que quieres reseñar ya no existe.'});
    const targetName=target[t.name];
    const row={id:makeId(),target_type:targetType,target_id:targetId,target_name:targetName,user_id:req.user.id,user_name:req.user.username,rating,comment,created_at:now(),updated_at:now()};
    const {data,error}=await supabase.from('reviews').upsert(row,{onConflict:'target_type,target_id,user_id'}).select('id,target_type,target_id,target_name,user_name,rating,comment,created_at').single();
    if(error) throw error;
    await logActivity({action:'Reseña',type:targetType,item:targetName,userId:req.user.id,userName:req.user.username});
    res.status(201).json({ok:true,review:data});
  } catch(error){next(error);}
});

// Registra una descarga real y actualiza el contador central.
app.post('/api/track-download', ensureSupabase, authMiddleware, async (req,res,next) => {
  try {
    const type=String(req.body?.type||'').toLowerCase();
    const id=String(req.body?.id||'');
    if(!id||!['mod','skin','world'].includes(type)) return res.status(400).json({error:'Tipo de descarga no válido.'});
    const {data:count,error}=await supabase.rpc('mcrh_increment_download',{p_kind:type,p_id:id});
    if(error) throw error;
    if(count===null||count===undefined) return res.status(404).json({error:'El archivo no existe.'});
    const table={mod:'mods',skin:'skins',world:'worlds'}[type];
    const column={mod:'title',skin:'name',world:'name'}[type];
    const {data:item,error:itemError}=await supabase.from(table).select(`id,${column}`).eq('id',id).maybeSingle();
    if(itemError) throw itemError;
    if(!item) return res.status(404).json({error:'El contenido no existe.'});
    await logActivity({action:'Descarga',type:type==='mod'?'Mod':type==='skin'?'Skin':'Mundo',id,item:item[column],userId:req.user.id,userName:req.user.username});
    res.json({ok:true,downloads:Number(count)});
  }catch(error){next(error);}
});

app.get('/api/chat/:serverId', ensureSupabase, authMiddleware, async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('messages').select('*').eq('server_id', req.params.serverId).order('created_at', { ascending: true }).limit(100);
    if (error) throw error;
    res.json({ messages: (data || []).map(m => ({ id: m.id, userId: m.user_id, userName: m.user_name, avatar: m.user_avatar, text: m.message, createdAt: m.created_at })) });
  } catch (error) { next(error); }
});

io.use(async (socket, next) => {
  try {
    const token = String(socket.handshake.auth?.token || '');
    const profile = await getProfileForToken(token);
    if (!profile) return next(new Error('Perfil no conectado.'));
    socket.user = profile;
    next();
  } catch (error) { next(error); }
});
io.on('connection', socket => {
  socket.on('chat:join', async serverId => {
    try {
      const { data: serverRow, error } = await supabase.from('servers').select('id').eq('id', String(serverId)).maybeSingle();
      if (error) throw error;
      if (!serverRow) return socket.emit('chat:error', 'Servidor no encontrado.');
      for (const room of socket.rooms) if (room.startsWith('server:')) socket.leave(room);
      socket.join(`server:${serverId}`);
      const { data, error: msgError } = await supabase.from('messages').select('*').eq('server_id', String(serverId)).order('created_at', { ascending: true }).limit(100);
      if (msgError) throw msgError;
      socket.emit('chat:history', (data || []).map(m => ({ id: m.id, userId: m.user_id, userName: m.user_name, avatar: m.user_avatar, text: m.message, createdAt: m.created_at })));
    } catch (error) { socket.emit('chat:error', 'No se pudo abrir el chat.'); }
  });
  socket.on('chat:message', async payload => {
    try {
      const serverId = String(payload?.serverId || ''), message = String(payload?.text || '').trim().slice(0,1000);
      if (!serverId || !message) return;
      const { data: serverRow, error: serverError } = await supabase.from('servers').select('id,creator_id,name').eq('id', serverId).maybeSingle();
      if (serverError) throw serverError;
      if (!serverRow) return socket.emit('chat:error', 'Servidor no encontrado.');
      const row = { id: makeId(), server_id: serverId, user_id: socket.user.id, user_name: socket.user.username, user_avatar: socket.user.avatar_path, message, created_at: now() };
      const { error } = await supabase.from('messages').insert(row);
      if (error) throw error;
      await logActivity({action:'Mensaje',type:'Chat',id:serverId,item:serverRow.name||serverId,userId:socket.user.id,userName:socket.user.username});
      io.to(`server:${serverId}`).emit('chat:message', { id: row.id, userId: row.user_id, userName: row.user_name, avatar: await signedUrl(row.user_avatar), text: row.message, createdAt: row.created_at, isCreator: row.user_id === serverRow.creator_id });
    } catch (error) { socket.emit('chat:error', 'No se pudo enviar el mensaje.'); }
  });
});

// Página web pública y panel comunitario: comparte la misma API que utiliza la app Android.
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Ruta API no encontrada.' });
  return res.status(404).json({ error: 'Ruta no disponible.' });
});
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(413).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `El archivo supera el límite de ${MAX_FILE_MB} MB.` : 'La carga contiene demasiados archivos o campos.' });
  const message = String(error?.message || 'Error interno del servidor');
  const status = /duplicate key|unique constraint/i.test(message) ? 409 : 400;
  res.status(status).json({ error: message.slice(0, 300) });
});

server.listen(PORT, () => console.log(`MC RED HUB Cloud API activo en el puerto ${PORT}`));
