#!/usr/bin/env bash
# Teste da CLI completa com o Claude Code de verdade (gasta tokens).
set -u
OUT=${SHOTS:-test-results}; mkdir -p "$OUT"
WS=$(mktemp -d /tmp/zagent-clireal-XXXX)
( cd "$WS" && git init -q -b main && git config user.email t@t && git config user.name t &&
  printf 'export function soma(a, b) {\n  return a + b;\n}\n' > math.js &&
  printf 'export function saudacao(nome) {\n  return "oi " + nome;\n}\n' > texto.js && git add -A && git commit -qm init )
H=$(mktemp -d)
CLI=$(pwd)/dist/cli.js
LANG=C.UTF-8 tmux -u new-session -d -s outer -x 190 -y 50 "env -u TMUX ZAGENT_HOME=$H node $CLI --cwd $WS --model haiku --agent claude --no-intro"
sleep 4
S=$(tmux ls -F '#{session_name}' | grep '^zagent-' | head -1)
echo "sessão interna: $S"
L="$S:0.0"
# Espera o Claude ficar pronto, aceitando as telas de primeiro uso.
for i in $(seq 1 30); do
  sleep 1.5
  T=$(tmux capture-pane -p -t "$L" | grep -v "^[[:space:]]*$" | tail -25)
  # Diálogo de confiança: o padrão é "No, exit", então só confirma depois de mover para "Yes".
  if grep -q 'trust this folder' <<<"$T"; then
    if grep -q "❯ Yes, I trust" <<<"$T"; then echo "trust: Enter"; tmux send-keys -t "$L" Enter; else echo "trust: Down"; tmux send-keys -t "$L" Down; fi
    continue
  fi
  if grep -qiE 'Press Enter|Enter to confirm|new MCP server' <<<"$T"; then echo "prompt: Enter"; tmux send-keys -t "$L" Enter; continue; fi
  if grep -qiE 'for shortcuts|bypass|accept edits|^❯ *$' <<<"$T"; then echo "claude pronto ($i)"; break; fi
done
tmux send-keys -t "$L" -l 'Use 2 agentes em paralelo: um adiciona JSDoc em math.js e o outro adiciona JSDoc em texto.js. Depois me diga o resultado.'
sleep 0.5; tmux send-keys -t "$L" Enter
for i in $(seq 1 60); do
  sleep 5
  T=$(tmux capture-pane -p -t "$L" | grep -v "^[[:space:]]*$" | tail -15)
  if grep -q 'Enter to confirm' <<<"$T"; then tmux send-keys -t "$L" Enter; fi
  R=$(tmux capture-pane -p -t "$S:0.1")
  N=$(grep -cE 'CONCLUÍDO|FALHOU' <<<"$R")
  echo "$i concluídos=$N"
  if [ "$N" -ge 2 ]; then sleep 30; break; fi
done
tmux capture-pane -e -p -t outer > "$OUT/cli-real.ansi"
tmux capture-pane -p -t outer
( cd "$WS" && git worktree list && git log --all --oneline )
tmux kill-session -t "$S" 2>/dev/null; tmux kill-session -t outer 2>/dev/null
