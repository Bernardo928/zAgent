// Tipos compartilhados entre o processo principal (Electron) e a interface.

export type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export type FeedKind = 'text' | 'tool' | 'tool_error' | 'system' | 'result' | 'stderr';

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
}

export type WorkerPermission = 'safe' | 'standard' | 'full';

export interface Settings {
  workspace: string;
  workerPermission: WorkerPermission;
  /** Modelo dos agentes paralelos; vazio = padrão do Claude Code. */
  workerModel: string;
  maxConcurrent: number;
  /** Cria um git worktree por agente (recomendado). */
  isolate: boolean;
}

export interface AgentEvent {
  agent: AgentSnapshot;
  /** Itens novos do feed desde o último evento. */
  feed: FeedItem[];
}
