// Servidor MCP local que o Claude principal usa para abrir e acompanhar agentes paralelos.
// Escuta só em 127.0.0.1 e exige um token aleatório gerado a cada execução do app.
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Orchestrator } from './orchestrator';
import type { AgentSnapshot } from '../shared/types';

export interface McpHandle {
  url: string;
  token: string;
  close(): void;
}

function report(a: AgentSnapshot, full: boolean): string {
  const lines = [
    `## ${a.name} (id ${a.id}) — ${a.status}`,
    `Tarefa: ${a.task}`,
    a.branch ? `Branch: ${a.branch}  ·  Pasta: ${a.cwd}` : `Pasta: ${a.cwd} (sem isolamento)`,
  ];
  if (a.diffStat) lines.push(`Mudanças: ${a.diffStat}`);
  if (a.costUsd) lines.push(`Custo: US$ ${a.costUsd.toFixed(4)} · ${a.turns} turnos · ${a.toolCalls} ferramentas`);
  if (a.status === 'running' || a.status === 'queued') lines.push(`Agora: ${a.activity}`);
  if (a.result) lines.push('', full ? a.result : a.result.slice(0, 600));
  if (a.error) lines.push('', `Erro: ${a.error}`);
  return lines.join('\n');
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function buildServer(orch: Orchestrator): McpServer {
  const server = new McpServer({ name: 'zagent', version: '0.1.0' });

  server.registerTool(
    'spawn_agents',
    {
      title: 'Abrir agentes paralelos',
      description:
        'Abre um ou mais agentes em paralelo (Claude Code ou OpenCode, conforme a configuração do zAgent). Cada um ganha um painel visível no zAgent, ' +
        'um git worktree próprio e uma branch própria. Retorna na hora com os ids; use wait_agents para esperar os resultados. ' +
        'Dê a cada agente uma tarefa independente e completa (ele não vê esta conversa), com critério de pronto claro.',
      inputSchema: {
        agents: z
          .array(
            z.object({
              name: z.string().describe('Nome curto e único, ex.: "api", "testes-auth"'),
              task: z.string().describe('Instrução completa e autossuficiente para o agente'),
              isolate: z.boolean().optional().describe('Worktree próprio (padrão: configuração do app, normalmente true)'),
            }),
          )
          .min(1)
          .max(12),
      },
    },
    async ({ agents }) => {
      const out: AgentSnapshot[] = [];
      for (const a of agents) out.push(await orch.spawn({ ...a, origin: 'claude' }));
      return text(
        `Abri ${out.length} agente(s):\n` +
          out.map((a) => `- ${a.name} (id ${a.id})${a.branch ? ` na branch ${a.branch}` : ''}`).join('\n') +
          '\n\nUse wait_agents para receber os resultados.',
      );
    },
  );

  server.registerTool(
    'wait_agents',
    {
      title: 'Esperar agentes',
      description:
        'Espera os agentes terminarem e devolve o resumo de cada um (status, resposta final, branch, mudanças). ' +
        'Se o tempo acabar antes, devolve o estado atual; chame de novo para continuar esperando.',
      inputSchema: {
        ids: z.array(z.string()).optional().describe('Ids ou nomes. Vazio = todos.'),
        timeout_seconds: z.number().int().min(5).max(1800).optional().describe('Padrão 600'),
      },
    },
    async ({ ids, timeout_seconds }) => {
      const res = await orch.waitFor(ids, (timeout_seconds ?? 600) * 1000);
      const pending = res.filter((a) => a.status === 'running' || a.status === 'queued').length;
      return text(
        (pending ? `${pending} agente(s) ainda rodando. Chame wait_agents de novo.\n\n` : 'Todos terminaram.\n\n') +
          res.map((a) => report(a, true)).join('\n\n---\n\n'),
      );
    },
  );

  server.registerTool(
    'agent_status',
    {
      title: 'Status dos agentes',
      description: 'Lista todos os agentes e o que cada um está fazendo agora, sem esperar.',
      inputSchema: {},
    },
    async () => {
      const all = orch.list();
      return text(all.length ? all.map((a) => report(a, false)).join('\n\n') : 'Nenhum agente aberto.');
    },
  );

  server.registerTool(
    'agent_log',
    {
      title: 'Log de um agente',
      description: 'Últimas ações de um agente (comandos, arquivos, erros). Útil para entender uma falha.',
      inputSchema: { id: z.string(), last: z.number().int().min(1).max(200).optional() },
    },
    async ({ id, last }) => {
      const feed = orch.feed(id).slice(-(last ?? 40));
      if (!feed.length) return text(`Nada registrado para "${id}".`);
      return text(feed.map((f) => `[${f.kind}${f.tool ? ':' + f.tool : ''}] ${f.text}`).join('\n'));
    },
  );

  server.registerTool(
    'message_agent',
    {
      title: 'Mandar mensagem a um agente',
      description: 'Continua a sessão de um agente que já terminou, com uma nova instrução (ex.: corrigir algo).',
      inputSchema: { id: z.string(), message: z.string() },
    },
    async ({ id, message }) => {
      const a = orch.continueAgent(id, message);
      return text(`Mensagem enviada para ${a.name}. Use wait_agents para o resultado.`);
    },
  );

  server.registerTool(
    'stop_agent',
    {
      title: 'Parar agente',
      description: 'Para um agente em execução. O worktree e a branch continuam existindo.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const a = orch.stop(id);
      return text(`${a.name}: ${a.status}`);
    },
  );

  return server;
}

export async function startMcpServer(orch: Orchestrator): Promise<McpHandle> {
  const token = randomBytes(24).toString('hex');
  const http: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      // Modo sem sessão: não há stream GET nem DELETE.
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }
    // Um servidor + transporte por requisição (modo stateless do SDK).
    const server = buildServer(orch);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  // Chamadas como wait_agents podem durar minutos.
  http.requestTimeout = 0;
  http.headersTimeout = 0;
  http.timeout = 0;

  await new Promise<void>((r) => http.listen(Number(process.env.ZAGENT_MCP_PORT) || 0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, token, close: () => http.close() };
}
