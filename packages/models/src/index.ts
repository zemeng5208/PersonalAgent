import { ProtocolError, validateToolValue } from '@personal-agent/contracts';
import type { ToolDescriptor } from '@personal-agent/contracts';

export type ModelCapability = 'text' | 'streaming' | 'toolCalling' | 'structuredOutput' | 'vision';
export type Verification = 'mock' | 'verified' | 'conditional';

export interface ModelCapabilities {
  text: boolean;
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  contextLimit?: number;
  rateLimit?: {requestsPerMinute?: number; tokensPerMinute?: number};
}

export interface ModelDeployment {
  provider: string;
  deployment: string;
  model: string;
  verification: Verification;
  capabilities: ModelCapabilities;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ToolProposal {
  toolName: string;
  toolVersion: string;
  arguments: Record<string, unknown>;
}

export type ModelResponse =
  | {kind: 'final'; text: string}
  | {kind: 'tool_proposal'; proposal: ToolProposal};

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly ToolDescriptor[];
  requiredCapabilities?: readonly ModelCapability[];
  maxOutputTokens: number;
  deadline: string;
  signal: AbortSignal;
}

export interface ModelResult {
  response: ModelResponse;
  deployment: ModelDeployment;
  usage?: ModelUsage;
  latencyMs: number;
  stopReason: string;
}

export interface ModelProvider {
  readonly deployment: ModelDeployment;
  complete(request: ModelRequest): Promise<ModelResult>;
}

export type ModelPort = ModelProvider;

const allCapabilities = (): ModelCapabilities => ({
  text: true, streaming: false, toolCalling: true, structuredOutput: true, vision: false, contextLimit: 32_000,
});

const unavailableCapabilities = (): ModelCapabilities => ({
  text: false, streaming: false, toolCalling: false, structuredOutput: false, vision: false,
});

function requiredText(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new ProtocolError('INVALID_ARGUMENT', `${field} must not be empty`);
  return result;
}

function validateRequest(request: ModelRequest): void {
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
    throw new ProtocolError('INVALID_ARGUMENT', 'maxOutputTokens must be a positive integer');
  }
  if (!Number.isFinite(Date.parse(request.deadline))) throw new ProtocolError('INVALID_ARGUMENT', 'deadline must be an ISO timestamp');
  if (request.signal.aborted) throw new ProtocolError('CANCELLED', 'Model request was cancelled');
}

function supports(capabilities: ModelCapabilities, capability: ModelCapability): boolean {
  if (capability === 'text') return capabilities.text;
  if (capability === 'streaming') return capabilities.streaming;
  if (capability === 'toolCalling') return capabilities.toolCalling;
  if (capability === 'structuredOutput') return capabilities.structuredOutput;
  return capabilities.vision;
}

function validateResponse(response: ModelResponse): void {
  if (response.kind === 'final') {
    requiredText(response.text, 'model response text');
    return;
  }
  if (response.kind !== 'tool_proposal' || !response.proposal || typeof response.proposal !== 'object') {
    throw new ProtocolError('INVALID_ARGUMENT', 'Model response must be a final answer or tool proposal');
  }
}

export interface ModelCapabilityProbe {
  probe(provider: ModelProvider): Promise<ModelCapabilities>;
}

export class DeclaredCapabilityProbe implements ModelCapabilityProbe {
  async probe(provider: ModelProvider): Promise<ModelCapabilities> {
    return structuredClone(provider.deployment.capabilities);
  }
}

export class ModelCapabilityRegistry {
  private readonly deployments = new Map<string, ModelDeployment>();

  async probe(provider: ModelProvider, capabilityProbe: ModelCapabilityProbe = new DeclaredCapabilityProbe()): Promise<ModelDeployment> {
    const deployment = {...provider.deployment, capabilities: await capabilityProbe.probe(provider)};
    const key = `${deployment.provider}/${deployment.deployment}/${deployment.model}`;
    this.deployments.set(key, structuredClone(deployment));
    return structuredClone(deployment);
  }

  get(provider: string, deployment: string, model: string): ModelDeployment | undefined {
    const value = this.deployments.get(`${provider}/${deployment}/${model}`);
    return value ? structuredClone(value) : undefined;
  }
}

export class ModelGateway implements ModelPort {
  readonly deployment: ModelDeployment;

  constructor(private readonly provider: ModelProvider, deployment: ModelDeployment = provider.deployment) {
    this.deployment = structuredClone(deployment);
  }

  static async fromProvider(provider: ModelProvider, capabilityProbe: ModelCapabilityProbe = new DeclaredCapabilityProbe()): Promise<ModelGateway> {
    const capabilities = await capabilityProbe.probe(provider);
    return new ModelGateway(provider, {...provider.deployment, capabilities});
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    validateRequest(request);
    const required = new Set<ModelCapability>(request.requiredCapabilities ?? ['text']);
    if (request.tools.length > 0) {
      required.add('toolCalling');
      required.add('structuredOutput');
    }
    for (const capability of required) {
      if (!supports(this.deployment.capabilities, capability)) {
        throw new ProtocolError('UNSUPPORTED_CAPABILITY', `${this.deployment.provider}/${this.deployment.model} does not support ${capability}`);
      }
    }
    const result = await this.provider.complete({...request, tools: structuredClone(request.tools)});
    validateResponse(result.response);
    if (result.deployment.provider !== this.deployment.provider || result.deployment.deployment !== this.deployment.deployment || result.deployment.model !== this.deployment.model) {
      throw new ProtocolError('EXTERNAL_FAILURE', 'Model provider returned a different deployment identity');
    }
    if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0) throw new ProtocolError('EXTERNAL_FAILURE', 'Model provider returned an invalid latency');
    return structuredClone(result);
  }
}

export class FakeModelProvider implements ModelProvider {
  readonly deployment: ModelDeployment;
  private cursor = 0;
  private readonly seenRequests: ModelRequest[] = [];

  constructor(
    private readonly steps: readonly (ModelResponse | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>))[],
    deployment: Partial<ModelDeployment> = {},
  ) {
    this.deployment = {
      provider: deployment.provider ?? 'fake', deployment: deployment.deployment ?? 'fake-deployment', model: deployment.model ?? 'fake-model',
      verification: deployment.verification ?? 'mock', capabilities: deployment.capabilities ?? allCapabilities(),
    };
  }

  get requests(): readonly ModelRequest[] { return this.seenRequests; }

  static async fromProvider(provider: ModelProvider, capabilityProbe: ModelCapabilityProbe = new DeclaredCapabilityProbe()): Promise<ModelGateway> {
    const capabilities = await capabilityProbe.probe(provider);
    return new ModelGateway(provider, {...provider.deployment, capabilities});
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    validateRequest(request);
    this.seenRequests.push({...request, messages: request.messages.map(message => ({...message})), tools: request.tools.map(tool => structuredClone(tool))});
    const step = this.steps[this.cursor++];
    if (!step) throw new ProtocolError('EXTERNAL_FAILURE', 'Fake model has no response step remaining');
    const response = typeof step === 'function' ? await step(request) : step;
    validateResponse(response);
    return {response: structuredClone(response), deployment: structuredClone(this.deployment), usage: {promptTokens: 1, completionTokens: 1, totalTokens: 2}, latencyMs: 0, stopReason: 'fixture'};
  }
}

export class UnavailableModelProvider implements ModelProvider {
  readonly deployment: ModelDeployment;

  constructor(provider = 'unavailable', model = 'not-configured') {
    this.deployment = {provider, deployment: 'not-configured', model, verification: 'conditional', capabilities: unavailableCapabilities()};
  }

  async complete(_request: ModelRequest): Promise<ModelResult> {
    throw new ProtocolError('UNSUPPORTED_CAPABILITY', `${this.deployment.provider} model provider is not configured`);
  }
}

/** Real Pangu endpoint/SDK details are deliberately deferred to an authorized integration task. */
export class PanguModelProvider extends UnavailableModelProvider {
  constructor() { super('pangu', 'not-configured'); }
}

export function validateToolProposal(value: unknown): ToolProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('INVALID_ARGUMENT', 'Tool proposal must be an object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'arguments,toolName,toolVersion') throw new ProtocolError('UNAUTHORIZED', 'Tool proposal contains fields outside the tool contract');
  const args = record.arguments;
  if (typeof record.toolName !== 'string' || typeof record.toolVersion !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Tool proposal has invalid fields');
  }
  return {toolName: requiredText(record.toolName, 'toolName'), toolVersion: requiredText(record.toolVersion, 'toolVersion'), arguments: structuredClone(args as Record<string, unknown>)};
}

export function validateToolArguments(descriptor: ToolDescriptor, value: unknown): void {
  validateToolValue(descriptor.inputSchema, value);
}
