// Processo principal do Electron: janela, terminal do Claude principal, agentes e servidor MCP.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { claudeAvailable, claudeBin, ptyCommand } from './claudeBin';
import { startMcpServer, type McpHandle } from './mcpServer';
import { Orchestrator } from './orchestrator';
import type { Settings } from '../shared/types';
import { MAIN_PROMPT, MAIN_ALLOWED_TOOLS, mcpConfigJson } from '../shared/mainClaude';

let win: BrowserWindow | null = null;
let term: pty.IPty | null = null;
let mcp: McpHandle | null = null;
let orch: Orchestrator;

const settingsPath = () => join(app.getPath('userData'), 'settings.json');
const DEFAULTS: Settings = {
  workspace: process.env.ZAGENT_WORKSPACE || process.cwd() || homedir(),
  workerPermission: 'standard',
  workerModel: '',
  maxConcurrent: 4,
  isolate: true,
};
let settings: Settings = { ...DEFAULTS };

function loadSettings(): void {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
  if (process.env.ZAGENT_WORKSPACE) settings.workspace = process.env.ZAGENT_WORKSPACE;
  if (!existsSync(settings.workspace)) settings.workspace = homedir();
}

function saveSettings(): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

function startMainClaude(cols = 100, rows = 30): void {
  term?.kill();
  term = null;
  if (!mcp) return;
  const runDir = join(app.getPath('userData'), 'run');
  mkdirSync(runDir, { recursive: true });
  const mcpConfig = join(runDir, 'mcp.json');
  writeFileSync(mcpConfig, mcpConfigJson(mcp.url, mcp.token));
  const promptFile = join(runDir, 'main-prompt.txt');
  writeFileSync(promptFile, MAIN_PROMPT);

  const args = [
    '--mcp-config', mcpConfig,
    '--append-system-prompt-file', promptFile,
    // Ferramentas do próprio zAgent liberadas sem pedir permissão a cada uso.
    '--allowedTools', MAIN_ALLOWED_TOOLS,
  ];
  const cmd = process.env.ZAGENT_MAIN_CMD
    ? { file: process.env.ZAGENT_MAIN_CMD, args: [] as string[] }
    : ptyCommand(args);
  try {
    term = pty.spawn(cmd.file, cmd.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: settings.workspace,
      env: {
        ...(process.env as Record<string, string>),
        // wait_agents pode levar vários minutos.
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT || '1800000',
        ZAGENT_MCP_URL: mcp.url,
        ZAGENT_MCP_TOKEN: mcp.token,
        COLORTERM: 'truecolor',
      },
    });
  } catch (e) {
    send('pty:data', `\r\n\x1b[31mNão consegui abrir o Claude Code (${claudeBin()}): ${(e as Error).message}\x1b[0m\r\n`);
    send('pty:exit', -1);
    return;
  }
  const t = term;
  t.onData((d) => send('pty:data', d));
  t.onExit(({ exitCode }) => {
    if (term === t) {
      term = null;
      send('pty:exit', exitCode);
    }
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0c0d10',
    title: 'zAgent',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    claudeFound: claudeAvailable(),
    claudeBin: claudeBin(),
    mcpUrl: mcp?.url,
  }));
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const workspaceChanged = patch.workspace && patch.workspace !== settings.workspace;
    settings = { ...settings, ...patch };
    saveSettings();
    if (workspaceChanged) startMainClaude();
    return settings;
  });
  ipcMain.handle('workspace:pick', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.workspace });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.workspace = r.filePaths[0];
    saveSettings();
    startMainClaude();
    return settings;
  });

  ipcMain.on('pty:start', (_e, cols: number, rows: number) => {
    if (!term) startMainClaude(cols, rows);
  });
  ipcMain.on('pty:restart', (_e, cols: number, rows: number) => startMainClaude(cols, rows));
  ipcMain.on('pty:input', (_e, data: string) => term?.write(data));
  ipcMain.on('pty:resize', (_e, cols: number, rows: number) => {
    if (term && cols > 0 && rows > 0) term.resize(cols, rows);
  });

  ipcMain.handle('agents:list', () => orch.list().map((a) => ({ agent: a, feed: orch.feed(a.id) })));
  ipcMain.handle('agents:spawn', (_e, name: string, task: string) => orch.spawn({ name, task, origin: 'user' }));
  ipcMain.handle('agents:stop', (_e, id: string) => orch.stop(id));
  ipcMain.handle('agents:continue', (_e, id: string, msg: string) => orch.continueAgent(id, msg));
  ipcMain.handle('agents:dismiss', (_e, id: string) => orch.dismiss(id));
  ipcMain.handle('agents:open-folder', (_e, path: string) => shell.openPath(path));
}

app.whenReady().then(async () => {
  loadSettings();
  orch = new Orchestrator(
    () => settings,
    (ev) => send('agents:event', ev),
    join(app.getPath('userData'), 'run'),
  );
  mcp = await startMcpServer(orch);
  if (process.env.ZAGENT_DEBUG_MCP_FILE) {
    writeFileSync(process.env.ZAGENT_DEBUG_MCP_FILE, JSON.stringify({ url: mcp.url, token: mcp.token }));
  }
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  orch?.stopAll();
  term?.kill();
  mcp?.close();
});
