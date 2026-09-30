// Uso: node check.js [--mostrar]
// Verifica todos os projetos, grava historico.csv e imprime o resumo em JSON.
const { runCheck } = require('./engine');

runCheck({
  showWindow: process.argv.includes('--mostrar'),
  onProgress: ({ done, total, current }) => process.stderr.write(`\r${done}/${total}  ${current}`.padEnd(90)),
})
  .then(async ({ summary, results }) => {
    process.stderr.write('\n');
    console.log(JSON.stringify({ summary, results }, null, 2));
    // atualiza a versão online (Vercel); mensagens vão para stderr para não misturar com o resumo
    try { const r = await require('./publicar').publicar(); process.stderr.write(`Versão online: ${r.motivo}\n`); }
    catch (e) { process.stderr.write(`Versão online: não publicada (${e.message})\n`); }
  })
  .catch((e) => { console.error('\nFalhou:', e.message); process.exit(1); });
