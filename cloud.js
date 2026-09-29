// Nuvem antiga (contas com login, v2.8) — SOMENTE LEITURA, para migracao.
// Desde a v2.11 o sistema usa apenas o historico compartilhado (shared-lots.js).
// Este modulo existe so para que aparelhos que ainda tem uma sessao da nuvem antiga
// consigam baixar os lotes guardados e move-los para o historico compartilhado / navegador.
// Nada e apagado do banco: as tabelas bm_users, bm_sessions e bm_state continuam intactas.
// Cadastro, login e gravacao (PUT /state) foram removidos.
const express = require('express');

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

function mysqlStore(cfg) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({ ...cfg, waitForConnections: true, connectionLimit: 2, charset: 'utf8mb4' });
  return {
    async userBySession(token) {
      const [rows] = await pool.query(
        'SELECT u.id, u.email, u.name FROM bm_sessions s JOIN bm_users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > NOW()', [token]);
      return rows[0] || null;
    },
    async getState(userId) {
      const [rows] = await pool.query('SELECT data, version, updated_at FROM bm_state WHERE user_id = ?', [userId]);
      return rows[0] ? { data: rows[0].data, version: rows[0].version, updatedAt: rows[0].updated_at } : null;
    },
    async deleteSession(token) { await pool.query('DELETE FROM bm_sessions WHERE token = ?', [token]); }
  };
}

function createLegacyRouter(store) {
  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  function needDb(req, res, next) {
    if (!store) return res.status(503).json({ error: 'db_not_configured' });
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

  router.get('/health', (req, res) => res.json({ cloud: false, legacy: !!store }));

  // Leitura dos dados antigos (usada uma unica vez pela migracao no navegador)
  router.get('/state', needDb, auth, async (req, res, next) => {
    try {
      const s = await store.getState(req.user.id);
      res.json(s ? { data: JSON.parse(s.data), version: s.version, updatedAt: s.updatedAt } : { data: null, version: 0 });
    } catch (e) { next(e); }
  });

  // Encerra a sessao antiga depois da migracao (nao apaga dados)
  router.post('/logout', needDb, auth, async (req, res, next) => {
    try { await store.deleteSession(req.token); res.json({ ok: true }); } catch (e) { next(e); }
  });

  router.use((err, req, res, next) => {
    console.error('Nuvem antiga: erro', err && err.message);
    res.status(500).json({ error: 'server_error' });
  });
  return router;
}

function setupCloud(app) {
  const cfg = dbConfig();
  const store = cfg ? mysqlStore(cfg) : null;
  console.log('Nuvem antiga: ' + (store ? 'somente leitura para migracao' : 'banco nao configurado'));
  app.use('/api', createLegacyRouter(store));
}

module.exports = { setupCloud };
