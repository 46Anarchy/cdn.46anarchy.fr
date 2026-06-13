import express from 'express';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

dotenv.config();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is required in .env. Shutting down.');
  process.exit(1);
}

const STORAGE_ROOT = process.env.DOCKER == true ? '/app/files' : path.join(process.env.PWD, 'files');
const PORT = Number(process.env.PORT || 8080);
const MANIFEST_BASE_URL = process.env.MANIFEST_BASE_URL ? process.env.MANIFEST_BASE_URL.replace(/\/+$/, '') : 'http://localhost:' + PORT;
const app = express();
// When running behind a reverse proxy (nginx, cloudflare) enable trust proxy
// so Express correctly recognizes the original client protocol and IP.
app.set('trust proxy', true);
const upload = multer({ storage: multer.memoryStorage() });

await fsPromises.mkdir(STORAGE_ROOT, { recursive: true });
// Ensure log directory exists
const LOG_DIR = path.join(STORAGE_ROOT, 'logs');
await fsPromises.mkdir(LOG_DIR, { recursive: true });
const db = new Database(path.join(STORAGE_ROOT, 'db.sqlite'));

function dbInit() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      version TEXT NOT NULL,
      description TEXT,
      dest TEXT NOT NULL,
      os TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha1 TEXT NOT NULL,
      os TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      download_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS blacklist_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      reason TEXT,
      blacklisted_at TEXT NOT NULL,
      UNIQUE(model, path)
    );
    CREATE TABLE IF NOT EXISTS blacklist_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      reason TEXT,
      blacklisted_at TEXT NOT NULL
    );
  `);
}

dbInit();

const remoteUrl = 'https://cdn.paladium-pvp.fr/games/paladiumv2/paladium.json';
const REMOTE_CACHE_PATH = path.join(STORAGE_ROOT, 'remote_manifest.json');
const MANIFEST_CACHE_PATH = path.join(STORAGE_ROOT, 'manifest_cache.json');
let remoteManifest = { models: [], files: [] };
let manifestCache = null;
let manifestCacheDirty = true;
let manifestCacheHost = null;

function safePath(value) {
  return value.replace(/(^|[\/\\])\.\.?($|[\/\\])/g, '_').replace(/\\/g, '/');
}

async function appendLogFile(name, line) {
  try {
    await fsPromises.appendFile(path.join(LOG_DIR, name), line + '\n', 'utf-8');
  } catch (err) {
    console.error('Failed to write log file', err.message);
  }
}

function logger(level, message, meta = {}) {
  const ts = new Date().toISOString();
  const entry = { ts, level, message, ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(message, meta);
  else console.log(message, meta);
  // fire-and-forget
  appendLogFile('server.log', line);
  if (level === 'error') appendLogFile('error.log', line);
}

async function loadRemoteManifestCache() {
  try {
    const cacheText = await fsPromises.readFile(REMOTE_CACHE_PATH, 'utf-8');
    const json = JSON.parse(cacheText);
    remoteManifest = {
      ...json,
      models: Array.isArray(json.models) ? json.models : [],
      files: Array.isArray(json.files) ? json.files : []
    };
    console.log('Loaded remote manifest from cache');
  } catch (err) {
    console.log('No remote manifest cache found, fetching fresh manifest.');
    await fetchRemoteManifest();
  }
}

async function saveRemoteManifestCache() {
  try {
    await fsPromises.writeFile(REMOTE_CACHE_PATH, JSON.stringify(remoteManifest, null, 2), 'utf-8');
    console.log('Remote manifest cache saved');
  } catch (err) {
    console.error('Unable to save remote manifest cache:', err.message);
  }
}

async function loadManifestCache() {
  try {
    manifestCache = await fsPromises.readFile(MANIFEST_CACHE_PATH, 'utf-8');
    manifestCacheDirty = false;
    console.log('Loaded manifest cache');
  } catch (err) {
    manifestCache = null;
    manifestCacheDirty = true;
  }
}

async function saveManifestCache(content) {
  try {
    await fsPromises.writeFile(MANIFEST_CACHE_PATH, content, 'utf-8');
    console.log('Manifest cache saved');
  } catch (err) {
    console.error('Unable to save manifest cache:', err.message);
  }
}

function markManifestDirty() {
  manifestCacheDirty = true;
}

function getManifestHost(req) {
  return MANIFEST_BASE_URL;
}

function getBlacklistedFiles() {
  return db.prepare('SELECT id, model, path, name, reason, blacklisted_at FROM blacklist_files ORDER BY blacklisted_at DESC').all();
}

function getBlacklistedModels() {
  return db.prepare('SELECT id, name, reason, blacklisted_at FROM blacklist_models ORDER BY blacklisted_at DESC').all();
}

function remoteFileExists(model, pathValue) {
  return (remoteManifest.files || []).some((item) => item.model === model && item.path === pathValue);
}

function remoteModelExists(name) {
  return (remoteManifest.models || []).some((item) => item.name === name);
}

function cleanupRemoteBlacklist() {
  const fileDeletes = db.prepare('DELETE FROM blacklist_files WHERE id = ?');
  const modelDeletes = db.prepare('DELETE FROM blacklist_models WHERE id = ?');
  const blacklistedFiles = getBlacklistedFiles();
  const blacklistedModels = getBlacklistedModels();
  let removed = false;

  for (const item of blacklistedFiles) {
    // Remove blacklist entries only if the file no longer exists in remote manifest
    // AND it does not exist as a locally uploaded file.
    const existsRemote = remoteFileExists(item.model, item.path);
    const existsLocal = !!db.prepare('SELECT id FROM files WHERE model = ? AND path = ?').get(item.model, item.path);
    if (!existsRemote && !existsLocal) {
      const info = fileDeletes.run(item.id);
      if (info.changes) removed = true;
    }
  }
  for (const item of blacklistedModels) {
    // Remove blacklist entries only if the model no longer exists in remote manifest
    // AND it does not exist as a locally created model.
    const existsRemote = remoteModelExists(item.name);
    const existsLocal = !!db.prepare('SELECT name FROM models WHERE name = ?').get(item.name);
    if (!existsRemote && !existsLocal) {
      const info = modelDeletes.run(item.id);
      if (info.changes) removed = true;
    }
  }

  if (removed) {
    markManifestDirty();
  }
}

async function fetchRemoteManifest() {
  try {
    const response = await fetch(remoteUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`fetch failed ${response.status}`);
    const json = await response.json();
    remoteManifest = {
      ...json,
      models: Array.isArray(json.models) ? json.models : [],
      files: Array.isArray(json.files) ? json.files : []
    };
    await saveRemoteManifestCache();
    cleanupRemoteBlacklist();
    markManifestDirty();
    console.log('Remote manifest loaded');
  } catch (err) {
    console.error('Could not fetch remote manifest:', err.message);
  }
}

await loadRemoteManifestCache();
await loadManifestCache();
cleanupRemoteBlacklist();
setInterval(fetchRemoteManifest, 10 * 60 * 1000);

// Application-level config stored on disk
const CONFIG_PATH = path.join(STORAGE_ROOT, 'app_config.json');
let appConfig = { exclude_paladium: false };

async function loadAppConfig() {
  try {
    const text = await fsPromises.readFile(CONFIG_PATH, 'utf-8');
    const json = JSON.parse(text);
    appConfig = { ...appConfig, ...json };
    console.log('Loaded app config');
  } catch (err) {
    console.log('No app config found, using defaults');
    await saveAppConfig();
  }
}

async function saveAppConfig() {
  try {
    await fsPromises.writeFile(CONFIG_PATH, JSON.stringify(appConfig, null, 2), 'utf-8');
    console.log('App config saved');
  } catch (err) {
    console.error('Unable to save app config:', err.message);
  }
}

await loadAppConfig();

app.locals.authTokens = new Set();

function normalizeOs(osArray) {
  if (!Array.isArray(osArray)) return [];
  const unique = Array.from(new Set(osArray.map((item) => String(item).toUpperCase())));
  return unique.filter((value) => ['MACOS', 'LINUX', 'WINDOWS'].includes(value));
}

function secureAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token || !req.app.locals.authTokens.has(token)) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  next();
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const contentType = req.headers['content-type'] || '';
  const contentLength = req.headers['content-length'] || ''; 
  logger('info', 'request', { method: req.method, url: req.originalUrl, ip, contentType, contentLength });
  next();
});

import cookieParser from 'cookie-parser';
app.use(cookieParser());

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  req.app.locals.authTokens.add(token);
  res.cookie('auth_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 24
  });
  res.json({ success: true });
});

app.post('/api/logout', secureAuth, (req, res) => {
  const token = req.cookies?.auth_token;
  if (token) {
    req.app.locals.authTokens.delete(token);
  }
  res.clearCookie('auth_token');
  res.json({ success: true });
});

app.get('/api/models', secureAuth, (req, res) => {
  const rows = db.prepare('SELECT name, version, description, dest, os, created_at FROM models ORDER BY created_at DESC').all();
  const blacklistedModelNames = new Set(getBlacklistedModels().map((item) => item.name));
  const localModels = rows.map((row) => ({
    ...row,
    os: JSON.parse(row.os),
    source: 'local',
    blacklisted: blacklistedModelNames.has(row.name)
  }));
  const remoteModels = (remoteManifest.models || []).map((model) => ({
    ...model,
    os: normalizeOs(model.os),
    source: 'remote',
    blacklisted: blacklistedModelNames.has(model.name)
  }));
  res.json([...remoteModels, ...localModels]);
});

app.post('/api/models', secureAuth, (req, res) => {
  const { name, version, description, dest, os: osRaw } = req.body;
  if (!name || !version || !dest) {
    return res.status(400).json({ error: 'name, version and dest are required' });
  }
  const osArray = normalizeOs(osRaw);
  const stmt = db.prepare(`INSERT OR IGNORE INTO models (name, version, description, dest, os, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(name, version, description || '', dest, JSON.stringify(osArray), new Date().toISOString());
  if (!info.changes) {
    return res.status(400).json({ error: 'A model with this name already exists' });
  }
  markManifestDirty();
  const rows = db.prepare('SELECT name, version, description, dest, os, created_at FROM models ORDER BY created_at DESC').all();
  res.json({ models: rows.map((row) => ({ ...row, os: JSON.parse(row.os) })) });
});

app.get('/api/files', secureAuth, (req, res) => {
  const rows = db.prepare('SELECT id, name, model, path, size, sha1, os, uploaded_at, download_count FROM files ORDER BY uploaded_at DESC').all();
  const baseUrl = getManifestHost(req);
  res.json(rows.map((row) => ({ ...row, os: JSON.parse(row.os), url: `${baseUrl}/files/${row.path}` })));
});

app.get('/api/blacklist', secureAuth, (req, res) => {
  res.json({ files: getBlacklistedFiles(), models: getBlacklistedModels() });
});

app.post('/api/blacklist/files', secureAuth, (req, res) => {
  const { model, path: filePath, reason = '' } = req.body;
  if (!model || !filePath) {
    return res.status(400).json({ error: 'model and path are required' });
  }
  // Allow blacklisting of remote files or locally uploaded files.
  const remoteFile = (remoteManifest.files || []).find((item) => item.model === model && item.path === filePath);
  const localFile = db.prepare('SELECT name FROM files WHERE model = ? AND path = ?').get(model, filePath);
  if (!remoteFile && !localFile) {
    return res.status(400).json({ error: 'Specified file could not be found in CDN cache or local uploads' });
  }
  const displayName = remoteFile?.name || localFile?.name || '';
  const stmt = db.prepare('INSERT OR IGNORE INTO blacklist_files (model, path, name, reason, blacklisted_at) VALUES (?, ?, ?, ?, ?)');
  const info = stmt.run(model, filePath, displayName, reason, new Date().toISOString());
  if (!info.changes) {
    return res.status(400).json({ error: 'File is already blacklisted' });
  }
  markManifestDirty();
  logger('info', 'blacklist_file_added', { model, path: filePath, name: displayName, reason });
  res.json(getBlacklistedFiles());
});

app.delete('/api/blacklist/files/:id', secureAuth, (req, res) => {
  const info = db.prepare('DELETE FROM blacklist_files WHERE id = ?').run(req.params.id);
  if (!info.changes) {
    return res.status(404).json({ error: 'Blacklisted file not found' });
  }
  markManifestDirty();
  logger('info', 'blacklist_file_removed', { id: req.params.id });
  res.json({ success: true });
});

app.post('/api/blacklist/models', secureAuth, (req, res) => {
  const { name, reason = '' } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  // Allow blacklisting of remote models or locally created models.
  const existsRemote = remoteModelExists(name);
  const existsLocal = !!db.prepare('SELECT name FROM models WHERE name = ?').get(name);
  if (!existsRemote && !existsLocal) {
    return res.status(400).json({ error: 'Specified model could not be found in CDN cache or local models' });
  }
  const stmt = db.prepare('INSERT OR IGNORE INTO blacklist_models (name, reason, blacklisted_at) VALUES (?, ?, ?)');
  const info = stmt.run(name, reason, new Date().toISOString());
  if (!info.changes) {
    return res.status(400).json({ error: 'Model is already blacklisted' });
  }
  markManifestDirty();
  logger('info', 'blacklist_model_added', { name, reason });
  res.json(getBlacklistedModels());
});

app.delete('/api/blacklist/models/:id', secureAuth, (req, res) => {
  const info = db.prepare('DELETE FROM blacklist_models WHERE id = ?').run(req.params.id);
  if (!info.changes) {
    return res.status(404).json({ error: 'Blacklisted model not found' });
  }
  markManifestDirty();
  logger('info', 'blacklist_model_removed', { id: req.params.id });
  res.json({ success: true });
});

app.get('/api/remote-cdn', secureAuth, (req, res) => {
  const blacklistedModelNames = new Set(getBlacklistedModels().map((item) => item.name));
  const blacklistedFileKeys = new Set(getBlacklistedFiles().map((item) => `${item.model}::${item.path}`));
  const models = (remoteManifest.models || [])
    .filter((item) => !blacklistedModelNames.has(item.name))
    .map((model) => ({
      ...model,
      os: normalizeOs(model.os)
    }));
  const files = (remoteManifest.files || [])
    .filter((item) => !blacklistedFileKeys.has(`${item.model}::${item.path}`) && !blacklistedModelNames.has(item.model))
    .map((file) => ({
      ...file,
      os: normalizeOs(file.os)
    }));
  res.json({ models, files });
});

// App config endpoints
app.get('/api/config', secureAuth, (req, res) => {
  res.json({ exclude_paladium: !!appConfig.exclude_paladium });
});

app.post('/api/config', secureAuth, async (req, res) => {
  const { exclude_paladium } = req.body ?? {};
  if (typeof exclude_paladium !== 'boolean') {
    return res.status(400).json({ error: 'exclude_paladium (boolean) is required' });
  }
  appConfig.exclude_paladium = exclude_paladium;
  await saveAppConfig();
  markManifestDirty();
  res.json({ exclude_paladium: appConfig.exclude_paladium });
});

function getModelDefinition(modelName) {
  const row = db.prepare('SELECT dest, os FROM models WHERE name = ?').get(modelName);
  if (row) {
    return {
      dest: row.dest,
      os: normalizeOs(JSON.parse(row.os))
    };
  }
  const remoteModel = (remoteManifest.models || []).find((item) => item.name === modelName);
  if (remoteModel) {
    return {
      dest: remoteModel.dest,
      os: normalizeOs(remoteModel.os)
    };
  }
  return null;
}

app.post('/api/files', secureAuth, upload.single('file'), async (req, res) => {
  const { model: modelName, path: relativePath = '' } = req.body;
  if (!req.file) return res.status(400).json({ error: 'File missing' });
  if (!modelName) return res.status(400).json({ error: 'model is required' });
  const fileName = req.file.originalname;
  logger('info', 'upload_attempt', { model: modelName, fileName, size: req.file.size, ip: req.ip });
  try {
    const modelDefinition = getModelDefinition(modelName);
    if (!modelDefinition) return res.status(400).json({ error: 'Unknown model' });

    const sanitizedRelative = safePath(relativePath || (req.body.name || fileName));
    const normalizedPath = sanitizedRelative.replace(/^\/+/, '');
    const filePath = path.posix.join(modelDefinition.dest, normalizedPath);
    const fullPath = path.join(STORAGE_ROOT, filePath);
    logger('info', 'saving_file', { fullPath });
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, req.file.buffer);
    const sha1 = crypto.createHash('sha1').update(req.file.buffer).digest('hex');
    const size = req.file.size;
    const osArray = normalizeOs(modelDefinition.os);
    const displayName = req.body.name || fileName;
    db.prepare(`INSERT INTO files (name, model, path, size, sha1, os, uploaded_at, download_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(
      displayName,
      modelName,
      filePath,
      size,
      sha1,
      JSON.stringify(osArray),
      new Date().toISOString()
    );
    markManifestDirty();
    logger('info', 'upload_success', { model: modelName, path: filePath, name: displayName });

    const rows = db.prepare('SELECT id, name, model, path, size, sha1, os, uploaded_at, download_count FROM files ORDER BY uploaded_at DESC').all();
    const baseUrl = getManifestHost(req);
    res.json(rows.map((row) => ({ ...row, os: JSON.parse(row.os), url: `${baseUrl}/files/${row.path}` })));
  } catch (err) {
    logger('error', 'upload_failed', { model: modelName, fileName, error: err.message });
    res.status(500).json({ error: 'upload failed' });
  }
});

// Batch upload: accept multiple files and place each into the target model destination.
// The client should append multiple files under the field name `files` and may
// set each file's filename to the relative path (for example using FormData.append('files', file, relativePath)).
app.post('/api/files/batch', secureAuth, upload.array('files'), async (req, res) => {
  const { model: modelName, path: basePath = '' } = req.body;
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Files missing' });
  if (!modelName) return res.status(400).json({ error: 'model is required' });
  logger('info', 'batch_upload_attempt', { model: modelName, count: req.files.length, ip: req.ip });
  try {
    const modelDefinition = getModelDefinition(modelName);
    if (!modelDefinition) return res.status(400).json({ error: 'Unknown model' });

    for (const file of req.files) {
        // Prefer explicit paths[] values sent by the client (same order as files).
        // Multer will parse text fields into req.body; paths may be a single string or array.
        let suppliedRelative = '';
        if (req.body && req.body['paths[]']) {
          const pathsField = req.body['paths[]'];
          if (Array.isArray(pathsField)) suppliedRelative = pathsField.shift() || '';
          else suppliedRelative = pathsField || '';
        }
        // fallback to file.originalname when explicit path not provided
        if (!suppliedRelative) suppliedRelative = file.originalname || '';
        const combined = path.posix.join(basePath || '', suppliedRelative || path.posix.basename(suppliedRelative || file.originalname || ''));
      const sanitizedRelative = safePath(combined || path.posix.basename(file.originalname || ''));
      const normalizedPath = sanitizedRelative.replace(/^\/+/, '');
      const filePath = path.posix.join(modelDefinition.dest, normalizedPath);
      const fullPath = path.join(STORAGE_ROOT, filePath);
      await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
      await fsPromises.writeFile(fullPath, file.buffer);
      const sha1 = crypto.createHash('sha1').update(file.buffer).digest('hex');
      const size = file.size;
      const osArray = normalizeOs(modelDefinition.os);
      const name = path.posix.basename(sanitizedRelative || file.originalname || '');
      db.prepare(`INSERT INTO files (name, model, path, size, sha1, os, uploaded_at, download_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(
        name,
        modelName,
        filePath,
        size,
        sha1,
        JSON.stringify(osArray),
        new Date().toISOString()
      );
      logger('info', 'batch_save_file', { model: modelName, path: filePath, name });
    }

    markManifestDirty();
    logger('info', 'batch_upload_success', { model: modelName, count: req.files.length });
    const rows = db.prepare('SELECT id, name, model, path, size, sha1, os, uploaded_at, download_count FROM files ORDER BY uploaded_at DESC').all();
    const baseUrl = getManifestHost(req);
    res.json(rows.map((row) => ({ ...row, os: JSON.parse(row.os), url: `${baseUrl}/files/${row.path}` })));
  } catch (err) {
    logger('error', 'batch_upload_failed', { model: modelName, error: err.message });
    res.status(500).json({ error: 'batch upload failed' });
  }
});

app.delete('/api/files/:id', secureAuth, (req, res) => {
  const id = req.params.id;
  const file = db.prepare('SELECT path FROM files WHERE id = ?').get(id);
  if (!file) {
    logger('error', 'delete_file_not_found', { id });
    return res.status(404).json({ error: 'File not found' });
  }
  const fullPath = path.join(STORAGE_ROOT, file.path);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  markManifestDirty();
  logger('info', 'file_deleted', { id, path: file.path });
  const rows = db.prepare('SELECT id, name, model, path, size, sha1, os, uploaded_at, download_count FROM files ORDER BY uploaded_at DESC').all();
  const baseUrl = getManifestHost(req);
  res.json(rows.map((row) => ({ ...row, os: JSON.parse(row.os), url: `${baseUrl}/files/${row.path}` })));
});

// Dangerous: delete all files on the server (both DB entries and disk files)
app.post('/api/files/delete-all', secureAuth, (req, res) => {
  const rows = db.prepare('SELECT path FROM files').all();
  let removed = 0;
  for (const r of rows) {
    const fullPath = path.join(STORAGE_ROOT, r.path);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        removed++;
      }
    } catch (e) {
      logger('error', 'failed_delete_file', { path: r.path, error: e.message });
    }
  }
  db.prepare('DELETE FROM files').run();
  markManifestDirty();
  logger('info', 'delete_all_files', { removed });
  res.json({ success: true, removed });
});

// Delete all files for a specific model
app.post('/api/files/delete-model', secureAuth, (req, res) => {
  const { model } = req.body || {};
  if (!model) return res.status(400).json({ error: 'model is required' });
  const rows = db.prepare('SELECT path FROM files WHERE model = ?').all(model);
  let removed = 0;
  for (const r of rows) {
    const fullPath = path.join(STORAGE_ROOT, r.path);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        removed++;
      }
    } catch (e) {
      logger('error', 'failed_delete_file', { path: r.path, error: e.message });
    }
  }
  db.prepare('DELETE FROM files WHERE model = ?').run(model);
  markManifestDirty();
  logger('info', 'delete_model_files', { model, removed });
  res.json({ success: true, model, removed });
});

app.put('/api/files/:id', secureAuth, upload.single('file'), async (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!existing) {
    logger('error', 'edit_file_not_found', { id });
    return res.status(404).json({ error: 'File not found' });
  }

  const updatedModel = req.body.model || existing.model;
  const updatedName = req.body.name || existing.name;
  const requestedPath = typeof req.body.path === 'string' ? req.body.path : '';
  const modelDefinition = getModelDefinition(updatedModel);
  if (!modelDefinition) {
    return res.status(400).json({ error: 'Unknown model' });
  }

  const oldModelDefinition = getModelDefinition(existing.model);
  let existingRelative = path.posix.basename(existing.path);
  if (oldModelDefinition && existing.path.startsWith(`${oldModelDefinition.dest}/`)) {
    existingRelative = existing.path.slice(oldModelDefinition.dest.length + 1);
  }

  const sanitizedRelative = safePath(requestedPath || existingRelative);
  const normalizedRelative = sanitizedRelative.replace(/^\/+/, '');
  const filePath = path.posix.join(modelDefinition.dest, normalizedRelative);
  const fullPath = path.join(STORAGE_ROOT, filePath);
  await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });

  let size = existing.size;
  let sha1 = existing.sha1;
  if (req.file) {
    await fsPromises.writeFile(fullPath, req.file.buffer);
    size = req.file.size;
    sha1 = crypto.createHash('sha1').update(req.file.buffer).digest('hex');
  } else if (filePath !== existing.path) {
    const oldFull = path.join(STORAGE_ROOT, existing.path);
    if (!fs.existsSync(oldFull)) {
      return res.status(404).json({ error: 'Original file content not found' });
    }
    if (fs.existsSync(fullPath)) {
      await fsPromises.unlink(fullPath);
    }
    await fsPromises.rename(oldFull, fullPath);
  }

  const osArray = normalizeOs(modelDefinition.os);
  db.prepare('UPDATE files SET name = ?, model = ?, path = ?, size = ?, sha1 = ?, os = ?, uploaded_at = ? WHERE id = ?')
    .run(updatedName, updatedModel, filePath, size, sha1, JSON.stringify(osArray), new Date().toISOString(), id);
  markManifestDirty();
  logger('info', 'file_updated', { id, path: filePath, name: updatedName });

  const rows = db.prepare('SELECT id, name, model, path, size, sha1, os, uploaded_at, download_count FROM files ORDER BY uploaded_at DESC').all();
  const baseUrl = getManifestHost(req);
  res.json(rows.map((row) => ({ ...row, os: JSON.parse(row.os), url: `${baseUrl}/files/${row.path}` })));
});

async function buildManifest(host) {
  const excludePaladium = !!appConfig.exclude_paladium;
  const blacklistedModelNames = new Set(getBlacklistedModels().map((item) => item.name));
  const blacklistedFileKeys = new Set(getBlacklistedFiles().map((item) => `${item.model}::${item.path}`));
  // Always start from remote manifest for models; when exclude_paladium is set,
  // we will remove remote files only (leave remote models present).
  const manifest = JSON.parse(JSON.stringify(remoteManifest));
  manifest.models = (manifest.models || []).filter((item) => !blacklistedModelNames.has(item.name));
  if (excludePaladium) {
    // remove remote files entirely
    manifest.files = [];
  } else {
    manifest.files = (manifest.files || []).filter((item) => !blacklistedFileKeys.has(`${item.model}::${item.path}`) && !blacklistedModelNames.has(item.model));
  }

  const models = db.prepare('SELECT name, version, description, dest, os FROM models ORDER BY created_at DESC').all().map((row) => ({
    name: row.name,
    version: row.version,
    description: row.description,
    dest: row.dest,
    os: JSON.parse(row.os)
  }));
  const files = db.prepare('SELECT name, model, path, size, sha1, os FROM files ORDER BY uploaded_at DESC').all().map((row) => ({
    name: row.name,
    model: row.model,
    url: `${host}/files/${row.path}`,
    size: row.size,
    sha1: row.sha1,
    path: row.path,
    os: JSON.parse(row.os)
  }));

  // Exclude any locally added models/files that are blacklisted
  // Reuse `blacklistedModelNames` and `blacklistedFileKeys` declared above

  const filteredLocalModels = models.filter((m) => !blacklistedModelNames.has(m.name));
  const filteredLocalFiles = files.filter((f) => !blacklistedFileKeys.has(`${f.model}::${f.path}`) && !blacklistedModelNames.has(f.model));

  manifest.models = [...manifest.models, ...filteredLocalModels];
  manifest.files = [...manifest.files, ...filteredLocalFiles];
  const manifestText = JSON.stringify(manifest, null, 2);
  manifestCache = manifestText;
  manifestCacheHost = host + `::exclude_paladium=${excludePaladium}`;
  manifestCacheDirty = false;
  await saveManifestCache(manifestText);
  return manifestText;
}

app.get('/manifest.json', async (req, res) => {
  if (!remoteManifest.models.length && !remoteManifest.files.length) {
    await fetchRemoteManifest();
  }
  const host = getManifestHost(req);
  const excludePaladium = !!appConfig.exclude_paladium;
  const cacheKey = host + `::exclude_paladium=${excludePaladium}`;
  if (!manifestCacheDirty && manifestCache && manifestCacheHost === cacheKey) {
    res.setHeader('Content-Type', 'application/json');
    return res.send(manifestCache);
  }
  const manifestText = await buildManifest(host);
  res.setHeader('Content-Type', 'application/json');
  res.send(manifestText);
});

app.get('/files/*', (req, res) => {
  const relativeFile = req.params[0];
  if (!relativeFile) return res.status(404).send('Not found');
  const filePath = path.posix.normalize(relativeFile).replace(/^\.+/, '');
  const fullPath = path.join(STORAGE_ROOT, filePath);
  console.log('Serving file', fullPath);
  if (!fullPath.startsWith(path.resolve(STORAGE_ROOT))) {
    return res.status(400).json({ error: 'invalid file path' });
  }
  if (!fs.existsSync(fullPath)) {
    logger('error', 'file_not_found_on_serve', { path: filePath, fullPath });
    return res.status(404).json({ error: 'not found' });
  }
  db.prepare('UPDATE files SET download_count = download_count + 1 WHERE path = ?').run(filePath);
  logger('info', 'file_served', { path: filePath });
  res.sendFile(fullPath);
});

app.use(express.static(path.join(process.cwd(), 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
});

// Error handler to catch uncaught errors and log them
app.use((err, req, res, next) => {
  try {
    logger('error', 'unhandled_error', { message: err?.message, stack: err?.stack, url: req?.originalUrl });
  } catch (e) {
    console.error('Failed logging error middleware', e.message);
  }
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Storage root:', STORAGE_ROOT);
});
