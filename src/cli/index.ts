// zagent (CLI): Claude Code à esquerda, monitor de agentes à direita, no terminal (via tmux).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeBin } from '../main/claudeBin';
import { startMcpServer } from '../main/mcpServer';
import { Orchestrator } from '../main/orchestrator';
import { MAIN_ALLOWED_TOOLS, MAIN_PROMPT, mcpConfigJson } from '../shared/mainClaude';
import type { Settings, WorkerPermission } from '../shared/types';
import { Monitor } from './monitor';

const HOME = process.env.ZAGENT_HOME || join(homedir(), '.zagent');
const RUN = join(HOME, 'run');

const HELP = `zagent: Claude Code com um painel para cada agente paralelo, direto no terminal.

Uso:
  zagent [opções] [-- args extras do claude]   abre o Claude à esquerda e o monitor à direita (tmux)
  zagent monitor [opções]                      só o monitor (use quando não tiver tmux)
  zagent claude [-- args extras]               abre um Claude ligado ao monitor que já está rodando
  zagent help

Opções:
  --cwd <pasta>         pasta do projeto (padrão: a atual)
  --model <modelo>      modelo dos agentes paralelos (ex.: sonnet, haiku, opus)
  --permission <modo>   safe | standard | full  (padrão: standard)
  --max <n>             máximo de agentes ao mesmo tempo (padrão: 4)
  --no-isolate          não cria git worktree por agente (não recomendado)

No monitor: ↑↓ escolhe · enter abre · s para · m manda mensagem · n novo agente · x fecha · q sai
Configuração padrão em ${join(HOME, 'settings.json')}.`;

interface Parsed {
  cmd: 'run' | 'monitor' | 'claude' | 'help';
  settings: Settings;
  readyFile?: string;
  hint?: boolean;
  extra: string[];
}

function parse(argv: string[]): Parsed {
  let cmd: Parsed['cmd'] = 'run';
  const dd = argv.indexOf('--');
  const extra = dd >= 0 ? argv.slice(dd + 1) : [];
  const args = dd >= 0 ? argv.slice(0, dd) : argv;

  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(join(HOME, 'settings.json'), 'utf8'));
  } catch { /* sem arquivo: usa o padrão */ }
  const settings: Settings = {
    workspace: process.cwd(),
    workerPermission: 'standard',
    workerModel: '',
    maxConcurrent: 4,
    isolate: true,
    ...saved,
  };
  settings.workspace = process.cwd();
  const out: Parsed = { cmd, settings, extra };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => {
      const v = args[++i];
      if (v === undefined) die(`Falta o valor de ${a}.`);
      return v;
    };
    switch (a) {
      case 'monitor':
      case 'claude':
      case 'help':
        out.cmd = a;
        break;
      case '-h':
      case '--help':
        out.cmd = 'help';
        break;
      case '--cwd':
        settings.workspace = resolve(val());
        break;
      case '--model':
        settings.workerModel = val();
        break;
      case '--permission': {
        const p = val();
        if (!['safe', 'standard', 'full'].includes(p)) die('--permission deve ser safe, standard ou full.');
        settings.workerPermission = p as WorkerPermission;
        break;
      }
      case '--max':
        settings.maxConcurrent = Math.max(1, Math.min(12, Number(val()) || 4));
        break;
      case '--no-isolate':
        settings.isolate = false;
        break;
      case '--ready-file':
        out.readyFile = val();
        break;
      case '--hint':
        out.hint = true;
        break;
      default:
        die(`Opção desconhecida: ${a}\n\n${HELP}`);
    }
  }
  if (!existsSync(settings.workspace)) die(`Pasta não existe: ${settings.workspace}`);
  return out;
}

function die(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function settingsFlags(s: Settings): string[] {
  const f = ['--cwd', s.workspace, '--permission', s.workerPermission, '--max', String(s.maxConcurrent)];
  if (s.workerModel) f.push('--model', s.workerModel);
  if (!s.isolate) f.push('--no-isolate');
  return f;
}

interface SessionInfo {
  pid: number;
  workspace: string;
  mcpConfig: string;
  promptFile: string;
  startedAt: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claudeArgs(s: SessionInfo, extra: string[]): string[] {
  return [
    '--mcp-config', s.mcpConfig,
    '--append-system-prompt-file', s.promptFile,
    '--allowedTools', MAIN_ALLOWED_TOOLS,
    ...extra,
  ];
}

// ------------------------------------------------------------------ zagent monitor
async function runMonitor(p: Parsed): Promise<void> {
  if (!process.stdout.isTTY) die('O monitor precisa de um terminal interativo.');
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  let monitor: Monitor | null = null;
  const orch = new Orchestrator(() => p.settings, (ev) => monitor?.onEvent(ev), RUN);
  const mcp = await startMcpServer(orch);

  const mcpConfig = join(RUN, `mcp-${process.pid}.json`);
  writeFileSync(mcpConfig, mcpConfigJson(mcp.url, mcp.token), { mode: 0o600 });
  chmodSync(mcpConfig, 0o600);
  const promptFile = join(RUN, 'main-prompt.txt');
  writeFileSync(promptFile, MAIN_PROMPT);
  const info: SessionInfo = { pid: process.pid, workspace: p.settings.workspace, mcpConfig, promptFile, startedAt: Date.now() };
  const sessionFile = join(RUN, `session-${process.pid}.json`);
  writeFileSync(sessionFile, JSON.stringify(info), { mode: 0o600 });
  if (p.readyFile) writeFileSync(p.readyFile, JSON.stringify(info), { mode: 0o600 });

  let exiting = false;
  const shutdown = (code = 0) => {
    if (exiting) return;
    exiting = true;
    orch.stopAll();
    monitor?.close();
    mcp.close();
    for (const f of [mcpConfig, sessionFile]) rmSync(f, { force: true });
    if (process.env.ZAGENT_TMUX_SESSION) {
      spawnSync('tmux', ['kill-session', '-t', process.env.ZAGENT_TMUX_SESSION], { stdio: 'ignore' });
    }
    // Dá tempo para os agentes receberem o sinal de parada.
    setTimeout(() => process.exit(code), 300);
  };
  process.on('SIGHUP', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  monitor = new Monitor(orch, p.settings.workspace, () => shutdown(0), p.hint ? 'zagent claude' : undefined);
  monitor.start();
}

// ------------------------------------------------------------------ zagent claude
function findSession(workspace: string): SessionInfo | null {
  if (!existsSync(RUN)) return null;
  const sessions = readdirSync(RUN)
    .filter((f) => /^session-\d+\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(RUN, f), 'utf8')) as SessionInfo;
      } catch {
        return null;
      }
    })
    .filter((s): s is SessionInfo => !!s && alive(s.pid))
    .sort((a, b) => b.startedAt - a.startedAt);
  return sessions.find((s) => s.workspace === workspace) ?? sessions[0] ?? null;
}

function runClaude(p: Parsed): void {
  const s = findSession(p.settings.workspace);
  if (!s) die('Nenhum monitor rodando. Abra outro terminal e rode `zagent monitor` primeiro (ou só `zagent`, com tmux).');
  if (s.workspace !== p.settings.workspace) {
    process.stderr.write(`Aviso: o monitor está na pasta ${s.workspace}. Os agentes vão trabalhar lá.\n`);
  }
  const bin = claudeBin();
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const child = spawn(bin, claudeArgs(s, p.extra), { stdio: 'inherit', cwd: s.workspace, shell });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ------------------------------------------------------------------ zagent (tmux)
async function runAll(p: Parsed): Promise<void> {
  const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  if (!hasTmux) {
    process.stderr.write(
      'tmux não encontrado, então vou abrir só o monitor aqui.\n' +
        'Abra OUTRO terminal nesta mesma pasta e rode:  zagent claude\n\n' +
        (process.platform === 'win32'
          ? 'Dica: no Windows Terminal, Alt+Shift+D divide a janela.\n'
          : 'Dica: instale o tmux (brew install tmux / apt install tmux) para abrir tudo junto.\n'),
    );
    await new Promise((r) => setTimeout(r, 2500));
    return runMonitor({ ...p, hint: true });
  }

  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const session = `zagent-${process.pid}`;
  const ready = join(RUN, `ready-${process.pid}.json`);
  rmSync(ready, { force: true });
  const self = [process.execPath, process.argv[1]];
  const cols = process.stdout.columns || 200;
  const rows = process.stdout.rows || 50;
  // -u: força UTF-8 (sem isso, terminais com locale ruim mostram bordas e ícones quebrados).
  const tmux = (...args: string[]) => spawnSync('tmux', ['-u', ...args], { encoding: 'utf8' });

  const monitorCmd = [...self, 'monitor', ...settingsFlags(p.settings), '--ready-file', ready].map(q).join(' ');
  const r = tmux(
    'new-session', '-d', '-s', session, '-x', String(cols), '-y', String(rows),
    '-c', p.settings.workspace, '-e', `ZAGENT_TMUX_SESSION=${session}`, monitorCmd,
  );
  if (r.status !== 0) die(`Não consegui abrir o tmux: ${r.stderr}`);

  let info: SessionInfo | null = null;
  for (let i = 0; i < 100 && !info; i++) {
    await new Promise((res) => setTimeout(res, 100));
    try {
      info = JSON.parse(readFileSync(ready, 'utf8'));
    } catch { /* ainda não ficou pronto */ }
  }
  rmSync(ready, { force: true });
  if (!info) {
    tmux('kill-session', '-t', session);
    die('O monitor não iniciou a tempo.');
  }

  // Quando o Claude sair, o painel continua com um shell para você abrir de novo.
  const claudeLine = [claudeBin(), ...claudeArgs(info, p.extra)].map(q).join(' ');
  const left =
    `${claudeLine}; printf '\\n\\033[90mClaude encerrou. Rode "zagent claude" para abrir de novo, ou q no painel da direita para sair.\\033[0m\\n'; ` +
    `exec "\${SHELL:-/bin/sh}"`;
  tmux('split-window', '-h', '-b', '-l', '58%', '-t', `${session}:0`, '-c', p.settings.workspace, left);

  // Visual: títulos nos painéis, mouse para clicar/redimensionar, barra de status discreta.
  tmux('set-option', '-t', session, 'mouse', 'on');
  tmux('set-option', '-t', session, 'pane-border-status', 'top');
  tmux('set-option', '-t', session, 'pane-border-format', ' #{pane_title} ');
  tmux('set-option', '-t', session, 'pane-active-border-style', 'fg=colour215');
  tmux('set-option', '-t', session, 'pane-border-style', 'fg=colour238');
  tmux('set-option', '-t', session, 'status-style', 'bg=colour234,fg=colour244');
  tmux('set-option', '-t', session, 'status-left', '#[fg=colour215,bold] zAgent #[default]');
  tmux('set-option', '-t', session, 'status-right', ' clique para trocar de painel · q no monitor sai ');
  // Impede o Claude de trocar o título do painel (tmux 3.3+; versões antigas só ignoram).
  for (const pane of ['0.0', '0.1']) tmux('set-option', '-p', '-t', `${session}:${pane}`, 'allow-set-title', 'off');
  tmux('select-pane', '-t', `${session}:0.1`, '-T', 'Agentes');
  tmux('select-pane', '-t', `${session}:0.0`, '-T', 'Claude Code');

  if (process.env.TMUX) {
    tmux('switch-client', '-t', session);
  } else {
    spawnSync('tmux', ['-u', 'attach-session', '-t', session], { stdio: 'inherit' });
  }
}

// ------------------------------------------------------------------ main
const p = parse(process.argv.slice(2));
if (p.cmd === 'help') {
  process.stdout.write(HELP + '\n');
} else if (p.cmd === 'monitor') {
  runMonitor(p).catch((e) => die(String(e?.stack ?? e)));
} else if (p.cmd === 'claude') {
  runClaude(p);
} else {
  runAll(p).catch((e) => die(String(e?.stack ?? e)));
}
