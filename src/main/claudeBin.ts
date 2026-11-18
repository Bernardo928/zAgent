// Descobre como executar o `claude` nesta máquina (Windows, macOS, Linux).
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const cache = new Map<string, string>();

/** Caminho do executável do Claude Code. ZAGENT_CLAUDE_BIN sobrescreve (útil em testes). */
export function claudeBin(): string {
  return resolveBin('claude', process.env.ZAGENT_CLAUDE_BIN);
}

/** Caminho do executável do OpenCode. ZAGENT_OPENCODE_BIN sobrescreve (útil em testes). */
export function opencodeBin(): string {
  return resolveBin('opencode', process.env.ZAGENT_OPENCODE_BIN);
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Procura direto nas pastas do PATH (e nas pastas comuns de instalação), sem depender de shell. */
function searchPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

/** Acha um executável no PATH do usuário; devolve o próprio nome se não achar. */
export function resolveBin(name: string, override?: string): string {
  if (override) return override;
  const hit = cache.get(name);
  if (hit) return hit;
  const direct = searchPath(name);
  if (direct) {
    cache.set(name, direct);
    return direct;
  }
  let found = name;
  try {
    if (process.platform === 'win32') {
      const list = execFileSync('where', [name], { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      // Prefere o .exe nativo; o .cmd (instalação via npm) exige passar pelo cmd.exe.
      found = list.find((f) => f.toLowerCase().endsWith('.exe')) ?? list[0] ?? name;
    } else {
      // Último recurso: shell de login (pega PATH definido só no .profile/.bashrc).
      // No proot do Termux, SHELL pode apontar para um shell que não existe ali dentro.
      const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
      // Shell de login para enxergar o PATH do usuário (apps GUI no macOS não herdam o PATH do terminal).
      found = execFileSync(shell, ['-lc', `command -v ${name}`], { encoding: 'utf8' }).trim().split('\n').pop() || name;
    }
  } catch {
    found = name;
  }
  if (found !== name) cache.set(name, found);
  return found;
}

export function claudeAvailable(): boolean {
  return claudeBin() !== 'claude';
}

/** true se o executável foi encontrado nesta máquina. */
export function binAvailable(name: string): boolean {
  return resolveBin(name) !== name;
}

const needsCmd = (bin: string) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);

function quoteWin(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** Inicia o claude como processo filho (usado pelos agentes paralelos). */
export function spawnClaude(args: string[], opts: SpawnOptions): ChildProcess {
  return spawnBin(claudeBin(), args, opts);
}

/** Inicia um executável qualquer, tratando o .cmd do Windows. */
export function spawnBin(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (needsCmd(bin)) {
    const line = [bin, ...args].map(quoteWin).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(bin, args, opts);
}

/** Comando + args para abrir o claude num PTY (o terminal principal). */
export function ptyCommand(args: string[]): { file: string; args: string[] } {
  const bin = claudeBin();
  if (needsCmd(bin)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', bin, ...args] };
  }
  return { file: bin, args };
}
