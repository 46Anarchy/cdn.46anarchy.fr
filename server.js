import crypto from 'crypto';
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import multer from 'multer';
import path from 'path';
import Database from 'better-sqlite3';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8080);
const storageRoot = path.resolve(process.env.STORAGE_ROOT || path.join(process.cwd(), 'files'));
const dataFile = path.join(storageRoot, 'catalog.json');
const remoteCacheFile = path.join(storageRoot, 'remote-manifest.json');
const remoteUrl = process.env.REMOTE_MANIFEST_URL || 'https://cdn.paladium-pvp.fr/games/paladiumv2/paladium.json';
const sessionDays = Math.max(1, Number(process.env.AUTH_SESSION_DAYS || 30));
const sessionLifetime = sessionDays * 24 * 60 * 60 * 1000;
const sessionSecret = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024) } });

if (!process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set. Add it to .env before starting the server.');
}

let catalog = { models: [], files: [], blacklist: { models: [], files: [] }, config: { exclude_paladium: false } };
let remoteManifest = { models: [], files: [] };

function normaliseOs(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item).toUpperCase()).filter((item) => ['WINDOWS', 'MACOS', 'LINUX'].includes(item)))];
}

function cleanPath(value) {
  const result = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!result || result.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('A valid relative path is required.');
  return result;
}

function safeStoragePath(relativePath) {
  const fullPath = path.resolve(storageRoot, relativePath);
  if (fullPath !== storageRoot && !fullPath.startsWith(`${storageRoot}${path.sep}`)) throw new Error('Invalid storage path.');
  return fullPath;
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((value) => value.trim().split('=').map(decodeURIComponent)).filter(([key]) => key));
}

function signSession(expiresAt) {
  const payload = String(expiresAt);
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSession(token) {
  if (!token || !token.includes('.')) return false;
  const [expiresAt, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionSecret).update(expiresAt).digest('base64url');
  const received = Buffer.from(signature);
  const signed = Buffer.from(expected);
  return received.length === signed.length && crypto.timingSafeEqual(received, signed) && Number(expiresAt) > Date.now();
}

function remember(response) {
  const expiresAt = Date.now() + sessionLifetime;
  response.cookie('cdn_session', signSession(expiresAt), { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: sessionLifetime });
}

function requireAuth(request, response, next) {
  if (validSession(parseCookies(request).cdn_session)) {
    // Sliding expiry: regular use keeps the remembered login valid.
    remember(response);
    return next();
  }
  return response.status(401).json({ error: 'Authentication required.' });
}

function publicFile(file, request) {
  const host = process.env.MANIFEST_BASE_URL || `${request.protocol}://${request.get('host')}`;
  return { ...file, url: `${host.replace(/\/$/, '')}/files/${encodeURI(file.path)}` };
}

// Remote model definitions are useful on their own: they define the destination
// and supported platforms for local files, even when remote artifacts are off.
function availableModels() {
  const blocked = new Set(catalog.blacklist.models.map((item) => item.name));
  const models = new Map();
  for (const model of remoteManifest.models) {
    models.set(model.name, { ...model, os: normaliseOs(model.os), source: 'paladium', excluded: blocked.has(model.name) });
  }
  for (const model of catalog.models) {
    models.set(model.name, { ...model, os: normaliseOs(model.os), source: 'local', excluded: blocked.has(model.name) });
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function persist() {
  const staging = `${dataFile}.tmp`;
  await fs.writeFile(staging, JSON.stringify(catalog, null, 2));
  await fs.rename(staging, dataFile);
}

async function initialise() {
  await fs.mkdir(storageRoot, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    catalog = {
      models: Array.isArray(parsed.models) ? parsed.models : [],
      files: Array.isArray(parsed.files) ? parsed.files : [],
      blacklist: { models: Array.isArray(parsed.blacklist?.models) ? parsed.blacklist.models : [], files: Array.isArray(parsed.blacklist?.files) ? parsed.blacklist.files : [] },
      config: { exclude_paladium: Boolean(parsed.config?.exclude_paladium) }
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await migrateLegacyCatalog();
    await persist();
  }
  try { remoteManifest = JSON.parse(await fs.readFile(remoteCacheFile, 'utf8')); } catch (_) { /* first start */ }
}

// Earlier releases used SQLite. Import it once when catalog.json does not exist,
// so an upgrade keeps the published files and their metadata intact.
async function migrateLegacyCatalog() {
  const legacyPath = path.join(storageRoot, 'db.sqlite');
  try {
    await fs.access(legacyPath);
    const database = new Database(legacyPath, { readonly: true });
    const models = database.prepare('SELECT name, version, description, dest, os, created_at FROM models').all();
    const files = database.prepare('SELECT id, name, model, path, size, sha1, os, uploaded_at FROM files').all();
    catalog.models = models.map((model) => ({ ...model, os: normaliseOs(JSON.parse(model.os || '[]')) }));
    catalog.files = files.map((file) => ({ ...file, id: String(file.id), os: normaliseOs(JSON.parse(file.os || '[]')) }));
    database.close();
    console.log(`Migrated ${models.length} models and ${files.length} files from SQLite.`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Legacy catalog migration skipped: ${error.message}`);
  }
}

async function refreshRemoteManifest() {
  try {
    const response = await fetch(remoteUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`upstream returned ${response.status}`);
    const manifest = await response.json();
    remoteManifest = { ...manifest, models: Array.isArray(manifest.models) ? manifest.models : [], files: Array.isArray(manifest.files) ? manifest.files : [] };
    await fs.writeFile(remoteCacheFile, JSON.stringify(remoteManifest));
  } catch (error) {
    console.warn(`Remote manifest refresh failed: ${error.message}`);
  }
}

function mergedManifest(request) {
  const blockedModels = new Set(catalog.blacklist.models.map((item) => item.name));
  const blockedFiles = new Set(catalog.blacklist.files.map((item) => `${item.model}:${item.path}`));
  const remoteModels = remoteManifest.models.filter((model) => !blockedModels.has(model.name));
  const remoteFiles = catalog.config.exclude_paladium ? [] : remoteManifest.files.filter((file) => !blockedModels.has(file.model) && !blockedFiles.has(`${file.model}:${file.path}`));
  const localModels = catalog.models.filter((model) => !blockedModels.has(model.name));
  const localFiles = catalog.files.filter((file) => !blockedModels.has(file.model) && !blockedFiles.has(`${file.model}:${file.path}`)).map((file) => publicFile(file, request));
  return { ...remoteManifest, models: [...remoteModels, ...localModels], files: [...remoteFiles, ...localFiles] };
}

app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));

app.post('/api/login', (request, response) => {
  const supplied = Buffer.from(String(request.body?.password || ''));
  const expected = Buffer.from(process.env.ADMIN_PASSWORD);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return response.status(401).json({ error: 'Invalid password.' });
  }
  remember(response);
  return response.json({ success: true });
});
app.post('/api/logout', (_request, response) => { response.clearCookie('cdn_session'); response.json({ success: true }); });

app.get('/api/models', requireAuth, (_request, response) => response.json(availableModels()));
app.post('/api/models', requireAuth, async (request, response, next) => {
  try {
    const name = String(request.body?.name || '').trim();
    const version = String(request.body?.version || '').trim();
    const dest = cleanPath(request.body?.dest);
    if (!name || !version) return response.status(400).json({ error: 'Name and version are required.' });
    if (availableModels().some((model) => model.name === name)) return response.status(409).json({ error: 'A model with this name already exists.' });
    const model = { name, version, dest, description: String(request.body?.description || '').trim(), os: normaliseOs(request.body?.os), created_at: new Date().toISOString() };
    catalog.models.push(model); await persist(); return response.status(201).json(model);
  } catch (error) { next(error); }
});
app.put('/api/models/:name', requireAuth, async (request, response, next) => {
  try {
    const model = catalog.models.find((item) => item.name === request.params.name);
    if (!model) return response.status(404).json({ error: 'Only locally managed models can be edited.' });
    const version = String(request.body?.version || '').trim();
    if (!version) return response.status(400).json({ error: 'Version is required.' });
    model.version = version;
    model.dest = cleanPath(request.body?.dest);
    model.description = String(request.body?.description || '').trim();
    model.os = normaliseOs(request.body?.os);
    await persist(); return response.json({ ...model, source: 'local' });
  } catch (error) { next(error); }
});
app.patch('/api/models/:name/excluded', requireAuth, async (request, response, next) => {
  try {
    if (typeof request.body?.excluded !== 'boolean') return response.status(400).json({ error: 'excluded must be a boolean.' });
    const model = availableModels().find((item) => item.name === request.params.name);
    if (!model) return response.status(404).json({ error: 'Model not found.' });
    const index = catalog.blacklist.models.findIndex((item) => item.name === model.name);
    if (request.body.excluded && index < 0) catalog.blacklist.models.push({ name: model.name, reason: 'Excluded in console' });
    if (!request.body.excluded && index >= 0) catalog.blacklist.models.splice(index, 1);
    await persist(); return response.json({ success: true });
  } catch (error) { next(error); }
});
app.delete('/api/models/:name', requireAuth, async (request, response, next) => {
  try {
    const index = catalog.models.findIndex((item) => item.name === request.params.name);
    if (index < 0) return response.status(404).json({ error: 'Only locally managed models can be deleted.' });
    const [model] = catalog.models.splice(index, 1);
    const affectedFiles = catalog.files.filter((file) => file.model === model.name);
    catalog.files = catalog.files.filter((file) => file.model !== model.name);
    catalog.blacklist.models = catalog.blacklist.models.filter((item) => item.name !== model.name);
    await Promise.all(affectedFiles.map((file) => fs.unlink(safeStoragePath(file.path)).catch((error) => { if (error.code !== 'ENOENT') throw error; })));
    await persist(); return response.json({ success: true, deletedFiles: affectedFiles.length });
  } catch (error) { next(error); }
});

app.get('/api/files', requireAuth, (request, response) => response.json(catalog.files.slice().sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)).map((file) => publicFile(file, request))));
async function saveUploadedFiles(model, uploads) {
  const stored = uploads.map(({ file: uploadedFile, relative }) => {
    const cleanRelative = cleanPath(relative);
    const filePath = cleanPath(path.posix.join(model.dest, cleanRelative));
    return {
      uploadedFile,
      file: {
        id: crypto.randomUUID(),
        name: path.posix.basename(cleanRelative),
        model: model.name,
        path: filePath,
        size: uploadedFile.size,
        sha1: crypto.createHash('sha1').update(uploadedFile.buffer).digest('hex'),
        os: model.os,
        uploaded_at: new Date().toISOString()
      }
    };
  });

  const paths = new Set();
  for (const { file } of stored) {
    if (paths.has(file.path)) throw new Error('The upload contains more than one file for the same path.');
    paths.add(file.path);
  }

  for (const { uploadedFile, file } of stored) {
    const destination = safeStoragePath(file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, uploadedFile.buffer);
  }

  catalog.files = catalog.files.filter((item) => !paths.has(item.path) || item.model !== model.name);
  catalog.files.push(...stored.map(({ file }) => file));
  await persist();
  return stored.map(({ file }) => file);
}

app.post('/api/files', requireAuth, upload.single('file'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ error: 'Choose a file to upload.' });
    const model = availableModels().find((item) => item.name === request.body.model);
    if (!model) return response.status(400).json({ error: 'Choose an existing model.' });
    const relative = request.body.path ? cleanPath(request.body.path) : cleanPath(request.file.originalname);
    const [file] = await saveUploadedFiles(model, [{ file: request.file, relative }]);
    return response.status(201).json(publicFile(file, request));
  } catch (error) { next(error); }
});
app.delete('/api/files/:id', requireAuth, async (request, response, next) => {
  try {
    const index = catalog.files.findIndex((file) => file.id === request.params.id);
    if (index < 0) return response.status(404).json({ error: 'File not found.' });
    const [file] = catalog.files.splice(index, 1);
    await fs.unlink(safeStoragePath(file.path)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await persist(); return response.json({ success: true });
  } catch (error) { next(error); }
});

app.get('/api/config', requireAuth, (_request, response) => response.json(catalog.config));
app.post('/api/config', requireAuth, async (request, response, next) => {
  try {
    if (typeof request.body?.exclude_paladium !== 'boolean') return response.status(400).json({ error: 'exclude_paladium must be a boolean.' });
    catalog.config.exclude_paladium = request.body.exclude_paladium; await persist(); return response.json(catalog.config);
  } catch (error) { next(error); }
});

app.get('/manifest.json', (request, response) => response.json(mergedManifest(request)));
app.get('/files/*', async (request, response, next) => { try { response.sendFile(safeStoragePath(cleanPath(request.params[0]))); } catch (error) { next(error); } });
app.use(express.static(path.join(process.cwd(), 'dist'), { index: false }));
app.get('*', (_request, response) => response.sendFile(path.join(process.cwd(), 'dist', 'index.html')));
app.use((error, _request, response, _next) => { console.error(error); response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : error.message || 'Request failed.' }); });

await initialise();
await refreshRemoteManifest();
setInterval(refreshRemoteManifest, 10 * 60 * 1000).unref();
app.listen(port, () => console.log(`CDN Console listening on port ${port}`));
