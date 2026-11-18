// Interface do zAgent: terminal do Claude principal + cards dos agentes.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ZagentApi } from '../main/preload';
import type { AgentEvent, AgentSnapshot, FeedItem, Settings } from '../shared/types';

declare global {
  interface Window { zagent: ZagentApi }
}
const api = window.zagent;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ ícones
const ICONS: Record<string, string> = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
};
const icon = (name: string) => `<span class="icon"><svg viewBox="0 0 24 24">${ICONS[name] ?? ''}</svg></span>`;
function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[el.dataset.icon!] ?? ''}</svg>`;
  });
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtUsd = (n: number) => `US$ ${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

const STATUS_LABEL: Record<AgentSnapshot['status'], string> = {
  waiting: 'esperando',
  queued: 'na fila',
  running: 'rodando',
  done: 'concluído',
  failed: 'falhou',
  stopped: 'parado',
};

function toast(text: string, status?: AgentSnapshot['status']) {
  const el = document.createElement('div');
  el.className = `toast ${status ? 's-' + status : ''}`;
  el.innerHTML = `${status ? '<span class="dot"></span>' : ''}<span>${esc(text)}</span>`;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ------------------------------------------------------------------ terminal principal
const term = new Terminal({
  fontFamily: "ui-monospace, 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 10000,
  theme: {
    background: '#0c0d10',
    foreground: '#e7e9ee',
    cursor: '#f2a05c',
    cursorAccent: '#0c0d10',
    selectionBackground: '#33405a',
    black: '#1b1e25', brightBlack: '#5c6370',
    red: '#f0646f', brightRed: '#ff7b85',
    green: '#52c98e', brightGreen: '#6fe0a5',
    yellow: '#e8c35a', brightYellow: '#f5d27a',
    blue: '#6ea8ff', brightBlue: '#8cbaff',
    magenta: '#c792ea', brightMagenta: '#d7a8f5',
    cyan: '#5fc8d6', brightCyan: '#7ddbe7',
    white: '#c9ced8', brightWhite: '#ffffff',
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('terminal'));

let mainAlive = false;
function setMainAlive(alive: boolean) {
  mainAlive = alive;
  $('main-dot').className = `dot ${alive ? 'live' : 'dead'}`;
}

function refit() {
  try {
    fit.fit();
    api.pty.resize(term.cols, term.rows);
  } catch { /* janela minimizada */ }
}
new ResizeObserver(() => requestAnimationFrame(refit)).observe($('terminal'));

term.onData((d) => {
  if (!mainAlive) {
    if (d === '\r') restartMain();
    return;
  }
  api.pty.input(d);
});
api.pty.onData((d: string) => {
  if (!mainAlive) setMainAlive(true);
  term.write(d);
});
api.pty.onExit((code: number) => {
  setMainAlive(false);
  // Normalmente o app fecha junto (/exit). Se não fechou, foi erro ao abrir: deixa reabrir com Enter.
  term.write(`\r\n\x1b[90m── Claude encerrou (código ${code}). Pressione Enter para abrir de novo. ──\x1b[0m\r\n`);
});
function restartMain() {
  term.reset();
  setMainAlive(true);
  api.pty.restart(term.cols, term.rows);
}
$('restart-main').addEventListener('click', restartMain);

// ------------------------------------------------------------------ agentes
interface CardState {
  snap: AgentSnapshot;
  el: HTMLElement;
  feedEl: HTMLElement;
  lastSeq: number;
  stick: boolean;
  hue: number;
}
const cards = new Map<string, CardState>();
const HUES = [212, 28, 152, 280, 340, 48, 188, 8, 250, 112];
let focusedId: string | null = null;

const grid = $('agents-grid');
const layout = $('layout');

function setPanel(open: boolean) {
  layout.classList.toggle('collapsed', !open);
  setTimeout(refit, 240);
}
let userClosedPanel = false;
$('toggle-panel').addEventListener('click', () => {
  const open = layout.classList.contains('collapsed');
  userClosedPanel = !open;
  setPanel(open);
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    $('toggle-panel').click();
  }
});

function cardSkeleton(c: CardState): void {
  c.el.innerHTML = `
    <div class="card-head">
      <div class="card-title">
        <span class="dot"></span>
        <span class="card-name"></span>
        <span class="badge"></span>
        <span class="origin"></span>
        <div class="card-tools">
          <button class="btn ghost small icon-only" data-act="focus" title="Expandir">${icon('expand')}</button>
        </div>
      </div>
      <div class="card-meta"></div>
      <div class="card-task"></div>
    </div>
    <div class="feed" role="log" aria-live="off"></div>
    <button class="jump" hidden>↓ novas ações</button>
    <div class="card-foot"></div>`;
  c.feedEl = c.el.querySelector('.feed')!;
  c.feedEl.addEventListener('scroll', () => {
    const f = c.feedEl;
    c.stick = f.scrollHeight - f.scrollTop - f.clientHeight < 24;
    if (c.stick) (c.el.querySelector('.jump') as HTMLElement).hidden = true;
  });
  c.el.querySelector('.jump')!.addEventListener('click', () => {
    c.stick = true;
    c.feedEl.scrollTop = c.feedEl.scrollHeight;
  });
  c.el.addEventListener('click', (e) => onCardAction(c, e));
  c.el.querySelector('.card-head')!.addEventListener('dblclick', () => toggleFocus(c.snap.id));
}

function renderCard(c: CardState): void {
  const a = c.snap;
  c.el.className = `card s-${a.status}${focusedId === a.id ? ' focus' : ''}`;
  c.el.style.setProperty('--hue', String(c.hue));
  const q = (s: string) => c.el.querySelector(s) as HTMLElement;
  q('.card-name').textContent = a.name;
  q('.card-name').title = a.name;
  q('.badge').textContent = STATUS_LABEL[a.status];
  q('.origin').textContent = a.origin === 'claude' ? 'pelo Claude' : 'manual';
  q('.card-task').textContent = a.task;
  q('.card-task').title = a.task;
  q('[data-act=focus]').innerHTML = icon(focusedId === a.id ? 'shrink' : 'expand');
  (q('[data-act=focus]') as HTMLElement).title = focusedId === a.id ? 'Voltar à grade' : 'Expandir';

  const meta: string[] = [];
  meta.push(`<span data-elapsed>${elapsedText(a)}</span>`);
  if (a.toolCalls) meta.push(`<span>${a.toolCalls} ações</span>`);
  if (a.tokensOut) meta.push(`<span>${fmtTokens(a.tokensOut)} tokens</span>`);
  if (a.costUsd) meta.push(`<span>${fmtUsd(a.costUsd)}</span>`);
  if (a.model) meta.push(`<span>${esc(a.model.replace(/^claude-/, ''))}</span>`);
  meta.push(
    a.branch
      ? `<span class="branch" title="${esc(a.cwd)}">⎇ ${esc(a.branch)}</span>`
      : `<span class="warn" title="Sem worktree: trabalha direto na pasta do projeto">sem isolamento</span>`,
  );
  q('.card-meta').innerHTML = meta.join('');

  const foot = q('.card-foot');
  const live = a.status === 'running' || a.status === 'queued';
  if (live) {
    foot.innerHTML = `<span class="activity" title="${esc(a.activity)}">${esc(a.activity)}</span>
      <button class="btn small danger" data-act="stop">${icon('stop')}Parar</button>`;
  } else {
    foot.innerHTML = `<span class="diffstat" title="${esc(a.diffStat ?? '')}">${esc(a.diffStat ?? (a.status === 'done' ? 'Concluído' : a.error ?? ''))}</span>
      <button class="btn ghost small icon-only" data-act="folder" title="Abrir a pasta do agente">${icon('folder')}</button>
      ${a.branch ? `<button class="btn ghost small icon-only" data-act="copy" title="Copiar o comando de merge">${icon('copy')}</button>` : ''}
      <button class="btn small" data-act="message" title="Continuar a conversa com este agente">${icon('message')}Mensagem</button>
      <button class="btn ghost small icon-only" data-act="dismiss" title="Fechar card (o worktree continua)">${icon('close')}</button>`;
  }
}

function elapsedText(a: AgentSnapshot): string {
  if (!a.startedAt) return 'aguardando vaga';
  return fmtElapsed((a.endedAt ?? Date.now()) - a.startedAt);
}

const TAGS: Partial<Record<FeedItem['kind'], string>> = { tool_error: 'erro', system: 'info', stderr: 'aviso', result: 'Resultado final', message: 'msg' };
function appendFeed(c: CardState, items: FeedItem[]): void {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (it.seq <= c.lastSeq) continue;
    c.lastSeq = it.seq;
    const row = document.createElement('div');
    const blocked = it.kind === 'tool_error' && it.text.startsWith('Bloqueado:');
    row.className = `feed-item k-${blocked ? 'blocked' : it.kind}`;
    const tag = blocked ? 'bloqueado' : it.kind === 'tool' ? it.tool ?? '' : it.kind === 'text' ? '' : TAGS[it.kind] ?? '';
    const shown = blocked ? it.text.slice('Bloqueado:'.length).trim() : it.text;
    const long = shown.length > 260 || shown.split('\n').length > 4;
    if (long) row.classList.add('clippable');
    row.innerHTML = `<span class="feed-tag">${esc(tag)}</span><span class="feed-body"><span class="${long ? 'clip' : ''}">${esc(shown)}</span></span>`;
    if (long) row.title = 'Clique para expandir';
    frag.appendChild(row);
  }
  c.feedEl.appendChild(frag);
  while (c.feedEl.childElementCount > 600) c.feedEl.firstElementChild!.remove();
  if (c.stick) c.feedEl.scrollTop = c.feedEl.scrollHeight;
  else if (items.length) (c.el.querySelector('.jump') as HTMLElement).hidden = false;
}

function upsert(ev: AgentEvent): void {
  let c = cards.get(ev.agent.id);
  const prev = c?.snap.status;
  if (!c) {
    const el = document.createElement('article');
    c = { snap: ev.agent, el, feedEl: el, lastSeq: 0, stick: true, hue: HUES[cards.size % HUES.length] };
    cardSkeleton(c);
    cards.set(ev.agent.id, c);
    grid.appendChild(el);
    if (!userClosedPanel) setPanel(true);
  }
  c.snap = ev.agent;
  renderCard(c);
  appendFeed(c, ev.feed);
  if (prev && prev !== ev.agent.status && ['done', 'failed'].includes(ev.agent.status)) {
    toast(`${ev.agent.name}: ${STATUS_LABEL[ev.agent.status]}`, ev.agent.status);
  }
  refreshSummary();
}

function onCardAction(c: CardState, e: Event): void {
  const t = (e.target as HTMLElement).closest('[data-act], .feed-item.clippable') as HTMLElement | null;
  if (!t) return;
  if (t.classList.contains('feed-item')) {
    t.classList.toggle('open');
    return;
  }
  const a = c.snap;
  switch (t.dataset.act) {
    case 'focus':
      toggleFocus(a.id);
      break;
    case 'stop':
      api.agents.stop(a.id);
      break;
    case 'folder':
      api.agents.openFolder(a.cwd);
      break;
    case 'copy':
      navigator.clipboard.writeText(`git merge --no-ff ${a.branch}`);
      toast(`Copiado: git merge --no-ff ${a.branch}`);
      break;
    case 'message':
      openMessage(a);
      break;
    case 'dismiss':
      api.agents.dismiss(a.id).then(() => removeCard(a.id));
      break;
  }
}

function removeCard(id: string) {
  const c = cards.get(id);
  if (!c) return;
  c.el.remove();
  cards.delete(id);
  if (focusedId === id) toggleFocus(id);
  refreshSummary();
}

function toggleFocus(id: string) {
  focusedId = focusedId === id ? null : id;
  grid.classList.toggle('focused', !!focusedId);
  cards.forEach(renderCard);
}

$('clear-done').addEventListener('click', async () => {
  for (const [id, c] of cards) {
    if (['done', 'failed', 'stopped'].includes(c.snap.status)) {
      await api.agents.dismiss(id);
      removeCard(id);
    }
  }
});

function refreshSummary(): void {
  const list = [...cards.values()].map((c) => c.snap);
  const n = (s: AgentSnapshot['status']) => list.filter((a) => a.status === s).length;
  const cost = list.reduce((t, a) => t + a.costUsd, 0);
  $('agent-count').textContent = String(list.length);
  $('agents-empty').hidden = list.length > 0;
  grid.hidden = list.length === 0;
  grid.classList.toggle('single', list.length === 1);
  grid.classList.toggle('fit', list.length > 1 && list.length <= 4);
  const parts: string[] = [];
  if (n('running')) parts.push(`<span class="stat s-running"><span class="dot"></span>${n('running')} rodando</span>`);
  if (n('waiting')) parts.push(`<span class="stat s-waiting"><span class="dot"></span>${n('waiting')} esperando</span>`);
  if (n('queued')) parts.push(`<span class="stat s-queued"><span class="dot"></span>${n('queued')} na fila</span>`);
  if (n('done')) parts.push(`<span class="stat s-done"><span class="dot"></span>${n('done')} concluído${n('done') > 1 ? 's' : ''}</span>`);
  if (n('failed')) parts.push(`<span class="stat s-failed"><span class="dot"></span>${n('failed')} falhou</span>`);
  if (cost) parts.push(`<span class="stat">${fmtUsd(cost)}</span>`);
  $('stats').innerHTML = parts.join('');
  $('agents-sub').textContent = list.length ? `${list.length} no total` : '';
}

// Atualiza os cronômetros a cada segundo, sem re-renderizar o card inteiro.
setInterval(() => {
  for (const c of cards.values()) {
    if (c.snap.status === 'running') {
      const el = c.el.querySelector('[data-elapsed]');
      if (el) el.textContent = elapsedText(c.snap);
    }
  }
}, 1000);

// ------------------------------------------------------------------ splitter
{
  const splitter = $('splitter');
  const setW = (px: number) => {
    const total = layout.clientWidth;
    const w = Math.min(Math.max(px, 340), total - 380);
    document.documentElement.style.setProperty('--panel-w', `${w}px`);
    try { localStorage.setItem('zagent.panelW', String(w)); } catch { /* sem storage */ }
  };
  try {
    const saved = Number(localStorage.getItem('zagent.panelW'));
    if (saved) document.documentElement.style.setProperty('--panel-w', `${saved}px`);
  } catch { /* sem storage */ }
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    layout.classList.add('dragging');
    const move = (ev: PointerEvent) => setW(layout.getBoundingClientRect().right - ev.clientX);
    const up = () => {
      layout.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      refit();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
  splitter.addEventListener('keydown', (e) => {
    const pane = $('agents-pane');
    if (e.key === 'ArrowLeft') setW(pane.clientWidth + 40);
    if (e.key === 'ArrowRight') setW(pane.clientWidth - 40);
    refit();
  });
}

// ------------------------------------------------------------------ diálogos
const newDlg = $<HTMLDialogElement>('new-agent-dialog');
$('new-agent').addEventListener('click', () => {
  ($('new-agent-form') as HTMLFormElement).reset();
  newDlg.showModal();
});
newDlg.addEventListener('close', async () => {
  if (newDlg.returnValue !== 'ok') return;
  const f = new FormData($('new-agent-form') as HTMLFormElement);
  await api.agents.spawn(String(f.get('name')), String(f.get('task')));
});

const msgDlg = $<HTMLDialogElement>('message-dialog');
let msgTarget: AgentSnapshot | null = null;
function openMessage(a: AgentSnapshot) {
  msgTarget = a;
  $('message-target').textContent = a.name;
  ($('message-form') as HTMLFormElement).reset();
  msgDlg.showModal();
}
msgDlg.addEventListener('close', async () => {
  if (msgDlg.returnValue !== 'ok' || !msgTarget) return;
  const f = new FormData($('message-form') as HTMLFormElement);
  try {
    await api.agents.continue(msgTarget.id, String(f.get('message')));
  } catch (e) {
    toast(String((e as Error).message));
  }
});

let settings: Settings;
const setDlg = $<HTMLDialogElement>('settings-dialog');
const setForm = $('settings-form') as HTMLFormElement;
$('open-settings').addEventListener('click', () => {
  (setForm.elements.namedItem('workerModel') as HTMLInputElement).value = settings.workerModel;
  (setForm.elements.namedItem('workerAgent') as HTMLSelectElement).value = settings.workerAgent ?? 'claude';
  (setForm.elements.namedItem('maxConcurrent') as HTMLInputElement).value = String(settings.maxConcurrent);
  (setForm.elements.namedItem('isolate') as HTMLInputElement).checked = settings.isolate;
  setForm.querySelectorAll<HTMLInputElement>('[name=workerPermission]').forEach((r) => (r.checked = r.value === settings.workerPermission));
  setDlg.showModal();
});
setDlg.addEventListener('close', async () => {
  if (setDlg.returnValue !== 'ok') return;
  const f = new FormData(setForm);
  settings = await api.settings.set({
    workerPermission: f.get('workerPermission') as Settings['workerPermission'],
    workerModel: String(f.get('workerModel') ?? ''),
    workerAgent: f.get('workerAgent') === 'opencode' ? 'opencode' : 'claude',
    maxConcurrent: Math.min(12, Math.max(1, Number(f.get('maxConcurrent')) || 4)),
    isolate: f.get('isolate') === 'on',
  });
  toast('Configurações salvas. Valem para os próximos agentes.');
});

function showWorkspace() {
  // Mostra só o fim do caminho; o caminho completo fica no tooltip.
  const parts = settings.workspace.split(/[\\/]/).filter(Boolean);
  $('workspace-path').textContent = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : settings.workspace;
  $('workspace').title = `${settings.workspace}\nClique para trocar a pasta do projeto`;
}
$('workspace').addEventListener('click', async () => {
  const s = await api.settings.pickWorkspace();
  if (s) {
    settings = s;
    showWorkspace();
    term.reset();
  }
});

// ------------------------------------------------------------------ início
(async () => {
  hydrateIcons();
  const info = await api.info();
  if (info.platform === 'darwin') document.body.classList.add('mac');
  settings = await api.settings.get();
  showWorkspace();
  if (!info.claudeFound) {
    const b = $('banner');
    b.innerHTML = `Não encontrei o Claude Code nesta máquina. Instale com <code>npm install -g @anthropic-ai/claude-code</code> e reinicie o zAgent.`;
    b.hidden = false;
  }
  const existing: AgentEvent[] = await api.agents.list();
  existing.forEach(upsert);
  api.agents.onEvent(upsert);
  refreshSummary();
  setPanel(existing.length > 0);
  requestAnimationFrame(() => {
    fit.fit();
    setMainAlive(true);
    api.pty.start(term.cols, term.rows);
    term.focus();
  });
})();
