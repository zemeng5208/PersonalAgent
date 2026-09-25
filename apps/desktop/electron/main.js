import {app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, safeStorage, screen, session, Tray} from 'electron';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {EventCursor} from '@personal-agent/client';
import {register, requestTaskCancellation} from './runtime.js';
import {panelBounds, clampOrb, draggedGroupBounds} from './placement.js';
import {Conversations} from './conversations.js';
import {createDesktopHost} from './desktop-host.js';
import {desktopDataPaths} from './data-paths.js';
import {createMicrophonePermissionGate} from './microphone-permission.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(dir, '../src/app/index.html');
const fakeMode = process.argv.includes('--fake-runtime');
const fakeModelMode = process.argv.includes('--fake-model') || process.env.PA_DESKTOP_MODEL_MODE === 'fake';
const runtimeProfile = process.env.PA_RUNTIME_PROFILE === undefined ? 'local' : process.env.PA_RUNTIME_PROFILE;
const agentArtsInvokeMode = process.env.PA_AGENTARTS_INVOKE_MODE === undefined
  ? 'published'
  : process.env.PA_AGENTARTS_INVOKE_MODE;
const competitionMode = !fakeMode && runtimeProfile === 'huawei_ict_agentarts';
if (fakeMode || fakeModelMode) app.setPath('userData', app.isPackaged
  ? path.join(app.getPath('temp'), `personal-agent-fake-${process.pid}`)
  : path.resolve(dir, '../.cache/user-data'));
if (process.env.PA_DESKTOP_EPHEMERAL_MODEL === '1') app.setPath('userData', app.isPackaged
  ? path.join(app.getPath('temp'), `personal-agent-test-${process.pid}`)
  : path.resolve(dir, `../.cache/test-user-data-${process.pid}`));
if (process.env.PA_DESKTOP_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.PA_DESKTOP_TEST_USER_DATA));
const dataPaths = desktopDataPaths({electronDir: dir, userData: app.getPath('userData'),
  packaged: app.isPackaged, fakeRuntime: fakeMode, fakeModel: fakeModelMode,
  ephemeral: process.env.PA_DESKTOP_EPHEMERAL_MODEL === '1',
  testUserData: Boolean(process.env.PA_DESKTOP_TEST_USER_DATA)});

const ownsDesktopInstance = app.requestSingleInstanceLock();
if (!ownsDesktopInstance) app.quit();

let runtime;
let desktopHost;
let runtimeConnection;
let client;
let eventCursor;
let eventPoll;
let eventBusy = false;
let orb;
let panel;
let admin;
let workspace;
let adminNavigation = {page: 'settings', revision: 0};
let tray;
let poll;
let pinned = false;
let dragging = false;
let dragOffset;
let panelDragOrigin;
let away = 0;
let audioLevel = 0;
let orbStateOverride = null;
let connectionLabel = '未连接 Runtime';
let runtimeError = '';
let capabilities = [];
let health = [];
const modelConfig = {
  baseUrl: process.env.PANGU_BASE_URL ?? '',
  model: process.env.PANGU_MODEL ?? 'pangu-nlp-n1-32k',
  deployment: process.env.PANGU_DEPLOYMENT ?? process.env.PANGU_MODEL ?? 'pangu-nlp-n1-32k',
  apiKey: process.env.PANGU_API_KEY ?? '',
};
const modelStorage = {persisted: false};
let model = {
  provider: 'pangu', label: '盘古大模型 2.0', status: 'unavailable', verification: 'conditional',
  baseUrl: modelConfig.baseUrl, model: modelConfig.model, deployment: modelConfig.deployment,
  configured: false, keyConfigured: Boolean(modelConfig.apiKey),
  capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false},
  persisted: false, enabled: false,
  reason: '盘古 Provider 已接入；请在“模型”页配置 Endpoint、模型和 API Key', lastTestAt: null, latencyMs: null,
};
if (competitionMode) {
  model = {
    ...model,
    provider: 'agentarts', label: 'AgentArts · Competition Profile', verification: 'unverified',
    baseUrl: '', model: 'AgentArts Runtime', deployment: process.env.PA_AGENTARTS_RUNTIME_NAME ?? '',
    keyConfigured: false,
    reason: 'Competition Runtime 尚未完成初始化；请检查可信主进程配置',
  };
}
let thinking = {depth: 1, fast: false, applied: false, reason: 'Runtime 尚未公开思考参数契约'};
const tasks = new Map();
const taskGoals = new Map();
let conversations;
const submitting = new Set();
const terminalTaskStates = new Set(['succeeded', 'failed', 'cancelled']);
const approvals = new Map();
const notifications = new Map();
let runtimeApplication;
let microphonePermissionGate;

function snapshot(surface) {
  return {
    connection: connectionLabel,
    connectionError: runtimeError,
    fakeModel: fakeModelMode,
    fake: fakeMode,
    pinned,
    adminNavigation: {...adminNavigation},
    audioLevel,
    orbStateOverride,
    tasks: [...tasks.values()].filter(task => !surface || conversations?.surface(task.taskId) === surface).map(task => ({...structuredClone(task), userMessage: taskGoals.get(task.taskId) ?? conversations?.goal(task.taskId)})),
    conversation: surface ?? 'all',
    capabilities: structuredClone(capabilities),
    health: structuredClone(health),
    approvals: [...approvals.values()],
    notifications: [...notifications.values()],
    model: structuredClone(model),
    thinking: structuredClone(thinking),
    voice: {available: false, status: 'unavailable', reason: '语音供应商尚未连接'},
  };
}

function publish() {
  for (const win of [orb, panel, admin, workspace]) {
    if (win && !win.isDestroyed()) win.webContents.send('desktop:update', snapshot(win === workspace ? 'workspace' : win === admin ? undefined : 'panel'));
  }
}

function windowFor(mode, bounds, options = {}) {
  const win = new BrowserWindow({...desktopHost.restore(mode, bounds), show: false, backgroundColor: '#00000000',
    webPreferences: {preload: path.join(dir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true}, ...options});
  win.setMenuBarVisibility(false);
  desktopHost.attach(win, mode);
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', event => event.preventDefault());
  let presented = false;
  const present = () => {
    if (presented || win.isDestroyed()) return;
    presented = true;
    if (['panel','admin','workspace'].includes(mode)) applyShape(win, mode === 'panel' ? 20 : 12);
    if (mode !== 'panel') win.show();
    publish();
  };
  // Applying a restored zoom during did-finish-load can prevent Electron from
  // emitting ready-to-show.  Loaded local pages are already safe to present,
  // so either lifecycle event may complete the one-shot presentation.
  win.webContents.once('did-finish-load', present);
  win.once('ready-to-show', present);
  win.loadFile(entry, {query: {mode}});
  return win;
}

/* roundedCorners 不会裁切透明窗口的实际区域，用窗口区域把整窗裁成圆角。 */
function roundedRects(width, height, radius) {
  const r = Math.min(radius, Math.floor(width / 2), Math.floor(height / 2));
  if (r <= 0) return [{x:0,y:0,width,height}];
  const rects = [
    {x: 0, y: r, width, height: height - 2 * r},
    {x: r, y: 0, width: width - 2 * r, height: r},
    {x: r, y: height - r, width: width - 2 * r, height: r},
  ];
  for (let y = 0; y < r; y += 1) {
    const dx = Math.round(r - Math.sqrt(Math.max(0, r * r - (y - r) * (y - r))));
    const bottom = height - y - 1;
    rects.push({x: dx, y, width: r - dx, height: 1}, {x: width - r, y, width: r - dx, height: 1});
    rects.push({x: dx, y: bottom, width: r - dx, height: 1}, {x: width - r, y: bottom, width: r - dx, height: 1});
  }
  return rects;
}

function applyShape(win, radius) {
  const bounds = win.getBounds();
  win.setShape(roundedRects(bounds.width, bounds.height, radius));
}

function openPanel(focus = false) {
  if (!orb || !panel || orb.isDestroyed() || panel.isDestroyed()) return;
  if (!focus && workspace && !workspace.isDestroyed() && workspace.isVisible()) return;
  panel.setBounds(panelBounds(orb.getBounds(), screen.getDisplayMatching(orb.getBounds()).workArea));
  applyShape(panel, 20);
  if (focus) panel.show(); else panel.showInactive();
  away = 0;
}

function movePanelGroup(point) {
  if (!panelDragOrigin || !orb || !panel) return;
  const area = screen.getDisplayNearestPoint(point).workArea;
  const next = draggedGroupBounds(panelDragOrigin.orb, panelDragOrigin.pointer, point, area);
  // On Windows, setBounds() can expand a frameless non-resizable window to the
  // native minimum tracking size, leaving an invisible click-blocking area.
  // Dragging the orb must only change its position and preserve 112x112.
  orb.setPosition(next.orb.x, next.orb.y);
  panel.setBounds(next.panel);
  applyShape(panel, 20);
}

function openAdmin(page) {
  if (page && ['settings','profile','models','tasks','capabilities','authorizations','git','connections'].includes(page)) {
    adminNavigation = {page, revision:adminNavigation.revision + 1};
  }
  if (admin && !admin.isDestroyed()) { admin.show(); admin.focus(); publish(); return; }
  const area = screen.getDisplayMatching(orb.getBounds()).workArea;
  admin = windowFor('admin', {width: Math.min(1120, area.width), height: Math.min(760, area.height)},
    {title: 'PersonalAgent · 管理后台', frame: false, transparent: true, backgroundMaterial: 'none', roundedCorners: true, minWidth: 600, minHeight: 400});
  admin.once('ready-to-show', () => applyShape(admin, 12));
  admin.on('resize', () => applyShape(admin, 12));
  admin.on('closed', () => { admin = undefined; });
}

function createTray() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#090c10" stroke="#52c7bd" stroke-width="2"/><circle cx="16" cy="16" r="3" fill="#fff"/><circle cx="9" cy="11" r="1" fill="#fff"/><circle cx="23" cy="11" r="1" fill="#fff"/><circle cx="9" cy="21" r="1" fill="#fff"/><circle cx="23" cy="21" r="1" fill="#fff"/></svg>';
  try {
    tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`));
    tray.setToolTip('PersonalAgent');
    tray.setContextMenu(Menu.buildFromTemplate([
      {label: '打开悬浮面板', click: () => { pinned = true; openPanel(true); publish(); }},
      {label: '打开管理后台', click: () => openAdmin()},
      {label: '桌面设置与恢复', click: () => desktopHost.openSettings()},
      {type: 'separator'},
      {label: '退出 PersonalAgent', click: () => app.quit()},
    ]));
    tray.on('click', () => {
      if (panel?.isVisible()) { pinned = false; panel.hide(); publish(); }
      else { pinned = true; openPanel(true); publish(); }
    });
  } catch (error) {
    runtimeError = `托盘初始化失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
}

function requiredModelText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${name} 不能为空`);
  return value.trim();
}

function modelEndpoint(value) {
  const baseUrl = requiredModelText(value, '模型 Endpoint');
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw Error('模型 Endpoint 必须是有效的 http(s) 地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Error('模型 Endpoint 只允许使用 http 或 https');
  return baseUrl.replace(/\/+$/, '');
}

function modelConfigPath() {
  return path.join(app.getPath('userData'), 'pangu-config.json');
}

function persistModelConfig() {
  if (process.env.PA_DESKTOP_EPHEMERAL_MODEL === '1') return {saved: false, reason: '联调测试模式不写入模型配置'};
  if (!safeStorage.isEncryptionAvailable()) {
    throw Error('系统加密存储不可用，无法安全保存 API Key；本次配置未写入磁盘');
  }
  const target = modelConfigPath();
  mkdirSync(path.dirname(target), {recursive: true});
  const temporary = `${target}.tmp-${process.pid}`;
  const payload = {
    version: 2,
    baseUrl: modelConfig.baseUrl,
    model: modelConfig.model,
    deployment: modelConfig.deployment,
    enabled: model.enabled,
    apiKey: safeStorage.encryptString(modelConfig.apiKey).toString('base64'),
  };
  writeFileSync(temporary, JSON.stringify(payload), {encoding: 'utf8'});
  renameSync(temporary, target);
  modelStorage.persisted = true;
  return {saved: true, reason: '配置已保存到本机加密存储'};
}

function restoreModelConfig() {
  if (process.env.PA_DESKTOP_EPHEMERAL_MODEL === '1') return;
  const target = modelConfigPath();
  if (!existsSync(target) || !safeStorage.isEncryptionAvailable()) return;
  try {
    const payload = JSON.parse(readFileSync(target, 'utf8'));
    if (![1, 2].includes(payload?.version) || typeof payload.apiKey !== 'string') return;
    const restoredKey = safeStorage.decryptString(Buffer.from(payload.apiKey, 'base64'));
    if (!modelConfig.baseUrl && typeof payload.baseUrl === 'string') modelConfig.baseUrl = payload.baseUrl;
    if (!process.env.PANGU_MODEL && typeof payload.model === 'string') modelConfig.model = payload.model;
    if (!process.env.PANGU_DEPLOYMENT && typeof payload.deployment === 'string') modelConfig.deployment = payload.deployment;
    if (!modelConfig.apiKey) modelConfig.apiKey = restoredKey;
    model.enabled = payload.enabled !== false;
    modelStorage.persisted = true;
  } catch {
    model = {...model, reason: '已找到保存的模型配置，但无法解密；请重新输入 API Key'};
  }
}

function runtimeTextOptions(state = model, config = modelConfig) {
  if (state.enabled === false) return {mode: 'unavailable', model: config.model};
  if (state.provider === 'fake') return {mode: 'fake'};
  if (state.configured && config.baseUrl && config.apiKey) {
    return {
      mode: 'pangu', baseUrl: config.baseUrl, model: config.model,
      deployment: config.deployment, apiKey: () => modelConfig.apiKey,
    };
  }
  return {mode: 'unavailable', model: config.model};
}

async function configurePangu(input, {publishState = true, persist = true} = {}) {
  const baseUrl = modelEndpoint(input?.baseUrl);
  const modelName = requiredModelText(input?.model, '模型名称');
  const deployment = requiredModelText(input?.deployment || modelName, '部署名称');
  const apiKey = typeof input?.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : modelConfig.apiKey;
  if (!apiKey) throw Error('API Key 未配置；密钥只会保留在主进程内存中');
  const previousConfig = {...modelConfig};
  const previousModel = model;
  modelConfig.baseUrl = baseUrl;
  modelConfig.model = modelName;
  modelConfig.deployment = deployment;
  modelConfig.apiKey = apiKey;
  let storage = {saved: modelStorage.persisted, reason: modelStorage.persisted ? '配置已从本机加密存储恢复' : '配置仅保留在本次运行'};
  try {
    const configuredDeployment = runtimeApplication.configureText(runtimeTextOptions({provider: 'pangu', configured: true, enabled: true}, modelConfig));
    model = {
      ...model,
      provider: 'pangu', label: '盘古大模型 2.0', status: 'configured', verification: configuredDeployment.verification,
      baseUrl, model: modelName, deployment, configured: true, keyConfigured: true, enabled: true,
      capabilities: structuredClone(configuredDeployment.capabilities),
    };
    if (persist) storage = persistModelConfig();
  } catch (error) {
    Object.assign(modelConfig, previousConfig);
    model = previousModel;
    try { runtimeApplication.configureText(runtimeTextOptions(previousModel, previousConfig)); } catch {}
    throw error;
  }
  model = {
    ...model,
    persisted: storage.saved,
    reason: `${storage.reason}，尚未发起真实连接测试`, lastTestAt: null, latencyMs: null,
  };
  if (publishState) publish();
  return structuredClone(model);
}

async function testPangu() {
  if (!runtimeApplication || runtimeApplication.deployment.provider !== 'pangu') throw Error('请先保存盘古模型配置');
  if (model.enabled === false) throw Error('模型已停用，请先启用');
  const controller = new AbortController();
  const started = Date.now();
  try {
    const result = await runtimeApplication.testTextConnection({signal: controller.signal});
    const latencyMs = Number.isFinite(result.latencyMs) ? result.latencyMs : Date.now() - started;
    model = {...model, status: 'ready', reason: `连接测试通过 · ${latencyMs}ms`, lastTestAt: new Date().toISOString(), latencyMs};
    publish();
    return structuredClone(model);
  } catch (error) {
    model = {...model, status: 'error', reason: error instanceof Error ? error.message : '盘古连接测试失败', lastTestAt: new Date().toISOString(), latencyMs: null};
    publish();
    throw error;
  }
}

function openWorkspace() {
  pinned = false;
  panel?.hide();
  if (workspace && !workspace.isDestroyed()) { workspace.show(); workspace.focus(); publish(); return; }
  const area = screen.getDisplayMatching(orb.getBounds()).workArea;
  const width = Math.min(1280, area.width - 32), height = Math.min(820, area.height - 32);
  workspace = windowFor('workspace', {width, height, x: area.x + Math.round((area.width-width)/2), y: area.y + Math.round((area.height-height)/2)},
    {title: 'PersonalAgent · 工作区', frame: false, transparent: true, backgroundMaterial: 'none', roundedCorners: true, minWidth: Math.min(760,width), minHeight: Math.min(540,height)});
  workspace.once('ready-to-show', () => { applyShape(workspace, 12); workspace.focus(); });
  workspace.on('resize', () => applyShape(workspace, workspace.isMaximized() ? 0 : 12));
  workspace.on('closed', () => { workspace = undefined; });
}

function toggleModel(input) {
  if (!model.configured) throw Error('请先保存模型配置');
  const enabled = Boolean(input?.enabled);
  if (enabled === (model.enabled !== false)) return structuredClone(model);
  const previous = model;
  const next = {...model, enabled, status: enabled ? 'configured' : 'disabled', reason: enabled ? '模型已启用，请重新测试真实连接' : '模型已停用，不会用于新任务'};
  try {
    runtimeApplication.configureText(runtimeTextOptions(next));
    model = next;
    if (model.provider !== 'fake') persistModelConfig();
  } catch (error) {
    model = previous;
    try { runtimeApplication.configureText(runtimeTextOptions(previous)); } catch {}
    throw error;
  }
  publish();
  return structuredClone(model);
}

function updateThinking(input) {
  const depth = Number(input?.depth);
  if (!Number.isInteger(depth) || depth < 0 || depth > 5) throw Error('思考深度必须是 0 到 5');
  thinking = {depth, fast: Boolean(input?.fast), applied: false, reason: '已保存桌面测试设置，等待 Runtime 思考参数契约'};
  publish();
  return structuredClone(thinking);
}

async function initializeModelFromEnvironment() {
  if (competitionMode) {
    model = {
      ...model,
      provider: 'agentarts',
      label: 'AgentArts · Competition Profile',
      status: 'configured',
      verification: 'unverified',
      baseUrl: process.env.PA_AGENTARTS_GATEWAY_URL ?? '',
      model: 'AgentArts Runtime',
      deployment: process.env.PA_AGENTARTS_RUNTIME_NAME ?? '',
      configured: true,
      keyConfigured: Boolean(process.env.PA_AGENTARTS_AUTHORIZATION),
      persisted: false,
      enabled: true,
      capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false},
      reason: 'Competition Profile 已装配；云端结果仍需真实调用和本地读回验证',
      lastTestAt: null,
      latencyMs: null,
    };
    return;
  }
  if (fakeModelMode) {
    runtimeApplication.configureText({mode: 'fake'});
    model = {
      ...model,
      provider: 'fake', label: 'Fake Model · 离线测试', status: 'ready', verification: 'mock',
      configured: true, keyConfigured: false, persisted: false, enabled: true,
      capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false},
      reason: '显式 Fake Model 模式；不会调用真实 AI 或网络服务', lastTestAt: null, latencyMs: 0,
    };
    return;
  }
  if (!modelConfig.baseUrl || !modelConfig.apiKey) return;
  const shouldEnable = !modelStorage.persisted || model.enabled !== false;
  try {
    await configurePangu(modelConfig, {publishState: false, persist: false});
    if (!shouldEnable) {
      model = {...model, enabled: false, status: 'disabled', reason: '模型已停用，不会用于新任务'};
      runtimeApplication.configureText(runtimeTextOptions(model));
    }
  } catch (error) {
    model = {...model, status: 'error', reason: error instanceof Error ? error.message : '盘古配置无效'};
  }
}

async function refresh(taskId) {
  const task = await client.call('task.get', {taskId});
  tasks.set(taskId, task);
  clearInactiveTaskExitWarning();
  publish();
  return task;
}

function clearInactiveTaskExitWarning() {
  if (runtimeError === 'Runtime 仍有活动任务；请先等待完成或停止任务后再退出'
    && [...tasks.values()].every(task => terminalTaskStates.has(task.state))) {
    runtimeError = '';
  }
}

function applyEvent(event) {
  if (event.type === 'notification.created' && event.payload) notifications.set(event.payload.notificationId, {...event.payload,occurredAt:event.occurredAt});
  if (event.taskId && event.payload && ['task.created', 'task.state_changed', 'task.completed', 'task.failed', 'task.cancelled'].includes(event.type)) {
    tasks.set(event.taskId, structuredClone(event.payload));
    clearInactiveTaskExitWarning();
  }
  if (event.type === 'approval.requested' && event.payload) approvals.set(event.payload.approvalId, structuredClone(event.payload));
  if (event.type === 'task.cancelled' && event.payload?.taskId) {
    for (const [id, approval] of approvals) if (approval.taskId === event.payload.taskId) approvals.delete(id);
  }
}

async function pumpEvents() {
  if (eventBusy || !client || !runtimeConnection?.readEvents || !eventCursor) return;
  eventBusy = true;
  try {
    const afterSequence = eventCursor.afterSequence;
    await client.call('event.subscribe', {streamId: 'tasks', afterSequence});
    const events = await runtimeConnection.readEvents(afterSequence);
    const accepted = eventCursor.accept(events);
    for (const event of accepted) {
      applyEvent(event);
      if (event.type === 'approval.requested') {
        const result = await client.call('approval.list', {approvalId: event.payload.approvalId, limit: 1});
        if (result.items[0]) approvals.set(event.payload.approvalId, structuredClone(result.items[0]));
      }
    }
    if (accepted.length) publish();
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : '事件流读取失败';
    publish();
  } finally {
    eventBusy = false;
  }
}

async function syncCapabilities() {
  try {
    const result = await client.call('capability.list', {});
    capabilities = result.manifests ?? [];
    health = result.health ?? [];
  } catch (error) {
    capabilities = [];
    health = [];
    if (error?.code !== 'UNSUPPORTED_CAPABILITY') runtimeError = error instanceof Error ? error.message : '能力目录读取失败';
  }
}

async function syncRuntimeSnapshots() {
  tasks.clear(); approvals.clear();
  let beforeSequence;
  let snapshotSequence;
  do {
    const page = await client.call('task.list', {limit: 100, ...(beforeSequence ? {beforeSequence} : {}), ...(snapshotSequence === undefined ? {} : {snapshotSequence})});
    snapshotSequence = page.snapshotSequence;
    for (const task of page.items) { tasks.set(task.taskId, structuredClone(task)); if (task.goal) taskGoals.set(task.taskId, task.goal); }
    beforeSequence = page.nextBeforeSequence;
  } while (beforeSequence);
  const pending = await client.call('approval.list', {state: 'pending', limit: 100});
  for (const approval of pending.items) approvals.set(approval.approvalId, structuredClone(approval));
  eventCursor.reset(snapshotSequence ?? 0);
}

async function initializeRuntime() {
  const runtimeModule = await import('@personal-agent/runtime/application');
  const {createRuntimeApplication} = runtimeModule;
  let readEvents;
  if (!['local', 'huawei_ict_agentarts'].includes(runtimeProfile)) {
    throw Error('PA_RUNTIME_PROFILE 只允许 local 或 huawei_ict_agentarts');
  }
  if (!fakeMode && fakeModelMode && runtimeProfile === 'huawei_ict_agentarts') {
    throw Error('Competition Profile 不能与 fake-model 同时启用；不会静默切换到 Local 或真实云端');
  }
  if (fakeMode) {
    const {FakeRuntime} = await import('@personal-agent/testkit');
    runtime = new FakeRuntime({mode: 'test', scenario: 'success'});
    runtimeApplication = createRuntimeApplication({
      path: dataPaths.runtime,
      text: {mode: 'unavailable', model: modelConfig.model},
    });
    readEvents = after => runtime.readEvents('tasks', after);
  } else {
    const dbPath = dataPaths.runtime;
    mkdirSync(path.dirname(dbPath), {recursive: true});
    if (competitionMode) {
      if (!process.env.PA_AGENTARTS_AUTHORIZATION) {
        throw Error('PA_AGENTARTS_AUTHORIZATION 未配置；Competition Runtime 不会启动');
      }
      runtimeApplication = runtimeModule.createAgentArtsRuntimeApplication({
        path: dbPath,
        gatewayUrl: process.env.PA_AGENTARTS_GATEWAY_URL ?? '',
        runtimeName: process.env.PA_AGENTARTS_RUNTIME_NAME ?? '',
        invokeMode: agentArtsInvokeMode,
        authorizationProvider: {
          read: async () => {
            const authorization = process.env.PA_AGENTARTS_AUTHORIZATION;
            if (!authorization) throw Error('AgentArts authorization is unavailable');
            return authorization;
          },
        },
      });
    } else {
      const createApplication = process.argv.includes('--weather-tools')
        ? (await import('@personal-agent/runtime/weather')).createOpenMeteoApplication
        : createRuntimeApplication;
      runtimeApplication = createApplication({
        path: dbPath,
        text: {mode: 'unavailable', model: modelConfig.model},
      });
    }
    runtime = runtimeApplication.runtime;
    readEvents = after => runtimeApplication.readEvents(after);
  }
  runtimeConnection = await register({
    transport: fakeMode ? runtime : runtimeApplication,
    now: () => fakeMode ? runtime.clock.now() : Date.now(),
    readEvents,
    attachClient: value => { client = value; return () => { client = undefined; }; },
  });
  client = runtimeConnection.client;
  connectionLabel = fakeMode
    ? 'Fake Runtime · 联调模式'
    : competitionMode ? '本地 Runtime · AgentArts Competition' : '本地 Runtime · 已连接';
  eventCursor = new EventCursor('tasks');
  await syncCapabilities();
  await syncRuntimeSnapshots();
  await pumpEvents();
  eventPoll = setInterval(() => void pumpEvents(), 120);
}

async function action(event, name, payload) {
  const sender = [orb, panel, admin, workspace].find(win => win && !win.isDestroyed() && win.webContents === event.sender);
  if (!sender || event.senderFrame !== sender.webContents.mainFrame) throw Error('Untrusted sender');
  if (competitionMode && ['model.configure', 'model.test', 'model.toggle'].includes(name)) {
    throw Error('Competition Profile 的 AgentArts 配置只允许由可信主进程提供；盘古配置操作不可用');
  }
  if (name === 'snapshot') return snapshot(sender === workspace ? 'workspace' : sender === admin ? undefined : 'panel');
  if (name === 'admin.open') { openAdmin(payload?.page); return; }
  if (name === 'workspace.open' && sender === panel) { openWorkspace(); return; }
  if (name === 'workspace.close' && sender === workspace) { workspace.close(); return; }
  if (name === 'workspace.minimize' && sender === workspace) { workspace.minimize(); return; }
  if (name === 'workspace.maximize' && sender === workspace) { if(workspace.isMaximized()) workspace.unmaximize(); else workspace.maximize(); return; }
  if (name === 'admin.close') {
    if (sender !== admin) throw Error('Untrusted sender');
    admin.close(); return;
  }
  if (name === 'panel.pin' && sender === panel) { pinned = Boolean(payload); publish(); return; }
  if (name === 'panel.hide' && sender === panel) { pinned = false; panel.hide(); publish(); return; }
  if (name === 'orb.open' && sender === orb) { pinned = true; openPanel(true); publish(); return; }
  if (name === 'orb.dragStart' && sender === orb) {
    dragging = true; panel.hide(); const point = screen.getCursorScreenPoint(); const bounds = orb.getBounds();
    dragOffset = {x: point.x - bounds.x, y: point.y - bounds.y}; return;
  }
  if (name === 'orb.dragEnd' && sender === orb) { dragging = false; desktopHost.snap(orb); away = Date.now() + 400; return; }
  if (name === 'panel.dragStart' && sender === panel) {
    if (!payload || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) throw Error('拖动坐标无效');
    dragging = 'panel';
    panelDragOrigin = {pointer: {x: payload.x, y: payload.y}, orb: orb.getBounds()};
    return;
  }
  if (name === 'panel.dragMove' && sender === panel && dragging === 'panel') {
    if (!payload || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) throw Error('拖动坐标无效');
    movePanelGroup(payload);
    return;
  }
  if (name === 'panel.dragEnd' && sender === panel) { dragging = false; panelDragOrigin = undefined; away = Date.now() + 400; return; }
  if (name === 'app.quit') { app.quit(); return; }
  if (name === 'voice.stop') {
    if (sender !== panel) throw Error('语音操作只能从面板调用');
    return {available: false, stopped: false, reason: '语音供应商尚未连接'};
  }
  if (name === 'clipboard.writeText') {
    if ((sender !== panel && sender !== workspace) || typeof payload !== 'string' || payload.length > 50000) throw Error('剪贴板内容无效');
    clipboard.writeText(payload);
    return {copied: true};
  }
  if (name === 'model.configure') {
    if (sender !== admin) throw Error('模型配置只能从管理后台调用');
    return configurePangu(payload);
  }
  if (name === 'model.test') {
    if (sender !== admin) throw Error('模型测试只能从管理后台调用');
    return testPangu();
  }
  if (name === 'model.toggle') {
    if (sender !== admin) throw Error('模型启停只能从管理后台调用');
    return toggleModel(payload);
  }
  if (name === 'thinking.update') {
    if (sender !== panel && sender !== admin && sender !== workspace) throw Error('思考设置来源不受信任');
    return updateThinking(payload);
  }
  if (sender === orb) throw Error('Action unavailable from orb');
  if (!client) throw Error('Runtime 未连接，此操作尚不可用');
  if (name === 'task.submit') {
    if (sender !== panel && sender !== workspace) throw Error('请在对话工作区发送消息');
    if (typeof payload !== 'string' || !payload.trim()) throw Error('请输入有效任务');
    if (!fakeMode && model.enabled === false) throw Error('模型已停用，请先在模型设置中启用');
    const surface = sender === workspace ? 'workspace' : 'panel';
    if (submitting.has(surface) || [...tasks.values()].some(task => conversations.surface(task.taskId) === surface && !terminalTaskStates.has(task.state))) throw Error('请等待当前回答完成，或先停止当前任务');
    submitting.add(surface);
    try {
    const goal = payload.trim();
    const result = await client.call('task.submit', {goal, conversationId: `desktop-${surface}`}, {idempotencyKey: crypto.randomUUID()});
    conversations.add(result.taskId, surface, goal);
    taskGoals.set(result.taskId, goal);
    if (sender === panel) pinned = true;
    const task = await refresh(result.taskId);
    return task;
    } finally { submitting.delete(surface); }
  }
  if (name === 'task.cancel') {
    if (typeof payload !== 'string' || !tasks.has(payload)) throw Error('Unknown task');
    if (sender !== admin && conversations.surface(payload) !== (sender === workspace ? 'workspace' : 'panel')) throw Error('无法停止其他工作区的任务');
    return requestTaskCancellation(client, payload, refresh);
  }
  if (name === 'task.refresh') {
    if (!tasks.has(payload)) throw Error('Unknown task');
    if (sender !== admin && conversations.surface(payload) !== (sender === workspace ? 'workspace' : 'panel')) throw Error('无法读取其他工作区的任务');
    return refresh(payload);
  }
  if (name === 'capability.list') { await syncCapabilities(); publish(); return {manifests: capabilities, health}; }
  if (name === 'settings.get') return client.call('settings.get', {namespace: String(payload ?? 'desktop')});
  if (name === 'settings.update') return client.call('settings.update', payload);
  if (name === 'authorization.respond') {
    if (!payload || typeof payload.approvalId !== 'string' || !['allow_once', 'deny'].includes(payload.decision) || !Number.isSafeInteger(payload.expectedRevision)) throw Error('授权决定格式无效');
    const result = await client.call('authorization.respond', {approvalId: payload.approvalId, decision: payload.decision, expectedRevision: payload.expectedRevision});
    approvals.delete(payload.approvalId);
    if (payload.taskId && tasks.has(payload.taskId)) await refresh(payload.taskId);
    publish();
    return result;
  }
  if (name === 'test.advance' && fakeMode) {
    if (!tasks.has(payload)) throw Error('Unknown task');
    runtime.advance(payload); await pumpEvents(); return refresh(payload);
  }
  if (name === 'test.orbLevel' && fakeMode) {
    audioLevel = Math.max(0, Math.min(1, Number(payload) || 0)); publish(); return audioLevel;
  }
  if (name === 'test.orbState' && fakeMode) {
    const valid = ['idle', 'listening', 'thinking', 'executing', 'waiting', 'error'];
    orbStateOverride = payload === null ? null : valid.includes(payload) ? payload : null;
    publish(); return orbStateOverride;
  }
  throw Error('Unsupported action');
}

app.on('second-instance', () => {
  if (desktopHost && orb && panel && !orb.isDestroyed() && !panel.isDestroyed()) { pinned = true; openPanel(true); publish(); }
});

app.whenReady().then(async () => {
  if (!ownsDesktopInstance) return;
  desktopHost = createDesktopHost();
  microphonePermissionGate = createMicrophonePermissionGate({
    expectedPageUrl: pathToFileURL(entry).href,
    isTrustedWindow: contents => contents === panel?.webContents,
  });
  session.defaultSession.setPermissionRequestHandler(microphonePermissionGate.request);
  session.defaultSession.setPermissionCheckHandler(microphonePermissionGate.check);
  try {
    conversations = new Conversations(dataPaths.conversations);
    if (!competitionMode) restoreModelConfig();
    await initializeRuntime();
    await initializeModelFromEnvironment();
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : 'Runtime 初始化失败';
    connectionLabel = 'Runtime 未连接';
  }

  const area = screen.getPrimaryDisplay().workArea;
  orb = windowFor('orb', {x: area.x + area.width - 150, y: area.y + area.height - 180, width: 112, height: 112},
    {frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false});
  panel = windowFor('panel', panelBounds(orb.getBounds(), area),
    {frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false, backgroundMaterial: 'none', roundedCorners: true});
  panel.on('close', event => { if (!app.isQuitting) { event.preventDefault(); pinned = false; panel.hide(); publish(); } });
  createTray();

  ipcMain.handle('desktop:action', async (...args) => {
    try { return {ok: true, value: await action(...args)}; }
    catch (error) { return {ok: false, error: error instanceof Error ? error.message : '操作失败'}; }
  });

  function reposition() {
    orb.setBounds(clampOrb(orb.getBounds(), screen.getDisplayMatching(orb.getBounds()).workArea));
    if (panel.isVisible()) openPanel();
  }
  screen.on('display-removed', reposition);
  screen.on('display-metrics-changed', reposition);
  poll = setInterval(() => {
    if (orb.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const bounds = orb.getBounds();
    if (dragging === true) {
      orb.setBounds(clampOrb({...bounds, x: point.x - dragOffset.x, y: point.y - dragOffset.y}, screen.getDisplayNearestPoint(point).workArea));
      return;
    }
    if (away > Date.now()) return;
    const near = Math.hypot(point.x - bounds.x - bounds.width / 2, point.y - bounds.y - bounds.height / 2) <= 90;
    const panelBoundsValue = panel.getBounds();
    const inside = panel.isVisible() && point.x >= panelBoundsValue.x && point.x <= panelBoundsValue.x + panelBoundsValue.width && point.y >= panelBoundsValue.y && point.y <= panelBoundsValue.y + panelBoundsValue.height;
    if ((near && desktopHost.settings.hover) || inside || pinned) { away = 0; if (near && desktopHost.settings.hover && !panel.isVisible()) openPanel(); }
    else if (panel.isVisible()) { if (!away) away = Date.now(); else if (Date.now() - away > 520) { panel.hide(); away = 0; } }
  }, 80);
  app.on('before-quit', event => {
    if ((runtimeApplication?.activeTaskCount ?? 0) > 0) {
      event.preventDefault();
      app.isQuitting = false;
      runtimeError = 'Runtime 仍有活动任务；请先等待完成或停止任务后再退出';
      publish();
      return;
    }
    app.isQuitting = true;
    microphonePermissionGate?.revoke();
    clearInterval(poll);
    clearInterval(eventPoll);
    tray?.destroy();
    runtimeConnection?.dispose?.();
    try {
      if (runtimeApplication) runtimeApplication.close();
      else runtime?.close?.();
    } catch (error) {
      event.preventDefault();
      runtimeError = error instanceof Error ? error.message : 'Runtime 仍有活动任务，无法安全退出';
      publish();
    }
  });
  app.on('window-all-closed', event => event.preventDefault());
}).catch(error => { console.error(error); app.exit(1); });
