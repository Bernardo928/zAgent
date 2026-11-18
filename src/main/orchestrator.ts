// Orquestrador: cria, monitora e para os agentes paralelos.
//
// Cada agente é um processo `claude -p --output-format stream-json` separado,
// rodando no próprio git worktree (branch própria). Isso evita o cenário clássico
// de vários agentes na mesma pasta apagando o trabalho uns dos outros.
import { execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFileSync } from 'node:child_process';
import { opencodeBin, spawnBin, spawnClaude } from './claudeBin';
import type { AgentEvent, AgentSnapshot, BoardMessage, FeedItem, IntegrationResult, Settings, WorkerAgent } from '../shared/types';

const run = promisify(execFile);
const FEED_LIMIT = 600;

/**
 * Comandos que os agentes paralelos nunca podem rodar.
 * Atenção: bloqueio por padrão de texto é uma rede de segurança, não uma garantia
 * (`bash -c "..."` ou um script podem contornar). O isolamento por worktree é a proteção principal.
 */
export const DENY_RULES = [
  'Bash(git push *)',
  'Bash(git push)',
  'Bash(git reset --hard *)',
  'Bash(git reset --hard)',
  'Bash(git clean *)',
  'Bash(git rebase *)',
  'Bash(git branch -D *)',
  'Bash(git worktree *)',
  'Bash(git checkout main*)',
  'Bash(git checkout master*)',
  'Bash(git switch *)',
  'Bash(rm -rf *)',
  'Bash(rm -fr *)',
  'Bash(sudo *)',
  'Bash(*DROP DATABASE*)',
  'Bash(*drop database*)',
  'Bash(*DROP TABLE*)',
  'Bash(*drop table*)',
  'Bash(*TRUNCATE*)',
  'Bash(*prisma migrate reset*)',
  'Bash(*db push --force-reset*)',
];

/** As mesmas regras de DENY_RULES, no formato do OpenCode (padrões do comando bash). */
export const OPENCODE_DENY: Record<string, 'deny'> = Object.fromEntries(
  DENY_RULES.map((r) => [r.replace(/^Bash\((.*)\)$/, '$1'), 'deny' as const]),
);

/** Versão principal do OpenCode instalado (a 2.x precisa de --standalone para respeitar a config de cada agente). */
let opencodeMajor: number | null = null;
function opencodeVersion(): number {
  if (opencodeMajor !== null) return opencodeMajor;
  try {
    const v = execFileSync(opencodeBin(), ['--version'], { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' });
    opencodeMajor = Number(/(\d+)\./.exec(v)?.[1] ?? 1);
  } catch {
    opencodeMajor = 1;
  }
  return opencodeMajor;
}

/** Nomes das ferramentas do OpenCode no mesmo formato das do Claude Code, para o resumo e as cores. */
const OPENCODE_TOOL: Record<string, string> = {
  bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', multiedit: 'MultiEdit',
  glob: 'Glob', grep: 'Grep', list: 'Glob', webfetch: 'WebFetch', websearch: 'WebSearch',
  task: 'Task', todowrite: 'TodoWrite', todoread: 'TodoWrite',
};

const WORKER_PROMPT = `Você é um agente paralelo dentro do zAgent. Outros agentes trabalham ao mesmo tempo em outras partes do projeto.
Regras:
- Trabalhe SOMENTE na pasta atual. Ela é um git worktree só seu, numa branch só sua.
- Nunca rode git push, reset --hard, rebase, nem troque de branch. Nunca apague testes para fazê-los passar.
- Nunca apague, recrie ou migre bancos de dados.
- Se algo bloquear você (teste falhando, dependência de outro agente, permissão negada), PARE e explique no resumo final. Não contorne.
- Ao terminar, se puder rodar git, faça commit das suas mudanças nesta branch (git add -A && git commit -m "...").
- Termine com um resumo curto: o que mudou, arquivos tocados, o que foi verificado e o que NÃO foi.
Comunicação com os outros agentes (ferramentas board_read e board_post do servidor MCP "zagent"):
- Logo no começo, rode board_read para ver avisos que já existem.
- Quando mudar algo que afeta outros agentes (tipos, nomes, rotas de API, formato de dados, arquivos compartilhados), avise com board_post, curto e concreto.
- Antes de terminar, rode board_read de novo e leve em conta o que chegou.
- Não use o quadro para conversa fiada: cada mensagem custa tempo de todos.`;

const REVIEWER_PROMPT = (merged: string[], conflicts: IntegrationResult['conflicts'], extra?: string) => `Você é o REVISOR DE INTEGRAÇÃO do zAgent.
Esta pasta é uma branch de integração onde o zAgent juntou o trabalho destes agentes: ${merged.join(', ') || '(nenhum)'}.
${conflicts.length ? `Estas branches NÃO entraram por conflito:\n${conflicts.map((c) => `- ${c.agent} (${c.branch}): ${c.files.join(', ')}`).join('\n')}\nTente trazer essas mudanças à mão (git show/diff da branch) e resolva o conflito com cuidado.\n` : ''}
Seu trabalho:
1. Descubra como o projeto é construído e testado (package.json, Makefile, README) e rode build e testes.
2. Confira se as partes funcionam JUNTAS (tipos, imports, rotas, nomes que um agente mudou e outro usa).
3. Corrija SÓ problemas de integração. Não reescreva o que funciona, não adicione funcionalidade, não apague testes.
4. Faça commit das correções nesta branch.
5. Termine com um relatório: o que rodou, o que passou, o que falhou, o que você corrigiu, e se a branch está pronta para merge.
${extra ? `\nInstruções extras: ${extra}` : ''}`;

interface AgentRuntime {
  snap: AgentSnapshot;
  feed: FeedItem[];
  seq: number;
  proc?: ChildProcess;
  baseRef?: string;
  pending: FeedItem[];
  flushTimer?: NodeJS.Timeout;
  waiters: Array<() => void>;
  queuedPrompt?: { text: string; resume: boolean };
  /** Última resposta em texto (o OpenCode não manda um evento final com o resumo). */
  lastText?: string;
  /** Token do endpoint MCP só deste agente (quadro de mensagens). */
  token: string;
  /** Até onde este agente já leu o quadro. */
  boardCursor: number;
  /** Já juntou as branches das dependências (só na primeira execução). */
  afterPrepared?: boolean;
}

export interface SpawnRequest {
  name: string;
  task: string;
  isolate?: boolean;
  origin: 'claude' | 'user';
  /** Nomes dos agentes que precisam terminar antes (o resultado deles vai junto na tarefa). */
  after?: string[];
  /** Usa uma pasta/branch já existente em vez de criar um worktree (revisor da integração). */
  existing?: { cwd: string; branch: string; baseRef: string };
  role?: 'reviewer';
}

const TERMINAL = new Set(['done', 'failed', 'stopped']);
const gitRun = (args: string[], cwd: string) => run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim());

/** Se o repositório não tem nome/email do git, usa um genérico só para os commits do zAgent. */
async function gitIdentity(cwd: string): Promise<string[]> {
  try {
    if ((await gitRun(['config', 'user.email'], cwd)) && (await gitRun(['config', 'user.name'], cwd))) return [];
  } catch { /* sem configuração */ }
  return ['-c', 'user.name=zAgent', '-c', 'user.email=zagent@localhost'];
}

function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'agente'
  );
}

function short(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** Uma linha legível para cada chamada de ferramenta. */
export function summarizeTool(name: string, input: Record<string, unknown> = {}): string {
  if (input.filePath && !input.file_path) input = { ...input, file_path: input.filePath };
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const file = (p: string) => p.split(/[\\/]/).slice(-2).join('/');
  switch (name) {
    case 'Bash':
      return short(s('command'), 140);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file(s('file_path') || s('notebook_path'));
    case 'Glob':
    case 'Grep':
      return short(s('pattern'), 100);
    case 'WebFetch':
      return short(s('url'), 100);
    case 'WebSearch':
      return short(s('query'), 100);
    case 'Task':
    case 'Agent':
      return short(s('description') || s('prompt'), 100);
    case 'TodoWrite':
      return 'atualizou a lista de tarefas';
    default:
      return short(JSON.stringify(input), 100);
  }
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('\n');
  return '';
}

export class Orchestrator {
  private agents = new Map<string, AgentRuntime>();
  private order: string[] = [];
  private board: BoardMessage[] = [];
  private boardSeq = 0;
  private mcpBase = '';
  private mainBoardCursor = 0;

  constructor(
    private settings: () => Settings,
    private emit: (ev: AgentEvent) => void,
    private settingsDir: string,
  ) {}

  list(): AgentSnapshot[] {
    return this.order.map((id) => this.agents.get(id)!.snap);
  }

  get(id: string): AgentRuntime | undefined {
    if (this.agents.has(id)) return this.agents.get(id);
    // Pelo nome: o mais recente com esse nome.
    return [...this.agents.values()].reverse().find((a) => a.snap.name === id);
  }

  /** URL base do servidor MCP (para dar a cada agente o endpoint do quadro). */
  setMcpBase(url: string): void {
    this.mcpBase = url.replace(/\/mcp$/, '');
  }

  /** Valida o token do endpoint de um agente: /agent/<id>. */
  agentByToken(id: string, token: string): AgentRuntime | undefined {
    const rt = this.agents.get(id);
    return rt && rt.token === token ? rt : undefined;
  }

  // ---------------------------------------------------------------- quadro de mensagens

  /** Publica no quadro. `to` = nome de um agente ou "todos". */
  post(from: string, to: string, text: string): BoardMessage {
    const target = to.trim() || 'todos';
    if (target !== 'todos' && target !== 'principal' && !this.get(target)) throw new Error(`Não existe agente "${target}".`);
    const msg: BoardMessage = { seq: ++this.boardSeq, at: Date.now(), from, to: target, text: text.trim() };
    this.board.push(msg);
    for (const rt of this.agents.values()) {
      if (rt.snap.name === from) this.push(rt, 'message', `→ ${target}: ${msg.text}`);
      else if (target === 'todos' || target === rt.snap.name) this.push(rt, 'message', `← ${from}: ${msg.text}`);
      else continue;
      this.scheduleFlush(rt);
    }
    return msg;
  }

  /** Mensagens novas para `name` (enviadas a ele ou a todos, menos as dele). Avança o cursor. */
  readBoard(name: string): BoardMessage[] {
    const rt = name === 'principal' ? undefined : this.get(name);
    const cursor = rt ? rt.boardCursor : this.mainBoardCursor;
    const msgs = this.board.filter((m) => m.seq > cursor && m.from !== name && (m.to === 'todos' || m.to === name));
    if (rt) rt.boardCursor = this.boardSeq;
    else this.mainBoardCursor = this.boardSeq;
    return msgs;
  }

  boardAll(): BoardMessage[] {
    return [...this.board];
  }

  feed(id: string): FeedItem[] {
    return this.get(id)?.feed ?? [];
  }

  /** Abre vários de uma vez, validando as dependências entre eles (nomes e ciclos). */
  async spawnMany(reqs: SpawnRequest[]): Promise<AgentSnapshot[]> {
    const batch = new Set(reqs.map((r) => r.name.trim()));
    const deps = new Map(reqs.map((r) => [r.name.trim(), (r.after ?? []).map((a) => a.trim())]));
    for (const [name, after] of deps) {
      for (const a of after) {
        if (a === name) throw new Error(`"${name}" não pode depender de si mesmo.`);
        if (!batch.has(a) && !this.get(a)) throw new Error(`"${name}" depende de "${a}", que não existe.`);
      }
    }
    // Ciclo (a depende de b, b depende de a) travaria os dois para sempre.
    const state = new Map<string, number>();
    const visit = (n: string, path: string[]): void => {
      if (state.get(n) === 2) return;
      if (state.get(n) === 1) throw new Error(`Dependência circular: ${[...path, n].join(' → ')}`);
      state.set(n, 1);
      for (const d of deps.get(n) ?? []) if (deps.has(d)) visit(d, [...path, n]);
      state.set(n, 2);
    };
    for (const n of deps.keys()) visit(n, []);

    const out: AgentSnapshot[] = [];
    for (const r of reqs) out.push(await this.spawn(r));
    return out;
  }

  async spawn(req: SpawnRequest): Promise<AgentSnapshot> {
    const cfg = this.settings();
    const id = randomUUID().slice(0, 8);
    let name = req.name.trim() || `agente-${this.order.length + 1}`;
    // Nomes únicos entre os cards abertos: dependências e mensagens usam o nome.
    if ([...this.agents.values()].some((a) => a.snap.name === name)) {
      let n = 2;
      while ([...this.agents.values()].some((a) => a.snap.name === `${name}-${n}`)) n++;
      name = `${name}-${n}`;
    }
    const after = (req.after ?? []).map((a) => a.trim()).filter(Boolean);
    const rt: AgentRuntime = {
      snap: {
        id,
        name,
        task: req.task,
        status: 'queued',
        cwd: cfg.workspace,
        isolated: false,
        backend: cfg.workerAgent ?? 'claude',
        createdAt: Date.now(),
        costUsd: 0,
        turns: 0,
        toolCalls: 0,
        tokensOut: 0,
        activity: after.length ? `Esperando ${after.join(', ')}` : 'Na fila',
        origin: req.origin,
        after: after.length ? after : undefined,
        role: req.role,
      },
      feed: [],
      seq: 0,
      pending: [],
      waiters: [],
      queuedPrompt: { text: req.task, resume: false },
      token: randomUUID().replace(/-/g, ''),
      boardCursor: 0,
    };
    if (after.length) rt.snap.status = 'waiting';
    this.agents.set(id, rt);
    this.order.push(id);

    if (req.existing) {
      rt.snap.cwd = req.existing.cwd;
      rt.snap.branch = req.existing.branch;
      rt.snap.isolated = true;
      rt.baseRef = req.existing.baseRef;
    } else if (req.isolate ?? cfg.isolate) {
      try {
        await this.makeWorktree(rt, cfg.workspace);
      } catch (e) {
        this.push(rt, 'stderr', `Sem worktree isolado (${(e as Error).message.split('\n')[0]}). Rodando na pasta do projeto.`);
      }
    }
    this.flush(rt);
    this.pump();
    return rt.snap;
  }

  /** Manda uma nova mensagem para um agente que já terminou (retoma a mesma sessão). */
  continueAgent(id: string, message: string): AgentSnapshot {
    const rt = this.get(id);
    if (!rt) throw new Error(`Agente "${id}" não existe.`);
    if (!TERMINAL.has(rt.snap.status)) throw new Error(`Agente "${rt.snap.name}" ainda está ${rt.snap.status}.`);
    rt.snap.status = 'queued';
    rt.snap.activity = 'Na fila';
    rt.snap.result = undefined;
    rt.snap.error = undefined;
    rt.snap.endedAt = undefined;
    rt.queuedPrompt = { text: message, resume: !!rt.snap.sessionId };
    this.push(rt, 'system', `Nova mensagem: ${message}`);
    this.flush(rt);
    this.pump();
    return rt.snap;
  }

  stop(id: string): AgentSnapshot {
    const rt = this.get(id);
    if (!rt) throw new Error(`Agente "${id}" não existe.`);
    if (rt.snap.status === 'queued' || rt.snap.status === 'waiting') {
      this.finish(rt, 'stopped', 'Cancelado antes de começar.');
    } else if (rt.proc && rt.snap.status === 'running') {
      rt.snap.status = 'stopped';
      killTree(rt.proc);
    } else if (rt.snap.status === 'running') {
      // Ainda preparando (juntando branches): não há processo para matar.
      void this.finish(rt, 'stopped', 'Parado por você.');
    }
    return rt.snap;
  }

  stopAll(): void {
    for (const id of this.order) {
      const rt = this.agents.get(id)!;
      if (!TERMINAL.has(rt.snap.status)) this.stop(id);
    }
  }

  /** Tira o card da tela. Não apaga o worktree nem a branch: o trabalho fica salvo. */
  dismiss(id: string): void {
    const rt = this.get(id);
    if (!rt) return;
    if (!TERMINAL.has(rt.snap.status)) throw new Error('Pare o agente antes de fechar o card.');
    this.agents.delete(rt.snap.id);
    this.order = this.order.filter((x) => x !== rt.snap.id);
  }

  /** Espera os agentes terminarem (ou o tempo acabar). */
  waitFor(ids: string[] | undefined, timeoutMs: number): Promise<AgentSnapshot[]> {
    const targets = (ids?.length ? ids.map((i) => this.get(i)) : this.order.map((i) => this.agents.get(i)))
      .filter((x): x is AgentRuntime => !!x);
    const pending = targets.filter((t) => !TERMINAL.has(t.snap.status));
    if (!pending.length) return Promise.resolve(targets.map((t) => t.snap));
    return new Promise((res) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res(targets.map((t) => t.snap));
      };
      const timer = setTimeout(finish, timeoutMs);
      for (const t of pending) {
        t.waiters.push(() => {
          if (targets.every((x) => TERMINAL.has(x.snap.status))) finish();
        });
      }
    });
  }

  // ---------------------------------------------------------------- interno

  private running(): number {
    return [...this.agents.values()].filter((a) => a.snap.status === 'running').length;
  }

  private pump(): void {
    // 1) Libera (ou pula) quem estava esperando dependências.
    for (const id of this.order) {
      const rt = this.agents.get(id)!;
      if (rt.snap.status !== 'waiting') continue;
      const deps = (rt.snap.after ?? []).map((n) => this.get(n));
      const bad = deps.find((d) => !d || d.snap.status === 'failed' || d.snap.status === 'stopped');
      if (bad !== undefined) {
        const who = bad ? bad.snap.name : (rt.snap.after ?? []).find((n) => !this.get(n));
        void this.finish(rt, 'stopped', `Pulado: a etapa anterior "${who}" não terminou com sucesso.`);
        continue;
      }
      if (deps.every((d) => d!.snap.status === 'done')) {
        rt.snap.status = 'queued';
        rt.snap.activity = 'Na fila';
        this.push(rt, 'system', `Etapas anteriores concluídas: ${(rt.snap.after ?? []).join(', ')}`);
        this.flush(rt);
      }
    }
    // 2) Começa os da fila, respeitando o limite de agentes ao mesmo tempo.
    const max = Math.max(1, this.settings().maxConcurrent);
    for (const id of this.order) {
      if (this.running() >= max) return;
      const rt = this.agents.get(id)!;
      if (rt.snap.status === 'queued' && rt.queuedPrompt) void this.start(rt);
    }
  }

  /**
   * Antes de um agente com dependências começar: junta as branches das etapas anteriores
   * no worktree dele (para ele partir do código delas) e monta o contexto com os resultados.
   */
  private async prepareAfter(rt: AgentRuntime): Promise<string> {
    const deps = (rt.snap.after ?? []).map((n) => this.get(n)).filter((d): d is AgentRuntime => !!d);
    const lines: string[] = [];
    for (const d of deps) {
      let merged = '';
      if (rt.snap.isolated && d.snap.branch && d.snap.branch !== rt.snap.branch) {
        try {
          const id = await gitIdentity(rt.snap.cwd);
          await gitRun([...id, 'merge', '--no-ff', '--no-edit', '-m', `zagent: traz o trabalho de ${d.snap.name}`, d.snap.branch], rt.snap.cwd);
          merged = ' (o código dela já está nesta pasta)';
          this.push(rt, 'system', `Juntou a branch de ${d.snap.name}: ${d.snap.branch}`);
        } catch (e) {
          await gitRun(['merge', '--abort'], rt.snap.cwd).catch(() => {});
          merged = ` (NÃO foi possível juntar a branch ${d.snap.branch} por conflito; veja com git diff se precisar)`;
          this.push(rt, 'stderr', `Conflito ao juntar ${d.snap.branch}; começando sem o código dessa etapa.`);
        }
      }
      lines.push(`## Etapa anterior: ${d.snap.name}${merged}\nTarefa: ${d.snap.task}\nResultado:\n${d.snap.result ?? '(sem resumo)'}`);
    }
    return lines.length ? `Contexto: estas etapas terminaram antes de você.\n\n${lines.join('\n\n')}\n\n---\n\nSua tarefa:\n` : '';
  }

  /** Commita o que o agente deixou sem commit, para a branch dele carregar todo o trabalho. */
  private async autoCommit(rt: AgentRuntime): Promise<void> {
    if (!rt.snap.isolated) return;
    try {
      if (!(await gitRun(['status', '--porcelain'], rt.snap.cwd))) return;
      await gitRun(['add', '-A'], rt.snap.cwd);
      const id = await gitIdentity(rt.snap.cwd);
      await gitRun([...id, 'commit', '-q', '-m', `zagent(${rt.snap.name}): trabalho não commitado do agente`], rt.snap.cwd);
      this.push(rt, 'system', 'O zAgent commitou as mudanças que o agente deixou sem commit.');
    } catch (e) {
      this.push(rt, 'stderr', `Não consegui commitar as mudanças restantes: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  // ---------------------------------------------------------------- integração

  /**
   * Junta as branches dos agentes concluídos numa branch nova de integração (num worktree próprio).
   * Conflitos não travam: a branch com conflito fica de fora e é listada. A main nunca é tocada.
   * Com `verify`, abre um agente revisor nessa branch para rodar build/testes e corrigir a integração.
   */
  async integrate(opts: { ids?: string[]; verify?: boolean; instructions?: string } = {}): Promise<IntegrationResult> {
    const cfg = this.settings();
    const chosen = (opts.ids?.length ? opts.ids.map((i) => this.get(i)) : this.order.map((i) => this.agents.get(i)))
      .filter((x): x is AgentRuntime => !!x && x.snap.role !== 'reviewer');
    const ready = chosen.filter((a) => a.snap.status === 'done' && a.snap.isolated && a.snap.branch);
    const skipped = chosen.filter((a) => !ready.includes(a)).map((a) => `${a.snap.name} (${a.snap.status})`);
    if (!ready.length) throw new Error('Nenhum agente concluído com branch própria para juntar.');

    const top = await gitRun(['rev-parse', '--show-toplevel'], cfg.workspace);
    const base = await gitRun(['rev-parse', 'HEAD'], top);
    const id = randomUUID().slice(0, 6);
    const branch = `zagent/integracao-${id}`;
    const path = join(top, '.zagent', 'worktrees', `integracao-${id}`);
    mkdirSync(join(top, '.zagent', 'worktrees'), { recursive: true });
    await gitRun(['worktree', 'add', '-b', branch, path, base], top);

    const ident = await gitIdentity(path);
    const merged: string[] = [];
    const conflicts: IntegrationResult['conflicts'] = [];
    for (const a of ready) {
      try {
        await gitRun([...ident, 'merge', '--no-ff', '--no-edit', '-m', `zagent: integra ${a.snap.name}`, a.snap.branch!], path);
        merged.push(a.snap.name);
      } catch {
        const files = (await gitRun(['diff', '--name-only', '--diff-filter=U'], path).catch(() => '')).split('\n').filter(Boolean);
        await gitRun(['merge', '--abort'], path).catch(() => {});
        conflicts.push({ agent: a.snap.name, branch: a.snap.branch!, files });
      }
    }

    const result: IntegrationResult = { branch, path, merged, conflicts, skipped };
    if (opts.verify ?? true) {
      const rev = await this.spawn({
        name: 'revisor',
        task: REVIEWER_PROMPT(merged, conflicts, opts.instructions),
        origin: 'claude',
        role: 'reviewer',
        existing: { cwd: path, branch, baseRef: base },
      });
      result.reviewer = rev.name;
    }
    return result;
  }

  private async makeWorktree(rt: AgentRuntime, workspace: string): Promise<void> {
    const git = (args: string[], cwd = workspace) => run('git', args, { cwd }).then((r) => r.stdout.trim());
    const top = await git(['rev-parse', '--show-toplevel']);
    const base = await git(['rev-parse', 'HEAD']);
    const commonDir = resolve(top, await git(['rev-parse', '--git-common-dir'], top));
    // Mantém os worktrees fora do `git status` do projeto.
    const exclude = join(commonDir, 'info', 'exclude');
    mkdirSync(join(commonDir, 'info'), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!current.split(/\r?\n/).includes('.zagent/')) appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}.zagent/\n`);

    const dirName = `${slug(rt.snap.name)}-${rt.snap.id}`;
    const branch = `zagent/${dirName}`;
    const path = join(top, '.zagent', 'worktrees', dirName);
    mkdirSync(join(top, '.zagent', 'worktrees'), { recursive: true });
    await git(['worktree', 'add', '-b', branch, path, base], top);
    rt.snap.cwd = path;
    rt.snap.branch = branch;
    rt.snap.isolated = true;
    rt.baseRef = base;
    this.push(rt, 'system', `Worktree isolado: branch ${branch}`);
  }

  private workerArgs(rt: AgentRuntime, resume: boolean): string[] {
    const cfg = this.settings();
    mkdirSync(this.settingsDir, { recursive: true });
    const settingsFile = join(this.settingsDir, `worker-${rt.snap.id}.json`);
    const allow =
      cfg.workerPermission === 'safe'
        ? ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite']
        : ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'Bash'];
    if (this.mcpBase) allow.push('mcp__zagent__board_post', 'mcp__zagent__board_read');
    writeFileSync(settingsFile, JSON.stringify({ permissions: { allow, deny: DENY_RULES } }, null, 2));

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--settings', settingsFile];
    const mcp = this.workerMcp(rt);
    if (mcp) {
      const mcpFile = join(this.settingsDir, `worker-${rt.snap.id}.mcp.json`);
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: { zagent: { type: 'http', url: mcp.url, headers: mcp.headers } } }), { mode: 0o600 });
      args.push('--mcp-config', mcpFile);
    }
    if (cfg.workerPermission === 'full') args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'acceptEdits');
    if (cfg.workerModel) args.push('--model', cfg.workerModel);
    if (resume && rt.snap.sessionId) args.push('--resume', rt.snap.sessionId);
    else args.push('--append-system-prompt', WORKER_PROMPT);
    return args;
  }

  /** Argumentos do `opencode run`: config própria (permissões + instruções) via OPENCODE_CONFIG. */
  private opencodeArgs(rt: AgentRuntime, resume: boolean): { args: string[]; env: Record<string, string> } {
    const cfg = this.settings();
    mkdirSync(this.settingsDir, { recursive: true });
    const promptFile = join(this.settingsDir, 'worker-prompt.md');
    writeFileSync(promptFile, WORKER_PROMPT);
    // A última regra que casa vence: "*" primeiro, bloqueios depois.
    const bash = cfg.workerPermission === 'safe' ? 'deny' : { '*': 'allow', ...OPENCODE_DENY };
    const permission = {
      '*': 'allow',
      edit: 'allow',
      bash,
      // Fica dentro do worktree: nada de mexer em pastas de fora.
      external_directory: cfg.workerPermission === 'full' ? 'allow' : 'deny',
    };
    const configFile = join(this.settingsDir, `worker-${rt.snap.id}.opencode.json`);
    const mcp = this.workerMcp(rt);
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          permission,
          instructions: [promptFile],
          ...(mcp ? { mcp: { zagent: { type: 'remote', url: mcp.url, headers: mcp.headers, enabled: true } } } : {}),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    // --auto: no modo sem tela, pedidos de permissão viram "sim"; os "deny" continuam valendo.
    // --dir: o OpenCode decide a pasta do projeto pela variável PWD, não pela pasta do processo.
    // Sem isso, um agente "isolado" roda na pasta de onde o zAgent foi aberto.
    const args = ['run', '--format', 'json', '--auto', '--dir', rt.snap.cwd];
    if (opencodeVersion() >= 2) args.push('--standalone', '--archived');
    // O modelo do OpenCode é "provedor/modelo"; aliases do Claude (sonnet, haiku) não servem aqui.
    if (cfg.workerModel.includes('/')) args.push('--model', cfg.workerModel);
    if (resume && rt.snap.sessionId) args.push('--session', rt.snap.sessionId);
    return { args, env: { OPENCODE_CONFIG: configFile } };
  }

  /** Endpoint MCP só deste agente: dá acesso ao quadro de mensagens e a mais nada. */
  private workerMcp(rt: AgentRuntime): { url: string; headers: Record<string, string> } | null {
    if (!this.mcpBase) return null;
    return { url: `${this.mcpBase}/agent/${rt.snap.id}`, headers: { Authorization: `Bearer ${rt.token}` } };
  }

  private async start(rt: AgentRuntime): Promise<void> {
    const prompt = rt.queuedPrompt!;
    rt.queuedPrompt = undefined;
    rt.snap.status = 'running';
    rt.snap.startedAt ??= Date.now();
    rt.snap.activity = 'Iniciando…';
    let text = prompt.text;
    if (!prompt.resume && rt.snap.after?.length && !rt.afterPrepared) {
      rt.afterPrepared = true;
      rt.snap.activity = 'Juntando o trabalho das etapas anteriores…';
      this.flush(rt);
      text = (await this.prepareAfter(rt)) + text;
      if (rt.snap.status !== 'running') return; // parado enquanto preparava
    }

    const backend: WorkerAgent = rt.snap.backend;
    const label = backend === 'opencode' ? 'opencode' : 'claude';
    rt.lastText = undefined;
    let proc: ChildProcess;
    try {
      if (backend === 'opencode') {
        const { args, env } = this.opencodeArgs(rt, prompt.resume);
        rt.snap.model ??= this.settings().workerModel.includes('/') ? this.settings().workerModel : 'padrão do OpenCode';
        proc = spawnBin(opencodeBin(), args, {
          cwd: rt.snap.cwd,
          env: { ...process.env, ...env, PWD: rt.snap.cwd, ZAGENT_AGENT: rt.snap.name },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        proc = spawnClaude(this.workerArgs(rt, prompt.resume), {
          cwd: rt.snap.cwd,
          env: { ...process.env, PWD: rt.snap.cwd, ZAGENT_AGENT: rt.snap.name },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } catch (e) {
      this.finish(rt, 'failed', `Não consegui iniciar o ${label}: ${(e as Error).message}`);
      return;
    }
    rt.proc = proc;
    // O prompt vai pelo stdin: sem problemas de aspas/escape em nenhum sistema.
    proc.stdin?.end(text);

    let buf = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) (backend === 'opencode' ? this.onOpencodeLine(rt, line) : this.onLine(rt, line));
      }
    });
    let errTail = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      errTail = (errTail + chunk).slice(-2000);
    });
    proc.on('error', (e) => this.finish(rt, 'failed', `Erro ao executar o ${label}: ${e.message}`));
    proc.on('close', (code) => {
      if (buf.trim()) (backend === 'opencode' ? this.onOpencodeLine(rt, buf.trim()) : this.onLine(rt, buf.trim()));
      rt.proc = undefined;
      if (rt.snap.status === 'stopped') return this.finish(rt, 'stopped', 'Parado por você.');
      if (rt.snap.status !== 'running') return; // já finalizado pelo evento "result"
      // O OpenCode não manda evento final: sucesso = saiu com 0, e o resumo é a última resposta em texto.
      if (code === 0 && rt.lastText !== undefined) return this.finish(rt, 'done', rt.lastText);
      const msg = errTail.trim() ? short(errTail.trim(), 600) : `O processo saiu com código ${code}.`;
      this.finish(rt, code === 0 ? 'done' : 'failed', msg);
    });
    this.flush(rt);
  }

  /** Eventos do `opencode run --format json` (step_start, text, tool_use, step_finish, error). */
  private onOpencodeLine(rt: AgentRuntime, line: string): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.sessionID) rt.snap.sessionId = ev.sessionID;
    const part = ev.part ?? {};
    switch (ev.type) {
      case 'text':
        if (typeof part.text === 'string' && part.text.trim()) {
          const text: string = part.text.trim();
          rt.lastText = text;
          this.push(rt, 'text', text);
          rt.snap.activity = short(text, 120);
        }
        break;
      case 'tool_use': {
        const st = part.state ?? {};
        const name = OPENCODE_TOOL[part.tool] ?? part.tool ?? 'tool';
        const summary = st.title && name !== 'Read' && name !== 'Edit' && name !== 'Write' ? short(String(st.title), 140) : summarizeTool(name, st.input ?? {});
        rt.snap.toolCalls++;
        rt.snap.activity = `${name} · ${summary}`;
        this.push(rt, 'tool', summary, name);
        if (st.status === 'error') {
          const err = String(st.error ?? 'erro');
          const blocked = /rule which prevents|permission|denied|not allowed/i.test(err);
          this.push(rt, 'tool_error', (blocked ? 'Bloqueado: ' : '') + short(blocked ? `regra do zAgent impediu: ${summary}` : err, 400));
        } else if (typeof st.metadata?.exit === 'number' && st.metadata.exit !== 0) {
          this.push(rt, 'tool_error', short(`saiu com código ${st.metadata.exit}: ${String(st.output ?? '').trim()}`, 400));
        }
        break;
      }
      case 'step_finish':
        rt.snap.turns++;
        rt.snap.costUsd += Number(part.cost) || 0;
        rt.snap.tokensOut += Number(part.tokens?.output) || 0;
        break;
      case 'error': {
        const e = ev.error ?? part.error ?? ev;
        const msg = typeof e === 'string' ? e : e?.data?.message ?? e?.message ?? JSON.stringify(e);
        this.push(rt, 'tool_error', short(String(msg), 400));
        rt.lastText = undefined;
        this.finish(rt, 'failed', String(msg));
        break;
      }
    }
    this.scheduleFlush(rt);
  }

  private onLine(rt: AgentRuntime, line: string): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const sub = ev.parent_tool_use_id ? '↳ ' : '';
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          rt.snap.sessionId = ev.session_id;
          rt.snap.model = ev.model;
        }
        break;
      case 'assistant': {
        const usage = ev.message?.usage;
        if (usage?.output_tokens) rt.snap.tokensOut += usage.output_tokens;
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) {
            this.push(rt, 'text', sub + b.text.trim());
            rt.snap.activity = short(b.text, 120);
          } else if (b.type === 'tool_use') {
            const summary = summarizeTool(b.name, b.input);
            rt.snap.toolCalls++;
            rt.snap.activity = `${b.name} · ${summary}`;
            this.push(rt, 'tool', sub + summary, b.name);
          }
        }
        break;
      }
      case 'user':
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_result' && b.is_error) {
            const text = contentText(b.content);
            const blocked = /permission|denied|not allowed|bloque/i.test(text);
            this.push(rt, 'tool_error', (blocked ? 'Bloqueado: ' : '') + short(text, 400));
          }
        }
        break;
      case 'result':
        rt.snap.costUsd += ev.total_cost_usd ?? 0;
        rt.snap.turns += ev.num_turns ?? 0;
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
          this.finish(rt, 'failed', String(ev.result || ev.subtype || 'Falhou'));
        } else {
          this.finish(rt, 'done', String(ev.result ?? ''));
        }
        break;
    }
    this.scheduleFlush(rt);
  }

  private async finish(rt: AgentRuntime, status: AgentSnapshot['status'], text: string): Promise<void> {
    if (TERMINAL.has(rt.snap.status) && rt.snap.status !== 'stopped') return;
    rt.snap.status = status;
    rt.snap.endedAt = Date.now();
    if (status === 'done') {
      rt.snap.result = text;
      rt.snap.activity = 'Concluído';
      this.push(rt, 'result', text || '(sem resumo)');
    } else {
      rt.snap.error = text;
      rt.snap.activity = status === 'stopped' ? 'Parado' : 'Falhou';
      this.push(rt, status === 'stopped' ? 'system' : 'tool_error', text);
    }
    if (rt.proc && rt.snap.status !== 'running') killTree(rt.proc);
    if (status === 'done') await this.autoCommit(rt);
    await this.computeDiff(rt);
    this.flush(rt);
    const waiters = rt.waiters.splice(0);
    waiters.forEach((w) => w());
    this.pump();
  }

  private async computeDiff(rt: AgentRuntime): Promise<void> {
    if (!rt.snap.isolated || !rt.baseRef) return;
    try {
      const opts = { cwd: rt.snap.cwd };
      const stat = (await run('git', ['diff', '--shortstat', rt.baseRef], opts)).stdout.trim();
      const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], opts)).stdout
        .split('\n')
        .filter(Boolean).length;
      const commits = (await run('git', ['rev-list', '--count', `${rt.baseRef}..HEAD`], opts)).stdout.trim();
      const parts = [stat || 'nenhuma mudança'];
      if (untracked) parts.push(`${untracked} arquivo(s) novo(s) fora do git`);
      if (commits !== '0') parts.push(`${commits} commit(s)`);
      rt.snap.diffStat = parts.join(' · ');
    } catch {
      /* worktree removido ou git indisponível: só não mostra o diff */
    }
  }

  private push(rt: AgentRuntime, kind: FeedItem['kind'], text: string, tool?: string): void {
    const item: FeedItem = { seq: ++rt.seq, at: Date.now(), kind, text, tool };
    rt.feed.push(item);
    if (rt.feed.length > FEED_LIMIT) rt.feed.splice(0, rt.feed.length - FEED_LIMIT);
    rt.pending.push(item);
  }

  private scheduleFlush(rt: AgentRuntime): void {
    if (rt.flushTimer) return;
    rt.flushTimer = setTimeout(() => this.flush(rt), 80);
  }

  private flush(rt: AgentRuntime): void {
    if (rt.flushTimer) clearTimeout(rt.flushTimer);
    rt.flushTimer = undefined;
    const feed = rt.pending.splice(0);
    this.emit({ agent: { ...rt.snap }, feed });
  }
}

function killTree(proc: ChildProcess): void {
  if (proc.pid == null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
  } else {
    proc.kill('SIGTERM');
    setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 3000).unref();
  }
}
