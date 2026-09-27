import {app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, session, Tray} from 'electron';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {EventCursor} from '@personal-agent/client';
import {register, requestTaskCancellation, submitConversationTask} from './runtime.js';
import {panelBounds, clampOrb, draggedGroupBounds} from './placement.js';
import {Conversations} from './conversations.js';
import {createDesktopHost} from './desktop-host.js';
import {desktopDataPaths} from './data-paths.js';
import {restoreSyntheticRepairSubmission} from './competition-repair-submission.js';
import {readCapabilityDirectory} from './capability-directory.js';
import {createMicrophonePermissionGate} from './microphone-permission.js';
import {readApprovalPage} from './approval-history.js';
import {createMicrophoneCaptureHost} from './microphone-capture-host.js';
import {createDesktopEvidenceHost} from './evidence-host.js';
import {createDesktopCompetitionFactBridge} from './competition-fact-bridge.js';
import {createDesktopSisPlaybackHost} from './huawei-sis-playback.js';
import {createDesktopSisConfigHost} from './huawei-sis-config.js';
import {acquireHuaweiSisToken} from './huawei-iam-login.js';
import {createLiveVoiceConfig} from './live-voice-config.js';
import {createLiveVoiceHost} from './live-voice-host.js';
import {createDesktopProactiveHost} from './proactive-host.js';
import {createPublicConnectorHost} from './public-connector-host.js';
import {createWorkspaceConfigHost} from './workspace-config-host.js';
import {createWorkspaceCommandRecipeTool} from './workspace-command-recipes.js';
import {createAgentArtsConfig} from './agentarts-config.js';
import {createDeferredRuntimeStartup} from './runtime-startup.js';
import {createMailConfig} from './mail-config.js';
import {createDesktopMailAnalysisHost} from './mail-analysis-host.js';
import {createDesktopFeedsHost} from './feeds-host.js';
import {createDesktopNotepadHost} from './notepad-host.js';
import {createDesktopTodoHost} from './todo-host.js';
import {createDesktopGoalCloudHost} from './goal-cloud-host.js';
import {createMailMetadataStorage} from './mail-metadata-storage.js';
import {createLocalLayaHost} from './laya-local-host.js';
import {resultText} from '../src/features/conversation/result-text.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(dir, '../src/app/index.html');
const fakeMode = process.argv.includes('--fake-runtime');
const fakeModelMode = process.argv.includes('--fake-model') || process.env.PA_DESKTOP_MODEL_MODE === 'fake';
const runtimeProfile = process.env.PA_RUNTIME_PROFILE === undefined ? 'local' : process.env.PA_RUNTIME_PROFILE;
const agentArtsInvokeMode = process.env.PA_AGENTARTS_INVOKE_MODE === undefined
  ? 'published'
  : process.env.PA_AGENTARTS_INVOKE_MODE;
const competitionMode = !fakeMode && runtimeProfile === 'huawei_ict_agentarts';
const syntheticMvp = process.env.PA_DESKTOP_SYNTHETIC_MVP === '1';
const syntheticFactSource = process.env.PA_DESKTOP_SYNTHETIC_FACT_SOURCE === '1';
const agentArtsResponseMode = process.env.PA_AGENTARTS_RESPONSE_MODE;
const repairCandidateVersion = process.env.PA_AGENTARTS_REPAIR_CANDIDATE_VERSION;
const layaPort = process.env.PA_DESKTOP_LAYA_PORT;
const layaKey = process.env.PA_DESKTOP_LAYA_API_KEY;
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
let voiceConfigurationPending = false;
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
let capabilityDirectory = {state: 'loading', reason: '正在读取 Runtime 能力目录'};
let capabilityReadRevision = 0;
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
let syntheticRepairHost;
const repairPrompts = new Set();
let microphonePermissionGate;
let microphoneCaptureHost;
let voicePcmSource;
let voiceInput;
let sisPlaybackHost;
let sisConfigHost;
let liveConfig;
let agentArtsConfig;
let activeCloudBinding;
const runtimeStartup = createDeferredRuntimeStartup({
  isConfigured: () => !competitionMode || agentArtsConfig?.snapshot().runtimeReady === true,
  initialize: initializeProductServices,
});
let liveVoice;
let liveShortcut = {key: 'F8', registered: false, reason: ''};
let lastLiveShortcutAt = 0;
let voiceInitializationFailure = null;
let voiceDisposed = false;
let voiceDisposal;
let voiceDisposalFailed = false;
let goalHost;
let goalCloudHost;
let competitionCatalog;
let competitionFactBridge;
let proactiveHost;
let productTools;
let codingWorkspace;
let mailConfig;
let feedsHost;
let todoHost;
let todoFailure = '';
let todoClosing;
let todoClosed = false;
let notepadHost;
let notepadClosing;
let notepadClosed = false;
let mailHost;
let mailAnalysisHost;
let mailFailure = '';
let localLaya;
let localServicesStopping = false;
let localServicesStopped = false;
let nextMailRefresh = 0;

function mailSnapshot() {
  const config = mailConfig?.snapshot() ?? {configured:false, status:'unconfigured', sessionAllowed:false};
  const host = mailHost?.snapshot();
  return {...host, ...config, status:host?.status === 'stop_unconfirmed' ? 'stop_unconfirmed'
    : mailFailure ? 'unavailable' : config.sessionAllowed ? host?.status ?? config.status : config.status,
    counts:host?.counts, analyses:mailAnalysisHost?.snapshot(), localModelReady:localLaya?.snapshot().ready === true,
    reason:host?.status === 'stop_unconfirmed' ? '已撤销新读取；现有邮箱连接退出尚未确认'
      : mailFailure || (config.sessionAllowed ? host?.reason ?? config.reason : config.reason)};
}

async function refreshMail() {
  if (!mailHost || Date.now() < nextMailRefresh) return;
  nextMailRefresh = Date.now() + 1000;
  const before = JSON.stringify(mailSnapshot());
  try {await mailHost.refresh();}
  catch {await mailHost.cancel(); mailFailure = '邮箱处理未完成，已停止读取；请重新配置或重启后恢复';}
  await mailAnalysisHost?.tick();
  if (JSON.stringify(mailSnapshot()) !== before) publish();
}

function taskSurface(task) {
  const registered = conversations?.turns.get(task.taskId)?.surface;
  if (registered) return registered;
  if (task.conversationId === 'desktop-panel') return 'panel';
  if (task.conversationId === 'desktop-workspace') return 'workspace';
  return undefined;
}

function orderedTasks() {
  return [...tasks.values()].sort((a, b) => String(conversations?.turns.get(a.taskId)?.createdAt ?? a.createdAt ?? a.updatedAt ?? '')
    .localeCompare(String(conversations?.turns.get(b.taskId)?.createdAt ?? b.createdAt ?? b.updatedAt ?? '')));
}

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
    tasks: orderedTasks().filter(task => !surface || taskSurface(task) === surface).map(task => ({...structuredClone(task),
      createdAt: conversations?.turns.get(task.taskId)?.createdAt ?? task.createdAt ?? task.updatedAt,
      userMessage: taskGoals.get(task.taskId) ?? conversations?.goal(task.taskId)})),
    messages: conversations?.messagesFor(surface) ?? [],
    conversation: surface ?? 'all',
    capabilities: structuredClone(capabilities),
    health: structuredClone(health),
    capabilityDirectory: {...capabilityDirectory},
    approvals: [...approvals.values()],
    notifications: [...notifications.values(),...(todoHost?.snapshot().notifications ?? [])],
    model: structuredClone(model),
    thinking: structuredClone(thinking),
    live: {...(liveVoice?.snapshot() ?? liveConfig?.snapshot()), shortcut: {...liveShortcut}},
    proactive: proactiveHost?.snapshot() ?? {enabled: false, cloudAnalysis: false, status: 'disabled', reason: '主动观察尚未装配', suggestions: []},
    mail: mailSnapshot(),
    feeds: feedsHost?.snapshot(),
    todo: todoHost?.snapshot() ?? {available:false,items:[],notifications:[],reason:todoFailure || '待办将在 Runtime 连接后可用'},
    goalCloud:goalCloudHost?.snapshot() ?? {available:false,sessionAllowed:false,reason:'目标工具将在 Runtime 连接后可用'},
    notepad: notepadHost?.snapshot() ?? {available:false,busy:false,state:'unavailable',
      reason:'本机执行组件尚未就绪，记事本操作暂不可用。'},
    coding: codingWorkspace?.snapshot() ?? {configured:false,reason:'编程工作区尚未装配'},
    agentArts: agentArtsConfig?.snapshot(),
    laya: localLaya?.snapshot() ?? {state:'unavailable', ready:false, reason:'本地模型尚未装配'},
    voice: voiceInput ? {...voiceInput.snapshot(), experimental: sisConfigHost?.snapshot().configured,
      configuration: sisConfigHost?.snapshot()} : {available: false, status: voiceInitializationFailure ? 'error' : 'unconfigured',
      reason: voiceInitializationFailure?.message ?? sisConfigHost?.snapshot().reason ?? 'SIS 尚未配置',
      failure: voiceInitializationFailure, configuration: sisConfigHost?.snapshot(),
      capture: microphoneCaptureHost?.snapshot() ?? {authorized: false, active: false, busy: false,
        subscriberCount: 0, lastRelease: {stopped: true, verified: false, reason: 'never_started'}}},
  };
}

function publish() {
  for (const win of [orb, panel, admin, workspace]) {
    if (win && !win.isDestroyed()) win.webContents.send('desktop:update', snapshot(win === workspace ? 'workspace' : win === admin ? undefined : 'panel'));
  }
}

function windowFor(mode, bounds, options = {}) {
  const win = new BrowserWindow({...desktopHost.restore(mode, bounds), show: false, backgroundColor: '#00000000',
    webPreferences: {preload: path.join(dir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      ...(mode === 'panel' ? {autoplayPolicy: 'no-user-gesture-required'} : {})}, ...options});
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
    const cloudSettings=agentArtsConfig.snapshot();
    model = {
      ...model,
      provider: 'agentarts',
      label: 'AgentArts · Competition Profile',
      status: cloudSettings.configured?'configured':'unconfigured',
      verification: 'unverified',
      baseUrl: cloudSettings.gatewayUrl,
      model: 'AgentArts Runtime',
      deployment: cloudSettings.runtimeName,
      configured: cloudSettings.configured,
      keyConfigured: cloudSettings.configured,
      persisted: false,
      enabled: true,
      capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false},
      reason: cloudSettings.configured?'Competition Profile 已装配；云端结果仍需真实调用和本地读回验证':cloudSettings.reason,
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
      if (event.type === 'task.completed' && syntheticRepairHost && repairCandidateVersion === '1.0') {
        void promptSyntheticRepairCandidate(event.taskId).catch(() => {
          runtimeError = '本地修复预览未能显示；计划未被自动修改'; publish();
        });
      }
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
  const revision = ++capabilityReadRevision;
  capabilityDirectory = {state: 'loading', reason: '正在读取 Runtime 能力目录'};
  capabilities = [];
  health = [];
  publish();
  const result = await readCapabilityDirectory(client);
  if (revision !== capabilityReadRevision) return;
  capabilities = result.manifests;
  health = result.health;
  capabilityDirectory = result.status;
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

async function promptSyntheticRepairCandidate(taskId) {
  if (!syntheticRepairHost || !runtimeApplication || repairPrompts.has(taskId)) return;
  repairPrompts.add(taskId);
  try {
    if (runtimeApplication.runtime.loadCheckpoint(taskId, 'mvp-repair-submitted')) return;
    const candidate = runtimeApplication.readRepairCandidate(taskId);
    if (!candidate) return;
    const source = syntheticRepairHost.readBinding(taskId);
    if (!source || source.binding.graphRevision !== candidate.candidate.expectedGraphRevision) return;
    const idempotencyKey = createHash('sha256').update(taskId + ':' + source.evidenceId).digest('hex');
    const prior = restoreSyntheticRepairSubmission(runtimeApplication, syntheticRepairHost,
      taskId, source, candidate, idempotencyKey);
    if (prior) { await refresh(prior.taskId); return; }
    const lines = candidate.candidate.changes.map(item =>
      `${item.node.id}#${item.node.revision} → ${item.summary}\n原因：${item.reason}\n依赖：${item.dependencies.map(dep => `${dep.id}#${dep.revision}`).join(', ')}`);
    const options = {
      type: 'question', title: '合成会议计划修复预览',
      message: 'AgentArts 提供了未验证的计划修复候选',
      detail: `当前图版本 ${source.binding.graphRevision}；候选涉及：\n${lines.join('\n')}\n\n确认后仅创建独立的本地审批任务，写入仍需通过 Policy 的一次性批准。`,
      buttons: ['创建本地审批任务', '暂不执行'], defaultId: 1, cancelId: 1, noLink: true,
    };
    const answer = panel && !panel.isDestroyed()
      ? await dialog.showMessageBox(panel, options) : await dialog.showMessageBox(options);
    if (answer.response !== 0) return;
    if (runtimeApplication.runtime.loadCheckpoint(taskId, 'mvp-repair-submitted')) return;
    const concurrent = restoreSyntheticRepairSubmission(runtimeApplication, syntheticRepairHost,
      taskId, source, candidate, idempotencyKey);
    if (concurrent) { await refresh(concurrent.taskId); return; }
    const repair = runtimeApplication.submitLocalRepair({sourceTaskId: taskId,
      evidenceId: source.evidenceId, idempotencyKey,
      deadline: new Date(Date.now() + 10 * 60_000).toISOString()});
    runtimeApplication.runtime.saveCheckpoint(taskId, 'mvp-repair-submitted', {taskId: repair.taskId});
    await refresh(repair.taskId);
  } finally { repairPrompts.delete(taskId); }
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
  if (syntheticMvp && (!competitionMode || app.isPackaged)) {
    throw Error('合成 MVP 工具只允许显式 Competition 开发验收，不适用于 Local/Fake 或安装包');
  }
  if (agentArtsResponseMode !== undefined && !['text', 'tool-proposal-json'].includes(agentArtsResponseMode)) {
    throw Error('PA_AGENTARTS_RESPONSE_MODE 只允许 text 或 tool-proposal-json');
  }
  if (repairCandidateVersion !== undefined && (repairCandidateVersion !== '1.0'
    || !syntheticMvp || agentArtsResponseMode !== 'tool-proposal-json')) {
    throw Error('版本化修复候选只允许合成 Competition JSON 模式显式启用');
  }
  if ((layaPort !== undefined || layaKey !== undefined)
    && (!syntheticMvp || !layaPort || !layaKey || !/^\d+$/.test(layaPort))) {
    throw Error('本地 Laya 判断只允许显式合成 MVP 配置并要求回环端口及密钥');
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
      const cloudBinding=agentArtsConfig.runtimeBinding();
      if (!cloudBinding) throw Error(agentArtsConfig.snapshot().reason);
      activeCloudBinding = cloudBinding;
      feedsHost?.prepare();
      const syntheticTools = syntheticMvp
        ? (await import('./competition-synthetic-workspace.js')).createSyntheticMeetingToolset(
          path.resolve(dir, '../../../tests/manual/agentarts/fixtures/mvp-meeting'),
          (...args) => syntheticRepairHost.projectConfirmed(...args))
        : {};
      if (syntheticMvp) {
        const cognitionModule = layaPort ? await import('@personal-agent/cognition') : undefined;
        const decision = layaPort ? (() => {
          const {ProactiveDecisionService, LayaDecisionModel, LocalLayaHttpTransport} = cognitionModule;
          return new ProactiveDecisionService(new LayaDecisionModel(
            new LocalLayaHttpTransport(Number(layaPort), () => layaKey)));
        })() : undefined;
        syntheticRepairHost = (await import('./competition-repair-host.js')).createSyntheticRepairHost(
          path.join(path.dirname(dbPath), 'mvp-synthetic-memory.sqlite'), {decision});
      }
      const {createGoalHost} = await import('./goal-host.js');
      const {createWorkspaceReadTool,createWorkspaceCommandTool} = await import('@personal-agent/coding-tools');
      const {createDesktopCompetitionToolCatalog} = await import('./competition-tool-catalog.js');
      const namespace = desktopHost.userNamespace;
      goalHost = createGoalHost(namespace);
      if (!syntheticMvp) goalCloudHost = createDesktopGoalCloudHost({goalHost});
      if (!syntheticMvp) {
        try {todoHost = createDesktopTodoHost({userData:app.getPath('userData'),safeStorage,namespace,
          createDeliveryHost:runtimeModule.createReminderDeliveryHost,onUpdate:publish,
          onNotification:item=>{
            if(!Notification.isSupported()) return;
            const notification=new Notification({title:'PersonalAgent 待办提醒',body:item.summary});
            notification.on('click',()=>openPanel());notification.show();
          }});}
        catch {todoFailure = '待办存储无法读取，原数据已保留，请恢复本机安全存储';}
      }
      const hostPath = path.resolve(dir, '../../windows-host/host/bin/Release/net8.0-windows/WindowsHost.Host.exe');
      const bridgePath = path.resolve(dir, '../../windows-host/host/bridge/bin/Release/net8.0-windows/WindowsHost.PipeBridge.exe');
      if (!syntheticMvp && process.platform === 'win32' && existsSync(hostPath) && existsSync(bridgePath)) {
        notepadHost = createDesktopNotepadHost({
          createAdapter:runtimeModule.createWindowsHostNotepadAdapter,
          createAttempts:runtimeModule.createRuntimeWindowsHostAttemptStore,
          transport:runtimeModule.createWindowsHostBridgeTransport({hostPath,bridgePath}),
          registerConfirmation:handler => globalShortcut.register('F9',handler)
            ? () => globalShortcut.unregister('F9') : undefined,
          openNotepad:() => new Promise((resolve,reject) => {
            const child=spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','notepad.exe'),[],
              {windowsHide:false,stdio:'ignore'});
            child.once('spawn',()=>{child.unref();resolve();});child.once('error',reject);
          }),
          respond:payload => client.call('authorization.respond',payload),
          cancelTask:taskId => client.call('task.cancel',{taskId,reason:'用户停止记事本操作'}),
          onUpdate:publish,
        });
      }
      if (syntheticFactSource) competitionCatalog = createDesktopCompetitionToolCatalog({
        rootPath: path.resolve(dir, '../fixtures/agentarts'), createWorkspaceReadTool,
      });
      productTools = createPublicConnectorHost({systemObservationFactory:runtimeModule.createSystemObservationTool});
      const commandHelper=path.join(app.getPath('userData'),'native-tools','workspace-command','WindowsJobProcessHost.exe');
      codingWorkspace = createWorkspaceConfigHost({userData:app.getPath('userData'),safeStorage,
        jobHelperExecutable:existsSync(commandHelper)?commandHelper:undefined,
        selectDirectory:async () => {
          const result = await dialog.showOpenDialog(admin, {title:'选择允许 PersonalAgent 使用的编程工作区',
            properties:['openDirectory']});
          return result.canceled ? undefined : result.filePaths[0];
        },
        selectNodeExecutable:async () => {
          const result=await dialog.showOpenDialog(admin,{title:'选择可信安装目录中的 Node 可执行文件',
            properties:['openFile'],filters:[{name:'Node executable',extensions:['exe']}]});
          return result.canceled?undefined:result.filePaths[0];
        },
        selectNpmCli:async () => {
          const result=await dialog.showOpenDialog(admin,{title:'选择可信 Node 安装目录中的 npm-cli.js',
            properties:['openFile'],filters:[{name:'npm CLI',extensions:['js']}]});
          return result.canceled?undefined:result.filePaths[0];
        },
        selectCheckFile:async workspaceRoot => {
          const result=await dialog.showOpenDialog(admin,{title:'选择此工作区内需要语法检查的文件',
            defaultPath:workspaceRoot,properties:['openFile'],filters:[{name:'JavaScript',extensions:['js','mjs','cjs']}]});
          return result.canceled?undefined:result.filePaths[0];
        },
        createCommandRecipeTool:options=>createWorkspaceCommandRecipeTool({...options,createWorkspaceCommandTool})});
      const {LayaActionChoiceService, LocalLayaHttpTransport} = await import('@personal-agent/cognition');
      localLaya = createLocalLayaHost({projectRoot:path.resolve(dir, '../../..'),
        createService:runtimeModule.createLocalInboxClassifier,
        createChooser:({port,getApiKey}) => new LayaActionChoiceService(new LocalLayaHttpTransport(port,getApiKey)),
        onUpdate:publish});
      mailConfig = createMailConfig({userData:app.getPath('userData'), safeStorage,
        onRevoke:async () => {await mailHost?.cancel();},
        onCloudRevoke:async () => {await mailAnalysisHost?.revoke();}});
      const configuredMail = mailConfig.current();
      if (configuredMail) {
        try {
          const {user, authCode, revision} = configuredMail;
          mailHost = runtimeModule.createQQMailTriageHost({user, authCode, accountRef:'desktop-qq-inbox',
            storage:createMailMetadataStorage({userData:app.getPath('userData'), safeStorage}),
            namespace:`${namespace}:qq-inbox:${user.toLowerCase()}`, triage:localLaya,
            labels:{meeting:'Meeting invitations, rescheduling and appointment notices',
              work:'Work, project, technical discussions and documents',
              subscription:'Subscribed newsletters, news digests and product updates',
              transaction:'Receipts, invoices, order and delivery notices',
              personal:'Personal conversations and social notifications',
              other:'Other or unclear subject; review manually'}, meetingLabels:['meeting'],
            isSessionAllowed:() => mailConfig.isSessionAllowed(revision)});
        } catch {mailFailure = '邮箱本地分类状态无法装配；其他功能可继续使用';}
      }
      runtimeApplication = runtimeModule.createAgentArtsRuntimeApplication({
        path: dbPath,
        hostUserNamespace: namespace,
        // Match the existing text tool workflow budget; preserve room for the final answer.
        competitionMaxSteps: 8,
        beforeCompetitionSend:request=> {
          if (!proactiveHost && runtimeApplication.runtime.getTask(request.taskId).conversationId?.startsWith('desktop-proactive-goals:')) {
            throw Error('目标主动分析宿主尚未就绪');
          }
          proactiveHost?.assertCognitionCloudSend(request);
          goalCloudHost?.assertCloudSend(request);
          if (!mailAnalysisHost && runtimeApplication.runtime.getTask(request.taskId).conversationId?.startsWith('desktop-mail-analysis:')) {
            throw Error('邮件分析宿主尚未就绪');
          }
          mailAnalysisHost?.assertCloudSend(request);
        },
        tools: [...(syntheticMvp ? syntheticTools.tools : codingWorkspace.tools.length ? codingWorkspace.tools : competitionCatalog ? [competitionCatalog.tool] : []), ...(goalCloudHost?.tools ?? goalHost.tools), ...productTools.tools, ...(mailHost?.tools ?? []), ...(feedsHost?.tools ?? []), ...(notepadHost?.tools ?? []), ...(todoHost?.tools ?? [])],
        ...(syntheticMvp ? {localRepair: syntheticRepairHost.localRepair} : {}),
        ...(repairCandidateVersion === undefined ? {} : {repairCandidateVersion}),
        ...(process.env.PA_AGENTARTS_WORKFLOW_GOAL_INPUT === undefined ? {} : {workflowGoalInput: process.env.PA_AGENTARTS_WORKFLOW_GOAL_INPUT}),
        responseMode: agentArtsResponseMode ?? 'tool-proposal-json',
        ...(syntheticMvp ? {competitionToolExports: syntheticTools.competitionToolExports} : {
          initialRequestMode: 'goal-with-tools-json',
          competitionToolAvailability: [...(codingWorkspace.tools.length ? codingWorkspace.competitionToolAvailability : competitionCatalog ? [competitionCatalog.availability] : []), ...productTools.competitionToolAvailability, ...feedsHost.competitionToolAvailability, ...(todoHost?.competitionToolAvailability ?? []), ...(goalCloudHost?.competitionToolAvailability ?? [])],
          competitionToolExports: [...(codingWorkspace.tools.length ? codingWorkspace.competitionToolExports : competitionCatalog ? [competitionCatalog.export] : []), ...productTools.competitionToolExports, ...feedsHost.competitionToolExports, ...(todoHost?.competitionToolExports ?? []), ...(goalCloudHost?.competitionToolExports ?? [])],
        }),
        ...cloudBinding,
        invokeMode: agentArtsInvokeMode,
        onDiagnostic: process.env.PA_AGENTARTS_SAFE_DIAGNOSTICS === '1'
          ? receipt => desktopHost.logAgentArtsFailure(receipt) : undefined,
        authorizationProvider: {
          read: async () => {
            return agentArtsConfig.readAuthorization(cloudBinding);
          },
        },
      });
      if (syntheticRepairHost) await syntheticRepairHost.initialize(runtimeApplication.runtime);
      if (mailHost) {mailHost.bindApplication(runtimeApplication); mailConfig.markBound(configuredMail.revision);}
      codingWorkspace.bindApplication(runtimeApplication);
      feedsHost?.bindApplication(runtimeApplication);
      todoHost?.bindApplication(runtimeApplication);
      goalHost.bind(runtimeApplication);
      goalCloudHost?.bindApplication(runtimeApplication);
      notepadHost?.bind(runtimeApplication);
      goalHost.resumeApproved();
      if (!syntheticMvp && competitionCatalog && !codingWorkspace.tools.length) competitionFactBridge = createDesktopCompetitionFactBridge({
        application: runtimeApplication, catalog: competitionCatalog,
        runtimePath: dbPath, userNamespace: namespace,
      });
      await competitionFactBridge?.recover();
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
  if (competitionMode && mailHost) mailAnalysisHost = createDesktopMailAnalysisHost({
    application:runtimeApplication,client,mail:mailHost,config:mailConfig,namespace:desktopHost.userNamespace,
    onUpdate:publish,onTask:({taskId,goal})=>{
      if (!conversations.turns.has(taskId)) conversations.add(taskId,'panel',goal);
      taskGoals.set(taskId,goal);
    },
  });
  await syncCapabilities();
  await syncRuntimeSnapshots();
  if (competitionMode) proactiveHost = createDesktopProactiveHost({application: runtimeApplication,
    client, userData: app.getPath('userData'), namespace: desktopHost.userNamespace, onUpdate: publish,
    goalHost,chooser:localLaya,cognitionReady:()=>localLaya.snapshot().state==='ready',
    createCognitionHost:runtimeModule.createProactiveCognitionHost,
    onAnalysisTask: ({taskId, goal}) => {
      if (!conversations.turns.has(taskId)) conversations.add(taskId, 'panel', goal);
      taskGoals.set(taskId, goal);
    },
  });
  await pumpEvents();
  if (syntheticRepairHost && repairCandidateVersion === '1.0') {
    for (const task of tasks.values()) {
      if (task.state === 'succeeded') void promptSyntheticRepairCandidate(task.taskId).catch(() => {});
    }
  }
  eventPoll = setInterval(() => {void pumpEvents(); void proactiveHost?.tick(); void refreshMail(); void notepadHost?.refresh(); void todoHost?.tick();}, 120);
}

async function initializeProductServices() {
  try {
    runtimeError = '';
    await initializeRuntime();
    await initializeModelFromEnvironment();
    if (competitionMode) {
      try {await initializeSisVoice();}
      catch {
        voiceInput = undefined;
        voiceInitializationFailure = {stage:'initialization',code:'EXTERNAL_FAILURE',message:'语音适配器启动失败'};
      }
      try {await initializeLiveVoice();}
      catch {runtimeError = 'Live 适配器启动失败；文字与听写仍可使用';}
    }
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : 'Runtime 初始化失败';
    connectionLabel = 'Runtime 未连接';
    throw error;
  }
}

async function action(event, name, payload) {
  const sender = [orb, panel, admin, workspace].find(win => win && !win.isDestroyed() && win.webContents === event.sender);
  if (!sender || event.senderFrame !== sender.webContents.mainFrame) throw Error('Untrusted sender');
  if (competitionMode && ['model.configure', 'model.test', 'model.toggle'].includes(name)) {
    throw Error('Competition Profile 的 AgentArts 配置只允许由可信主进程提供；盘古配置操作不可用');
  }
  if (name === 'snapshot') return snapshot(sender === workspace ? 'workspace' : sender === admin ? undefined : 'panel');
  if (name === 'notepad.start' || name === 'notepad.cancel') {
    if (sender !== admin || !notepadHost || notepadClosing) throw Error('请从电脑操控设置操作记事本');
    return name === 'notepad.start' ? notepadHost.start(payload) : notepadHost.cancel();
  }
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
  if (name === 'agentarts.configure') {
    if (sender!==admin || !competitionMode || runtimeApplication?.activeTaskCount || liveVoice?.hasActive()
      || runtimeStartup.snapshot().state==='starting') throw Error('请在任务、通话及启动结束后从设置配置 AgentArts');
    const result=agentArtsConfig.configure(payload);
    const startup = await runtimeStartup.start();
    if (liveVoice && !liveShortcut.registered) registerLiveShortcut();
    const requiresRestart = startup.state !== 'ready' || result.gatewayUrl !== activeCloudBinding?.gatewayUrl
      || result.runtimeName !== activeCloudBinding?.runtimeName;
    if (!requiresRestart) await initializeModelFromEnvironment();
    publish();
    return {...result, requiresRestart, reason: requiresRestart
      ? '配置已加密保存，请重启应用完成连接。'
      : '配置已加密保存，Runtime 已连接；云端可用性以实际任务结果为准。'};
  }
  if (['todo.authorize','todo.revoke','todo.configureNotifications','todo.dismiss'].includes(name)) {
    if(sender!==admin || !competitionMode || syntheticMvp || !todoHost) throw Error('请从正式应用待办设置操作');
    const result=todoHost[name.slice(5)](payload);publish();return result;
  }
  if (['goalCloud.authorize','goalCloud.revoke'].includes(name)) {
    if(sender!==admin || !competitionMode || syntheticMvp || !goalCloudHost) throw Error('请从正式应用目标管理设置操作');
    const result=goalCloudHost[name.slice('goalCloud.'.length)](payload);publish();return result;
  }
  if (['feeds.add','feeds.remove','feeds.authorize','feeds.revoke'].includes(name)) {
    if (sender !== admin || !competitionMode || syntheticMvp || !feedsHost) throw Error('请从正式应用订阅设置操作');
    if (name !== 'feeds.revoke' && (runtimeApplication?.activeTaskCount || runtimeStartup.snapshot().state==='starting')) {
      throw Error('请等待当前任务和启动结束后修改订阅');
    }
    const result = feedsHost[name.slice('feeds.'.length)](payload); publish(); return result;
  }
  if (['coding.select','coding.selectNode','coding.selectNpmCli','coding.selectCheckFile','coding.authorize','coding.revoke'].includes(name)) {
    if (sender !== admin || !competitionMode || syntheticMvp || !codingWorkspace) throw Error('请从正式应用设置配置编程工作区');
    if (name !== 'coding.revoke' && runtimeApplication.activeTaskCount > 0) throw Error('请等待当前任务结束后更改工作区');
    if (name === 'coding.select') await codingWorkspace.select();
    if (name === 'coding.selectNode') await codingWorkspace.selectNode();
    if (name === 'coding.selectNpmCli') await codingWorkspace.selectNpmCli();
    if (name === 'coding.selectCheckFile') await codingWorkspace.selectCheckFile();
    if (name === 'coding.authorize') codingWorkspace.authorize(payload);
    if (name === 'coding.revoke') codingWorkspace.revoke();
    publish();return {coding:codingWorkspace.snapshot()};
  }
  if (['mail.configure','mail.enable','mail.read','mail.disable','mail.enableCloud','mail.disableCloud','laya.start','laya.stop'].includes(name)) {
    if (sender !== admin || !competitionMode || !mailConfig || !localLaya) throw Error('此操作仅允许从本项目设置调用');
    if (name === 'laya.start') {localServicesStopped = false; return localLaya.start();}
    if (name === 'laya.stop') {await mailHost?.cancel(); const result = await localLaya.stop(); publish(); return result;}
    if (name === 'mail.configure') {await mailConfig.configure(payload); mailFailure = '';}
    if (name === 'mail.enable') mailConfig.enableSession(payload);
    if (name === 'mail.disable') await mailConfig.revoke();
    if (name === 'mail.enableCloud') mailConfig.enableCloudAnalysis(payload);
    if (name === 'mail.disableCloud') await mailConfig.revokeCloudAnalysis();
    if (name === 'mail.read') {
      if (!mailHost || mailConfig.snapshot().requiresRestart) throw Error('邮箱配置将在下次启动应用时接入');
      if (!localLaya.snapshot().ready) throw Error('请先启动本地 Laya');
      if (mailHost.snapshot().status === 'classification_unavailable') mailHost.retryClassification();
      else mailHost.startBatch({expiresAt:new Date(Date.now() + 8 * 60 * 60_000).toISOString()});
      localServicesStopped = false;
    }
    publish(); return mailSnapshot();
  }
  if (name === 'proactive.configure' || name === 'proactive.analyze') {
    if ((sender !== panel && sender !== admin) || !competitionMode || !proactiveHost) throw Error('主动观察仅允许可信设置或面板调用');
    if (name === 'proactive.configure') return proactiveHost.configure(payload);
    if (!payload || Object.keys(payload).some(key => key !== 'id') || typeof payload.id !== 'string') throw Error('主动分析请求无效');
    return proactiveHost.analyze(payload.id);
  }
  if (name === 'voice.stop') {
    if (sender !== panel) throw Error('语音操作只能从面板调用');
    if (liveVoice?.hasActive()) {liveVoice.interrupt(); return {stopped: true};}
    return voiceInput ? voiceInput.stopSpeaking(sender.webContents.id)
      : {available: false, stopped: false, reason: '语音供应商尚未连接'};
  }
  if (name === 'voice.configure' || name === 'voice.login') {
    if (sender !== panel || !competitionMode) throw Error('SIS 配置只能从 Competition 可信面板提交');
    if (voiceConfigurationPending) throw Error('语音配置正在更新，请稍候');
    if (!voiceInput && sisPlaybackHost) throw Error('旧语音播放资源释放未确认，无法重新装配');
    if (voiceInput?.hasActive() || liveVoice?.hasActive()) throw Error('请先结束当前语音会话再更新 SIS 配置');
    voiceConfigurationPending = true;
    try {
    const configuration = name === 'voice.login' ? await acquireHuaweiSisToken(payload) : payload;
    // A voice capture may have started while the IAM request was in flight.
    if (voiceInput?.hasActive()) throw Error('请先结束当前语音会话再更新 SIS 配置');
    sisConfigHost.configure(configuration ?? {});
    if (voiceInput) {
      try { await voiceInput.dispose(); }
      catch {
        voiceInput = undefined;
        voicePcmSource = undefined;
        voiceInitializationFailure = {stage: 'cleanup', code: 'EXTERNAL_FAILURE',
          message: '旧语音资源释放未确认'};
        publish();
        throw Error('SIS 配置已保存，但旧语音资源释放未确认');
      }
      voiceInput = undefined;
      voicePcmSource = undefined;
      sisPlaybackHost = undefined;
    }
    try { await initializeSisVoice(); }
    catch {
      voiceInitializationFailure = {stage: 'initialization', code: 'EXTERNAL_FAILURE',
        message: 'SIS 语音适配器启动失败'};
      publish();
      throw Error('SIS 配置已保存，但语音适配器启动失败');
    }
    publish();
    return {...sisConfigHost.snapshot(), connected: Boolean(voiceInput)};
    } finally { voiceConfigurationPending = false; }
  }
  if (name.startsWith('voice.record.') || name === 'voice.play') {
    if (sender !== panel || !voiceInput) throw Error('语音试用只允许从 Competition 可信面板调用');
    if (voiceConfigurationPending) throw Error('语音配置正在更新，请稍候');
    if (liveVoice?.hasActive()) throw Error('请先关闭 Live 再使用语音转文字');
    const senderId = sender.webContents.id;
    if (name === 'voice.record.start') return voiceInput.beginCapture(senderId);
    if (name === 'voice.record.finish') return voiceInput.finishCapture(senderId);
    if (name === 'voice.record.cancel') return voiceInput.cancelCapture(senderId);
    if (name === 'voice.play') return voiceInput.playReply(senderId);
    throw Error('Unsupported voice action');
  }
  if (name === 'live.configure') {
    if ((sender !== panel && sender !== admin) || !competitionMode) throw Error('Live 配置只能从可信面板或设置提交');
    if (liveVoice?.hasActive() || voiceInput?.hasActive()) throw Error('请先结束语音再修改配置');
    const result = liveConfig.configure(payload);
    registerLiveShortcut(); publish(); return result;
  }
  if (name === 'live.toggle') {
    if (sender !== panel || !competitionMode) throw Error('Live 只能从可信面板开启');
    return toggleLive();
  }
  if (name === 'voice.capture.authorize') {
    if (sender !== panel || !competitionMode) throw Error('麦克风只允许 Competition 可信面板启用');
    if (!client) throw Error('Runtime 未连接，麦克风采集尚不可用');
    if (!voicePcmSource) throw Error('Voice PCM 来源尚未接入');
    const result = microphoneCaptureHost.authorize();
    publish();
    return result;
  }
  if (name === 'voice.capture.revoke') {
    if (sender !== panel) throw Error('麦克风只能从可信面板关闭');
    await liveVoice?.stop();
    await microphoneCaptureHost.revoke();
    publish();
    return microphoneCaptureHost.snapshot();
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
  if (['evidence.list', 'evidence.get', 'authorization.revoke'].includes(name)) {
    if (sender !== admin) throw Error('Evidence 操作仅允许可信后台窗口');
    const namespace = desktopHost.userNamespace;
    const evidenceHost = createDesktopEvidenceHost({
      application: runtimeApplication,
      subjectRef: namespace,
      isAdminSession: () => admin === sender && !sender.isDestroyed()
        && sender.webContents === event.sender && !sender.webContents.isDestroyed(),
      ownsTask: task => {
        const turn = conversations?.turns.get(task.taskId);
        if (turn && ['panel', 'workspace'].includes(turn.surface)
          && task.conversationId === `desktop-${turn.surface}`) return true;
        if (goalHost && task.conversationId === `host-tool:${namespace}`) {
          try { goalHost.readTask(task.taskId); return true; } catch { return false; }
        }
        return false;
      },
    });
    if (name === 'evidence.list') return evidenceHost.list(payload);
    if (name === 'evidence.get') return evidenceHost.get(payload);
    return evidenceHost.revoke(payload);
  }
  if (name.startsWith('goal.')) {
    if (sender !== panel && sender !== workspace) throw Error('Goal 操作只能从面板或工作区调用');
    if (!goalHost) throw Error('Goal 写入仅在 Competition Profile 的可信宿主中可用');
    if (name === 'goal.list') return goalHost.list();
    if (name === 'goal.get') return goalHost.get(payload);
    if (name === 'goal.create') return goalHost.create(payload);
    if (name === 'goal.revise') return goalHost.revise(payload);
    if (name === 'goal.readTask') return goalHost.readTask(payload);
    if (name === 'goal.listTasks') return goalHost.listTasks();
    if (name === 'goal.cancel') {
      goalHost.readTask(payload);
      const result = await client.call('task.cancel', {taskId: payload, reason: '用户取消 Goal 任务'});
      return {...result, task: goalHost.readTask(payload)};
    }
    throw Error('Unsupported Goal action');
  }
  if (name === 'task.submit') {
    if (sender !== panel && sender !== workspace) throw Error('请在对话工作区发送消息');
    if (typeof payload !== 'string' || !payload.trim()) throw Error('请输入有效任务');
    if (competitionMode && !agentArtsConfig.snapshot().configured) throw Error('请先在设置 → 模型中保存 AgentArts Authorization；Live 语音配置无需重新填写');
    if (!fakeMode && model.enabled === false) throw Error('模型已停用，请先在模型设置中启用');
    const surface = sender === workspace ? 'workspace' : 'panel';
    if (submitting.has(surface) || [...tasks.values()].some(task => taskSurface(task) === surface && !terminalTaskStates.has(task.state))) throw Error('请等待当前回答完成，或先停止当前任务');
    submitting.add(surface);
    try {
    const goal = payload.trim();
    const result = await submitConversationTask(client, {goal, conversationId: `desktop-${surface}`}, {competition: competitionMode});
    conversations.add(result.taskId, surface, goal);
    taskGoals.set(result.taskId, goal);
    if (sender === panel) pinned = true;
    const task = await refresh(result.taskId);
    return task;
    } finally { submitting.delete(surface); }
  }
  if (name === 'task.cancel') {
    if (typeof payload !== 'string' || !tasks.has(payload)) throw Error('Unknown task');
    if (sender !== admin && taskSurface(tasks.get(payload)) !== (sender === workspace ? 'workspace' : 'panel')) throw Error('无法停止其他工作区的任务');
    return requestTaskCancellation(client, payload, refresh);
  }
  if (name === 'task.refresh') {
    if (!tasks.has(payload)) throw Error('Unknown task');
    if (sender !== admin && taskSurface(tasks.get(payload)) !== (sender === workspace ? 'workspace' : 'panel')) throw Error('无法读取其他工作区的任务');
    return refresh(payload);
  }
  if (name === 'capability.list') { await syncCapabilities(); publish(); return {manifests: capabilities, health}; }
  if (name === 'approval.history') {
    if (sender !== admin) throw Error('授权历史只能从管理后台读取');
    return readApprovalPage(client, payload);
  }
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

async function initializeSisVoice() {
  if (!competitionMode || !client || voiceInput) return;
  if (sisPlaybackHost) throw Error('旧语音播放资源释放未确认');
  if (!sisConfigHost.snapshot().configured) return;
  const selectedConfig = sisConfigHost.current();
  if (!selectedConfig) return;
  const {region, projectId} = selectedConfig;
  const {createVoicePcmFrameSourcePort, createHuaweiSisRecognitionPort,
    createHuaweiSisOutputPort} = await import('@personal-agent/voice');
  const {createDesktopVoiceInput} = await import('./voice-input.js');
  const tokenPort = {getSisToken: async ({region, signal}) => {
    if (signal.aborted || region !== speechConfig.region) throw Error('SIS 凭据不可用');
    const selected = sisConfigHost.current();
    if (!selected || selected.region !== region || selected.projectId !== speechConfig.projectId
      || selected.tokenExpiresAt && Date.parse(selected.tokenExpiresAt) <= Date.now() + 10_000) {
      throw Error('SIS 凭据不可用');
    }
    return selected.token;
  }};
  const speechConfig = {region, projectId, tokenPort};
  const playback = createDesktopSisPlaybackHost({getPanel: () => panel,
    onDiagnostic: phase => desktopHost.logVoicePlayback(phase)});
  let source;
  try {
    const speechPorts = {
      recognition: createHuaweiSisRecognitionPort(speechConfig),
      output: createHuaweiSisOutputPort({...speechConfig, playback}),
      dispose: () => playback.dispose(),
    };
    source = createVoicePcmFrameSourcePort(microphoneCaptureHost.binding);
    voiceInput = createDesktopVoiceInput({source, microphoneHost: microphoneCaptureHost,
      client, onUpdate: publish, enabled: true, inputMode: 'dictation', speechPorts,
      onTranscript: ({senderId, text}) => {
        if (panel && !panel.isDestroyed() && panel.webContents.id === senderId) {
          panel.webContents.send('desktop:dictation-result', {text});
        }
      },
      onTaskSubmitted: ({taskId, goal}) => {
        conversations.add(taskId, 'panel', goal);
        taskGoals.set(taskId, goal);
      }});
    voicePcmSource = source;
    sisPlaybackHost = playback;
    voiceInitializationFailure = null;
  } catch (error) {
    await source?.dispose?.();
    await playback.dispose();
    throw error;
  }
}

async function toggleLive() {
  if (!liveVoice) throw Error('Live 服务尚未装配');
  if (liveVoice.hasActive()) return liveVoice.stop();
  if (voiceConfigurationPending || voiceInput?.hasActive()) throw Error('请先结束语音转文字或配置更新');
  pinned = true; openPanel(true); publish();
  return liveVoice.start();
}

function registerLiveShortcut() {
  if (liveShortcut.registered) globalShortcut.unregister(liveShortcut.key);
  const key = liveConfig.snapshot().hotkey;
  const registered = globalShortcut.register(key, () => {
    if (Date.now() - lastLiveShortcutAt < 400) return;
    lastLiveShortcutAt = Date.now();
    void toggleLive().catch(error => {
      liveShortcut.reason = error instanceof Error ? error.message : 'Live 开关失败';
      pinned = true; openPanel(true); publish();
    });
  });
  liveShortcut = {key, registered, reason: registered ? '' : `${key} 已被占用，请在 Live 设置中更换快捷键`};
}

async function initializeLiveVoice() {
  if (!competitionMode || !client) return;
  const {createVoicePcmFrameSourcePort, createRuntimeClientTranscriptConsumer} = await import('@personal-agent/voice');
  liveVoice = createLiveVoiceHost({getPanel: () => panel, config: liveConfig, microphoneHost: microphoneCaptureHost,
    createSource: () => createVoicePcmFrameSourcePort(microphoneCaptureHost.binding),
    createGateway: config => runtimeApplication.createLiveVoiceModel(config),
    createConsumer: createRuntimeClientTranscriptConsumer, client, onUpdate: publish,
    onTranscript: message => conversations.addLiveMessage(message),
    onTaskSubmitted: ({taskId, goal}) => {conversations.add(taskId, 'panel', goal); taskGoals.set(taskId, goal);},
    readContext: () => JSON.stringify({profile: 'huawei_ict_agentarts',
      agentArts:{configured:agentArtsConfig.snapshot().configured,reason:agentArtsConfig.snapshot().reason},
      tasks: orderedTasks().filter(task => taskSurface(task) === 'panel').slice(-10)
        .map(task => ({taskId: task.taskId, goal: (taskGoals.get(task.taskId) ?? conversations.goal(task.taskId) ?? '').slice(0, 800),
          state: task.state, result: resultText(task.resultSummary).slice(0, 1600)})),
      messages: conversations.messagesFor('panel').slice(-20).map(({role, text}) => ({role, text: text.slice(0, 1600)})),
      capabilities: capabilities.map(item => ({name: item.name ?? item.id, version: item.version})),
      tools: [...(codingWorkspace?.competitionToolAvailability ?? []),
        ...(productTools?.competitionToolAvailability ?? []),...(feedsHost?.competitionToolAvailability ?? []),
        ...(todoHost?.competitionToolAvailability ?? []),...(goalCloudHost?.competitionToolAvailability ?? [])]
        .map(({toolName,toolVersion})=>({name:toolName,version:toolVersion,state:'registered_requires_task_authorization'})),
      sessionPermissions:{goals:goalCloudHost?.snapshot().sessionAllowed===true,
        coding: codingWorkspace?.snapshot().cloudExportAllowed===true,
        mailAnalysis:mailConfig?.snapshot().cloudAnalysisAllowed===true},
      note: '工具名称来自与文字任务相同的宿主目录；注册不代表本次已授权或已执行。需要工作时调用 request_work，由 Runtime 为实际任务检查目录、权限和参数；不能将注册列表冒充当前全部可用。任务成功以 Runtime 返回为准。'}),
  });
}

app.whenReady().then(async () => {
  if (!ownsDesktopInstance) return;
  desktopHost = createDesktopHost();
  microphonePermissionGate = createMicrophonePermissionGate({
    expectedPageUrl: pathToFileURL(entry).href,
    isTrustedWindow: contents => contents === panel?.webContents,
  });
  session.defaultSession.setPermissionRequestHandler(microphonePermissionGate.request);
  session.defaultSession.setPermissionCheckHandler(microphonePermissionGate.check);
  microphoneCaptureHost = createMicrophoneCaptureHost({permissionGate: microphonePermissionGate,
    getPanel: () => panel});
  ipcMain.on('desktop:microphone-event', (event, message) => {
    if (microphoneCaptureHost.receive(event, message)) publish();
  });
  sisConfigHost = createDesktopSisConfigHost({userData: app.getPath('userData'), safeStorage});
  liveConfig = createLiveVoiceConfig({userData: app.getPath('userData'), safeStorage});
  agentArtsConfig = createAgentArtsConfig({userData: app.getPath('userData'), safeStorage});
  if (competitionMode && !syntheticMvp) feedsHost = createDesktopFeedsHost({userData:app.getPath('userData'),safeStorage});
  ipcMain.on('desktop:live-event', (event, message) => {liveVoice?.receive(event, message);});
  ipcMain.on('desktop:voice-playback-event', (event, message) => {
    if (sisPlaybackHost?.receive(event, message)) publish();
  });
  try {
    conversations = new Conversations(dataPaths.conversations);
    if (!competitionMode) restoreModelConfig();
    const startup = await runtimeStartup.start();
    if (startup.state === 'configuration_required') {
      runtimeError = agentArtsConfig.snapshot().reason;
      connectionLabel = 'Runtime 等待配置';
    }
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
  panel.on('hide', () => { void liveVoice?.stop(); void sisPlaybackHost?.stop().catch(() => {
    runtimeError = '语音播放资源释放未确认'; publish();
  }); void microphoneCaptureHost.revoke().catch(error => {
    runtimeError = error instanceof Error ? error.message : '麦克风释放未确认';
    publish();
  }); publish(); });
  createTray();
  if (liveVoice) registerLiveShortcut();
  console.info('PersonalAgent startup',JSON.stringify({runtime:runtimeStartup.snapshot().state,
    agentArtsConfigured:agentArtsConfig.snapshot().configured,liveConfigured:liveConfig.snapshot().configured,
    liveReady:Boolean(liveVoice),liveShortcutRegistered:liveShortcut.registered,
    sisConfigured:sisConfigHost.snapshot().configured,sisReady:Boolean(voiceInput)}));

  ipcMain.handle('desktop:action', async (...args) => {
    try { return {ok: true, value: await action(...args)}; }
    catch (error) { return {ok: false, error: error instanceof Error ? error.message : '操作失败'}; }
  });
  // First-run configuration must be reachable even when cloud credentials prevent Runtime startup.
  if (competitionMode && !agentArtsConfig.snapshot().configured) openAdmin('models');

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
    if (runtimeStartup.snapshot().state === 'starting') {
      event.preventDefault(); runtimeError = 'Runtime 正在连接，请稍后退出'; publish(); return;
    }
    proactiveHost?.stop();
    if(todoHost && !todoClosed) {
      event.preventDefault();
      todoClosing ??= todoHost.close().then(()=>{todoClosed=true;app.quit();})
        .catch(()=>{todoClosing=undefined;runtimeError='提醒队列尚未结束，请稍后退出';publish();});
      return;
    }
    if (notepadHost && !notepadClosed) {
      event.preventDefault();
      if (!notepadClosing) notepadClosing = notepadHost.close().then(() => {
        notepadClosed = true; app.quit();
      }).catch(() => {notepadClosing = undefined;runtimeError = '本机操作停止尚未确认，请稍后退出';publish();});
      return;
    }
    if (!localServicesStopped && (mailHost || localLaya)) {
      event.preventDefault();
      if (!localServicesStopping) {
        localServicesStopping = true;
        void (async () => {
          await mailConfig?.revoke();
          const result = await localLaya?.stop();
          if (result?.state === 'stop_unconfirmed') throw Error('本地模型退出尚未确认');
          localServicesStopped = true; app.quit();
        })().catch(() => {runtimeError = '本地分类服务退出尚未确认，请稍后再退出'; publish();})
          .finally(() => {localServicesStopping = false;});
      }
      return;
    }
    if (liveVoice?.hasActive()) {
      event.preventDefault();
      void liveVoice.stop().then(() => app.quit());
      return;
    }
    if (voiceInput && !voiceDisposed) {
      event.preventDefault();
      if (!voiceDisposal && !voiceDisposalFailed) {
        voiceDisposal = voiceInput.dispose().then(() => {
          voiceDisposed = true;
          app.quit();
        }).catch(error => {
          voiceDisposalFailed = true;
          runtimeError = '语音资源释放未确认';
          publish();
        });
      }
      return;
    }
    if (microphoneCaptureHost?.snapshot().busy) {
      event.preventDefault();
      void microphoneCaptureHost.revoke().then(() => app.quit()).catch(error => {
        runtimeError = error instanceof Error ? error.message : '麦克风释放未确认';
        publish();
      });
      return;
    }
    if ((runtimeApplication?.activeTaskCount ?? 0) > 0) {
      event.preventDefault();
      app.isQuitting = false;
      runtimeError = 'Runtime 仍有活动任务；请先等待完成或停止任务后再退出';
      publish();
      return;
    }
    globalShortcut.unregisterAll();
    try {
      proactiveHost?.close();
      goalCloudHost?.close();
      mailAnalysisHost?.close();
      competitionFactBridge?.close();
      if (runtimeApplication) runtimeApplication.close();
      else runtime?.close?.();
      competitionCatalog?.close();
      productTools?.close();
      codingWorkspace?.close();
      feedsHost?.close();
      void todoHost?.close();
    } catch (error) {
      event.preventDefault();
      app.isQuitting = false;
      runtimeError = error instanceof Error ? error.message : 'Runtime 仍有活动任务，无法安全退出';
      publish();
      return;
    }
    try { syntheticRepairHost?.close(); }
    catch { console.error('Synthetic repair host failed to close'); }
    microphonePermissionGate?.revoke();
    app.isQuitting = true;
    clearInterval(poll);
    clearInterval(eventPoll);
    tray?.destroy();
    runtimeConnection?.dispose?.();
  });
  app.on('window-all-closed', event => event.preventDefault());
}).catch(error => { console.error(error); app.exit(1); });
