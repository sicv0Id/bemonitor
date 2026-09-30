// Publica a versão online (só para ver) do painel:
//  1. grava public/dados.json com os mesmos dados que o painel local mostra;
//  2. se esta pasta estiver ligada ao GitHub, envia a atualização — a Vercel republica sozinha.
// Uso manual: node publicar.js   (também roda sozinho depois de cada verificação)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ROOT } = require('./engine');
const { buildData, readJson } = require('./dados');

const OUT = path.join(ROOT, 'public', 'dados.json');
const git = (args) => new Promise((res) => execFile('git', args, { cwd: ROOT, windowsHide: true, timeout: 180000 },
  (err, stdout, stderr) => res({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() })));

function exportar() {
  const config = { mostrarNavegador: false, perfis: ['marcelotrevizan', 'jesskkuhn'], ...readJson(path.join(ROOT, 'config.json'), {}) };
  const data = buildData({ config, syncing: false, job: { running: false } });
  data.publicadoEm = new Date().toISOString();
  fs.writeFileSync(`${OUT}.tmp`, JSON.stringify(data), 'utf8');
  fs.renameSync(`${OUT}.tmp`, OUT);
  return data;
}

async function publicar() {
  exportar();
  if (!fs.existsSync(path.join(ROOT, '.git'))) return { ok: true, enviado: false, motivo: 'dados.json gravado; a pasta ainda não está ligada ao GitHub' };
  await git(['add', '-A']);
  if (!(await git(['status', '--porcelain'])).out) return { ok: true, enviado: false, motivo: 'nada mudou desde a última publicação' };
  const quando = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const c = await git(['commit', '-m', `Dados atualizados em ${quando}`]);
  if (!c.ok) return { ok: false, enviado: false, motivo: `não consegui registrar a mudança: ${c.out}` };
  let p = await git(['push']);
  if (!p.ok && /rejected|fetch first|non-fast-forward/i.test(p.out)) { // o GitHub tem algo novo: traz e tenta de novo
    const r = await git(['pull', '--rebase', '--autostash']);
    if (r.ok) p = await git(['push']);
  }
  return p.ok ? { ok: true, enviado: true, motivo: 'enviado ao GitHub; a Vercel atualiza em instantes' } : { ok: false, enviado: false, motivo: `o envio ao GitHub falhou: ${p.out}` };
}

module.exports = { publicar, exportar };

if (require.main === module) {
  publicar().then((r) => { console.log(r.motivo); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
}
