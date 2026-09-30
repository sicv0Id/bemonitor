// Sincroniza esta pasta com o GitHub e publica a versão online (só para ver) do painel.
//  - sincronizar(): traz o que foi publicado por outra máquina (ex.: a verificação na nuvem do GitHub)
//  - publicar():   grava public/dados.json, registra e envia ao GitHub — a Vercel republica sozinha
//  - atualizar():  sincroniza e, se houver algo daqui ainda não enviado, publica
// Uso manual: node publicar.js            (publica agora)
//             node publicar.js --sincronizar (só traz o que está no GitHub)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ROOT } = require('./engine');
const { buildData, readJson } = require('./dados');

const OUT = path.join(ROOT, 'public', 'dados.json');
const temGit = () => fs.existsSync(path.join(ROOT, '.git'));
const git = (args) => new Promise((res) => execFile('git', args, { cwd: ROOT, windowsHide: true, timeout: 180000 },
  (err, stdout, stderr) => res({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() })));

// Endereço do repositório no GitHub (para o botão "Executar verificação" da versão online).
async function repoUrl() {
  if (!temGit()) return null;
  const r = await git(['remote', 'get-url', 'origin']);
  const m = r.ok && r.out.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

async function exportar() {
  const config = { mostrarNavegador: false, perfis: ['marcelotrevizan', 'jesskkuhn'], ...readJson(path.join(ROOT, 'config.json'), {}) };
  const data = buildData({ config, syncing: false, job: { running: false } });
  data.publicadoEm = new Date().toISOString();
  const repo = await repoUrl();
  if (repo) data.acoes = { verificar: `${repo}/actions/workflows/verificar.yml` };
  fs.writeFileSync(`${OUT}.tmp`, JSON.stringify(data), 'utf8');
  fs.renameSync(`${OUT}.tmp`, OUT);
  return data;
}

// Registra o que mudou nesta pasta (dados, marcos, metas) antes de juntar com o GitHub.
async function registrar(msg) {
  await git(['add', '-A']);
  if (!(await git(['status', '--porcelain'])).out) return { ok: true, mudou: false };
  const c = await git(['commit', '-q', '-m', msg]);
  return { ok: c.ok, mudou: c.ok, out: c.out };
}

// Junta com o GitHub quando os dois lados mudaram. Em conflito, vale o que já está lá
// (o resultado de uma verificação completa); se nem assim der, desfaz e deixa tudo como estava.
async function mesclar() {
  const m = await git(['pull', '-q', '--no-rebase', '--no-edit', '-X', 'theirs', 'origin', 'main']);
  if (m.ok) return { ok: true, motivo: 'dados juntados com o GitHub' };
  await git(['merge', '--abort']);
  return { ok: false, motivo: `não consegui juntar com o GitHub: ${m.out}` };
}

async function sincronizar() {
  if (!temGit()) return { ok: true, motivo: 'pasta sem git' };
  await registrar('Ajustes feitos no painel local');
  const f = await git(['fetch', '-q', 'origin']);
  if (!f.ok) return { ok: false, motivo: `sem acesso ao GitHub agora: ${f.out}` };
  if ((await git(['merge', '-q', '--ff-only', 'origin/main'])).ok) return { ok: true, motivo: 'dados em dia com o GitHub' };
  return mesclar();
}

async function publicar() {
  await exportar();
  if (!temGit()) return { ok: true, enviado: false, motivo: 'dados.json gravado; a pasta ainda não está ligada ao GitHub' };
  const quando = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const c = await registrar(`Dados atualizados em ${quando}`);
  if (!c.ok) return { ok: false, enviado: false, motivo: `não consegui registrar a mudança: ${c.out}` };
  let p = await git(['push', '-q', 'origin', 'HEAD:main']);
  if (!p.ok) { // o GitHub tem algo novo (ex.: a nuvem verificou): junta, regrava o dados.json e tenta de novo
    const s = await sincronizar();
    if (!s.ok) return { ok: false, enviado: false, motivo: s.motivo };
    await exportar();
    await registrar(`Dados atualizados em ${quando}`);
    p = await git(['push', '-q', 'origin', 'HEAD:main']);
  }
  if (!p.ok) return { ok: false, enviado: false, motivo: `o envio ao GitHub falhou: ${p.out}` };
  return { ok: true, enviado: true, motivo: c.mudou ? 'enviado ao GitHub; a Vercel atualiza em instantes' : 'nada novo para enviar' };
}

async function atualizar() {
  const s = await sincronizar();
  if (!s.ok || !temGit()) return s;
  const ahead = await git(['rev-list', '--count', 'origin/main..HEAD']);
  return ahead.ok && Number(ahead.out) > 0 ? publicar() : s;
}

module.exports = { publicar, sincronizar, atualizar, exportar };

if (require.main === module) {
  (process.argv.includes('--sincronizar') ? sincronizar() : publicar())
    .then((r) => { console.log(r.motivo); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
}
