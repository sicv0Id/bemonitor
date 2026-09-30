// Uso: node check.js [--mostrar] [--se-precisar]
// Verifica todos os projetos, grava historico.csv e imprime o resumo em JSON.
// Antes, traz do GitHub o que outra máquina já publicou (ex.: a verificação na nuvem);
// depois, publica a versão online. --se-precisar: se já houve verificação hoje, só sincroniza.
const fs = require('fs');
const { runCheck, LAST } = require('./engine');
const { publicar, sincronizar } = require('./publicar');

const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

(async () => {
  try { const s = await sincronizar(); process.stderr.write(`GitHub: ${s.motivo}\n`); }
  catch (e) { process.stderr.write(`GitHub: não sincronizado (${e.message})\n`); }

  if (process.argv.includes('--se-precisar')) {
    let last = null;
    try { last = JSON.parse(fs.readFileSync(LAST, 'utf8')); } catch {}
    if (last && last.data === hoje()) {
      process.stderr.write(`Já houve verificação hoje (${last.fim}); nada a verificar.\n`);
      console.log(JSON.stringify({ summary: last, results: null, pulada: true }, null, 2));
      return;
    }
  }

  const { summary, results } = await runCheck({
    showWindow: process.argv.includes('--mostrar'),
    onProgress: ({ done, total, current }) => process.stderr.write(`\r${done}/${total}  ${current}`.padEnd(90)),
  });
  process.stderr.write('\n');
  console.log(JSON.stringify({ summary, results }, null, 2));

  // atualiza a versão online (Vercel); mensagens vão para stderr para não misturar com o resumo
  try {
    const r = await publicar();
    process.stderr.write(`Versão online: ${r.motivo}\n`);
    if (!r.ok && process.env.CI) process.exitCode = 1; // na nuvem, um envio que falhou aparece como erro
  } catch (e) {
    process.stderr.write(`Versão online: não publicada (${e.message})\n`);
    if (process.env.CI) process.exitCode = 1;
  }
})().catch((e) => { console.error('\nFalhou:', e.message); process.exit(1); });
