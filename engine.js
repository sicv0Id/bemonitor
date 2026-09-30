// Motor de verificação: abre o Chrome num perfil novo e anônimo (contexto incógnito via DevTools),
// visita cada projeto do Behance e lê curtidas, visualizações e comentários.
// Sem dependências: usa o WebSocket nativo do Node (v22+).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const HIST = path.join(ROOT, 'historico.csv');
const LAST = path.join(ROOT, 'ultima-verificacao.json');
const HEADER = ['data', 'id_galeria', 'projeto', 'status', 'curtidas', 'visualizacoes', 'comentarios', 'url'];

const CHROME_PATHS = [
  process.env.CHROME_PATH || '', // nuvem (GitHub Actions) ou outro computador
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const galleryId = (url) => (url.match(/gallery\/(\d+)/) || [])[1] || '';
const nameFromSlug = (url) => decodeURIComponent((url.split('/').pop() || '').replace(/-/g, ' '));

function loadProjects() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'projetos.json'), 'utf8'));
}

// ---------- CSV ----------
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ';') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const csvField = (v) => {
  const s = v == null ? '' : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function readHistory() {
  return fs.existsSync(HIST) ? parseCsv(fs.readFileSync(HIST, 'utf8')) : [];
}

function writeHistory(date, results) {
  const kept = readHistory().filter((r) => r.data !== date); // rodar de novo no mesmo dia substitui o dia
  const fresh = results.map((r) => ({
    data: date, id_galeria: r.id, projeto: r.name, status: r.status,
    curtidas: r.likes ?? '', visualizacoes: r.views ?? '', comentarios: r.comments ?? '', url: r.url,
  }));
  const lines = [HEADER.join(';'), ...[...kept, ...fresh].map((r) => HEADER.map((h) => csvField(r[h])).join(';'))];
  fs.writeFileSync(HIST, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

// ---------- donos dos projetos (autores.json) ----------
const OWNERS = path.join(ROOT, 'autores.json');
function readOwners() {
  try { return JSON.parse(fs.readFileSync(OWNERS, 'utf8')); } catch { return { perfis: {}, projetos: {} }; }
}
function writeOwners(results) {
  const data = readOwners();
  for (const r of results) {
    if (!r || !r.owners || !r.owners.length) continue; // leitura falhou: mantém o que já se sabia
    data.projetos[r.id] = r.owners.map((o) => o.user);
    for (const o of r.owners) {
      const prev = data.perfis[o.user] || {};
      data.perfis[o.user] = { nome: o.name || prev.nome || o.user, foto: o.avatar || prev.foto || '', url: `https://www.behance.net/${o.user}` };
    }
  }
  fs.writeFileSync(OWNERS, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- detalhes dos projetos (detalhes.json): capa, publicação, destaques ----------
const DETAILS = path.join(ROOT, 'detalhes.json');
function readDetails() {
  try { return JSON.parse(fs.readFileSync(DETAILS, 'utf8')); } catch { return {}; }
}
// Grava e devolve os nomes dos projetos que ganharam um destaque novo desde a última leitura.
function writeDetails(results) {
  const data = readDetails();
  const novos = [];
  for (const r of results) {
    if (!r || !r.extra) continue;
    const prev = data[r.id] || {};
    const antes = new Set((prev.destaques || []).map((d) => d.nome));
    if (prev.capa !== undefined && r.extra.destaques.some((d) => !antes.has(d.nome))) novos.push(r.name);
    data[r.id] = { ...prev, ...r.extra, capa: r.extra.capa || prev.capa || '', capaGrande: r.extra.capaGrande || prev.capaGrande || '' };
  }
  fs.writeFileSync(DETAILS, JSON.stringify(data, null, 2), 'utf8');
  return novos;
}

// ---------- estatísticas dos perfis (perfis-historico.csv) ----------
const PROFILE_HIST = path.join(ROOT, 'perfis-historico.csv');
const PROFILE_HEADER = ['data', 'perfil', 'seguidores', 'visualizacoes', 'avaliacoes', 'seguindo'];
function readProfileHistory() {
  return fs.existsSync(PROFILE_HIST) ? parseCsv(fs.readFileSync(PROFILE_HIST, 'utf8')) : [];
}
function writeProfileHistory(date, stats) {
  const ok = stats.filter((s) => s && s.seguidores != null);
  if (!ok.length) return;
  const kept = readProfileHistory().filter((r) => !(r.data === date && ok.some((s) => s.user === r.perfil)));
  const fresh = ok.map((s) => ({ data: date, perfil: s.user, seguidores: s.seguidores, visualizacoes: s.visualizacoes, avaliacoes: s.avaliacoes, seguindo: s.seguindo }));
  const lines = [PROFILE_HEADER.join(';'), ...[...kept, ...fresh].map((r) => PROFILE_HEADER.map((h) => csvField(r[h])).join(';'))];
  fs.writeFileSync(PROFILE_HIST, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}
function profileUsers() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).perfis || ['marcelotrevizan', 'jesskkuhn']; }
  catch { return ['marcelotrevizan', 'jesskkuhn']; }
}

// ---------- Chrome / DevTools ----------
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    };
  }
  send(method, params = {}, sessionId, timeout = 15000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout: ${method}`)); }, timeout);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    });
  }
}

async function launchChrome(showWindow) {
  const exe = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('Google Chrome não encontrado neste computador.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'behance-monitor-'));
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    ...(process.platform === 'win32' ? [] : ['--no-sandbox', '--disable-dev-shm-usage']), // servidores Linux da nuvem
    '--lang=pt-BR', '--window-size=1280,900', '--blink-settings=imagesEnabled=false',
    ...(showWindow ? [] : ['--headless=new']),
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(150);
  if (!fs.existsSync(portFile)) { proc.kill(); throw new Error('O Chrome não abriu a porta de depuração.'); }
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Falha ao conectar no Chrome.')); });
  return { proc, profile, ws, cdp: new CDP(ws) };
}

async function closeChrome({ proc, profile, ws, cdp }) {
  try { await cdp.send('Browser.close', {}, undefined, 3000); } catch {}
  try { ws.close(); } catch {}
  for (let i = 0; i < 20 && proc.exitCode === null; i++) await sleep(150);
  if (proc.exitCode === null) proc.kill();
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
  }
}

// Lê o estado da página. Roda dentro da aba do Behance.
const PROBE = `(() => {
  const box = document.querySelector('[class*="Project-projectStats"]');
  let likes = null, views = null, comments = null;
  if (box) box.querySelectorAll('[class*="Project-projectStat-"]').forEach((s) => {
    const label = (s.getAttribute('aria-label') || '').toLowerCase();
    const span = s.querySelector('span[title]');
    const n = span ? parseInt(span.getAttribute('title').replace(/\\D/g, ''), 10) : null;
    if (/curtid|apreci|like/.test(label)) likes = n;
    else if (/coment|comment/.test(label)) comments = n;
    else views = n;
  });
  // donos do projeto: vêm dos dados estruturados da página (lista completa, inclusive "vários proprietários");
  // a foto sai do avatar no cabeçalho do projeto
  const owners = [];
  const photos = {};
  document.querySelectorAll('.qa-project-owners img[alt]').forEach((img) => {
    photos[img.alt.replace(/^(perfil de|profile of|avatar de)\\s*/i, '').trim().toLowerCase()] = img.src;
  });
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    let data; try { data = JSON.parse(s.textContent); } catch { return; }
    [].concat(data.creator || data.author || []).forEach((c) => {
      const m = String(c.url || '').match(/behance\\.net\\/([A-Za-z0-9_-]+)/);
      if (!m || owners.some((o) => o.user === m[1].toLowerCase())) return;
      owners.push({ user: m[1].toLowerCase(), name: c.name || m[1], avatar: photos[String(c.name || '').toLowerCase()] || '' });
    });
  });
  // capa, data de publicação e destaques em galerias do Behance (dados internos da página)
  let extra = null;
  try {
    const st = JSON.parse(document.getElementById('beconfig-store_state').textContent);
    const p = st.project && st.project.project;
    if (p) {
      const all = (p.covers && p.covers.allAvailable) || [];
      const pick = (k) => (all.find((c) => c.url.indexOf('/projects/' + k + '/') > -1) || {}).url || '';
      extra = {
        capa: pick('404_webp') || pick('404') || pick('230_webp'),
        capaGrande: pick('808_webp') || pick('808') || pick('max_808_webp') || pick('max_808'),
        publicado: p.publishedOn || null,
        destaques: (p.features || []).map((f) => ({
          nome: f.name || (f.site && f.site.name) || (f.ribbon && (f.ribbon.label || f.ribbon.title)) || 'Destaque',
          data: f.featuredOn || f.featured_on || null,
          url: f.url || (f.site && f.site.url) || '',
        })),
      };
    }
  } catch (e) {}
  const nav = performance.getEntriesByType('navigation')[0] || {};
  return { title: document.title, url: location.href, hasBox: !!box, likes, views, comments, owners, extra, httpStatus: nav.responseStatus || 0,
    notFound: [404, 410].includes(nav.responseStatus) || /n[aã]o foi poss[ií]vel encontrar|couldn.t find|not found/i.test(document.title) };
})()`;

async function checkOne(cdp, contextId, url, userAgent) {
  const id = galleryId(url);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    // O Behance recusa (HTTP 400) o user-agent "HeadlessChrome"; usa o do Chrome normal.
    await cdp.send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: 'pt-BR,pt;q=0.9' }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId, 30000);
    let last = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(600);
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId, 5000);
        last = r.result && r.result.value;
      } catch { continue; } // a página recarrega durante o desafio anti-robô; tenta de novo
      if (!last) continue;
      if (last.hasBox && last.views != null) break;
      if (last.notFound) break;
    }
    const onBehance = last && /^https:\/\/(www\.)?behance\.net\//.test(last.url);
    const name = last && last.hasBox && / :: Behance$/.test(last.title) ? last.title.replace(/ :: Behance$/, '').trim() : nameFromSlug(url);
    let status;
    if (last && last.hasBox && last.views != null) status = 'NO AR';
    else if (onBehance && (last.notFound || !last.url.includes(id))) status = 'FORA DO AR'; // 404 ou redirecionado (removido/privado)
    else status = 'ERRO';
    return { id, url, name, status, likes: last?.likes ?? null, views: last?.views ?? null, comments: last?.comments ?? null, owners: last?.owners || [], extra: last?.extra || null };
  } finally {
    cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// Estatísticas públicas de um perfil (seguidores, exibições, avaliações), lidas dos dados internos da página.
const PROFILE_PROBE = `(() => {
  try {
    const st = JSON.parse(document.getElementById('beconfig-store_state').textContent);
    const u = st.profile && st.profile.user;
    if (!u || !u.stats) return null;
    const imgs = ((u.images && u.images.allAvailable) || []).filter((i) => i.width).sort((a, b) => a.width - b.width);
    const foto = (imgs.find((i) => i.width >= 100) || imgs[imgs.length - 1] || {}).url || '';
    return { nome: u.displayName || [u.firstName, u.lastName].filter(Boolean).join(' '), foto,
      seguidores: u.stats.followers, visualizacoes: u.stats.views, avaliacoes: u.stats.appreciations, seguindo: u.stats.following };
  } catch (e) { return null; }
})()`;

async function checkProfile(cdp, contextId, user, userAgent) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: 'pt-BR,pt;q=0.9' }, sessionId);
    await cdp.send('Page.navigate', { url: `https://www.behance.net/${user}` }, sessionId, 30000);
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(700);
      try {
        const v = (await cdp.send('Runtime.evaluate', { expression: PROFILE_PROBE, returnByValue: true }, sessionId, 5000)).result.value;
        if (v && v.seguidores != null) return { user, ...v };
      } catch {}
    }
    return { user, seguidores: null };
  } finally {
    cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// Lista todos os projetos públicos de perfis do Behance (rola a aba "Trabalho" até o fim).
// Devolve [{ id, url, name }] sem repetição — projetos em coautoria aparecem em mais de um perfil.
const COLLECT = `(() => {
  const out = [];
  document.querySelectorAll('a[class*="ProjectCoverNeue-coverLink"][href*="/gallery/"]').forEach((a) => {
    const m = a.href.match(/gallery\\/(\\d+)\\/([^/?#]*)/);
    if (!m) return;
    const card = a.closest('[class*="ProjectCoverNeue-root"]');
    const title = card && card.querySelector('[class*="Title-title"], [class*="titleStatsContainer"]');
    out.push({ id: m[1], url: 'https://www.behance.net/gallery/' + m[1] + '/' + m[2], name: title ? title.textContent.trim() : '' });
  });
  const last = [...document.querySelectorAll('a[class*="ProjectCoverNeue-coverLink"]')].pop();
  if (last) last.scrollIntoView({ block: 'center' });
  window.scrollBy(0, 1200);
  return out;
})()`;

async function listProfileProjects(users, { onProgress = () => {} } = {}) {
  const chrome = await launchChrome(false);
  const found = new Map();
  try {
    const { browserContextId } = await chrome.cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const userAgent = (await chrome.cdp.send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
    for (const user of users) {
      const { targetId } = await chrome.cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      try {
        await chrome.cdp.send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: 'pt-BR,pt;q=0.9' }, sessionId);
        await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
        await chrome.cdp.send('Page.navigate', { url: `https://www.behance.net/${user}` }, sessionId, 30000);
        let last = -1, stable = 0;
        for (let i = 0; i < 80 && stable < 4; i++) {
          await sleep(1200);
          let items = [];
          try { items = (await chrome.cdp.send('Runtime.evaluate', { expression: COLLECT, returnByValue: true }, sessionId, 8000)).result.value || []; } catch { continue; }
          for (const it of items) if (!found.has(it.id)) found.set(it.id, { ...it, perfil: user });
          const n = found.size; // conta o acumulado: a grade pode descartar cards que saíram da tela
          if (n === last) stable++; else { stable = 0; last = n; }
          onProgress({ user, count: n });
        }
      } finally {
        chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    }
  } finally {
    await closeChrome(chrome);
  }
  return [...found.values()];
}

// onProgress({ done, total, current, results })
async function runCheck({ showWindow = false, onProgress = () => {} } = {}) {
  const urls = loadProjects();
  const startedAt = new Date();
  const results = new Array(urls.length);
  let profileStats = [];
  let done = 0;
  const chrome = await launchChrome(showWindow);
  try {
    const { browserContextId } = await chrome.cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const userAgent = (await chrome.cdp.send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const i = next++;
        onProgress({ done, total: urls.length, current: nameFromSlug(urls[i]) });
        let r;
        try { r = await checkOne(chrome.cdp, browserContextId, urls[i], userAgent); }
        catch (e) { r = { id: galleryId(urls[i]), url: urls[i], name: nameFromSlug(urls[i]), status: 'ERRO', likes: null, views: null, comments: null }; }
        if (r.status === 'ERRO') { // segunda tentativa
          try { r = await checkOne(chrome.cdp, browserContextId, urls[i], userAgent); } catch {}
        }
        results[i] = r;
        done++;
        onProgress({ done, total: urls.length, current: r.name, result: r });
      }
    };
    // os perfis são lidos em paralelo com os projetos, sem atrasar a verificação
    const profiles = async () => {
      for (const user of profileUsers()) {
        try { profileStats.push(await checkProfile(chrome.cdp, browserContextId, user, userAgent)); } catch {}
      }
    };
    await Promise.all([worker(), worker(), worker(), profiles()]);
  } finally {
    await closeChrome(chrome);
  }
  const date = today();
  writeHistory(date, results);
  writeOwners(results);
  const novosDestaques = writeDetails(results);
  writeProfileHistory(date, profileStats);
  // foto e nome do perfil vindos da própria página do perfil são mais confiáveis
  const owners = readOwners();
  for (const s of profileStats) {
    if (!s || s.seguidores == null) continue;
    const prev = owners.perfis[s.user] || {};
    owners.perfis[s.user] = { ...prev, nome: s.nome || prev.nome || s.user, foto: s.foto || prev.foto || '', url: `https://www.behance.net/${s.user}` };
  }
  fs.writeFileSync(OWNERS, JSON.stringify(owners, null, 2), 'utf8');
  const summary = {
    data: date,
    inicio: startedAt.toISOString(),
    fim: new Date().toISOString(),
    total: results.length,
    noAr: results.filter((r) => r.status === 'NO AR').length,
    foraDoAr: results.filter((r) => r.status === 'FORA DO AR').map((r) => r.name),
    erros: results.filter((r) => r.status === 'ERRO').map((r) => r.name),
    novosDestaques,
    perfis: profileStats.filter((s) => s && s.seguidores != null).map((s) => ({ perfil: s.user, seguidores: s.seguidores })),
  };
  fs.writeFileSync(LAST, JSON.stringify(summary, null, 2), 'utf8');
  return { summary, results };
}

module.exports = { runCheck, listProfileProjects, readHistory, readOwners, readDetails, readProfileHistory, loadProjects, ROOT, LAST, launchChrome, closeChrome, PROBE };
