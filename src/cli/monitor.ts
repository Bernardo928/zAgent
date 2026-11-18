// Monitor de agentes no terminal: hospeda o orquestrador + servidor MCP e desenha um card por agente.
import { emitKeypressEvents } from 'node:readline';
import type { Orchestrator } from '../main/orchestrator';
import type { AgentEvent, AgentSnapshot, FeedItem } from '../shared/types';

// ------------------------------------------------------------------ ANSI
const ESC = '\x1b[';
const c256 = (n: number) => (s: string) => `${ESC}38;5;${n}m${s}${ESC}39m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}22m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}22m`;
const inverse = (s: string) => `${ESC}7m${s}${ESC}27m`;
const C = {
  running: c256(75),
  done: c256(78),
  failed: c256(203),
  stopped: c256(246),
  queued: c256(242),
  accent: c256(215),
  warn: c256(221),
  muted: c256(244),
  text: c256(253),
};
const HUES = [75, 215, 78, 177, 204, 221, 80, 209, 141, 114];

const STATUS: Record<AgentSnapshot['status'], [string, (s: string) => string]> = {
  waiting: ['ESPERANDO', C.queued],
  queued: ['NA FILA', C.queued],
  running: ['RODANDO', C.running],
  done: ['CONCLUÍDO', C.done],
  failed: ['FALHOU', C.failed],
  stopped: ['PARADO', C.stopped],
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visLen = (s: string) => [...s.replace(ANSI_RE, '')].length;

/** Corta uma string com ANSI para caber em `w` colunas visíveis. */
function fit(s: string, w: number): string {
  if (w <= 0) return '';
  if (visLen(s) <= w) return s;
  let out = '';
  let n = 0;
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (n >= w - 1) return out + '…' + `${ESC}0m`;
      out += ch;
      n++;
    }
  }
  return out;
}

/** Quebra por palavras; só corta uma palavra se ela sozinha for maior que a linha. */
function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  for (const raw of s.split('\n')) {
    let line = '';
    for (const word of raw.split(/(\s+)/)) {
      if ([...line + word].length <= w) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while ([...line].length > w) {
        out.push([...line].slice(0, w).join(''));
        line = [...line].slice(w).join('');
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtUsd = (n: number) => `US$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

// ------------------------------------------------------------------ monitor
interface Card {
  snap: AgentSnapshot;
  feed: FeedItem[];
  hue: number;
}

type Prompt = { label: string; value: string; onSubmit: (v: string) => void };

export class Monitor {
  private cards = new Map<string, Card>();
  private order: string[] = [];
  private sel = 0;
  private expanded = false;
  private scroll = 0; // linhas a partir do fim, na visão expandida
  private prompt: Prompt | null = null;
  private notice = '';
  private noticeTimer?: NodeJS.Timeout;
  private renderTimer?: NodeJS.Timeout;
  private tick?: NodeJS.Timeout;
  private confirmQuit = false;
  private closed = false;

  constructor(
    private orch: Orchestrator,
    private workspace: string,
    private onQuit: () => void,
    /** Sem tmux: lembra o usuário de abrir o Claude em outro terminal. */
    private hint?: string,
  ) {}

  /** Recebe os eventos do orquestrador. */
  onEvent = (ev: AgentEvent): void => {
    let card = this.cards.get(ev.agent.id);
    const prev = card?.snap.status;
    if (!card) {
      card = { snap: ev.agent, feed: [], hue: HUES[this.order.length % HUES.length] };
      this.cards.set(ev.agent.id, card);
      this.order.push(ev.agent.id);
    }
    card.snap = ev.agent;
    card.feed.push(...ev.feed);
    if (card.feed.length > 600) card.feed.splice(0, card.feed.length - 600);
    if (prev && prev !== ev.agent.status && (ev.agent.status === 'done' || ev.agent.status === 'failed')) {
      this.flash(`${ev.agent.name}: ${STATUS[ev.agent.status][0].toLowerCase()}`);
      process.stdout.write('\x07'); // sino: avisa mesmo com o foco no painel do Claude
    }
    this.schedule();
  };

  start(): void {
    const out = process.stdout;
    out.write(`${ESC}?1049h${ESC}?25l`);
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.onKey);
    out.on('resize', () => this.render());
    this.tick = setInterval(() => {
      if ([...this.cards.values()].some((c) => c.snap.status === 'running')) this.schedule();
    }, 1000);
    this.render();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.tick);
    process.stdin.off('keypress', this.onKey);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${ESC}0m${ESC}?25h${ESC}?1049l`);
  }

  private flash(msg: string): void {
    this.notice = msg;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = '';
      this.schedule();
    }, 4000);
    this.schedule();
  }

  private schedule(): void {
    if (this.renderTimer || this.closed) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 50);
  }

  private selected(): Card | undefined {
    return this.cards.get(this.order[this.sel]);
  }

  // ---------------------------------------------------------------- teclado
  private onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
    if (key.ctrl && key.name === 'c') return this.quit(false);

    if (this.prompt) {
      const p = this.prompt;
      if (key.name === 'escape') this.prompt = null;
      else if (key.name === 'return' || key.name === 'enter') {
        this.prompt = null;
        if (p.value.trim()) p.onSubmit(p.value.trim());
      } else if (key.name === 'backspace') p.value = [...p.value].slice(0, -1).join('');
      else if (str && !key.ctrl && str >= ' ') p.value += str;
      return this.render();
    }

    if (this.confirmQuit) {
      this.confirmQuit = false;
      if (str === 's' || str === 'S' || str === 'y') return this.quit(true);
      return this.render();
    }

    const card = this.selected();
    switch (key.name) {
      case 'up':
      case 'k':
        if (this.expanded) this.scroll += 1;
        else this.sel = Math.max(0, this.sel - 1);
        break;
      case 'down':
      case 'j':
        if (this.expanded) this.scroll = Math.max(0, this.scroll - 1);
        else this.sel = Math.min(this.order.length - 1, this.sel + 1);
        break;
      case 'pageup':
        this.scroll += 10;
        break;
      case 'pagedown':
        this.scroll = Math.max(0, this.scroll - 10);
        break;
      case 'return':
      case 'enter':
        if (card) {
          this.expanded = !this.expanded;
          this.scroll = 0;
        }
        break;
      case 'escape':
        this.expanded = false;
        break;
      case 'tab':
        if (this.order.length) this.sel = (this.sel + 1) % this.order.length;
        this.scroll = 0;
        break;
      case 'q':
        return this.quit(false);
      case 's':
        if (card) this.safely(() => this.orch.stop(card.snap.id));
        break;
      case 'x':
        if (card) {
          this.safely(() => {
            this.orch.dismiss(card.snap.id);
            this.cards.delete(card.snap.id);
            this.order = this.order.filter((i) => i !== card.snap.id);
            this.sel = Math.min(this.sel, Math.max(0, this.order.length - 1));
            this.expanded = false;
          });
        }
        break;
      case 'm':
        if (card) {
          this.prompt = {
            label: `Mensagem para ${card.snap.name}: `,
            value: '',
            onSubmit: (v) => this.safely(() => this.orch.continueAgent(card.snap.id, v)),
          };
        }
        break;
      case 'n':
        this.prompt = {
          label: 'Nome do novo agente: ',
          value: '',
          onSubmit: (name) => {
            this.prompt = {
              label: `Tarefa de ${name}: `,
              value: '',
              onSubmit: (task) => {
                this.orch.spawn({ name, task, origin: 'user' }).catch((e) => this.flash(String(e.message)));
              },
            };
            this.render();
          },
        };
        break;
      case 'c':
        if (card?.snap.branch) this.flash(`merge: git merge --no-ff ${card.snap.branch}`);
        break;
      case 'i':
        // Junta tudo que terminou numa branch de integração e abre o revisor.
        this.flash('Juntando as branches…');
        this.orch
          .integrate({ verify: true })
          .then((r) =>
            this.flash(
              `Integração em ${r.branch}: ${r.merged.length} juntada(s)` +
                (r.conflicts.length ? `, ${r.conflicts.length} com conflito (${r.conflicts.map((c) => c.agent).join(', ')})` : '') +
                '. Revisor aberto.',
            ),
          )
          .catch((e) => this.flash((e as Error).message));
        break;
    }
    this.render();
  };

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.flash((e as Error).message);
    }
  }

  private quit(force: boolean): void {
    const running = [...this.cards.values()].filter((c) => c.snap.status === 'running' || c.snap.status === 'queued');
    if (running.length && !force) {
      this.confirmQuit = true;
      return this.render();
    }
    this.onQuit();
  }

  // ---------------------------------------------------------------- desenho
  private render(): void {
    if (this.closed) return;
    const W = Math.max(30, process.stdout.columns || 80);
    const H = Math.max(10, process.stdout.rows || 24);
    const lines: string[] = [];

    lines.push(this.header(W));
    lines.push(C.muted('─'.repeat(W)));

    const bodyH = H - 4;
    const body = !this.order.length
      ? this.empty(W, bodyH)
      : this.expanded
        ? this.expandedView(W, bodyH)
        : this.grid(W, bodyH);
    for (let i = 0; i < bodyH; i++) lines.push(body[i] ?? '');

    lines.push(C.muted('─'.repeat(W)));
    lines.push(this.footer(W));

    const frame = lines.map((l) => fit(l, W) + `${ESC}0m${ESC}K`).join('\r\n');
    const cursor = this.prompt ? `${ESC}?25h` : `${ESC}?25l`;
    process.stdout.write(`${ESC}?25l${ESC}H${frame}${ESC}J${cursor}`);
  }

  private header(W: number): string {
    const list = [...this.cards.values()].map((c) => c.snap);
    const n = (s: AgentSnapshot['status']) => list.filter((a) => a.status === s).length;
    const cost = list.reduce((t, a) => t + a.costUsd, 0);
    const stats = [
      n('running') && C.running(`● ${n('running')} rodando`),
      n('queued') && C.queued(`● ${n('queued')} na fila`),
      n('done') && C.done(`● ${n('done')} concluído${n('done') > 1 ? 's' : ''}`),
      n('failed') && C.failed(`● ${n('failed')} falhou`),
      cost > 0 && C.muted(fmtUsd(cost)),
    ].filter(Boolean);
    const left = `${C.accent(bold(' z '))} ${bold('Agentes')}  ${C.muted(this.workspace)}`;
    const right = stats.join('  ');
    const pad = W - visLen(left) - visLen(right) - 1;
    return pad > 1 ? left + ' '.repeat(pad) + right : fit(left, W - visLen(right) - 2) + '  ' + right;
  }

  private footer(W: number): string {
    if (this.prompt) return bold(this.prompt.label) + this.prompt.value + '█';
    if (this.confirmQuit) return C.warn(bold('Há agentes rodando. Parar todos e sair? (s/N)'));
    if (this.notice) return C.accent(this.notice);
    const keys = this.expanded
      ? '↑↓ rolar · esc voltar · s parar · m mensagem · c merge'
      : '↑↓ escolher · enter abrir · s parar · m mensagem · n novo · i juntar+revisar · x fechar · c merge · q sair';
    return C.muted(fit(keys, W));
  }

  private empty(W: number, H: number): string[] {
    const msg = [
      bold('Nenhum agente ainda'),
      '',
      ...(this.hint ? [C.warn(`Abra outro terminal nesta pasta e rode: ${this.hint}`), ''] : []),
      C.muted(this.hint ? 'Depois peça ao Claude algo como:' : 'Peça ao Claude, no painel ao lado, algo como:'),
      C.text('"use 3 agentes: um para a API, um para o front e um para os testes"'),
      '',
      C.muted('Cada agente aparece aqui, num card, trabalhando numa branch própria.'),
      C.muted('Tecla n abre um agente manualmente.'),
    ];
    const top = Math.max(0, Math.floor((H - msg.length) / 2));
    const out: string[] = Array(top).fill('');
    for (const m of msg) {
      const pad = Math.max(0, Math.floor((W - visLen(m)) / 2));
      out.push(' '.repeat(pad) + m);
    }
    return out;
  }

  private cardHead(card: Card, W: number, selected: boolean): string {
    const a = card.snap;
    const [label, color] = STATUS[a.status];
    const elapsed = a.startedAt ? fmtElapsed((a.endedAt ?? Date.now()) - a.startedAt) : 'aguardando';
    const bar = c256(card.hue)(selected ? '▌' : '│');
    const name = selected ? inverse(bold(` ${a.name} `)) : bold(a.name);
    const meta = [
      a.backend === 'opencode' ? C.accent('OpenCode') : C.accent('Claude'),
      elapsed,
      a.toolCalls ? `${a.toolCalls} ações` : '',
      a.tokensOut ? `${fmtTok(a.tokensOut)} tok` : '',
      a.costUsd ? fmtUsd(a.costUsd) : '',
      a.role === 'reviewer' ? C.accent('revisor') : '',
      a.status === 'waiting' && a.after?.length ? C.warn(`depois de ${a.after.join(', ')}`) : '',
      a.branch ? `⎇ ${a.branch}` : C.warn('sem isolamento'),
    ].filter(Boolean);
    return `${bar} ${color('●')} ${name} ${color(label)}  ${C.muted(meta.join(' · '))}`;
  }

  private feedLine(card: Card, f: FeedItem, W: number): string {
    const bar = c256(card.hue)('│') + ' ';
    const blocked = f.kind === 'tool_error' && f.text.startsWith('Bloqueado:');
    const text = oneLine(blocked ? f.text.slice(10) : f.text);
    let tag: string;
    let body: string;
    switch (f.kind) {
      case 'tool':
        tag = c256(card.hue)((f.tool ?? '').padStart(6).slice(-6));
        body = C.text(text);
        break;
      case 'tool_error':
        tag = blocked ? C.warn('bloq. ') : C.failed('  erro');
        body = blocked ? C.warn(text) : C.failed(text);
        break;
      case 'result':
        tag = C.done('  fim ');
        body = C.done(text);
        break;
      case 'message':
        tag = C.accent('   msg');
        body = C.accent(text);
        break;
      case 'stderr':
        tag = C.warn(' aviso');
        body = C.warn(text);
        break;
      case 'system':
        tag = C.muted('  info');
        body = C.muted(text);
        break;
      default:
        tag = C.muted('     ›');
        body = text;
    }
    return fit(`${bar}${tag} ${body}`, W);
  }

  private cardFoot(card: Card, W: number): string {
    const a = card.snap;
    const bar = c256(card.hue)('│') + ' ';
    if (a.status === 'running' || a.status === 'queued') return `${bar}${C.running('▸')} ${C.muted(oneLine(a.activity))}`;
    const info = a.diffStat ?? (a.status === 'done' ? 'concluído' : oneLine(a.error ?? ''));
    return `${bar}${C.muted('Δ')} ${a.status === 'failed' ? C.failed(info) : C.text(info)}`;
  }

  /** Visão em lista: todos os cards dividem a altura. */
  private grid(W: number, H: number): string[] {
    const n = this.order.length;
    const MIN = 4; // cabeçalho + tarefa + 1 linha de feed + rodapé
    const fitCount = Math.max(1, Math.min(n, Math.floor((H + 1) / (MIN + 1))));
    // Janela de cards visíveis em volta do selecionado.
    let first = Math.max(0, Math.min(this.sel - Math.floor(fitCount / 2), n - fitCount));
    const visible = this.order.slice(first, first + fitCount);
    const per = Math.floor((H - (visible.length - 1)) / visible.length);
    const out: string[] = [];
    visible.forEach((id, i) => {
      const card = this.cards.get(id)!;
      const idx = first + i;
      const bar = c256(card.hue)('│') + ' ';
      out.push(this.cardHead(card, W, idx === this.sel));
      out.push(bar + C.muted(fit(oneLine(card.snap.task), W - 2)));
      const feedRows = Math.max(1, per - 3);
      const items = card.feed.slice(-feedRows);
      for (let r = 0; r < feedRows; r++) out.push(items[r] ? this.feedLine(card, items[r], W) : bar);
      out.push(this.cardFoot(card, W));
      if (i < visible.length - 1) out.push('');
    });
    if (n > visible.length) {
      out[H - 1] = C.muted(`  ${first > 0 ? '↑ ' : ''}${n - visible.length} card(s) fora da tela${first + visible.length < n ? ' ↓' : ''}`);
    }
    return out;
  }

  /** Um card ocupando tudo, com o feed completo e rolagem. */
  private expandedView(W: number, H: number): string[] {
    const card = this.selected();
    if (!card) return [];
    const a = card.snap;
    const bar = c256(card.hue)('│') + ' ';
    const out = [this.cardHead(card, W, true)];
    for (const l of wrap(a.task, W - 2).slice(0, 4)) out.push(bar + C.muted(l));
    if (a.cwd) out.push(bar + C.muted(`pasta: ${a.cwd}`));
    out.push(bar);

    const rows: string[] = [];
    for (const f of card.feed) {
      const first = this.feedLine(card, { ...f, text: '' }, W).replace(/\s+$/, '');
      const prefixLen = visLen(first) + 1;
      const parts = wrap(f.text, Math.max(10, W - prefixLen));
      const colored = this.feedLine(card, { ...f, text: parts[0] ?? '' }, W);
      rows.push(colored);
      for (const p of parts.slice(1)) rows.push(bar + ' '.repeat(Math.max(0, prefixLen - 2)) + p);
    }
    const room = H - out.length - 1;
    const maxScroll = Math.max(0, rows.length - room);
    this.scroll = Math.min(this.scroll, maxScroll);
    const end = rows.length - this.scroll;
    out.push(...rows.slice(Math.max(0, end - room), end));
    while (out.length < H - 1) out.push(bar);
    out.push(this.cardFoot(card, W) + (this.scroll ? C.muted(`   (↑ ${this.scroll} linhas acima do fim)`) : ''));
    return out;
  }
}
