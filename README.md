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

## Duas versões

- **Desktop** (Electron): `npm start`
- **CLI** (terminal, via tmux): `zagent`, com o Claude à esquerda e o monitor de agentes à direita

Os dois usam o mesmo orquestrador, o mesmo servidor MCP e as mesmas regras de segurança.

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

### CLI

```bash
npm install
npm run build
npm link            # deixa o comando `zagent` disponível no terminal
cd ~/meu-projeto
zagent              # ou: zagent --model sonnet --max 3
```

- **Abertura:** um portal animado em azul, roxo e branco, seguido da pergunta *"Qual modelo escolher?"*, com **Claude Code** e **OpenCode**. Use `←→` (ou `1`/`2`) e `enter`. Qualquer tecla pula a animação. A escolha fica salva; `--agent claude|opencode` pula a tela e `--no-intro` pula só a animação.
- **OpenCode:** se você escolher OpenCode, o agente principal **e os agentes paralelos** rodam no OpenCode, cada um no próprio worktree, ao mesmo tempo. O zAgent passa uma config própria para cada um (`OPENCODE_CONFIG`) sem alterar a sua: permissões com a mesma lista de bloqueio e as instruções de agente paralelo. O modelo dos agentes usa o formato do OpenCode (`--model anthropic/claude-sonnet-5-5`); sem `--model`, vale o padrão da sua config do OpenCode. Para misturar, use `--workers claude` ou `--workers opencode`.
- **`/exit` no agente principal fecha o zAgent inteiro**, e os agentes que estiverem rodando são parados. Na saída, o portal se fecha: a espiral acelera, encolhe até um clarão e aparece "até a próxima" (qualquer tecla pula; `--no-intro` desliga as duas animações). Se você só desanexar do tmux (`Ctrl+B d`), o zAgent continua rodando e mostra como voltar.
- Precisa do **tmux** (`brew install tmux` / `apt install tmux`). O mouse funciona: clique para trocar de painel e arraste a borda para redimensionar.
- **Android (Termux / proot-distro):** só a CLI funciona. O Electron não existe para Android, então o `npm install` pula o app desktop sozinho. Dentro do proot (Debian/Ubuntu), use o Node da distro, não o do Termux: `node -p process.platform` precisa responder `linux`.
- **Sem tmux (Windows):** rode `zagent monitor` num terminal e `zagent claude` em outro, na mesma pasta. No Windows Terminal, `Alt+Shift+D` divide a janela.
- **Teclas do monitor:** `↑↓` escolhe o agente · `enter` abre o log completo · `s` para · `m` manda mensagem · `n` abre um agente na mão · `x` fecha o card · `c` mostra o comando de merge · `q` sai (para os agentes e fecha a sessão).
- O monitor toca o sino do terminal quando um agente termina ou falha.
- `zagent help` lista todas as opções. O padrão fica em `~/.zagent/settings.json`.

### Desktop

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
node test/cli-e2e.mjs         # CLI com claude falso (precisa de tmux)
./test/cli-real.sh            # CLI com o Claude de verdade (gasta tokens)
node test/opencode-e2e.mjs    # agentes no OpenCode com provedor falso; confere o isolamento
```

No macOS e no Windows, rode sem o `xvfb-run`.

## Ainda não tem

- Instalador (.exe/.dmg) e pacote no npm. Por enquanto é pelo código-fonte.
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
src/cli/index.ts          CLI: comandos, sessão tmux, ligação monitor ↔ claude
src/cli/monitor.ts        monitor de agentes no terminal (TUI)
src/cli/intro.ts          abertura com o portal animado e escolha do agente principal
src/shared/mainClaude.ts  instruções e config do Claude principal (desktop e CLI)
```
