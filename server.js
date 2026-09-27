const express = require('express');
const path = require('path');
const fs = require('fs');
const pkg = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

// Identificação automática de cada deploy (a Vercel preenche o commit sozinha)
const BUILD = {
  version: pkg.version,
  commit: (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'dev').slice(0, 7),
  message: (process.env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0],
  env: process.env.VERCEL_ENV || 'local'
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

app.get('/version.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(BUILD);
});
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('*', sendIndex);

app.listen(PORT, () => { console.log('Bingo Master Pro v' + BUILD.version + ' (' + BUILD.commit + ') na porta ' + PORT); });
