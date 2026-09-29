// Historico compartilhado de cartelas salvas (sem login).
// Dois modos de armazenamento: MySQL (preferido) ou arquivo JSON (reserva).
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MAX_UNPINNED = 15;
const MAX_TOTAL = 25;
const CODE_RE = /^[A-Z0-9]{4,12}$/;

// ---------- Rate limiter (em memoria, 60 req/min por IP) ----------
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || 'x';
  const now = Date.now(), window = 60000;
  let list = hits.get(ip) || [];
  list = list.filter(t => now - t < window);
  if (list.length >= 60) return res.status(429).json({ error: 'rate_limit' });
  list.push(now);
  hits.set(ip, list);
  next();
}

// Data de criacao segura: aceita timestamp, ISO ou o formato brasileiro "27/09/2026, 11:58:03".
// (new Date("27/09/2026...") e invalido e fazia o MySQL recusar o INSERT.)
function safeCreatedAt(data, fallback) {
  if (data && typeof data.createdTs === 'number' && isFinite(data.createdTs)) return new Date(data.createdTs);
  const v = data && data.createdAt;
  if (v) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v));
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return fallback || new Date();
}

// ---------- Validacao ----------
function validateLotData(body) {
  const { code, title, savedBy, data } = body || {};
  if (!code || !CODE_RE.test(code)) return 'invalid_code';
  if (title && String(title).length > 120) return 'title_too_long';
  if (savedBy && String(savedBy).length > 40) return 'name_too_long';
  if (!data || typeof data !== 'object') return 'invalid_data';
  const { cards, gridSize, mode, maxNum } = data;
  if (!Array.isArray(cards) || cards.length === 0) return 'no_cards';
  if (![3, 4, 5].includes(gridSize)) return 'invalid_grid';
  if (mode !== 'numbers') return 'invalid_mode';
  const mx = maxNum || 75;
  for (const card of cards) {
    if (!card || !card.code) return 'invalid_card';
    if (!Array.isArray(card.data)) return 'invalid_card_data';
    for (const col of card.data) {
      if (!Array.isArray(col)) return 'invalid_card_data';
      for (const n of col) {
        if (n === 0) continue; // free cell
        if (typeof n !== 'number' || n < 1 || n > mx) return 'number_out_of_range';
      }
    }
  }
  return null;
}

// ---------- MySQL store ----------
function mysqlLotsStore(pool) {
  return {
    kind: 'mysql',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS bingo_saved_lots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lot_code VARCHAR(12) NOT NULL UNIQUE,
        title VARCHAR(120),
        saved_by VARCHAR(40),
        card_count INT,
        grid_size TINYINT,
        mode VARCHAR(10),
        data MEDIUMTEXT NOT NULL,
        pinned TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        saved_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) CHARACTER SET utf8mb4`);
    },
    async list() {
      const [rows] = await pool.query(
        'SELECT lot_code, title, saved_by, card_count, grid_size, mode, pinned, created_at, saved_at FROM bingo_saved_lots ORDER BY pinned DESC, saved_at DESC'
      );
      return rows.map(r => ({
        code: r.lot_code, title: r.title, savedBy: r.saved_by, cardCount: r.card_count,
        gridSize: r.grid_size, mode: r.mode, pinned: !!r.pinned,
        createdAt: r.created_at, savedAt: r.saved_at
      }));
    },
    async get(code) {
      const [rows] = await pool.query('SELECT lot_code, title, saved_by, pinned, created_at, saved_at, data FROM bingo_saved_lots WHERE lot_code = ?', [code]);
      if (!rows.length) return null;
      const r = rows[0];
      return { code: r.lot_code, title: r.title, savedBy: r.saved_by, pinned: !!r.pinned, createdAt: r.created_at, savedAt: r.saved_at, data: JSON.parse(r.data) };
    },
    async exists(code) {
      const [rows] = await pool.query('SELECT saved_at FROM bingo_saved_lots WHERE lot_code = ?', [code]);
      return rows.length ? { savedAt: rows[0].saved_at } : null;
    },
    async save(code, title, savedBy, data, replace) {
      const now = new Date();
      const cardCount = data.cards ? data.cards.length : 0;
      const json = JSON.stringify(data);
      const createdAt = safeCreatedAt(data, now);
      if (replace) {
        await pool.query(
          'UPDATE bingo_saved_lots SET title=?, saved_by=?, card_count=?, grid_size=?, mode=?, data=?, created_at=?, updated_at=? WHERE lot_code=?',
          [title, savedBy, cardCount, data.gridSize, data.mode, json, createdAt, now, code]
        );
      } else {
        await pool.query(
          'INSERT INTO bingo_saved_lots (lot_code, title, saved_by, card_count, grid_size, mode, data, pinned, created_at, saved_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?)',
          [code, title, savedBy, cardCount, data.gridSize, data.mode, json, createdAt, now, now]
        );
      }
    },
    async setPinned(code, pinned) {
      const [r] = await pool.query('UPDATE bingo_saved_lots SET pinned=?, updated_at=NOW() WHERE lot_code=?', [pinned ? 1 : 0, code]);
      return r.affectedRows > 0;
    },
    async setTitle(code, title) {
      const [rows] = await pool.query('SELECT data FROM bingo_saved_lots WHERE lot_code = ?', [code]);
      if (!rows.length) return false;
      let data = {};
      try { data = JSON.parse(rows[0].data) || {}; } catch (e) { data = {}; }
      data.title = title;
      await pool.query('UPDATE bingo_saved_lots SET title=?, data=?, updated_at=NOW() WHERE lot_code=?', [title, JSON.stringify(data), code]);
      return true;
    },
    async remove(code) {
      const [r] = await pool.query('DELETE FROM bingo_saved_lots WHERE lot_code=?', [code]);
      return r.affectedRows > 0;
    },
    async enforceLimit() {
      const [rows] = await pool.query(
        'SELECT lot_code FROM bingo_saved_lots WHERE pinned=0 ORDER BY saved_at DESC'
      );
      const toRemove = rows.slice(MAX_UNPINNED);
      const removed = [];
      for (const r of toRemove) {
        await pool.query('DELETE FROM bingo_saved_lots WHERE lot_code=?', [r.lot_code]);
        removed.push(r.lot_code);
      }
      return removed;
    },
    async count() {
      const [rows] = await pool.query('SELECT COUNT(*) as total FROM bingo_saved_lots');
      return rows[0].total;
    }
  };
}

// ---------- JSON file store ----------
function fileLotsStore(dataDir) {
  const filePath = path.join(dataDir, 'saved-lots.json');
  let lots = [];
  let writeQueue = Promise.resolve();

  function load() {
    try {
      if (fs.existsSync(filePath)) lots = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(lots)) lots = [];
    } catch (e) { lots = []; }
  }

  function persist() {
    writeQueue = writeQueue.then(() => new Promise((resolve) => {
      const tmp = filePath + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(lots, null, 2), 'utf8');
        fs.renameSync(tmp, filePath);
      } catch (e) { console.error('shared-lots: erro ao gravar', e.message); }
      resolve();
    }));
    return writeQueue;
  }

  load();

  return {
    kind: 'file',
    dataDir,
    async init() {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      load();
      console.log('Historico compartilhado: arquivo em ' + filePath);
    },
    async list() {
      return lots.map(l => ({
        code: l.code, title: l.title, savedBy: l.savedBy, cardCount: l.cardCount,
        gridSize: l.gridSize, mode: l.mode, pinned: !!l.pinned,
        createdAt: l.createdAt, savedAt: l.savedAt
      })).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.savedAt) - new Date(a.savedAt));
    },
    async get(code) {
      const l = lots.find(x => x.code === code);
      if (!l) return null;
      return { code: l.code, title: l.title, savedBy: l.savedBy, pinned: !!l.pinned, createdAt: l.createdAt, savedAt: l.savedAt, data: l.data };
    },
    async exists(code) {
      const l = lots.find(x => x.code === code);
      return l ? { savedAt: l.savedAt } : null;
    },
    async save(code, title, savedBy, data, replace) {
      const now = new Date().toISOString();
      const cardCount = data.cards ? data.cards.length : 0;
      const idx = lots.findIndex(x => x.code === code);
      if (replace && idx >= 0) {
        lots[idx] = { ...lots[idx], title, savedBy, cardCount, gridSize: data.gridSize, mode: data.mode, data, createdAt: safeCreatedAt(data, new Date(now)).toISOString(), updatedAt: now };
      } else {
        lots.push({ code, title, savedBy, cardCount, gridSize: data.gridSize, mode: data.mode, data, pinned: false, createdAt: safeCreatedAt(data, new Date(now)).toISOString(), savedAt: now, updatedAt: now });
      }
      await persist();
    },
    async setPinned(code, pinned) {
      const l = lots.find(x => x.code === code);
      if (!l) return false;
      l.pinned = !!pinned;
      l.updatedAt = new Date().toISOString();
      await persist();
      return true;
    },
    async setTitle(code, title) {
      const l = lots.find(x => x.code === code);
      if (!l) return false;
      l.title = title;
      if (l.data && typeof l.data === 'object') l.data.title = title;
      l.updatedAt = new Date().toISOString();
      await persist();
      return true;
    },
    async remove(code) {
      const idx = lots.findIndex(x => x.code === code);
      if (idx < 0) return false;
      lots.splice(idx, 1);
      await persist();
      return true;
    },
    async enforceLimit() {
      const unpinned = lots.filter(l => !l.pinned).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      const toRemove = unpinned.slice(MAX_UNPINNED);
      const removed = [];
      for (const r of toRemove) {
        const idx = lots.indexOf(r);
        if (idx >= 0) { lots.splice(idx, 1); removed.push(r.code); }
      }
      if (removed.length) await persist();
      return removed;
    },
    async count() { return lots.length; }
  };
}

// ---------- Router ----------
function createSharedLotsRouter(store) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(rateLimit);

  let ready = false, initError = null;
  if (store) {
    store.init()
      .then(() => { ready = true; console.log('Historico compartilhado: ' + store.kind + ' pronto' + (store.dataDir ? ' (' + store.dataDir + ')' : '')); })
      .catch(e => { initError = e; console.error('Historico compartilhado: erro:', e.message); });
  }

  function needStore(req, res, next) {
    if (!store) return res.status(503).json({ error: 'storage_not_configured' });
    if (!ready) return res.status(503).json({ error: initError ? 'storage_error' : 'storage_starting' });
    next();
  }

  // GET /api/lots
  router.get('/lots', needStore, async (req, res, next) => {
    try { res.json(await store.list()); }
    catch (e) { next(e); }
  });

  // GET /api/lots/:code
  router.get('/lots/:code', needStore, async (req, res, next) => {
    try {
      const code = String(req.params.code).toUpperCase();
      if (!CODE_RE.test(code)) return res.status(400).json({ error: 'invalid_code' });
      const lot = await store.get(code);
      if (!lot) return res.status(404).json({ error: 'not_found' });
      res.json(lot);
    } catch (e) { next(e); }
  });

  // POST /api/lots
  router.post('/lots', needStore, async (req, res, next) => {
    try {
      const { code: rawCode, title: rawTitle, savedBy: rawSavedBy, data } = req.body || {};
      const code = String(rawCode || '').toUpperCase();
      const title = String(rawTitle || '').trim().slice(0, 120);
      const savedBy = String(rawSavedBy || '').trim().slice(0, 40);
      const replace = req.query.replace === '1';

      const err = validateLotData({ code, title, savedBy, data });
      if (err) return res.status(400).json({ error: err });

      const existing = await store.exists(code);
      if (existing && !replace) return res.status(409).json({ exists: true, savedAt: existing.savedAt });

      const total = await store.count();
      if (!existing && total >= MAX_TOTAL) return res.status(400).json({ error: 'storage_full', max: MAX_TOTAL });

      await store.save(code, title, savedBy, data, !!existing && replace);
      const removed = await store.enforceLimit();
      res.json({ ok: true, removed });
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ exists: true });
      next(e);
    }
  });

  // PATCH /api/lots/:code  { pinned?: boolean, title?: string }
  router.patch('/lots/:code', needStore, async (req, res, next) => {
    try {
      const code = String(req.params.code).toUpperCase();
      if (!CODE_RE.test(code)) return res.status(400).json({ error: 'invalid_code' });
      const body = req.body || {};
      const hasPinned = body.pinned !== undefined, hasTitle = body.title !== undefined;
      if (!hasPinned && !hasTitle) return res.status(400).json({ error: 'nothing_to_update' });
      if (hasPinned && typeof body.pinned !== 'boolean') return res.status(400).json({ error: 'invalid_pinned' });
      let title = null;
      if (hasTitle) {
        if (typeof body.title !== 'string') return res.status(400).json({ error: 'invalid_title' });
        title = body.title.trim().slice(0, 120) || 'BINGO';
      }
      if (!(await store.exists(code))) return res.status(404).json({ error: 'not_found' });
      if (hasPinned) await store.setPinned(code, body.pinned);
      if (hasTitle) await store.setTitle(code, title);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // DELETE /api/lots/:code
  router.delete('/lots/:code', needStore, async (req, res, next) => {
    try {
      const code = String(req.params.code).toUpperCase();
      if (!CODE_RE.test(code)) return res.status(400).json({ error: 'invalid_code' });
      const confirm = req.get('X-Confirm-Code');
      if (!confirm || confirm.toUpperCase() !== code) return res.status(400).json({ error: 'confirmation_required' });
      const ok = await store.remove(code);
      if (!ok) return res.status(404).json({ error: 'not_found' });
      const ip = req.ip || '?';
      console.log('Historico: lote ' + code + ' excluido por ' + ip + ' em ' + new Date().toISOString());
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // GET /api/lots-health
  router.get('/lots-health', (req, res) => {
    const pkg = require('./package.json');
    const info = {
      ok: !!store && ready,
      storage: store ? store.kind : 'none',
      version: pkg.version
    };
    if (store && store.dataDir) info.dataDir = store.dataDir;
    if (store && ready) {
      store.count().then(total => { info.total = total; res.json(info); }).catch(() => res.json(info));
    } else {
      info.error = initError ? 'storage_error' : (!store ? 'not_configured' : 'starting');
      res.json(info);
    }
  });

  router.use((err, req, res, next) => {
    console.error('Historico compartilhado: erro', err && err.message);
    res.status(500).json({ error: 'server_error' });
  });

  return router;
}

// ---------- Setup ----------
function setupSharedLots(app) {
  const env = process.env;

  // Tenta reaproveitar a config MySQL do cloud.js
  function dbConfig() {
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

  let store = null;
  const cfg = dbConfig();

  if (cfg) {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({ ...cfg, waitForConnections: true, connectionLimit: 3, charset: 'utf8mb4' });
    store = mysqlLotsStore(pool);
    console.log('Historico compartilhado: usando MySQL em ' + cfg.host + ':' + cfg.port + '/' + cfg.database);
  } else {
    const dataDir = env.DATA_DIR || path.join(os.homedir(), 'bingo-data');
    store = fileLotsStore(dataDir);
    console.log('Historico compartilhado: usando arquivo JSON');
  }

  app.use('/api', createSharedLotsRouter(store));
}

module.exports = { setupSharedLots };
