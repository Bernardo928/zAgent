// Teste da CLI: roda `zagent monitor` num tmux, abre agentes pelo MCP (claude falso) e captura a tela.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = process.env.SHOTS || 'test-results';
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = mkdtempSync(join(tmpdir(), 'zagent-cli-'));
execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo x > a && git add -A && git commit -qm init', { cwd: ws });
const home = mkdtempSync(join(tmpdir(), 'zagent-home-'));
const ready = join(home, 'ready.json');
const S = 'zagent-test-' + process.pid;
const env = `ZAGENT_HOME=${home} ZAGENT_CLAUDE_BIN=${resolve('scripts/fake-claude.mjs')}`;
execSync(`tmux new-session -d -s ${S} -x 110 -y 46 "${env} node ${resolve('dist/cli.js')} monitor --cwd ${ws} --ready-file ${ready}"`);
let info;
for (let i = 0; i < 50 && !info; i++) { await sleep(100); try { info = JSON.parse(readFileSync(ready, 'utf8')); } catch {} }
const cap = (name) => { const t = execSync(`tmux capture-pane -e -p -t ${S}`, { encoding: 'utf8' }); writeFileSync(`${out}/${name}.ansi`, t); return t; };
await sleep(500);
console.log(execSync(`tmux capture-pane -p -t ${S}`, { encoding: 'utf8' }));

const cfg = JSON.parse(readFileSync(info.mcpConfig, 'utf8')).mcpServers.zagent;
const client = new Client({ name: 't', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
await client.callTool({ name: 'spawn_agents', arguments: { agents: [
  { name: 'api', task: 'Corrigir o 404 de /users/:id e cobrir com testes.' },
  { name: 'front', task: 'Ajustar a tela de perfil (lento).' },
  { name: 'migracao', task: 'Rodar a migração no banco de teste (falha).' },
] } });
await sleep(2500);
cap('cli-rodando');
console.log(execSync(`tmux capture-pane -p -t ${S}`, { encoding: 'utf8' }));
await client.callTool({ name: 'wait_agents', arguments: { timeout_seconds: 60 } });
await sleep(500);
cap('cli-fim');
console.log(execSync(`tmux capture-pane -p -t ${S}`, { encoding: 'utf8' }));
execSync(`tmux send-keys -t ${S} Enter`); await sleep(400);
console.log(execSync(`tmux capture-pane -p -t ${S}`, { encoding: 'utf8' }));
execSync(`tmux send-keys -t ${S} q`); await sleep(800);
let aliveAfter = true; try { execSync(`tmux has-session -t ${S} 2>/dev/null`); } catch { aliveAfter = false; }
console.log('sessão ainda existe depois de q?', aliveAfter);
try { execSync(`tmux kill-session -t ${S}`); } catch {}
await client.close().catch(() => {});
