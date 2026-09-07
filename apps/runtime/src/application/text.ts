import { runAgent } from '@personal-agent/agents';
import type { AgentToolPort, AgentWorkerContext, AgentWorkerResult } from '@personal-agent/agents';
import {
  FakeModelProvider,
  ModelGateway,
  PanguModelProvider,
  UnavailableModelProvider,
  StructuredToolProvider,
} from '@personal-agent/models';
import type {
  ModelDeployment,
  ModelGateway as ModelGatewayType,
  ModelProvider,
  ModelRequest,
  ModelResult,
} from '@personal-agent/models';
import type { TaskSnapshot } from '@personal-agent/contracts';

const NO_TOOLS: AgentToolPort = {
  list: () => [],
  invoke: async () => { throw new Error('Text chat does not register tools'); },
};

export type TextModelMode = 'fake' | 'pangu' | 'unavailable';

export interface TextApplicationOptions {
  tools?: AgentToolPort;
  mode?: TextModelMode;
  provider?: ModelProvider | ModelGatewayType;
  baseUrl?: string;
  model?: string;
  deployment?: string;
  apiKey?: () => string | Promise<string>;
}

export interface TextTaskRuntime {
  runTask(
    taskId: string,
    worker: (context: AgentWorkerContext) => Promise<AgentWorkerResult>,
    options: {deadline: string; sideEffect: 'read' | 'external_write'; resume?: boolean},
  ): Promise<TaskSnapshot>;
}

export interface TextTaskOptions {
  tools?: AgentToolPort;
  resume?: boolean;
  now?: () => number;
  deadlineMs?: number;
  maxTokens?: number;
}

export interface TextConnectionTestOptions {
  now?: () => number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface TextApplication {
  readonly deployment: ModelDeployment;
  startTask(runtime: TextTaskRuntime, taskId: string, goal: string, options?: TextTaskOptions): Promise<TaskSnapshot>;
  testConnection(options?: TextConnectionTestOptions): Promise<ModelResult>;
}

/**
 * Fake text provider for offline UI and Runtime acceptance. It is only selected when the caller
 * explicitly asks for `mode: 'fake'`; a missing Pangu configuration never falls back to it.
 */
export function createFakeTextProvider(): FakeModelProvider {
  const response = (request: ModelRequest) => ({kind: 'final' as const, text: `Fake Model 回答：${request.messages.at(-1)?.content ?? ''}`});
  return new FakeModelProvider(Array.from({length: 32}, () => response), {
    provider: 'fake', deployment: 'desktop-fake-text', model: 'fake-text-model', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false},
  });
}

function createProvider(options: TextApplicationOptions): ModelProvider | ModelGatewayType {
  if (options.provider) return options.provider;
  const mode = options.mode ?? 'unavailable';
  if (mode === 'fake') return createFakeTextProvider();
  if (mode === 'pangu') {
    if (!options.apiKey) throw new Error('Pangu text application requires an API key provider');
    const provider = new PanguModelProvider({
      baseUrl: options.baseUrl ?? '',
      model: options.model ?? '',
      ...(options.deployment === undefined ? {} : {deployment: options.deployment}),
      apiKey: options.apiKey,
    });
    return options.tools ? new StructuredToolProvider(provider) : provider;
  }
  return new UnavailableModelProvider('pangu', options.model ?? 'not-configured');
}

function toModelGateway(provider: ModelProvider | ModelGatewayType): ModelGatewayType {
  return provider instanceof ModelGateway ? provider : new ModelGateway(provider);
}

function deadline(now: () => number, durationMs: number): string {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw new Error('Text task deadlineMs must be a positive integer');
  return new Date(now() + durationMs).toISOString();
}

export function startTextTask(
  runtime: TextTaskRuntime,
  taskId: string,
  goal: string,
  provider: ModelProvider | ModelGatewayType,
  options: TextTaskOptions = {},
): Promise<TaskSnapshot> {
  const model = toModelGateway(provider);
  const now = options.now ?? Date.now;
  const taskDeadline = deadline(now, options.deadlineMs ?? 30_000);
  return runtime.runTask(taskId, context => runAgent(context, {
    goal,
    model,
    tools: options.tools ?? NO_TOOLS,
    authorizationRefFor: () => 'runtime-text-chat-no-tools',
    maxSteps: options.tools ? 8 : 1,
    maxTokens: options.maxTokens ?? 512,
  }), {deadline: taskDeadline, sideEffect: options.tools?.list().some(tool => tool.sideEffect !== 'read') ? 'external_write' : 'read', ...(options.resume ? {resume: true} : {})});
}

export function createTextApplication(options: TextApplicationOptions): TextApplication {
  const model = toModelGateway(createProvider(options));
  return {
    deployment: structuredClone(model.deployment),
    startTask(runtime, taskId, goal, taskOptions = {}) {
      return startTextTask(runtime, taskId, goal, model, {...taskOptions, ...(options.tools ? {tools: options.tools} : {})});
    },
    async testConnection(testOptions = {}) {
      const now = testOptions.now ?? Date.now;
      const signal = testOptions.signal ?? new AbortController().signal;
      const request: ModelRequest = {
        messages: [{role: 'user', content: 'Reply with exactly OK.'}],
        tools: [],
        maxOutputTokens: 4,
        deadline: deadline(now, testOptions.deadlineMs ?? 15_000),
        signal,
      };
      return model.complete(request);
    },
  };
}
