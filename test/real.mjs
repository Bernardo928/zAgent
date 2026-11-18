// Teste manual com o Claude Code de verdade (gasta tokens). Uso: xvfb-run node test/real.mjs
import { _electron as electron } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.env.SHOTS || 'test-results';
mkdirSync(out, { recursive: true });
const ws = mkdtempSync(join(tmpdir(), 'zagent-real-'));
execSync(`git init -q -b main && git config user.email t@t && git config user.name t &&
  printf 'export function soma(a, b) {\\n  return a + b;\\n}\\n' > math.js &&
  printf 'export function saudacao(nome) {\\n  return "oi " + nome;\\n}\\n' > texto.js &&
  git add -A && git commit -qm init`, { cwd: ws, shell: '/bin/bash' });
const userData = mkdtempSync(join(tmpdir(), 'zagent-ud-'));
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ workerModel: 'haiku', workerPermission: 'standard', maxConcurrent: 4, isolate: true }));

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, ZAGENT_WORKSPACE: ws } });
const win = await app.firstWindow();
await win.waitForSelector('.xterm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(9000);
await win.screenshot({ path: `${out}/r1.png` });
await win.click('#terminal');
// Diálogo de "confiar na pasta", se aparecer.
// Telas de primeiro uso (tema, avisos, confiar na pasta, MCP): aceita o padrão.
for (let i = 0; i < 12; i++) {
  const t = (await win.$eval('#terminal', (e) => e.innerText)).slice(-1500);
  if (/❯ No, exit/.test(t)) { await win.keyboard.press('ArrowDown'); await sleep(300); }
  if (/Press Enter|trust|proceed|Choose|theme|Enter to confirm|new MCP server|Use this and all/i.test(t)) {
    await win.keyboard.press('Enter');
    await sleep(3000);
  } else break;
}
await win.screenshot({ path: `${out}/r2.png` });
await win.keyboard.type('Use 2 agentes em paralelo: um adiciona JSDoc em math.js e o outro adiciona JSDoc em texto.js. Depois me diga o resultado.');
await sleep(500);
await win.keyboard.press('Enter');
for (let i = 0; i < 60; i++) {
  await sleep(5000);
  const t = await win.$eval('#terminal', (e) => e.innerText);
  if (/Enter to confirm/.test(t.slice(-600))) { await win.keyboard.press('Enter'); }
  const st = await win.$$eval('.card', (els) => els.map((e) => e.className));
  if (i % 4 === 0) await win.screenshot({ path: `${out}/r-${i}.png` });
  console.log(i, st.join(' | '));
  if (st.length >= 2 && st.every((c) => /s-(done|failed|stopped)/.test(c))) { await sleep(25000); break; }
}
await win.screenshot({ path: `${out}/r-final.png` });
console.log(execSync('git worktree list && git branch -a && git log --all --oneline', { cwd: ws, encoding: 'utf8' }));
for (const b of execSync('git branch --format="%(refname:short)" --list "zagent/*"', { cwd: ws, encoding: 'utf8' }).split('\n').map(s=>s.trim()).filter(Boolean))
  console.log(b, '\n', execSync(`git diff main ${b} --stat`, { cwd: ws, encoding: 'utf8' }));
console.log((await win.$eval('#terminal', (e) => e.innerText)).slice(-2500));
await app.close();
