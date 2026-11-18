// Abertura da CLI: um portal animado (azul, roxo, branco sobre preto) e a escolha do agente principal.
import { emitKeypressEvents } from 'node:readline';

export type MainAgent = 'claude' | 'opencode';

export interface IntroOptions {
  /** Pula a animação e vai direto para a escolha. */
  skipAnimation?: boolean;
  /** Opção já selecionada ao abrir (a última usada). */
  initial?: MainAgent;
  /** Diz se o executável de cada opção existe; as que faltam mostram como instalar. */
  available: Record<MainAgent, boolean>;
}

type RGB = [number, number, number];

const BG: RGB = [4, 4, 10];
const PURPLE: RGB = [138, 63, 252];
const DEEP_PURPLE: RGB = [70, 24, 150];
const BLUE: RGB = [40, 110, 255];
const SKY: RGB = [110, 180, 255];
const WHITE: RGB = [255, 255, 255];

const OPTIONS: Array<{ id: MainAgent; label: string; install: string }> = [
  { id: 'claude', label: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'opencode', label: 'OpenCode', install: 'npm install -g opencode-ai' },
];

// Blocos dão um brilho contínuo; os pontos ficam nas bordas mais fracas.
const RAMP = ' ·:░░▒▒▓▓██';
const STARS = ['·', '·', '+', '✦'];
const INTRO_MS = 2300;
const MOVE_MS = 450;

const mix = (a: RGB, b: RGB, k: number): RGB => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const easeOutBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const fg = (c: RGB) => `\x1b[38;2;${c[0] | 0};${c[1] | 0};${c[2] | 0}m`;
const bg = (c: RGB) => `\x1b[48;2;${c[0] | 0};${c[1] | 0};${c[2] | 0}m`;

/** Ruído determinístico por célula (posição das estrelas). */
function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Cor e caractere de uma célula do portal no instante t (segundos). */
function portalCell(x: number, y: number, t: number, cx: number, cy: number, R: number): [string, RGB] {
  // Células do terminal são ~2x mais altas que largas: compensa no eixo x.
  const dx = (x - cx) / 2.1;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  const rn = R > 0.01 ? d / R : 99;
  const th = Math.atan2(dy, dx);

  // Anel brilhante na borda do portal.
  const ring = Math.exp(-((rn - 1) ** 2) / 0.008) * (0.85 + 0.15 * Math.sin(th * 6 + t * 9));
  // Braços em espiral girando para dentro, com um núcleo de luz no centro.
  let swirl = 0;
  let core = 0;
  if (rn < 1.05) {
    const arms = 0.5 + 0.5 * Math.sin(3 * th + 7 * Math.log(rn + 0.06) - t * 5);
    swirl = (0.18 + 0.82 * Math.pow(arms, 1.8)) * (0.35 + 0.65 * clamp(rn)) * 0.9;
    core = Math.exp(-(rn * rn) / 0.035) * (0.85 + 0.15 * Math.sin(t * 7));
  }
  // Brilho que vaza para fora do anel.
  const glow = rn > 1 ? Math.exp(-(rn - 1) * 5) * 0.4 * (0.65 + 0.35 * Math.sin(th * 3 + t * 2.3)) : 0;
  // Estrelas piscando no fundo.
  let star = 0;
  let starCh = '·';
  if (rn > 1.2) {
    const h = hash(x, y);
    if (h < 0.016) {
      star = 0.3 + 0.7 * Math.abs(Math.sin(t * 2.4 + h * 400));
      starCh = STARS[Math.min(STARS.length - 1, Math.floor(star * STARS.length))];
    }
  }

  const I = Math.max(ring, swirl, glow, core);
  if (star > I) return [starCh, mix(BG, mix(SKY, WHITE, star), 0.35 + 0.65 * star)];
  if (I < 0.07) return [' ', BG];

  // Azul e roxo se alternam girando; perto do anel tende ao branco.
  const hue = 0.5 + 0.5 * Math.sin(th * 2 - t * 1.7 + rn * 3);
  let col = mix(mix(DEEP_PURPLE, PURPLE, clamp(I * 1.2)), mix(BLUE, SKY, clamp(I)), hue);
  col = mix(col, WHITE, clamp(ring * ring * 0.9 + core * 0.95));
  col = mix(BG, col, clamp(0.35 + I));
  const ch = RAMP[Math.min(RAMP.length - 1, Math.max(1, Math.round(I * (RAMP.length - 1))))];
  return [ch, col];
}

interface Layout {
  cx: number;
  cy: number;
  R: number;
}

export function runIntro(opts: IntroOptions): Promise<MainAgent | null> {
  const out = process.stdout;
  const start = Date.now() - (opts.skipAnimation ? INTRO_MS + MOVE_MS : 0);
  let sel = Math.max(0, OPTIONS.findIndex((o) => o.id === opts.initial));
  let notice = '';
  /** Opção que já mostrou o aviso de "não encontrado": um segundo Enter tenta abrir mesmo assim. */
  let warned: MainAgent | null = null;
  let picking = !!opts.skipAnimation;
  let pickAt = picking ? start + INTRO_MS : 0;
  let timer: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const finish = (v: MainAgent | null) => {
      clearInterval(timer);
      process.stdin.off('keypress', onKey);
      out.off('resize', draw);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write('\x1b[0m\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l');
      resolve(v);
    };

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'q' || key.name === 'escape') return finish(null);
      if (!picking) {
        // Qualquer tecla pula a animação.
        picking = true;
        pickAt = Date.now();
        return;
      }
      notice = '';
      if (key.name !== 'return' && key.name !== 'enter') warned = null;
      if (['left', 'up', 'h', 'k'].includes(key.name ?? '')) sel = (sel + OPTIONS.length - 1) % OPTIONS.length;
      else if (['right', 'down', 'l', 'j', 'tab'].includes(key.name ?? '')) sel = (sel + 1) % OPTIONS.length;
      else if (str === '1' || str === '2') sel = Number(str) - 1;
      if (key.name === 'return' || key.name === 'enter' || str === '1' || str === '2') {
        const o = OPTIONS[sel];
        // A detecção pode errar (PATH diferente no proot, por exemplo): avisa, mas deixa tentar.
        if (!opts.available[o.id] && warned !== o.id) {
          warned = o.id;
          notice = `Não achei o ${o.label}. Enter de novo para tentar mesmo assim, ou instale: ${o.install}`;
        } else return finish(o.id);
      }
      draw();
    };

    const draw = () => {
      const W = Math.max(20, out.columns || 80);
      const H = Math.max(8, out.rows || 24);
      const now = Date.now();
      const t = (now - start) / 1000;
      if (!picking && now - start >= INTRO_MS) {
        picking = true;
        pickAt = now;
      }

      // O menu usa 9 linhas lado a lado ou 12 empilhado (tela estreita, como no celular).
      const stacked = W < 52;
      const menuH = stacked ? 14 : 11;
      const intro: Layout = { cx: W / 2, cy: H / 2 - 1, R: Math.min(H * 0.36, (W / 2.1) * 0.4) };
      const topH = Math.max(3, H - menuH);
      const pick: Layout = { cx: W / 2, cy: topH / 2, R: Math.max(1.2, Math.min(topH * 0.4, (W / 2.1) * 0.4)) };

      let L: Layout;
      let menuK = 0;
      if (!picking) {
        const open = easeOutBack(clamp(t / 0.9));
        L = { ...intro, R: intro.R * open };
      } else {
        menuK = easeInOut(clamp((now - pickAt) / MOVE_MS));
        L = { cx: intro.cx, cy: intro.cy + (pick.cy - intro.cy) * menuK, R: intro.R + (pick.R - intro.R) * menuK };
      }

      const rows: string[] = [];
      const menuTop = H - menuH;
      const menu = picking ? menuLines(W, stacked, sel, t, notice, menuK) : [];
      for (let y = 0; y < H; y++) {
        const mi = y - menuTop;
        if (picking && mi >= 0 && mi < menu.length && menuK > 0.05) {
          rows.push(bg(BG) + menu[mi]);
          continue;
        }
        let line = bg(BG);
        let last = '';
        for (let x = 0; x < W; x++) {
          const [ch, col] = portalCell(x, y, t, L.cx, L.cy, L.R);
          // Quantiza a cor para mandar menos bytes ao terminal (importante em celular).
          const q = col.map((v) => (v | 0) & 0xf8) as RGB;
          const code = fg(q);
          if (code !== last) {
            line += code;
            last = code;
          }
          line += ch;
        }
        rows.push(line);
      }

      // Nome no centro durante a abertura.
      if (!picking || menuK < 1) {
        const title = 'z A g e n t';
        const k = clamp((t - 1.0) / 0.6) * (1 - menuK);
        if (k > 0) {
          const ty = Math.round(L.cy + L.R + 1.5);
          const tx = Math.max(0, Math.round(W / 2 - title.length / 2));
          if (ty < H && ty >= 0) {
            rows[ty] =
              bg(BG) + ' '.repeat(tx) + '\x1b[1m' + fg(mix(BG, WHITE, k)) + title + '\x1b[22m' + ' '.repeat(Math.max(0, W - tx - title.length));
          }
        }
      }

      out.write('\x1b[H' + rows.map((r) => r + '\x1b[0m').join('\r\n'));
    };

    out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    out.on('resize', draw);
    timer = setInterval(draw, 40);
    draw();
  });
}

function wrapText(s: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    if (line && (line + ' ' + word).length > w) {
      out.push(line);
      line = word;
    } else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out;
}

const visLen = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;
const center = (s: string, W: number) => {
  const pad = Math.max(0, Math.floor((W - visLen(s)) / 2));
  return ' '.repeat(pad) + s + ' '.repeat(Math.max(0, W - pad - visLen(s)));
};

/** A pergunta e as duas caixas ("grades") azuis. */
function menuLines(W: number, stacked: boolean, sel: number, t: number, notice: string, k: number): string[] {
  const fade = (c: RGB) => fg(mix(BG, c, k));
  const pulse = 0.5 + 0.5 * Math.sin(t * 4);
  const lines: string[] = [];
  lines.push(center('', W));
  lines.push(center('\x1b[1m' + fade(WHITE) + 'Qual modelo escolher?' + '\x1b[22m', W));
  lines.push(center('', W));

  const boxW = stacked ? Math.min(W - 4, 30) : Math.min(26, Math.floor((W - 8) / 2));
  const boxes = OPTIONS.map((o, i) => box(o.label, boxW, i === sel, pulse, fade));
  if (stacked) {
    for (const b of boxes) for (const l of b) lines.push(center(l, W));
  } else {
    const gap = '    ';
    for (let r = 0; r < 3; r++) lines.push(center(boxes[0][r] + gap + boxes[1][r], W));
  }
  lines.push(center('', W));
  if (notice) {
    // Em tela estreita o aviso quebra em mais linhas em vez de estourar a largura.
    for (const part of wrapText(notice, Math.max(10, W - 4)).slice(0, 3)) lines.push(center(fade(PURPLE) + part, W));
  }
  else lines.push(center(fade([90, 100, 140]) + '←→ escolher · enter confirmar · q sair', W));
  // Completa a área do menu para o portal não vazar por baixo.
  while (lines.length < (stacked ? 14 : 11)) lines.push(center('', W));
  return lines;
}

function box(label: string, w: number, selected: boolean, pulse: number, fade: (c: RGB) => string): string[] {
  const inner = w - 2;
  const text = label.length > inner - 2 ? label.slice(0, inner - 3) + '…' : label;
  const left = Math.floor((inner - text.length) / 2);
  const padded = ' '.repeat(left) + text + ' '.repeat(inner - left - text.length);
  if (selected) {
    // Selecionada: borda grossa, azul pulsando para o roxo, texto branco.
    const b = fade(mix(BLUE, PURPLE, pulse * 0.6));
    return [
      b + '┏' + '━'.repeat(inner) + '┓',
      b + '┃' + '\x1b[1m' + fade(WHITE) + padded + '\x1b[22m' + b + '┃',
      b + '┗' + '━'.repeat(inner) + '┛',
    ];
  }
  const b = fade([30, 70, 170]);
  const tx = fade([150, 160, 200]);
  return [b + '╭' + '─'.repeat(inner) + '╮', b + '│' + tx + padded + b + '│', b + '╰' + '─'.repeat(inner) + '╯'];
}
