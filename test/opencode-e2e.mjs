// Agentes paralelos no OpenCode, com um provedor falso (sem credenciais).
// Roda `zagent monitor --workers opencode` no tmux e abre 2 agentes pelo MCP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = spawn(process.execPath, [resolve('test/fake-openai.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((r) => fake.stdout.once('data', (d) => r(String(d).trim())));
const ws = mkdtempSync(join(tmpdir(), 'zagent-oc-'));
execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo x > a && git add -A && git commit -qm init', { cwd: ws });
const home = mkdtempSync(join(tmpdir(), 'zagent-home-'));
const ready = join(home, 'ready.json');
const provider = JSON.stringify({
  provider: { fake: { npm: '@ai-sdk/openai-compatible', name: 'Fake', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' }, models: { m1: { name: 'm1' } } } },
  model: 'fake/m1', small_model: 'fake/m1',
});
writeFileSync(join(home, 'provider.json'), provider);
const S = 'zagent-oc-' + process.pid;
// Abre o monitor a partir de OUTRA pasta (PWD diferente) para provar que os agentes ficam no worktree.
const elsewhere = mkdtempSync(join(tmpdir(), 'zagent-pwd-'));
execSync(`tmux -u new-session -d -s ${S} -x 120 -y 44 -c ${elsewhere} "OPENCODE_CONFIG_CONTENT=\\$(cat ${home}/provider.json) ZAGENT_HOME=${home} node ${resolve('dist/cli.js')} monitor --workers opencode --cwd ${ws} --ready-file ${ready}"`);
let info;
for (let i = 0; i < 50 && !info; i++) { await sleep(100); try { info = JSON.parse(readFileSync(ready, 'utf8')); } catch {} }
const cfg = JSON.parse(readFileSync(info.mcpConfig, 'utf8')).mcpServers.zagent;
const client = new Client({ name: 't', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
const t0 = Date.now();
await client.callTool({ name: 'spawn_agents', arguments: { agents: [
  { name: 'eco', task: 'Rode o comando. CMD: echo feito > prova.txt && git add -A && git commit -qm prova' },
  { name: 'perigoso', task: 'Rode o comando. CMD: git push --force origin main' },
] } });
await sleep(1500);
console.log(execSync(`tmux capture-pane -p -t ${S}`, { encoding: 'utf8' }).split('\n').filter((l) => l.trim()).slice(0, 14).join('\n'));
const res = await client.callTool({ name: 'wait_agents', arguments: { timeout_seconds: 120 } });
console.log(`\n--- wait_agents (${((Date.now() - t0) / 1000).toFixed(1)}s) ---\n` + res.content[0].text);
await sleep(400);
writeFileSync(join(process.env.SHOTS || '/tmp', 'oc-monitor.ansi'), execSync(`tmux capture-pane -e -p -t ${S}`, { encoding: 'utf8' }));
console.log('\n--- monitor ---\n' + execSync(`tmux capture-pane -p -t ${S}`, { encoding: 'utf8' }));
console.log(execSync('git log --all --oneline && git worktree list', { cwd: ws, encoding: 'utf8' }));
// Isolamento: o commit tem que estar só na branch do agente; a main e a pasta de onde abrimos ficam intactas.
const fail = (m) => { console.error('FALHOU: ' + m); process.exitCode = 1; };
const ecoBranch = execSync('git branch --list "zagent/eco-*" --format="%(refname:short)"', { cwd: ws, encoding: 'utf8' }).trim();
if (!execSync(`git log ${ecoBranch} --oneline`, { cwd: ws, encoding: 'utf8' }).includes('prova')) fail('o commit não está na branch do agente');
if (execSync('git log main --oneline', { cwd: ws, encoding: 'utf8' }).includes('prova')) fail('o commit vazou para a main');
if (execSync(`ls -A ${elsewhere}`, { encoding: 'utf8' }).trim()) fail('o agente escreveu na pasta de onde o zAgent foi aberto');
if (!res.content[0].text.includes('1 commit')) fail('o resumo não mostra o commit do agente');
if (!process.exitCode) console.log('OK: isolamento confirmado');
execSync(`tmux kill-session -t ${S}`);
fake.kill();
await client.close().catch(() => {});
