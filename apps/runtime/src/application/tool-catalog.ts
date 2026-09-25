import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {ToolDescriptor} from '@personal-agent/contracts';
import type {AgentToolPort} from '@personal-agent/agents';
import {Buffer} from 'node:buffer';
import type {TaskRuntime} from '../index.js';
import type {CompetitionToolExport} from './coordination.js';

const CHECKPOINT = 'competition-tool-catalog';
const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const MAX_ENTRIES = 16;
const MAX_CATALOG_BYTES = 12_288;

export interface CompetitionToolAvailability {
  toolName: string;
  toolVersion: string;
  /** Trusted host health and scope check; registration alone never means ready. */
  available(input: {taskId: string; deadline: string; signal: AbortSignal}): boolean | Promise<boolean>;
}

export interface CompetitionAvailableTool {
  name: string;
  version: string;
  inputSchema: Record<string, unknown>;
}

function safeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Tool input Schema cannot be projected');
  }
  const schema = value as Record<string, unknown>;
  const type = schema.type;
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(type as string)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Tool input Schema type is unavailable');
  }
  const result: Record<string, unknown> = {type};
  if (type === 'object') {
    const properties = schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Tool object Schema requires properties');
    }
    const projected: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(properties)) {
      if (!NAME.test(name)) throw new ProtocolError('INVALID_ARGUMENT', 'Unsafe tool parameter name');
      projected[name] = safeSchema(child, depth + 1);
    }
    result.properties = projected;
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some(item => typeof item !== 'string' || !(item in projected))) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Invalid required tool parameters');
    }
    result.required = [...required];
    result.additionalProperties = false;
  } else if (type === 'array') {
    result.items = safeSchema(schema.items, depth + 1);
  }
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) {
    const number = schema[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) result[key] = number;
  }
  return result;
}

export class RuntimeCompetitionToolCatalog {
  constructor(
    private readonly runtime: TaskRuntime,
    private readonly tools: AgentToolPort,
    private readonly exports: readonly CompetitionToolExport[],
    private readonly availability: readonly CompetitionToolAvailability[],
  ) {
    const names = new Set<string>();
    for (const entry of availability) {
      const key = JSON.stringify([entry.toolName, entry.toolVersion]);
      if (!NAME.test(entry.toolName) || !NAME.test(entry.toolVersion)
        || typeof entry.available !== 'function' || names.has(key)) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Invalid Competition tool availability binding');
      }
      names.add(key);
    }
  }

  private async ready(binding: CompetitionToolAvailability, input: {taskId: string; deadline: string; signal: AbortSignal}): Promise<boolean> {
    if (input.signal.aborted) throw new ProtocolError('CANCELLED', 'Tool catalog selection cancelled');
    const remaining = Date.parse(input.deadline) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new ProtocolError('TIMEOUT', 'Tool catalog selection expired');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = (): void => {};
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProtocolError('CANCELLED', 'Tool catalog selection cancelled'));
      input.signal.addEventListener('abort', onAbort, {once: true});
      timer = setTimeout(() => reject(new ProtocolError('TIMEOUT', 'Tool catalog selection expired')), Math.min(remaining, 2_147_483_647));
    });
    try {
      return await Promise.race([Promise.resolve().then(async () => await binding.available(input) === true), interrupted]);
    } catch (error) {
      if (error instanceof ProtocolError && ['CANCELLED', 'TIMEOUT'].includes(error.code)) throw error;
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
    }
  }

  async prepare(input: {taskId: string; deadline: string; signal: AbortSignal}): Promise<CompetitionAvailableTool[]> {
    if (this.runtime.getTask(input.taskId).state !== 'running'
      || this.runtime.loadCheckpoint(input.taskId, 'application-profile') !== 'huawei_ict_agentarts'
      || this.runtime.loadCheckpoint(input.taskId, 'application-deadline') !== input.deadline) {
      throw new ProtocolError('UNAUTHORIZED', 'Tool catalog is not bound to the running Competition task');
    }
    const saved = this.runtime.loadCheckpoint(input.taskId, CHECKPOINT) as CompetitionAvailableTool[] | undefined;
    if (saved) return structuredClone(saved);
    const descriptors = this.tools.list();
    const selected: CompetitionAvailableTool[] = [];
    for (const binding of this.availability) {
      const descriptor = descriptors.find(item => item.name === binding.toolName && item.version === binding.toolVersion);
      if (!descriptor || descriptor.sideEffect !== 'read'
        || !this.exports.some(item => item.toolName === binding.toolName && item.toolVersion === binding.toolVersion)) continue;
      if (!await this.ready(binding, input)) continue;
      selected.push({name: descriptor.name, version: descriptor.version, inputSchema: safeSchema(descriptor.inputSchema)});
      if (selected.length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(selected), 'utf8') > MAX_CATALOG_BYTES) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Competition tool catalog exceeds its limit');
      }
    }
    this.runtime.saveCheckpoint(input.taskId, CHECKPOINT, selected);
    return structuredClone(selected);
  }

  /** A cloud proposal must match the persisted selection and the original local Schema. */
  async assertProposal(input: {taskId: string; toolName: string; toolVersion: string;
    arguments: Record<string, unknown>; deadline: string; signal: AbortSignal}): Promise<void> {
    const selected = this.runtime.loadCheckpoint(input.taskId, CHECKPOINT) as CompetitionAvailableTool[] | undefined;
    const entry = selected?.find(item => item.name === input.toolName && item.version === input.toolVersion);
    const binding = this.availability.find(item => item.toolName === input.toolName && item.toolVersion === input.toolVersion);
    const descriptor: ToolDescriptor | undefined = this.tools.list().find(item => item.name === input.toolName && item.version === input.toolVersion);
    if (!entry || !binding || !descriptor || descriptor.sideEffect !== 'read'
      || !await this.ready(binding, input)) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition tool is unavailable for this task');
    validateToolValue(descriptor.inputSchema, input.arguments);
  }
}
