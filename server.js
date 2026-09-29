const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pkg = require('./package.json');

const app = express();
app.set('trust proxy', true); // Hostinger fica atras de CDN: usa o IP real do visitante
const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

// Commit do deploy: Vercel informa por variável; em outros servidores (Hostinger) tenta ler o .git
function gitCommit() {
  try {
    const gitDir = path.join(__dirname, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(5).trim();
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim();
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find(l => l.endsWith(' ' + ref));
    return line ? line.split(' ')[0] : '';
  } catch (e) { return ''; }
}
// Sem commit disponível, usa a "impressão digital" do index.html: muda a cada deploy com alteração
function contentHash() {
  try { return 'h' + crypto.createHash('sha1').update(fs.readFileSync(INDEX)).digest('hex').slice(0, 6); }
  catch (e) { return 'dev'; }
}

// Identificação automática de cada deploy
const commit = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || gitCommit();
const BUILD = {
  version: pkg.version,
  commit: commit ? commit.slice(0, 7) : contentHash(),
  message: (process.env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0],
  env: process.env.VERCEL_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'server')
};

function sendIndex(req, res) {
  fs.readFile(INDEX, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Erro ao carregar o sistema');
    // Sem cache: o navegador sempre busca a versão mais recente do sistema
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(
      html.replace(/__BUILD_COMMIT__/g, BUILD.commit).replace(/__BUILD_VERSION__/g, BUILD.version)
    );
  });
}

// Historico compartilhado de cartelas (sem login, visivel para todos)
require('./shared-lots').setupSharedLots(app);

// Nuvem antiga (v2.8): somente leitura, para migrar lotes de quem ainda tem sessao
require('./cloud').setupCloud(app);

app.get('/version.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(BUILD);
});
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('*', sendIndex);

app.listen(PORT, () => { console.log('Bingo Master Pro v' + BUILD.version + ' (' + BUILD.commit + ') na porta ' + PORT); });
