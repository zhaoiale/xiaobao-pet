import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import specData from '../pet-spec.json';
import type { InteractionResult, PetSpec, PetStats, Reminder, RuntimeFailureReport, RuntimeReadyReport, Settings, StateActivity, TypingStatus } from './shared/contracts';
import { assertInteractionId, assertReminderInput, assertRuntimeFailureReport, assertRuntimeReadyReport, assertSettingsPatch, assertStringArray } from './shared/contracts';
import { randomTip } from './shared/dev-tips';
import { draggedBounds, snapBounds, type Point, type Rect } from './main/drag';
import { JsonLogger } from './main/logger';
import { atomicWriteJson, uniqueDestination } from './main/persistence';
import { TypingListener } from './main/typing-listener';
import { localDateKey, nextReminderDelay, parsePersistedStats, parseReminders, parseSettings, type PersistedStats } from './main/data-validation';
import { readValidatedJson } from './main/persistence';
import trayIconPath from './assets/tray/tray-icon.png';

const spec = specData as PetSpec;
type Role = 'pet' | 'reminder' | 'dashboard';
let petWindow: BrowserWindow | undefined;
let reminderWindow: BrowserWindow | undefined;
let dashboardWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let logger: JsonLogger | undefined;
let settings: Settings;
let reminders: Reminder[] = [];
let stats: PersistedStats;
let sessionStartedAt = Date.now();
let typingStatus: TypingStatus = { enabled: false, reason: 'not-started' };
let isQuitting = false;
let dragSession: { bounds: Rect; cursor: Point } | undefined;
let runtimeRendererReport: RuntimeReadyReport | undefined;
const runtimeReadyRenderers = new Set<Role>();
let runtimeWindowReady = false;
let runtimeCommitted = false;
let fatalExitStarted = false;
let quitPersisting = false;
const roles = new Map<number, Role>();
const reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
const typingListener = new TypingListener();

// 散步（手动触发 + 自动随机）
let walking = false;
let walkDirection: 'left' | 'right' = 'right';
let walkTimer: ReturnType<typeof setInterval> | undefined;
let autoWalkTimer: ReturnType<typeof setTimeout> | undefined;
const WALK_SPEED_PX = 72;
const WALK_DURATION_MS = 6000;
const AUTO_WALK_MIN_MS = 4 * 60_000;
const AUTO_WALK_MAX_MS = 9 * 60_000;

// 程序员技巧自动提示
let tipTimer: ReturnType<typeof setTimeout> | undefined;
const TIP_AUTO_MIN_MS = 90 * 60_000;
const TIP_AUTO_MAX_MS = 150 * 60_000;

// ===== 作息调度（白天活动 / 夜晚睡觉）=====
const DAILY_ACTIVE_START_HOUR = 8;   // 早晨 8 点开始白天活动
const DAILY_ACTIVE_END_HOUR = 22;    // 晚上 22 点进入夜晚
const AUTO_FEED_MIN_MS = 15 * 60_000;  // 白天自主吃磨牙棒间隔
const AUTO_FEED_MAX_MS = 35 * 60_000;
let dailyRhythmTimer: ReturnType<typeof setInterval> | undefined;
let lastNightSleepDate = '';          // 记录最近一次夜晚自动入睡的本地日期，每晚只自动睡一次
let nextAutoFeedAt = 0;               // 下一次白天自主进食的时间戳

function localDateKeyOf(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function isNightHour(now: Date = new Date()): boolean {
  const hour = now.getHours();
  return hour >= DAILY_ACTIVE_END_HOUR || hour < DAILY_ACTIVE_START_HOUR;
}

function enterSleepForNight(): void {
  const sleepInteraction = spec.experience.interactions.find((item) => item.id === 'sleep');
  const feedback = sleepInteraction?.feedback[Math.floor(Math.random() * (sleepInteraction?.feedback.length ?? 1))] ?? '呼…呼…';
  sendActivity({ kind: 'interaction', stateId: 'sleep', feedback });
  void logger?.write('info', 'rhythm-sleep', { at: new Date().toISOString() });
}

function wakeUpForMorning(): void {
  sendActivity({ kind: 'interaction', stateId: 'happy', durationMs: 1200, feedback: '天亮啦，伸个懒腰~' });
  void logger?.write('info', 'rhythm-wake', { at: new Date().toISOString() });
}

function scheduleDailyRhythm(): void {
  if (dailyRhythmTimer) clearInterval(dailyRhythmTimer);
  if (nextAutoFeedAt === 0) {
    nextAutoFeedAt = Date.now() + AUTO_FEED_MIN_MS + Math.random() * (AUTO_FEED_MAX_MS - AUTO_FEED_MIN_MS);
  }
  dailyRhythmTimer = setInterval(() => {
    if (!settings.dailyRhythm) return;
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
    if (isNightHour()) {
      // 夜晚：每晚只自动入睡一次；用户手动唤醒后保持清醒，直到次日再自动睡。
      const today = localDateKeyOf();
      if (lastNightSleepDate !== today) {
        lastNightSleepDate = today;
        enterSleepForNight();
      }
    } else {
      // 白天：若昨晚睡过则先唤醒，然后偶尔自主吃磨牙棒。
      if (lastNightSleepDate !== '') {
        lastNightSleepDate = '';
        wakeUpForMorning();
      }
      if (Date.now() >= nextAutoFeedAt) {
        nextAutoFeedAt = Date.now() + AUTO_FEED_MIN_MS + Math.random() * (AUTO_FEED_MAX_MS - AUTO_FEED_MIN_MS);
        if (spec.features.interactions) void triggerInteraction('feed-chew').catch(() => {});
      }
    }
  }, 30_000);
}
const expectedRuntimeAssets = new Set([spec.character.coreAsset, ...spec.states.flatMap((state) => state.frames)]);
const runtimeReadyFile = path.join(process.cwd(), '.build', 'runtime-ready.json');
const runtimeFailureFile = path.join(process.cwd(), '.build', 'runtime-failed.json');
const runtimeEvidenceEnabled = !app.isPackaged || process.env.PET_PREVIEW_MODE === '1';
const e2eMode = process.env.PET_E2E === '1';

if (process.env.PET_E2E_USER_DATA) app.setPath('userData', path.resolve(process.env.PET_E2E_USER_DATA));

const defaultSettings: Settings = {
  edgeSnap: spec.features.edgeSnap,
  alwaysOnTop: true,
  typingReaction: spec.features.typingReaction,
  clickThrough: false,
  petScale: spec.experience.petSizing.defaultScale,
  walkEnabled: true,
  dailyRhythm: true,
};

const defaultStats: PersistedStats = {
  affection: 0,
  mood: 80,
  todayInteractions: 0,
  totalCompanionMs: 0,
  lastInteractionDate: localDateKey(),
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (process.env.PET_E2E === '1') {
  (globalThis as typeof globalThis & {
    __PET_E2E__?: {
      snapshot: () => {
        tray: boolean;
        roles: Array<{ role: Role; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      };
      quit: () => void;
    };
  }).__PET_E2E__ = {
    snapshot: () => ({
      tray: Boolean(tray && !tray.isDestroyed()),
      roles: [petWindow, reminderWindow, dashboardWindow].map((window, index) => ({
        role: (['pet', 'reminder', 'dashboard'] as const)[index]!,
        visible: Boolean(window?.isVisible()),
        destroyed: Boolean(window?.isDestroyed()),
      })),
      quitting: isQuitting,
    }),
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  };
}

function userFile(name: string): string { return path.join(app.getPath('userData'), name); }
function filePocket(): string { return path.join(app.getPath('documents'), spec.app.name); }
function stateForTrigger(trigger: string) { return spec.states.find((state) => state.triggers.includes(trigger)); }

async function verifySourceAssetGate(): Promise<void> {
  if (app.isPackaged) return;
  const reportPath = path.join(process.cwd(), 'qa', 'assets-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
    passed?: boolean;
    scope?: string;
    assets?: Array<{ frame?: string; ok?: boolean; fileSha256?: string }>;
  };
  if (report.passed !== true || (report.scope ?? 'all') !== 'all') {
    throw new Error('Source preview requires a complete passing qa/assets-report.json');
  }
  const records = new Map((report.assets ?? []).map((record) => [record.frame, record]));
  for (const relative of expectedRuntimeAssets) {
    const record = records.get(relative);
    if (!record?.ok || !record.fileSha256) throw new Error(`Source preview has no passing QA record for ${relative}`);
    const bytes = await readFile(path.join(process.cwd(), 'src', 'assets', 'pet', relative));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== record.fileSha256) throw new Error(`Source preview asset changed after QA: ${relative}`);
  }
}

async function writeRuntimeFile(file: string, value: unknown): Promise<void> {
  if (runtimeEvidenceEnabled) await atomicWriteJson(file, value);
}

async function commitRuntimeReady(): Promise<void> {
  if (
    runtimeCommitted
    || !runtimeWindowReady
    || !runtimeRendererReport
    || runtimeReadyRenderers.size !== 3
    || !petWindow
    || petWindow.isDestroyed()
  ) return;
  const report = {
    ...runtimeRendererReport,
    status: 'ready',
    expectedAssetCount: expectedRuntimeAssets.size,
    windowCount: BrowserWindow.getAllWindows().length,
    petVisible: petWindow.isVisible(),
    ipcReady: true,
    renderers: {
      pet: runtimeReadyRenderers.has('pet'),
      dashboard: runtimeReadyRenderers.has('dashboard'),
      reminder: runtimeReadyRenderers.has('reminder'),
    },
    appName: spec.app.name,
    version: spec.app.version,
    timestamp: new Date().toISOString(),
  };
  if (report.windowCount !== 3 || !report.petVisible) throw new Error(`Runtime window gate failed: windows=${report.windowCount}, visible=${report.petVisible}`);
  await logger?.write('info', 'runtime-ready', report);
  await writeRuntimeFile(runtimeReadyFile, report);
  runtimeCommitted = true;
}

async function fatalExit(event: string, error: unknown, details: Record<string, unknown> = {}): Promise<void> {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  const message = error instanceof Error ? error.message : String(error);
  const report = { status: 'failed', event, message, ...details, timestamp: new Date().toISOString() };
  console.error(event, error);
  try { await writeRuntimeFile(runtimeFailureFile, report); }
  catch (fileError) { console.error('runtime-failure-file-write-failed', fileError); }
  try { await logger?.write('error', event, { message, ...details }); }
  catch (logError) { console.error('structured-log-write-failed', logError); }
  app.exit(1);
}

function assertSender(event: IpcMainInvokeEvent, allowed: Role[]): Role {
  const role = roles.get(event.sender.id);
  if (!role || !allowed.includes(role) || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized IPC sender');
  return role;
}

function registerWindow(window: BrowserWindow, role: Role): BrowserWindow {
  const webContentsId = window.webContents.id;
  roles.set(webContentsId, role);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('did-fail-load', (_event, code, description) => {
    void fatalExit(`${role}-window-load-failed`, new Error(description), { code, role });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') {
      void logger?.write('warn', `${role}-renderer-stopped`, { role, reason: details.reason, exitCode: details.exitCode });
      return;
    }
    if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
      void fatalExit(`${role}-renderer-gone`, new Error(details.reason), { role, exitCode: details.exitCode });
      return;
    }
    void logger?.write('warn', `${role}-renderer-gone`, { role, reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('console-message', (details, level, legacyMessage) => {
    const message = details.message || legacyMessage;
    const currentLevel = details.level === 'error' ? 3 : level;
    const fatalMessage = /Content Security Policy|unsafe-eval|Refused to evaluate|Uncaught|Unhandled/i.test(message);
    if (fatalMessage || (!runtimeCommitted && currentLevel >= 3)) {
      void fatalExit(`${role}-renderer-console-error`, new Error(message), { role });
    } else if (currentLevel >= 3) {
      void logger?.write('error', `${role}-renderer-console-error`, { role, message: message.slice(0, 2000) });
    }
  });
  window.on('closed', () => roles.delete(webContentsId));
  return window;
}

function secureWindow(options: Electron.BrowserWindowConstructorOptions, role: Role, preload: string): BrowserWindow {
  return registerWindow(new BrowserWindow({
    ...options,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  }), role);
}

function petSize(): number { return Math.round(spec.experience.petSizing.baseWindowPx * settings.petScale); }

function applyPetSettings(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const size = petSize();
  petWindow.setSize(size, size, true);
  petWindow.setAlwaysOnTop(settings.alwaysOnTop);
  petWindow.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
}

function positionAbovePet(window: BrowserWindow): void {
  if (!petWindow) return;
  const petBounds = petWindow.getBounds();
  const target = window.getBounds();
  const workArea = screen.getDisplayMatching(petBounds).workArea;
  const x = Math.min(workArea.x + workArea.width - target.width, Math.max(workArea.x, petBounds.x + Math.round((petBounds.width - target.width) / 2)));
  const preferredY = petBounds.y - target.height - 12;
  const y = preferredY >= workArea.y ? preferredY : Math.min(workArea.y + workArea.height - target.height, petBounds.y + petBounds.height + 12);
  window.setPosition(x, y, false);
}

function createWindows(): void {
  const size = petSize();
  petWindow = secureWindow({
    width: size,
    height: size,
    transparent: true,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    opacity: e2eMode ? 0 : 1,
  }, 'pet', PET_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void petWindow.loadURL(PET_WINDOW_WEBPACK_ENTRY);
  petWindow.once('ready-to-show', () => {
    applyPetSettings();
    petWindow?.center();
    if (e2eMode) petWindow?.showInactive();
    else petWindow?.show();
    runtimeWindowReady = Boolean(petWindow?.isVisible());
    void commitRuntimeReady().catch((error) => fatalExit('runtime-ready-failed', error));
  });
  reminderWindow = secureWindow({
    width: 390,
    height: 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    opacity: e2eMode ? 0 : 1,
  }, 'reminder', REMINDER_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void reminderWindow.loadURL(REMINDER_WINDOW_WEBPACK_ENTRY);
  reminderWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); reminderWindow?.hide(); }
  });

  dashboardWindow = secureWindow({
    width: 520,
    height: 700,
    minWidth: 480,
    minHeight: 620,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: true,
    hasShadow: true,
    title: `${spec.character.displayName}的小屋`,
    opacity: e2eMode ? 0 : 1,
  }, 'dashboard', DASHBOARD_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void dashboardWindow.loadURL(DASHBOARD_WINDOW_WEBPACK_ENTRY);
  dashboardWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); dashboardWindow?.hide(); }
  });
}

function publicStats(): PetStats {
  const liveMs = stats.totalCompanionMs + Math.max(0, Date.now() - sessionStartedAt);
  return {
    affection: stats.affection,
    mood: stats.mood,
    todayInteractions: stats.todayInteractions,
    companionMinutes: Math.floor(liveMs / 60_000),
    lastInteractionDate: stats.lastInteractionDate,
  };
}

function normalizeStatsDay(): void {
  const today = localDateKey();
  if (stats.lastInteractionDate !== today) {
    stats.todayInteractions = 0;
    stats.lastInteractionDate = today;
  }
}

async function persistStats(): Promise<void> {
  stats.totalCompanionMs += Math.max(0, Date.now() - sessionStartedAt);
  sessionStartedAt = Date.now();
  await atomicWriteJson(userFile('pet-stats.json'), stats);
}

function broadcastStats(): void {
  const value = publicStats();
  for (const window of [petWindow, reminderWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('pet:stats', value);
  }
}

function sendActivity(activity: StateActivity): void {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('state:activity', activity);
}

function activityForTrigger(trigger: string, kind: string, feedback?: string, durationMs?: number): StateActivity {
  const state = stateForTrigger(trigger);
  return { kind, stateId: state?.id, durationMs, feedback };
}

async function triggerInteraction(id: string): Promise<InteractionResult> {
  const interaction = spec.experience.interactions.find((item) => item.id === id);
  if (!interaction || !spec.features.interactions) throw new Error(`Unknown or disabled interaction: ${id}`);
  normalizeStatsDay();
  stats.affection = Math.min(300, stats.affection + interaction.affectionGain);
  stats.mood = Math.min(100, stats.mood + Math.max(1, Math.ceil(interaction.affectionGain / 2)));
  stats.todayInteractions += 1;
  const feedback = interaction.feedback[Math.floor(Math.random() * interaction.feedback.length)] ?? interaction.label;
  await persistStats();
  const result: InteractionResult = { interaction, feedback, stats: publicStats() };
  sendActivity({ kind: 'interaction', stateId: interaction.stateId, durationMs: interaction.durationMs, feedback });
  broadcastStats();
  return result;
}

function showReminderComposer(): void {
  if (!spec.features.reminders || !reminderWindow) return;
  positionAbovePet(reminderWindow);
  if (e2eMode) reminderWindow.showInactive();
  else {
    reminderWindow.show();
    reminderWindow.focus();
  }
  reminderWindow.webContents.send('reminder:compose');
}

function showDashboard(): void {
  if (!spec.features.dashboard || !dashboardWindow) return;
  dashboardWindow.center();
  if (e2eMode) dashboardWindow.showInactive();
  else {
    dashboardWindow.show();
    dashboardWindow.focus();
  }
  broadcastStats();
}

// ===== 散步（手动触发 + 自动随机）=====
function notifyWalkDirection(): void {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('walk:direction', walkDirection);
}

function walkWorkArea(): Electron.Rectangle {
  if (!petWindow || petWindow.isDestroyed()) return screen.getPrimaryDisplay().workArea;
  return screen.getDisplayMatching(petWindow.getBounds()).workArea;
}

function startWalking(source: 'manual' | 'auto'): void {
  if (walking || !petWindow || petWindow.isDestroyed()) return;
  if (source === 'auto' && !settings.walkEnabled) return;
  walking = true;
  if (source === 'auto') {
    walkDirection = Math.random() < 0.5 ? 'left' : 'right';
  }
  notifyWalkDirection();
  const walkState = stateForTrigger('interaction:walk');
  const feedback = spec.experience.interactions.find((item) => item.id === 'walk')?.feedback ?? [];
  const message = feedback[Math.floor(Math.random() * feedback.length)];
  sendActivity({ kind: 'walk', stateId: walkState?.id, durationMs: WALK_DURATION_MS, feedback: message });
  const workArea = walkWorkArea();
  walkTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) { stopWalking('window-gone'); return; }
    const bounds = petWindow.getBounds();
    const step = WALK_SPEED_PX * 0.1;
    let x = bounds.x + (walkDirection === 'right' ? step : -step);
    if (x <= workArea.x) {
      x = workArea.x;
      if (walkDirection !== 'right') { walkDirection = 'right'; notifyWalkDirection(); }
    } else if (x + bounds.width >= workArea.x + workArea.width) {
      x = workArea.x + workArea.width - bounds.width;
      if (walkDirection !== 'left') { walkDirection = 'left'; notifyWalkDirection(); }
    }
    petWindow.setPosition(Math.round(x), bounds.y, false);
  }, 100);
  setTimeout(() => {
    if (walking) stopWalking('duration');
  }, WALK_DURATION_MS);
}

function stopWalking(reason: string): void {
  if (!walking && !walkTimer) return;
  walking = false;
  if (walkTimer) { clearInterval(walkTimer); walkTimer = undefined; }
  void logger?.write('info', 'walk-stopped', { reason });
}

function toggleWalk(): boolean {
  if (walking) {
    stopWalking('manual-toggle');
    return false;
  }
  startWalking('manual');
  return true;
}

function scheduleAutoWalk(): void {
  if (autoWalkTimer) clearTimeout(autoWalkTimer);
  const delay = AUTO_WALK_MIN_MS + Math.random() * (AUTO_WALK_MAX_MS - AUTO_WALK_MIN_MS);
  autoWalkTimer = setTimeout(() => {
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) {
      scheduleAutoWalk();
      return;
    }
    // 作息模式开启时，夜晚不散步，避免吵醒睡眠中的小宝。
    if (settings.dailyRhythm && isNightHour()) {
      scheduleAutoWalk();
      return;
    }
    if (!settings.walkEnabled) {
      scheduleAutoWalk();
      return;
    }
    startWalking('auto');
    scheduleAutoWalk();
  }, delay);
}

// ===== 程序员小技巧 =====
function showTip(tip: string): void {
  for (const window of [petWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('tip:show', tip);
  }
}

function scheduleAutoTip(): void {
  if (tipTimer) clearTimeout(tipTimer);
  const delay = TIP_AUTO_MIN_MS + Math.random() * (TIP_AUTO_MAX_MS - TIP_AUTO_MIN_MS);
  tipTimer = setTimeout(() => {
    showTip(randomTip());
    scheduleAutoTip();
  }, delay);
}

function buildPetMenu(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (spec.features.interactions) {
    for (const interaction of spec.experience.interactions) {
      if (interaction.id === 'walk') {
        items.push({ label: walking ? '🚶 停止散步' : '🚶 散步', click: () => void toggleWalk() });
        continue;
      }
      items.push({ label: `${interaction.emoji} ${interaction.label}`, click: () => void triggerInteraction(interaction.id) });
    }
    if (spec.experience.interactions.length) items.push({ type: 'separator' });
  }
  items.push({ label: '☀️ 起床', click: () => sendActivity({ kind: 'interaction', stateId: 'happy', durationMs: 1200, feedback: '汪！我醒啦~' }) });
  if (spec.features.reminders) items.push({ label: '⏰ 添加提醒', click: showReminderComposer });
  if (spec.features.dashboard) items.push({ label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard });
  if (spec.features.filePocket) items.push({ label: '📁 打开文件口袋', click: () => void openPocket() });
  items.push({ type: 'separator' });
  items.push({ label: '💡 程序员小技巧', click: () => showTip(randomTip()) });
  items.push({ label: settings.walkEnabled ? '🐾 自动散步：开' : '🐾 自动散步：关', click: () => void saveSettings({ ...settings, walkEnabled: !settings.walkEnabled }) });
  items.push({ label: settings.dailyRhythm ? '🌙 作息模式：开' : '🌙 作息模式：关', click: () => void saveSettings({ ...settings, dailyRhythm: !settings.dailyRhythm }) });
  items.push({ type: 'separator' });
  items.push({ label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) });
  items.push({ label: '🙈 隐藏桌宠', click: () => petWindow?.hide() });
  return items;
}

function createTray(): void {
  if (!spec.features.tray) return;
  const resolvedTrayIconPath = path.resolve(__dirname, trayIconPath);
  const trayImage = nativeImage.createFromPath(resolvedTrayIconPath);
  if (trayImage.isEmpty()) throw new Error(`Tray icon is empty: ${resolvedTrayIconPath}`);
  tray = new Tray(trayImage.resize({ width: 32, height: 32, quality: 'best' }));
  tray.setToolTip(spec.app.name);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `🐾 显示${spec.character.displayName}`, click: () => petWindow?.show() },
    { label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard },
    { label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) },
    { type: 'separator' },
    { label: '🚪 退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => petWindow?.isVisible() ? petWindow.hide() : petWindow?.show());
}

async function saveSettings(next: Settings): Promise<Settings> {
  settings = next;
  await atomicWriteJson(userFile('settings.json'), settings);
  applyPetSettings();
  restartTypingListener();
  createTrayMenuRefresh();
  if (!settings.walkEnabled) stopWalking('walk-disabled');
  return settings;
}

function createTrayMenuRefresh(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `🐾 显示${spec.character.displayName}`, click: () => petWindow?.show() },
    { label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard },
    { label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) },
    { type: 'separator' },
    { label: '🚪 退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function broadcastTypingStatus(): void {
  for (const window of [petWindow, reminderWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('typing:status', typingStatus);
  }
}

function restartTypingListener(): void {
  typingListener.stop();
  typingStatus = typingListener.start(settings.typingReaction, () => {
    const state = stateForTrigger('typing:activity');
    sendActivity({ kind: 'typing', stateId: state?.id, durationMs: 500 });
  });
  broadcastTypingStatus();
  void logger?.write(typingStatus.enabled ? 'info' : 'warn', 'typing-listener-status', typingStatus as unknown as Record<string, unknown>);
}

function clearReminderTimer(id: string): void {
  const timer = reminderTimers.get(id);
  if (timer) clearTimeout(timer);
  reminderTimers.delete(id);
}

function scheduleReminder(reminder: Reminder): void {
  clearReminderTimer(reminder.id);
  const delay = nextReminderDelay(reminder.dueAt);
  reminderTimers.set(reminder.id, setTimeout(() => {
    reminderTimers.delete(reminder.id);
    if (Date.parse(reminder.dueAt) > Date.now()) {
      scheduleReminder(reminder);
      return;
    }
    if (reminderWindow) {
      positionAbovePet(reminderWindow);
      if (e2eMode) reminderWindow.showInactive();
      else {
        reminderWindow.show();
        reminderWindow.focus();
      }
      reminderWindow.webContents.send('reminder:due', reminder);
    }
    const state = stateForTrigger('reminder:due');
    sendActivity({ kind: 'notify', stateId: state?.id, durationMs: 1800, feedback: reminder.text });
  }, delay));
}

async function persistReminders(): Promise<void> {
  await atomicWriteJson(userFile('reminders.json'), reminders);
}

async function openPocket(): Promise<void> {
  if (!spec.features.filePocket) throw new Error('File pocket is disabled');
  const directory = filePocket();
  await mkdir(directory, { recursive: true });
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
}

function registerIpc(): void {
  if (process.env.PET_E2E === '1') {
    ipcMain.handle('runtime:e2e-snapshot', (event) => {
      assertSender(event, ['pet', 'dashboard', 'reminder']);
      return (globalThis as typeof globalThis & {
        __PET_E2E__?: { snapshot: () => unknown };
      }).__PET_E2E__?.snapshot();
    });
    ipcMain.handle('runtime:e2e-quit', (event) => {
      assertSender(event, ['pet', 'dashboard', 'reminder']);
      setTimeout(() => {
        isQuitting = true;
        app.quit();
      }, 0);
    });
  }
  ipcMain.handle('runtime:renderer-ready', async (event, payload: unknown) => {
    const role = assertSender(event, ['pet', 'dashboard', 'reminder']);
    if (
      !payload
      || typeof payload !== 'object'
      || !('role' in payload)
      || payload.role !== role
      || !('bootstrapComplete' in payload)
      || payload.bootstrapComplete !== true
    ) {
      throw new TypeError('Invalid renderer-ready report');
    }
    runtimeReadyRenderers.add(role);
    await commitRuntimeReady();
  });
  ipcMain.handle('runtime:renderer-failed', async (event, payload: unknown) => {
    const role = assertSender(event, ['pet', 'dashboard', 'reminder']);
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message.slice(0, 2000)
      : 'Unknown renderer bootstrap failure';
    await fatalExit(`${role}-renderer-bootstrap-failed`, new Error(message), { role });
  });
  ipcMain.handle('runtime:ready', async (event, report: unknown) => {
    assertSender(event, ['pet']);
    assertRuntimeReadyReport(report);
    const state = spec.states.find((item) => item.id === report.stateId);
    if (!state || !state.frames.includes(report.frame)) throw new Error('Runtime report references an unknown state/frame pair');
    if (report.assetCount !== expectedRuntimeAssets.size) throw new Error(`Runtime asset count mismatch: ${report.assetCount}/${expectedRuntimeAssets.size}`);
    if (report.naturalWidth !== 512 || report.naturalHeight !== 512) throw new Error(`Runtime frame must be 512x512, got ${report.naturalWidth}x${report.naturalHeight}`);
    runtimeRendererReport = report;
    await commitRuntimeReady();
  });
  ipcMain.handle('runtime:fail', async (event, report: unknown) => {
    assertSender(event, ['pet']);
    assertRuntimeFailureReport(report);
    await fatalExit('renderer-runtime-failed', new Error(report.message), report as unknown as Record<string, unknown>);
  });
  ipcMain.handle('settings:get', (event) => { assertSender(event, ['pet', 'reminder', 'dashboard']); return settings; });
  ipcMain.handle('settings:update', async (event, patch: unknown) => {
    assertSender(event, ['dashboard']);
    assertSettingsPatch(patch);
    return saveSettings(parseSettings({ ...settings, ...patch }));
  });
  ipcMain.handle('reminders:list', (event) => { assertSender(event, ['dashboard', 'reminder']); return reminders; });
  ipcMain.handle('reminders:save', async (event, input: unknown) => {
    assertSender(event, ['dashboard', 'reminder']);
    assertReminderInput(input);
    const reminder: Reminder = { id: randomUUID(), text: input.text.trim(), dueAt: new Date(input.dueAt).toISOString(), createdAt: new Date().toISOString() };
    reminders.push(reminder);
    await persistReminders();
    scheduleReminder(reminder);
    return reminder;
  });
  ipcMain.handle('reminders:remove', async (event, id: unknown) => {
    assertSender(event, ['dashboard']);
    if (typeof id !== 'string' || id.length > 100) throw new TypeError('Invalid reminder id');
    const oldLength = reminders.length;
    reminders = reminders.filter((item) => item.id !== id);
    clearReminderTimer(id);
    await persistReminders();
    return oldLength !== reminders.length;
  });
  ipcMain.handle('interactions:list', (event) => { assertSender(event, ['pet', 'dashboard']); return spec.experience.interactions; });
  ipcMain.handle('interactions:stats', (event) => { assertSender(event, ['pet', 'dashboard']); normalizeStatsDay(); return publicStats(); });
  ipcMain.handle('interactions:trigger', async (event, id: unknown) => {
    assertSender(event, ['pet', 'dashboard']);
    assertInteractionId(id);
    return triggerInteraction(id);
  });
  ipcMain.handle('files:put', async (event, paths: unknown) => {
    assertSender(event, ['pet']);
    if (!spec.features.filePocket) throw new Error('File pocket is disabled');
    assertStringArray(paths);
    const destination = filePocket();
    await mkdir(destination, { recursive: true });
    const result = { copied: [] as string[], failed: [] as Array<{ source: string; reason: string }> };
    for (const source of paths) {
      try {
        if (!(await lstat(source)).isFile()) throw new Error('Only regular files are accepted');
        const target = await uniqueDestination(destination, path.basename(source));
        await copyFile(source, target);
        result.copied.push(target);
      } catch (error) {
        result.failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
  ipcMain.handle('files:open-pocket', async (event) => { assertSender(event, ['pet', 'dashboard']); await openPocket(); });
  ipcMain.handle('window:drag-begin', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !spec.features.drag) return;
    dragSession = { bounds: petWindow.getBounds(), cursor: screen.getCursorScreenPoint() };
  });
  ipcMain.handle('window:drag-update', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !dragSession) return;
    petWindow.setBounds(draggedBounds(dragSession.bounds, dragSession.cursor, screen.getCursorScreenPoint()), false);
  });
  ipcMain.handle('window:drag-end', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !dragSession) return;
    dragSession = undefined;
    if (settings.edgeSnap) {
      const point = screen.getCursorScreenPoint();
      const workArea = screen.getDisplayNearestPoint(point).workArea;
      petWindow.setBounds(snapBounds(petWindow.getBounds(), workArea), true);
      const state = stateForTrigger('window:edge-snap');
      sendActivity({ kind: 'edge-snap', stateId: state?.id, durationMs: 900 });
    }
  });
  ipcMain.handle('window:show-context-menu', (event) => {
    assertSender(event, ['pet']);
    if (petWindow) Menu.buildFromTemplate(buildPetMenu()).popup({ window: petWindow });
  });
  ipcMain.handle('window:show-reminder', (event) => { assertSender(event, ['pet', 'dashboard']); showReminderComposer(); });
  ipcMain.handle('window:show-dashboard', (event) => { assertSender(event, ['pet']); showDashboard(); });
  ipcMain.handle('window:hide-reminder', (event) => { assertSender(event, ['reminder']); reminderWindow?.hide(); });
  ipcMain.handle('window:hide-dashboard', (event) => { assertSender(event, ['dashboard']); dashboardWindow?.hide(); });
  ipcMain.handle('window:hide-pet', (event) => { assertSender(event, ['pet', 'dashboard']); petWindow?.hide(); });
  ipcMain.handle('walk:toggle', (event) => {
    assertSender(event, ['pet']);
    return toggleWalk();
  });
  ipcMain.handle('tips:random', (event) => {
    assertSender(event, ['pet', 'dashboard']);
    return randomTip();
  });
}

async function initialize(): Promise<void> {
  await verifySourceAssetGate();
  logger = new JsonLogger(userFile('logs/app.jsonl'));
  settings = await readValidatedJson(userFile('settings.json'), defaultSettings, parseSettings);
  reminders = await readValidatedJson(userFile('reminders.json'), [] as Reminder[], parseReminders);
  stats = await readValidatedJson(userFile('pet-stats.json'), defaultStats, parsePersistedStats);
  normalizeStatsDay();
  sessionStartedAt = Date.now();
  registerIpc();
  await logger.write('info', 'main-initializing', { platform: process.platform, arch: process.arch, version: spec.app.version, schemaVersion: spec.schemaVersion });
  createWindows();
  createTray();
  reminders.forEach(scheduleReminder);
  restartTypingListener();
  scheduleAutoWalk();
  scheduleAutoTip();
  scheduleDailyRhythm();
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (e2eMode) petWindow.showInactive();
    else {
      petWindow.show();
      petWindow.focus();
    }
  });
  app.whenReady().then(() => {
    if (e2eMode) app.dock?.hide();
    return initialize();
  }).catch((error) => { void fatalExit('initialize-failed', error); });
} else {
  app.exit(0);
}

app.on('window-all-closed', () => { /* tray app stays alive */ });
app.on('before-quit', (event) => {
  isQuitting = true;
  typingListener.stop();
  for (const timer of reminderTimers.values()) clearTimeout(timer);
  reminderTimers.clear();
  stopWalking('quit');
  if (autoWalkTimer) clearTimeout(autoWalkTimer);
  if (tipTimer) clearTimeout(tipTimer);
  if (dailyRhythmTimer) clearInterval(dailyRhythmTimer);
  if (quitPersisting || !stats) return;
  event.preventDefault();
  quitPersisting = true;
  void persistStats()
    .catch((error) => logger?.write('error', 'persist-stats-on-quit-failed', { message: error instanceof Error ? error.message : String(error) }))
    .finally(() => app.exit(0));
});
app.on('render-process-gone', (_event, webContents, details) => {
  if (isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') return;
  if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
    void fatalExit('render-process-gone', new Error(details.reason), { webContentsId: webContents.id, exitCode: details.exitCode });
  } else {
    void logger?.write('warn', 'render-process-gone', { webContentsId: webContents.id, reason: details.reason, exitCode: details.exitCode });
  }
});

process.on('uncaughtException', (error) => {
  void fatalExit('uncaught-exception', error, { stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  void fatalExit('unhandled-rejection', error, { stack: error.stack });
});
