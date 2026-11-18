// Descobre como executar o `claude` nesta máquina (Windows, macOS, Linux).
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';

const cache = new Map<string, string>();

/** Caminho do executável do Claude Code. ZAGENT_CLAUDE_BIN sobrescreve (útil em testes). */
export function claudeBin(): string {
  return resolveBin('claude', process.env.ZAGENT_CLAUDE_BIN);
}

/** Caminho do executável do OpenCode. ZAGENT_OPENCODE_BIN sobrescreve (útil em testes). */
export function opencodeBin(): string {
  return resolveBin('opencode', process.env.ZAGENT_OPENCODE_BIN);
}

/** Acha um executável no PATH do usuário; devolve o próprio nome se não achar. */
export function resolveBin(name: string, override?: string): string {
  if (override) return override;
  const hit = cache.get(name);
  if (hit) return hit;
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
      const shell = process.env.SHELL || '/bin/sh';
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
  const bin = claudeBin();
  return bin !== 'claude' || existsSync(bin);
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
