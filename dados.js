// Monta os dados que o painel mostra (lista de projetos + histórico + perfis + marcos + metas).
// Usado pelo servidor local (/api/data) e pela publicação da versão online (public/dados.json).
const fs = require('fs');
const path = require('path');
const { readHistory, readOwners, readDetails, readProfileHistory, loadProjects, ROOT, LAST } = require('./engine');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const galleryId = (u) => (String(u).match(/gallery\/(\d+)/) || [])[1] || '';
const slugName = (u) => decodeURIComponent((String(u).split('/').pop() || '').replace(/-/g, ' ')) || `Projeto ${galleryId(u)}`;
const MARKS = path.join(ROOT, 'marcos.json');
const GOALS = path.join(ROOT, 'metas.json');

function projectList() {
  const names = new Map();
  for (const r of readHistory()) if (r.status === 'NO AR' || !names.has(r.id_galeria)) names.set(r.id_galeria, r.projeto);
  const owners = readOwners().projetos;
  return loadProjects().map((u) => ({ id: galleryId(u), url: u, name: names.get(galleryId(u)) || slugName(u), owners: owners[galleryId(u)] || [] }));
}

function buildData({ config, syncing = false, job = { running: false } }) {
  const list = projectList();
  return {
    rows: readHistory(), last: readJson(LAST, null), projects: list.length, projectList: list, profiles: readOwners().perfis,
    details: readDetails(), profileRows: readProfileHistory(), marks: readJson(MARKS, []), goals: readJson(GOALS, {}), config, syncing, job,
  };
}

module.exports = { projectList, buildData, galleryId, readJson, MARKS, GOALS };
