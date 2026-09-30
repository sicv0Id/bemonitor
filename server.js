// Painel local do Behance Monitor — http://localhost:4747
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Abre o painel no navegador padrão. "detached" é essencial: sem isso o Windows encerra o pedido
// junto com este processo quando ele sai logo em seguida (caso do painel que já estava ligado).
function openBrowser() {
  if (process.argv.includes('--sem-abrir')) return;
  spawn('rundll32', ['url.dll,FileProtocolHandler', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
const { runCheck, listProfileProjects, readHistory, readOwners, readDetails, readProfileHistory, loadProjects, ROOT, LAST } = require('./engine');
const { projectList, buildData } = require('./dados');
const { publicar } = require('./publicar');

const PORT = Number(process.env.PORT) || 4747;
const CONFIG = path.join(ROOT, 'config.json');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
let config = { mostrarNavegador: false, perfis: ['marcelotrevizan', 'jesskkuhn'], ...readJson(CONFIG, {}) };
let syncing = false;

let job = { running: false, done: 0, total: 0, current: '', error: null, finishedAt: null, summary: null };

// Duração da última verificação, usada para estimar o tempo restante antes do primeiro resultado.
function expectedMs() {
  const last = readJson(LAST, null);
  const ms = last ? new Date(last.fim) - new Date(last.inicio) : NaN;
  return Number.isFinite(ms) && ms > 5000 ? ms : 35000;
}

function startRun() {
  if (job.running) return;
  job = {
    running: true, done: 0, total: loadProjects().length, current: 'Abrindo o Chrome anônimo', recent: [],
    startedAt: Date.now(), expectedMs: expectedMs(), error: null, finishedAt: null, summary: null,
  };
  runCheck({
    showWindow: !!config.mostrarNavegador,
    onProgress: ({ done, total, current, result }) => {
      Object.assign(job, { done, total, current });
      if (result) job.recent = [{ name: result.name, status: result.status, views: result.views }, ...job.recent].slice(0, 4);
    },
  })
    .then(({ summary }) => {
      Object.assign(job, { running: false, summary, finishedAt: Date.now() });
      // atualiza a versão online (Vercel); se falhar, só registra — a verificação já terminou
      publicar().then((r) => console.log(`Versão online: ${r.motivo}`)).catch((e) => console.log(`Versão online: não publicada (${e.message})`));
    })
    .catch((e) => Object.assign(job, { running: false, error: e.message, finishedAt: Date.now() }));
}

// ---------- lista de projetos (projetos.json) ----------
const PROJECTS = path.join(ROOT, 'projetos.json');
const galleryId = (u) => (String(u).match(/gallery\/(\d+)/) || [])[1] || '';
// projectList() vem de dados.js (a mesma montagem usada na versão online)

// ---------- marcos do gráfico e metas ----------
const MARKS = path.join(ROOT, 'marcos.json');
const GOALS = path.join(ROOT, 'metas.json');
const writeJson = (file, data) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n', 'utf8'); fs.renameSync(`${file}.tmp`, file); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));

// Projetos removidos à mão: a busca nos perfis não os traz de volta (adicionar pelo link desfaz isso).
const REMOVED = path.join(ROOT, 'removidos.json');
const readRemoved = () => new Set(readJson(REMOVED, []));
const writeRemoved = (set) => fs.writeFileSync(REMOVED, JSON.stringify([...set], null, 2) + '\n', 'utf8');

function saveProjects(urls) {
  const tmp = `${PROJECTS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(urls, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, PROJECTS);
}

// Aceita o link em qualquer formato razoável e devolve a URL canônica do projeto.
function normalizeUrl(input) {
  const m = String(input || '').trim().match(/behance\.net\/gallery\/(\d+)(?:\/([^/?#\s]+))?/i);
  if (!m) return null;
  return `https://www.behance.net/gallery/${m[1]}${m[2] ? '/' + m[2] : ''}`;
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/data') {
      return send(res, 200, buildData({ config, syncing, job: { ...job, elapsedMs: job.running ? Date.now() - job.startedAt : 0 } }));
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, projectList());
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const { url: raw } = JSON.parse((await readBody(req)) || '{}');
      const clean = normalizeUrl(raw);
      if (!clean) return send(res, 400, { error: 'Esse link não parece ser de um projeto do Behance (behance.net/gallery/…).' });
      const urls = loadProjects();
      if (urls.some((u) => galleryId(u) === galleryId(clean))) return send(res, 409, { error: 'Esse projeto já está na lista.' });
      saveProjects([clean, ...urls]);
      const removed = readRemoved();
      if (removed.delete(galleryId(clean))) writeRemoved(removed);
      return send(res, 201, projectList());
    }
    // marcos: anotações de ações de divulgação que aparecem no gráfico
    if (req.method === 'POST' && url.pathname === '/api/marks') {
      const { data, texto, perfil } = JSON.parse((await readBody(req)) || '{}');
      if (!isDate(data) || !String(texto || '').trim()) return send(res, 400, { error: 'Informe a data e uma descrição curta.' });
      const marks = readJson(MARKS, []);
      marks.push({ id: Date.now().toString(36), data, texto: String(texto).trim().slice(0, 140), perfil: perfil || 'todos' });
      marks.sort((a, b) => a.data.localeCompare(b.data));
      writeJson(MARKS, marks);
      return send(res, 201, marks);
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/marks/')) {
      const id = url.pathname.split('/').pop();
      const marks = readJson(MARKS, []).filter((m) => m.id !== id);
      writeJson(MARKS, marks);
      return send(res, 200, marks);
    }
    // metas: uma por escopo (todos ou um perfil), em visualizações até uma data
    if (req.method === 'POST' && url.pathname === '/api/goals') {
      const { escopo, alvo, prazo } = JSON.parse((await readBody(req)) || '{}');
      const goals = readJson(GOALS, {});
      if (alvo == null) delete goals[escopo || 'todos'];
      else {
        const n = Math.round(Number(alvo));
        if (!(n > 0) || !isDate(prazo)) return send(res, 400, { error: 'Informe um número de visualizações e uma data.' });
        goals[escopo || 'todos'] = { alvo: n, prazo };
      }
      writeJson(GOALS, goals);
      return send(res, 200, goals);
    }
    // varre os perfis do Behance e adiciona os projetos que ainda não estão na lista (sem duplicar pelo id)
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      if (syncing) return send(res, 409, { error: 'Já estou procurando nos perfis. Aguarde um instante.' });
      syncing = true;
      try {
        const found = await listProfileProjects(config.perfis);
        const urls = loadProjects();
        const have = new Set(urls.map(galleryId)), removed = readRemoved();
        const added = found.filter((p) => !have.has(p.id) && !removed.has(p.id));
        const ignored = found.filter((p) => removed.has(p.id)).length;
        if (added.length) saveProjects([...added.map((p) => p.url), ...urls]);
        return send(res, 200, { added: added.map((p) => p.id), found: found.length, ignored, list: projectList() });
      } catch (e) {
        return send(res, 500, { error: `Não consegui ler os perfis: ${e.message}` });
      } finally { syncing = false; }
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/projects/')) {
      const id = url.pathname.split('/').pop();
      const urls = loadProjects();
      const next = urls.filter((u) => galleryId(u) !== id);
      if (next.length === urls.length) return send(res, 404, { error: 'Projeto não encontrado na lista.' });
      saveProjects(next); // o histórico no CSV é mantido
      const removed = readRemoved(); removed.add(id); writeRemoved(removed);
      return send(res, 200, projectList());
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { ...job, elapsedMs: job.running ? Date.now() - job.startedAt : 0 });
    if (req.method === 'GET' && url.pathname === '/historico.csv') {
      const file = path.join(ROOT, 'historico.csv');
      if (!fs.existsSync(file)) return send(res, 404, { error: 'sem histórico ainda' });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="behance-historico.csv"' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && url.pathname === '/api/run') { startRun(); return send(res, 202, job); }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      config = { ...config, ...JSON.parse((await readBody(req)) || '{}') };
      fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
      return send(res, 200, config);
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
})
  .on('error', (e) => {
    if (e.code === 'EADDRINUSE') { // já está rodando: só abre o painel
      openBrowser();
      setTimeout(() => process.exit(0), 300);
      return;
    }
    throw e;
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Behance Monitor em http://localhost:${PORT}`);
    openBrowser();
  });
