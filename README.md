# zAgent

App desktop com um **Claude Code principal** já aberto. Quando você pede para usar vários agentes
("use 3 agentes: um na API, um no front, um nos testes"), cada agente abre num **card ao lado**,
onde dá para acompanhar tudo ao vivo: comandos, arquivos editados, erros, bloqueios, custo e resultado.

```
┌──────────────────────────────┬──────────────────────────────┐
│ Claude Code (principal)      │ ● api        rodando  1m12s  │
│                              │   Bash  npm test             │
│ > use 2 agentes para...      │   Edit  src/routes/users.ts  │
│                              ├──────────────────────────────┤
│                              │ ● front      concluído       │
│                              │   1 file changed, 6 ins(+)   │
└──────────────────────────────┴──────────────────────────────┘
```

## Como funciona

1. O terminal da esquerda é o `claude` normal, num PTY real. Ele roda com um servidor MCP local do
   zAgent (`spawn_agents`, `wait_agents`, `agent_status`, `agent_log`, `message_agent`, `stop_agent`)
   e com uma instrução para usar essas ferramentas em vez dos subagentes internos, que ficam invisíveis.
2. Cada agente paralelo é um processo `claude -p --output-format stream-json` separado. O zAgent lê
   esse stream e desenha o card.
3. **Cada agente roda num `git worktree` com branch própria** (`zagent/<nome>-<id>`, em `.zagent/worktrees/`).
   Os agentes não pisam uns nos outros, e a sua `main` só muda quando você fizer merge.
4. Quando terminam, o Claude principal recebe o resumo de cada um (resultado, diff, commits) e
   **pergunta antes de fazer merge**.

## Rodar

Requisitos: Node 20+, git e o [Claude Code](https://code.claude.com) instalado e logado (`claude` no PATH).

```bash
npm install
npm start
```

Na primeira vez, o `claude` pode mostrar as telas de boas-vindas e de "confiar nesta pasta". Elas
aparecem no terminal da esquerda, normalmente.

- **Windows/macOS:** o `node-pty` já vem pré-compilado.
- **Linux:** o `npm install` compila o `node-pty` (precisa de `make`, `g++` e `python3`).

Clique no caminho no topo para trocar a pasta do projeto. Use `Ctrl+B` para mostrar ou ocultar o painel de agentes.

## Segurança: o que protege e o que não protege

Configurações → Permissões dos agentes:

| Modo | O que o agente pode fazer |
|---|---|
| Seguro | Ler e editar arquivos. Não roda comandos (nem testes). |
| **Padrão** | Editar e rodar comandos, menos os bloqueados: `git push`, `reset --hard`, `clean`, `rebase`, `rm -rf`, `sudo`, `DROP`/`TRUNCATE`, `prisma migrate reset`… |
| Total | `--dangerously-skip-permissions`. Só use em projeto descartável. |

Seja realista sobre esses limites:
- O bloqueio de comandos compara padrões de texto. É uma rede de segurança, **não uma garantia**:
  `bash -c "..."` ou um script podem contornar. A proteção de verdade é o worktree isolado.
- O worktree isola **arquivos**. Ele **não isola banco de dados, portas nem serviços externos**. Dois
  agentes rodando migrações no mesmo banco ainda se atropelam. Use bancos de teste.
- O worktree é criado a partir do último commit. **Mudanças não commitadas na sua pasta não vão para os agentes.**
- Se o projeto não for um repositório git (ou não tiver commits), os agentes rodam na mesma pasta, e o card mostra "sem isolamento".

## Testes

```bash
npm run build
xvfb-run node test/e2e.mjs    # usa um claude falso (scripts/fake-claude.mjs), não gasta tokens
xvfb-run node test/real.mjs   # usa o Claude Code de verdade (gasta tokens)
```

No macOS e no Windows, rode sem o `xvfb-run`.

## Ainda não tem

- Instalador (.exe/.dmg). Por enquanto é só `npm start`.
- Persistência dos cards depois de fechar o app (os worktrees e as branches ficam salvos no git).
- Botão de merge na interface. O merge é feito pelo Claude principal, com a sua confirmação, ou por você.
- Vários projetos ou abas ao mesmo tempo.

## Estrutura

```
src/main/main.ts          janela, PTY do Claude principal, IPC
src/main/orchestrator.ts  cria worktrees, roda os agentes, lê o stream-json
src/main/mcpServer.ts     servidor MCP local (127.0.0.1 + token aleatório)
src/main/claudeBin.ts     acha o executável do claude no Windows/macOS/Linux
src/renderer/             interface (xterm.js + cards)
```
