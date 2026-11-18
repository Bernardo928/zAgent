// zagent (CLI): Claude Code à esquerda, monitor de agentes à direita, no terminal (via tmux).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeBin } from '../main/claudeBin';
import { startMcpServer } from '../main/mcpServer';
import { Orchestrator } from '../main/orchestrator';
import { MAIN_ALLOWED_TOOLS, MAIN_PROMPT, mcpConfigJson } from '../shared/mainClaude';
import type { Settings, WorkerAgent, WorkerPermission } from '../shared/types';
import { runIntro, type MainAgent } from './intro';
import { Monitor } from './monitor';

const HOME = process.env.ZAGENT_HOME || join(homedir(), '.zagent');
const RUN = join(HOME, 'run');

const HELP = `zagent: Claude Code ou OpenCode com um painel para cada agente paralelo, direto no terminal.

Uso:
  zagent [opções] [-- args extras]   abertura + escolha do agente, depois agente à esquerda e monitor à direita (tmux)
  zagent monitor [opções]            só o monitor (use quando não tiver tmux)
  zagent claude [-- args extras]     abre o Claude Code ligado ao monitor que já está rodando
  zagent opencode [-- args extras]   abre o OpenCode ligado ao monitor que já está rodando
  zagent help

Opções:
  --cwd <pasta>         pasta do projeto (padrão: a atual)
  --model <modelo>      modelo dos agentes paralelos (ex.: sonnet, haiku, opus)
  --permission <modo>   safe | standard | full  (padrão: standard)
  --max <n>             máximo de agentes ao mesmo tempo (padrão: 4)
  --no-isolate          não cria git worktree por agente (não recomendado)
  --agent <nome>        claude | opencode: pula a tela de escolha
  --no-intro            pula a animação de abertura

  --workers <nome>      claude | opencode: CLI dos agentes paralelos (padrão: a mesma do agente principal)

Digitar /exit no agente principal fecha o zAgent inteiro (e para os agentes que estiverem rodando).

No monitor: ↑↓ escolhe · enter abre · s para · m manda mensagem · n novo agente · x fecha · q sai
Configuração padrão em ${join(HOME, 'settings.json')}.`;

interface Parsed {
  cmd: 'run' | 'monitor' | 'claude' | 'opencode' | 'help';
  settings: Settings;
  agent?: MainAgent;
  savedAgent?: MainAgent;
  noIntro?: boolean;
  workers?: WorkerAgent;
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
  const savedAgent = (saved as { mainAgent?: MainAgent }).mainAgent;
  delete (settings as Partial<Settings> & { mainAgent?: unknown }).mainAgent;
  const out: Parsed = { cmd, settings, extra, savedAgent };

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
      case 'opencode':
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
      case '--agent': {
        const v = val();
        if (v !== 'claude' && v !== 'opencode') die('--agent deve ser claude ou opencode.');
        out.agent = v;
        break;
      }
      case '--no-intro':
        out.noIntro = true;
        break;
      case '--workers': {
        const v = val();
        if (v !== 'claude' && v !== 'opencode') die('--workers deve ser claude ou opencode.');
        out.workers = v;
        break;
      }
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
  // Agentes paralelos: --workers, senão a mesma CLI do agente principal (a última escolhida).
  settings.workerAgent = out.workers ?? out.agent ?? savedAgent ?? 'claude';
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
  f.push('--workers', s.workerAgent ?? 'claude');
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

/** Acha um executável no PATH (no shell de login, como o usuário veria). */
function which(name: string): string | null {
  if (process.platform === 'win32') {
    const r = spawnSync('where', [name], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
  }
  const r = spawnSync(process.env.SHELL || 'sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n').pop()!.trim() : null;
}

const AGENT_LABEL: Record<MainAgent, string> = { claude: 'Claude Code', opencode: 'OpenCode' };

/**
 * Config extra do OpenCode: liga o servidor MCP do zAgent e as instruções do agente principal.
 * Vai num arquivo próprio (OPENCODE_CONFIG), somado à config normal do usuário, sem alterá-la.
 */
function opencodeConfig(s: SessionInfo): string {
  const mcp = JSON.parse(readFileSync(s.mcpConfig, 'utf8')).mcpServers.zagent;
  const file = join(RUN, `opencode-${s.pid}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { zagent: { type: 'remote', url: mcp.url, headers: mcp.headers, enabled: true } },
      instructions: [s.promptFile],
    }),
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return file;
}

/** Comando, argumentos e variáveis para abrir o agente principal escolhido. */
function mainCommand(agent: MainAgent, s: SessionInfo, extra: string[]) {
  if (agent === 'opencode') {
    const bin = which('opencode') ?? 'opencode';
    // Na 2.x, sem --standalone o OpenCode usa um servidor compartilhado e ignora a config extra.
    const v2 = /^\D*(\d+)/.exec(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout ?? '')?.[1];
    const args = Number(v2) >= 2 ? ['--standalone', ...extra] : extra;
    return { bin, args, env: { OPENCODE_CONFIG: opencodeConfig(s) } };
  }
  return { bin: claudeBin(), args: claudeArgs(s, extra), env: {} as Record<string, string> };
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
    for (const f of [mcpConfig, sessionFile, join(RUN, `opencode-${process.pid}.json`)]) rmSync(f, { force: true });
    if (process.env.ZAGENT_TMUX_SESSION) {
      spawnSync('tmux', ['kill-session', '-t', process.env.ZAGENT_TMUX_SESSION], { stdio: 'ignore' });
    }
    // Dá tempo para os agentes receberem o sinal de parada.
    setTimeout(() => process.exit(code), 300);
  };
  process.on('SIGHUP', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  monitor = new Monitor(orch, p.settings.workspace, () => shutdown(0), p.hint ? `zagent ${p.agent ?? 'claude'}` : undefined);
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

function runMain(p: Parsed, agent: MainAgent): void {
  const s = findSession(p.settings.workspace);
  if (!s) die('Nenhum monitor rodando. Abra outro terminal e rode `zagent monitor` primeiro (ou só `zagent`, com tmux).');
  if (s.workspace !== p.settings.workspace) {
    process.stderr.write(`Aviso: o monitor está na pasta ${s.workspace}. Os agentes vão trabalhar lá.\n`);
  }
  const cmd = mainCommand(agent, s, p.extra);
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd.bin);
  const child = spawn(cmd.bin, cmd.args, { stdio: 'inherit', cwd: s.workspace, shell, env: { ...process.env, ...cmd.env, PWD: s.workspace } });
  // /exit no agente principal fecha o zAgent: avisa o monitor para parar os agentes e sair.
  child.on('exit', (code) => {
    try {
      process.kill(s.pid, 'SIGTERM');
    } catch { /* monitor já tinha saído */ }
    process.exit(code ?? 0);
  });
}

// ------------------------------------------------------------------ zagent (tmux)
function saveAgentChoice(agent: MainAgent): void {
  const file = join(HOME, 'settings.json');
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* primeiro uso */ }
  mkdirSync(HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...cur, mainAgent: agent }, null, 2));
}

/** Decide o agente principal: --agent, a tela de abertura ou a última escolha. */
async function chooseAgent(p: Parsed): Promise<MainAgent | null> {
  if (p.agent) return p.agent;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return p.savedAgent ?? 'claude';
  const available = { claude: !!which('claude') || claudeBin() !== 'claude', opencode: !!which('opencode') };
  const choice = await runIntro({ skipAnimation: p.noIntro, initial: p.savedAgent, available });
  if (choice) saveAgentChoice(choice);
  return choice;
}

async function runAll(p: Parsed): Promise<void> {
  const agent = await chooseAgent(p);
  if (!agent) return;
  p.agent = agent;
  p.settings.workerAgent = p.workers ?? agent;
  const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  if (!hasTmux) {
    process.stderr.write(
      'tmux não encontrado, então vou abrir só o monitor aqui.\n' +
        `Abra OUTRO terminal nesta mesma pasta e rode:  zagent ${agent}\n\n` +
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

  // /exit no agente principal fecha a sessão inteira; o monitor recebe SIGHUP e para os agentes.
  const cmd = mainCommand(agent, info, p.extra);
  const envPrefix = Object.entries(cmd.env).map(([k, v]) => `${k}=${q(v)} `).join('');
  const mainLine = envPrefix + [cmd.bin, ...cmd.args].map(q).join(' ');
  const left = `${mainLine}; tmux kill-session -t ${q(session)}`;
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
  tmux('select-pane', '-t', `${session}:0.0`, '-T', AGENT_LABEL[agent]);

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
} else if (p.cmd === 'claude' || p.cmd === 'opencode') {
  runMain(p, p.cmd);
} else {
  runAll(p).catch((e) => die(String(e?.stack ?? e)));
}
