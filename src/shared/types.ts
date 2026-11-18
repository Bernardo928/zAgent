// Tipos compartilhados entre o processo principal (Electron) e a interface.

/** waiting = esperando outros agentes terminarem (dependências). */
export type AgentStatus = 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export type FeedKind = 'text' | 'tool' | 'tool_error' | 'system' | 'result' | 'stderr' | 'message';

export interface FeedItem {
  /** Sequencial dentro do agente, para a UI renderizar só o que é novo. */
  seq: number;
  at: number;
  kind: FeedKind;
  /** Nome da ferramenta (Bash, Edit, Read...) quando kind = tool. */
  tool?: string;
  text: string;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  task: string;
  status: AgentStatus;
  /** Pasta onde o agente trabalha (worktree próprio ou a pasta do projeto). */
  cwd: string;
  /** Branch git do worktree, se isolado. */
  branch?: string;
  isolated: boolean;
  /** CLI que roda este agente. */
  backend: WorkerAgent;
  model?: string;
  sessionId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  /** Tokens de saída somados ao vivo (o custo em US$ só chega no fim). */
  tokensOut: number;
  /** Última coisa que o agente fez, mostrada no rodapé do card. */
  activity: string;
  /** Resposta final do agente. */
  result?: string;
  error?: string;
  /** Resumo `git diff --stat` do worktree contra a base, quando termina. */
  diffStat?: string;
  /** Quem criou: o Claude principal (via MCP) ou você (botão na UI). */
  origin: 'claude' | 'user';
  /** Nomes dos agentes que precisam terminar antes deste começar. */
  after?: string[];
  /** Papel especial: revisor da integração. */
  role?: 'reviewer';
}

export interface BoardMessage {
  seq: number;
  at: number;
  from: string;
  /** Nome do destinatário, ou "todos". */
  to: string;
  text: string;
}

export interface IntegrationResult {
  branch: string;
  path: string;
  merged: string[];
  conflicts: Array<{ agent: string; branch: string; files: string[] }>;
  skipped: string[];
  reviewer?: string;
}

export type WorkerPermission = 'safe' | 'standard' | 'full';

/** Qual CLI roda os agentes paralelos. */
export type WorkerAgent = 'claude' | 'opencode';

export interface Settings {
  workspace: string;
  workerPermission: WorkerPermission;
  /** Modelo dos agentes paralelos; vazio = padrão do Claude Code. */
  workerModel: string;
  maxConcurrent: number;
  /** Cria um git worktree por agente (recomendado). */
  isolate: boolean;
  /** CLI dos agentes paralelos (padrão: claude). */
  workerAgent?: WorkerAgent;
}

export interface AgentEvent {
  agent: AgentSnapshot;
  /** Itens novos do feed desde o último evento. */
  feed: FeedItem[];
}
