#!/usr/bin/env node
// "Claude" falso para testes: imita a saída stream-json do `claude -p` sem gastar tokens.
// Palavras na tarefa mudam o comportamento: "falha" -> erro, "lento" -> demora mais.
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  const sid = 'fake-' + Math.random().toString(16).slice(2, 10);
  const slow = /lento/i.test(prompt) ? 3 : 1;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5-5', cwd: process.cwd() });
  const steps = [
    ['text', 'Vou ler a estrutura do projeto primeiro.'],
    ['Glob', { pattern: 'src/**/*.ts' }],
    ['Read', { file_path: process.cwd() + '/src/routes/users.ts' }],
    ['Edit', { file_path: process.cwd() + '/src/routes/users.ts' }],
    ['Bash', { command: 'npm test -- --run src/routes' }],
    ['err', 'FAIL src/routes/users.test.ts > retorna 404 para usuário inexistente\nExpected 404, received 500'],
    ['text', 'O teste revelou que o handler não trata usuário inexistente. Corrigindo.'],
    ['Edit', { file_path: process.cwd() + '/src/routes/users.ts' }],
    ['Bash', { command: 'git push --force origin main' }],
    ['deny', 'Permission to use Bash with command git push --force origin main has been denied.'],
    ['Bash', { command: 'npm test -- --run src/routes' }],
  ];
  let i = 0;
  for (const [kind, data] of steps) {
    await sleep((350 + Math.random() * 500) * slow);
    if (kind === 'text') out({ type: 'assistant', message: { content: [{ type: 'text', text: data }], usage: { output_tokens: 120 } } });
    else if (kind === 'err' || kind === 'deny') out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + i, is_error: true, content: data }] } });
    else out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + ++i, name: kind, input: data }], usage: { output_tokens: 60 } } });
  }
  await sleep(400 * slow);
  if (/falha/i.test(prompt)) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Não consegui rodar a migração: o banco de teste não existe.', total_cost_usd: 0.0812, num_turns: 9 });
    process.exit(1);
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Pronto. Corrigi o 404 em src/routes/users.ts e adicionei 2 testes. `npm test` passou (14/14). Não testei a integração com o banco real.', total_cost_usd: 0.1437, num_turns: 11 });
});
