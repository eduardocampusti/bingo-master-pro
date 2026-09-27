// Salvamento na nuvem do Bingo Master Pro.
// Guarda o estado de cada usuario (lotes, jogadores, sorteios) num banco MySQL.
// Se o banco nao estiver configurado, a API responde 503 e o sistema segue salvando so no navegador.
const crypto = require('crypto');
const express = require('express');

const SESSION_DAYS = 60;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

// ---------- Configuracao do banco (aceita os nomes de variaveis mais comuns) ----------
function dbConfig() {
  const env = process.env;
  if (env.DATABASE_URL && /^mysql/i.test(env.DATABASE_URL)) {
    const u = new URL(env.DATABASE_URL);
    return { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, '') };
  }
  const host = env.DB_HOST || env.MYSQL_HOST || env.MYSQLHOST;
  const user = env.DB_USER || env.DB_USERNAME || env.MYSQL_USER || env.MYSQLUSER;
  const database = env.DB_NAME || env.DB_DATABASE || env.MYSQL_DATABASE || env.MYSQLDATABASE;
  if (!host || !user || !database) return null;
  return { host, user, database,
    port: Number(env.DB_PORT || env.MYSQL_PORT || env.MYSQLPORT || 3306),
    password: env.DB_PASSWORD || env.DB_PASS || env.MYSQL_PASSWORD || env.MYSQLPASSWORD || '' };
}

// ---------- Armazenamento MySQL ----------
function mysqlStore(cfg) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({ ...cfg, waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' });
  return {
    kind: 'mysql',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS bm_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(190) NOT NULL UNIQUE,
        name VARCHAR(120) NOT NULL DEFAULT '',
        pass_hash VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS bm_sessions (
        token CHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        INDEX (user_id)
      ) CHARACTER SET utf8mb4`);
      await pool.query(`CREATE TABLE IF NOT EXISTS bm_state (
        user_id INT PRIMARY KEY,
        data LONGTEXT NOT NULL,
        version INT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    },
    async createUser(email, name, passHash) {
      const [r] = await pool.query('INSERT INTO bm_users (email, name, pass_hash) VALUES (?, ?, ?)', [email, name, passHash]);
      return r.insertId;
    },
    async findUserByEmail(email) {
      const [rows] = await pool.query('SELECT id, email, name, pass_hash FROM bm_users WHERE email = ?', [email]);
      return rows[0] || null;
    },
    async createSession(token, userId, days) {
      await pool.query('INSERT INTO bm_sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))', [token, userId, days]);
    },
    async userBySession(token) {
      const [rows] = await pool.query(
        'SELECT u.id, u.email, u.name FROM bm_sessions s JOIN bm_users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > NOW()', [token]);
      return rows[0] || null;
    },
    async deleteSession(token) { await pool.query('DELETE FROM bm_sessions WHERE token = ?', [token]); },
    async getState(userId) {
      const [rows] = await pool.query('SELECT data, version, updated_at FROM bm_state WHERE user_id = ?', [userId]);
      return rows[0] ? { data: rows[0].data, version: rows[0].version, updatedAt: rows[0].updated_at } : null;
    },
    // Grava so se a versao base bater (evita que um aparelho desatualizado apague o que outro salvou)
    async putState(userId, data, baseVersion) {
      if (baseVersion === 0) {
        const [r] = await pool.query('INSERT IGNORE INTO bm_state (user_id, data, version) VALUES (?, ?, 1)', [userId, data]);
        if (r.affectedRows === 1) return { ok: true, version: 1 };
      } else {
        const [r] = await pool.query('UPDATE bm_state SET data = ?, version = version + 1 WHERE user_id = ? AND version = ?', [data, userId, baseVersion]);
        if (r.affectedRows === 1) return { ok: true, version: baseVersion + 1 };
      }
      return { ok: false, current: await this.getState(userId) };
    },
    async ping() { await pool.query('SELECT 1'); }
  };
}

// ---------- Armazenamento em memoria (somente para testes locais: BINGO_MEMORY_DB=1) ----------
function memoryStore() {
  const users = [], sessions = new Map(), states = new Map();
  return {
    kind: 'memoria (teste)',
    async init() {},
    async createUser(email, name, passHash) {
      if (users.some(u => u.email === email)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
      const id = users.length + 1; users.push({ id, email, name, pass_hash: passHash }); return id;
    },
    async findUserByEmail(email) { return users.find(u => u.email === email) || null; },
    async createSession(token, userId) { sessions.set(token, userId); },
    async userBySession(token) { const id = sessions.get(token); const u = users.find(x => x.id === id); return u ? { id: u.id, email: u.email, name: u.name } : null; },
    async deleteSession(token) { sessions.delete(token); },
    async getState(userId) { const s = states.get(userId); return s ? { ...s } : null; },
    async putState(userId, data, baseVersion) {
      const cur = states.get(userId);
      if ((cur ? cur.version : 0) !== baseVersion) return { ok: false, current: cur ? { ...cur } : null };
      const version = baseVersion + 1; states.set(userId, { data, version, updatedAt: new Date() }); return { ok: true, version };
    }
  };
}

// ---------- Senhas (scrypt nativo do Node, sem dependencias) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

// ---------- Limite simples de tentativas de login por IP ----------
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const list = (attempts.get(ip) || []).filter(t => now - t < win);
  attempts.set(ip, list);
  return list.length >= 10;
}
function recordFailure(ip) { const l = attempts.get(ip) || []; l.push(Date.now()); attempts.set(ip, l); }

function createCloudRouter(store) {
  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  let ready = false, initError = null;
  if (store) {
    store.init().then(() => { ready = true; console.log('Nuvem: banco ' + store.kind + ' pronto'); })
      .catch(e => { initError = e; console.error('Nuvem: erro ao preparar o banco:', e.message); });
  }
  function needDb(req, res, next) {
    if (!store) return res.status(503).json({ error: 'db_not_configured' });
    if (!ready) return res.status(503).json({ error: initError ? 'db_error' : 'db_starting' });
    next();
  }
  async function auth(req, res, next) {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'unauthorized' });
    try {
      const user = await store.userBySession(m[1]);
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      req.user = user; req.token = m[1]; next();
    } catch (e) { next(e); }
  }
  async function newSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    await store.createSession(token, user.id, SESSION_DAYS);
    return { token, user: { email: user.email, name: user.name } };
  }
  const cleanEmail = e => String(e || '').trim().toLowerCase();
  const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 190;

  router.get('/health', (req, res) => {
    res.json({ cloud: !!store && ready, configured: !!store, error: initError ? 'db_error' : null });
  });

  router.post('/register', needDb, async (req, res, next) => {
    try {
      const email = cleanEmail(req.body.email), password = String(req.body.password || ''), name = String(req.body.name || '').trim().slice(0, 120);
      if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });
      if (password.length < 6) return res.status(400).json({ error: 'weak_password' });
      if (await store.findUserByEmail(email)) return res.status(409).json({ error: 'email_taken' });
      const id = await store.createUser(email, name, hashPassword(password));
      res.json(await newSession({ id, email, name }));
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'email_taken' });
      next(e);
    }
  });

  router.post('/login', needDb, async (req, res, next) => {
    try {
      const ip = req.ip || 'x';
      if (tooManyAttempts(ip)) return res.status(429).json({ error: 'too_many_attempts' });
      const email = cleanEmail(req.body.email), password = String(req.body.password || '');
      const user = await store.findUserByEmail(email);
      if (!user || !checkPassword(password, user.pass_hash)) { recordFailure(ip); return res.status(401).json({ error: 'bad_credentials' }); }
      res.json(await newSession(user));
    } catch (e) { next(e); }
  });

  router.post('/logout', needDb, auth, async (req, res, next) => {
    try { await store.deleteSession(req.token); res.json({ ok: true }); } catch (e) { next(e); }
  });

  router.get('/me', needDb, auth, (req, res) => res.json({ user: { email: req.user.email, name: req.user.name } }));

  router.get('/state', needDb, auth, async (req, res, next) => {
    try {
      const s = await store.getState(req.user.id);
      res.json(s ? { data: JSON.parse(s.data), version: s.version, updatedAt: s.updatedAt } : { data: null, version: 0 });
    } catch (e) { next(e); }
  });

  router.put('/state', needDb, auth, async (req, res, next) => {
    try {
      const data = req.body && req.body.data;
      const baseVersion = Number(req.body && req.body.baseVersion) || 0;
      if (!data || typeof data !== 'object' || typeof data.lots !== 'object') return res.status(400).json({ error: 'invalid_state' });
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json) > MAX_STATE_BYTES) return res.status(413).json({ error: 'too_large' });
      const r = await store.putState(req.user.id, json, baseVersion);
      if (r.ok) return res.json({ version: r.version });
      const cur = r.current;
      res.status(409).json({ error: 'conflict', data: cur ? JSON.parse(cur.data) : null, version: cur ? cur.version : 0 });
    } catch (e) { next(e); }
  });

  router.use((err, req, res, next) => {
    console.error('Nuvem: erro', err && err.message);
    res.status(500).json({ error: 'server_error' });
  });
  return router;
}

function setupCloud(app) {
  const cfg = dbConfig();
  let store = null;
  if (process.env.BINGO_MEMORY_DB === '1') {
    store = memoryStore();
    console.log('Nuvem: usando armazenamento em memoria (somente teste)');
  } else if (cfg) {
    store = mysqlStore(cfg);
    console.log('Nuvem: usando MySQL em ' + cfg.host + ':' + cfg.port + '/' + cfg.database);
  } else {
    console.log('Nuvem: banco nao configurado (defina DB_HOST, DB_USER, DB_PASSWORD e DB_NAME). Salvando so no navegador.');
  }
  app.use('/api', createCloudRouter(store));
}

module.exports = { setupCloud, hashPassword, checkPassword };
