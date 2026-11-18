#!/usr/bin/env node
// "Claude" falso para testes: imita a saída stream-json do `claude -p` sem gastar tokens.
// Palavras na tarefa mudam o comportamento: "falha" -> erro, "lento" -> demora mais.
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
// Diretivas na tarefa, para testes de coordenação:
//   WRITE:<arquivo>=<conteúdo>  escreve um arquivo na pasta do agente
//   POST:<texto>                publica no quadro do zAgent (via MCP, como um agente real)
//   READ                        lê o quadro e coloca as mensagens no resumo final
async function boardCall(tool, args) {
  const i = process.argv.indexOf('--mcp-config');
  if (i < 0) return '(sem MCP)';
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../package.json', import.meta.url));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const cfg = JSON.parse(readFileSync(process.argv[i + 1], 'utf8')).mcpServers.zagent;
  const c = new Client({ name: 'fake', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  const r = await c.callTool({ name: tool, arguments: args });
  await c.close();
  return r.content[0].text;
}

process.stdin.on('end', async () => {
  const task = prompt.split('Sua tarefa:').pop();
  const { writeFileSync } = await import('node:fs');
  const notes = [];
  for (const m of task.matchAll(/WRITE:([^=\s]+)=(\S+)/g)) writeFileSync(m[1], m[2] + '\n');
  for (const m of task.matchAll(/POST:([^|]+)\|/g)) notes.push('postou: ' + (await boardCall('board_post', { text: m[1].trim() })));
  if (/\bREAD\b/.test(task)) notes.push('quadro: ' + (await boardCall('board_read', {})));
  const ctx = [...prompt.matchAll(/Etapa anterior: (\S+)/g)].map((m) => m[1]);
  if (ctx.length) notes.push('CONTEXTO recebido de: ' + ctx.join(', '));
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
  const base = 'Pronto. Corrigi o 404 em src/routes/users.ts e adicionei 2 testes. `npm test` passou (14/14). Não testei a integração com o banco real.';
  out({ type: 'result', subtype: 'success', is_error: false, result: [base, ...notes].join('\n'), total_cost_usd: 0.1437, num_turns: 11 });
});
