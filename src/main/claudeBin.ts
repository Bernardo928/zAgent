// Descobre como executar o `claude` nesta máquina (Windows, macOS, Linux).
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';

let cached: string | null = null;

/** Caminho do executável do Claude Code. ZAGENT_CLAUDE_BIN sobrescreve (útil em testes). */
export function claudeBin(): string {
  if (process.env.ZAGENT_CLAUDE_BIN) return process.env.ZAGENT_CLAUDE_BIN;
  if (cached) return cached;
  try {
    if (process.platform === 'win32') {
      const found = execFileSync('where', ['claude'], { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      // Prefere o .exe nativo; o .cmd (instalação via npm) exige passar pelo cmd.exe.
      cached = found.find((f) => f.toLowerCase().endsWith('.exe')) ?? found[0] ?? 'claude';
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      // Shell de login para enxergar o PATH do usuário (apps GUI no macOS não herdam o PATH do terminal).
      cached = execFileSync(shell, ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || 'claude';
    }
  } catch {
    cached = 'claude';
  }
  return cached;
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
  const bin = claudeBin();
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
