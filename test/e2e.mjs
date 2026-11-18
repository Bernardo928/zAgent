// Teste ponta a ponta: abre o app, simula o Claude principal chamando o MCP e confere os cards.
// Usa o claude falso (scripts/fake-claude.mjs), então não gasta tokens.
import { _electron as electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = process.env.SHOTS || 'test-results';
execSync(`mkdir -p ${out}`);
const ws = mkdtempSync(join(tmpdir(), 'zagent-ws-'));
execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo "# demo" > README.md && git add -A && git commit -qm init', { cwd: ws });
const mcpFile = join(ws, '..', `mcp-${Date.now()}.json`);
const userData = mkdtempSync(join(tmpdir(), 'zagent-ud-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    ZAGENT_WORKSPACE: ws,
    ZAGENT_CLAUDE_BIN: resolve('scripts/fake-claude.mjs'),
    ZAGENT_MAIN_CMD: process.env.ZAGENT_MAIN_CMD ?? '/bin/bash',
    ZAGENT_DEBUG_MCP_FILE: mcpFile,
  },
});
const win = await app.firstWindow();
await win.setViewportSize?.({ width: 1480, height: 900 });
await win.waitForSelector('.xterm');
for (let i = 0; i < 50 && !existsSync(mcpFile); i++) await new Promise((r) => setTimeout(r, 100));
const { url, token } = JSON.parse(readFileSync(mcpFile, 'utf8'));
await win.screenshot({ path: `${out}/1-inicio.png` });

const client = new Client({ name: 'teste', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const tools = await client.listTools();
console.log('ferramentas MCP:', tools.tools.map((t) => t.name).join(', '));

const spawn = await client.callTool({
  name: 'spawn_agents',
  arguments: {
    agents: [
      { name: 'api', task: 'Corrigir o 404 de /users/:id e cobrir com testes.' },
      { name: 'front', task: 'Ajustar a tela de perfil para mostrar erro amigável (lento).' },
      { name: 'migracao', task: 'Rodar a migração no banco de teste (falha).' },
    ],
  },
});
console.log(spawn.content[0].text);
await win.waitForSelector('.card >> nth=2');
await new Promise((r) => setTimeout(r, 2500));
await win.screenshot({ path: `${out}/2-rodando.png` });

const waited = await client.callTool({ name: 'wait_agents', arguments: { timeout_seconds: 60 } });
console.log(waited.content[0].text.slice(0, 1200));
await new Promise((r) => setTimeout(r, 800));
await win.screenshot({ path: `${out}/3-concluido.png` });

const wt = execSync('git worktree list', { cwd: ws, encoding: 'utf8' });
console.log('worktrees:\n' + wt);
const status = execSync('git status --porcelain', { cwd: ws, encoding: 'utf8' });
console.log('git status do projeto (deve estar vazio):', JSON.stringify(status));

// Unauthorized deve ser recusado
const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log('sem token ->', r.status);

const counts = await win.$$eval('.card', (els) => els.map((e) => e.className));
console.log('cards:', counts);
await client.close();
await app.close();
