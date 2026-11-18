// Coordenação: etapas com dependência, quadro de mensagens, integração com conflito e revisor.
// Usa o claude falso (scripts/fake-claude.mjs), que escreve arquivos e usa o quadro pelo MCP de verdade.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${msg}`);
  if (!ok) failures++;
};

const ws = mkdtempSync(join(tmpdir(), 'zagent-coord-'));
execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo base > README && git add -A && git commit -qm init', { cwd: ws });
const home = mkdtempSync(join(tmpdir(), 'zagent-home-'));
const ready = join(home, 'ready.json');
const S = 'zagent-coord-' + process.pid;
execSync(
  `tmux -u new-session -d -s ${S} -x 130 -y 60 "ZAGENT_HOME=${home} ZAGENT_CLAUDE_BIN=${resolve('scripts/fake-claude.mjs')} node ${resolve('dist/cli.js')} monitor --workers claude --max 4 --cwd ${ws} --ready-file ${ready}"`,
);
let info;
for (let i = 0; i < 50 && !info; i++) {
  await sleep(100);
  try { info = JSON.parse(readFileSync(ready, 'utf8')); } catch {}
}
const cfg = JSON.parse(readFileSync(info.mcpConfig, 'utf8')).mcpServers.zagent;
const client = new Client({ name: 't', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
const status = async () => call('agent_status', {});

// 1) Validação: ciclo e dependência inexistente são recusados.
const cyc = await client.callTool({ name: 'spawn_agents', arguments: { agents: [
  { name: 'a', task: 'x', after: ['b'] }, { name: 'b', task: 'x', after: ['a'] },
] } });
check(cyc.isError && /circular/i.test(cyc.content[0].text), 'recusa dependência circular');
const unk = await client.callTool({ name: 'spawn_agents', arguments: { agents: [{ name: 'c', task: 'x', after: ['fantasma'] }] } });
check(unk.isError && /não existe/.test(unk.content[0].text), 'recusa dependência inexistente');

// 2) Etapas + quadro + duas branches que vão conflitar.
const t0 = Date.now();
console.log(await call('spawn_agents', { agents: [
  { name: 'api', task: 'Crie a API. WRITE:api.txt=rotas-v2 POST:a rota /users agora é /v2/users|' },
  { name: 'front', task: 'Crie o front usando a API. WRITE:front.txt=usa-v2 READ', after: ['api'] },
  { name: 'estilo-a', task: 'Tema claro. WRITE:tema.txt=claro' },
  { name: 'estilo-b', task: 'Tema escuro. WRITE:tema.txt=escuro' },
] }));
await sleep(1500);
const early = await status();
check(/## front .*— waiting/.test(early), 'front fica "waiting" enquanto a api roda');

const all = await call('wait_agents', { timeout_seconds: 120 });
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
check(/## api .*— done/.test(all) && /## front .*— done/.test(all), 'api e front concluídos');
check(/CONTEXTO recebido de: api/.test(all), 'front recebeu o resultado da api na tarefa');
check(/quadro: .*de api para todos: a rota \/users agora é \/v2\/users/s.test(all), 'front leu no quadro o aviso da api');
const frontBranch = /## front[\s\S]*?Branch: (\S+)/.exec(all)[1];
const frontFiles = execSync(`git ls-tree --name-only ${frontBranch}`, { cwd: ws, encoding: 'utf8' });
check(frontFiles.includes('api.txt') && frontFiles.includes('front.txt'), 'branch do front contém o código da api (juntada antes de começar)');
check(/1 commit|2 commit|3 commit/.test(all), 'zAgent commitou o trabalho que o agente deixou sem commit');

// 3) Etapa que falha pula quem depende dela.
await call('spawn_agents', { agents: [
  { name: 'quebra', task: 'Isto falha (falha).' },
  { name: 'depende', task: 'Usa o resultado de quebra.', after: ['quebra'] },
] });
const skip = await call('wait_agents', { ids: ['quebra', 'depende'], timeout_seconds: 60 });
check(/## quebra .*— failed/.test(skip) && /## depende .*— stopped/.test(skip) && /Pulado/.test(skip), 'dependente é pulado quando a etapa anterior falha');

// 4) Quadro pelo principal.
await call('board_post', { text: 'lembrem de rodar os testes', to: 'todos' });
const boardAll = await call('board_read', { all: true });
check(/principal → todos: lembrem/.test(boardAll) && /api → todos/.test(boardAll), 'principal lê o histórico do quadro');

// 5) Integração com conflito + revisor.
const integ = await call('integrate_agents', { ids: ['api', 'front', 'estilo-a', 'estilo-b'] });
console.log(integ);
check(/Juntadas: api, front, estilo-a/.test(integ), 'junta api, front e estilo-a');
check(/estilo-b .*tema\.txt/.test(integ), 'estilo-b fica de fora por conflito em tema.txt');
const integBranch = /Branch de integração: (\S+)/.exec(integ)[1];
const rev = await call('wait_agents', { ids: ['revisor'], timeout_seconds: 60 });
check(/## revisor .*— done/.test(rev), 'revisor rodou e concluiu');
check(rev.includes(`Branch: ${integBranch}`), 'revisor trabalhou na branch de integração');
const integFiles = execSync(`git ls-tree --name-only ${integBranch}`, { cwd: ws, encoding: 'utf8' });
check(['api.txt', 'front.txt', 'tema.txt'].every((f) => integFiles.includes(f)), 'branch de integração tem o trabalho juntado');
check(execSync(`git show ${integBranch}:tema.txt`, { cwd: ws, encoding: 'utf8' }).trim() === 'claro', 'conflito não sobrescreveu: tema.txt = claro');
check(execSync('git log main --oneline', { cwd: ws, encoding: 'utf8' }).trim().split('\n').length === 1, 'main intacta');
check(!execSync('git status --porcelain', { cwd: ws, encoding: 'utf8' }).trim(), 'pasta do projeto sem mudanças');

// 6) Endpoint de agente não abre agentes nem aceita token errado.
const r = await fetch(cfg.url.replace(/\/mcp$/, '/agent/deadbeef'), { method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: '{}' });
check(r.status === 401, 'endpoint de agente recusa token errado');

await sleep(500);
writeFileSync(join(process.env.SHOTS || '/tmp', 'coord-monitor.ansi'), execSync(`tmux capture-pane -e -p -t ${S}`, { encoding: 'utf8' }));
console.log(execSync(`tmux capture-pane -p -t ${S}`, { encoding: 'utf8' }).split('\n').slice(0, 40).join('\n'));
execSync(`tmux kill-session -t ${S}`);
await client.close().catch(() => {});
console.log(failures ? `\n${failures} verificação(ões) falharam` : '\nTudo certo.');
process.exit(failures ? 1 : 0);
