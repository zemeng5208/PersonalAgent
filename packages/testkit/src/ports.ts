import { ProtocolError, validateContract, validateToolValue } from '@personal-agent/contracts';
import type { ConnectorManifest, ProtocolContracts, StoragePort, ToolContext, RegisteredTool, ToolHost, ConnectorPort } from '@personal-agent/contracts';
export class FakeClock {
  constructor(private time = Date.parse('2026-09-05T12:00:00.000Z')) {}
  readonly now = (): number => this.time;
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid clock increment');
    this.time += ms;
  }
}
export class FakeStorage {
  private namespaces = new Map<string, Map<string, unknown>>();
  namespace(name: string): StoragePort {
    let data = this.namespaces.get(name);
    if (!data) { data = new Map(); this.namespaces.set(name, data); }
    return {
      get: key => structuredClone(data.get(key)),
      set: (key, value) => { data.set(key, structuredClone(value)); },
      delete: key => { data.delete(key); },
    };
  }
}
export class FakeToolHost implements ToolHost {
  readonly verification = 'mock';
  private tools = new Map<string, RegisteredTool>();
  constructor(private readonly now: () => number = Date.now) {}
  register(tool: RegisteredTool): () => void {
    validateContract('tool', tool.descriptor);
    if (this.tools.has(tool.descriptor.name)) throw new Error('Duplicate tool');
    this.tools.set(tool.descriptor.name, tool);
    return () => { this.tools.delete(tool.descriptor.name); };
  }
  async invoke(name: string, input: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Tool not registered');
    if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Tool cancelled');
    if (!Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline) <= this.now()) throw new ProtocolError('TIMEOUT', 'Tool deadline expired');
    if (!tool.descriptor.requiredScopes.every(scope => context.scopes.includes(scope))) throw new ProtocolError('SCOPE_DENIED', 'Missing scope');
    validateToolValue(tool.descriptor.inputSchema, input);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => { controller.abort(); reject(new ProtocolError('CANCELLED', 'Tool cancelled; reconcile any side effects')); };
      context.signal.addEventListener('abort', cancel, {once: true});
      timer = setTimeout(() => { controller.abort(); reject(new ProtocolError('TIMEOUT', 'Tool timed out; reconcile any side effects')); }, Math.min(Date.parse(context.deadline) - this.now(), 2147483647));
    });
    try {
      const result = await Promise.race([tool.execute(structuredClone(input), {...context, signal: controller.signal}), stopped]);
      validateToolValue(tool.descriptor.outputSchema, result);
      return structuredClone(result);
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);
    }
  }
}
export class FakeConnector implements ConnectorPort {
  readonly manifest: ConnectorManifest = {
    id: 'fake-notes', version: '0.1.0', accountTypes: ['fixture'], capabilities: ['search','fetchChanges','getItem'],
    configSchema: {type: 'object'}, authentication: 'none', requiresPresence: false, syncStrategy: 'manual', verification: 'mock',
  };
  private connected = false;
  constructor(private readonly items: ProtocolContracts['connectorItem'][] = []) {
    for (const item of items) validateContract('connectorItem', item);
  }
  connect(): {sessionRef: string; interactionRequired: boolean} { this.connected = true; return {sessionRef:'fake-session', interactionRequired:false}; }
  disconnect(): {disconnected: boolean; cleanupState: string} { this.connected = false; return {disconnected:true, cleanupState:'complete'}; }
  getCapabilities(): string[] { return [...this.manifest.capabilities]; }
  health(): {state: 'ready' | 'disconnected'} { return {state: this.connected ? 'ready' : 'disconnected'}; }
  private check(): void { if (!this.connected) throw new ProtocolError('UNAUTHORIZED', 'Fake connector disconnected'); }
  fetchChanges(input: {accountRef: string; cursor?: string; limit: number}): {items: ProtocolContracts['connectorItem'][]; nextCursor: string; hasMore: boolean} {
    this.check();
    const offset = Number(input.cursor ?? '0');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid pagination');
    const scoped = this.items.filter(item => item.accountRef === input.accountRef);
    const items = scoped.slice(offset, offset + input.limit);
    return {items: structuredClone(items), nextCursor: String(offset + items.length), hasMore: offset + items.length < scoped.length};
  }
  search(accountRef: string, query: string): ProtocolContracts['connectorItem'][] { this.check(); return structuredClone(this.items.filter(item => item.accountRef === accountRef && item.contentRef.includes(query))); }
  getItem(accountRef: string, id: string): ProtocolContracts['connectorItem'] {
    this.check(); const item = this.items.find(item => item.accountRef === accountRef && item.externalId === id);
    if (!item) throw new ProtocolError('NOT_FOUND', 'Item not found');
    return structuredClone(item);
  }
  performAction(): never { throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Fixture connector is read only'); }
}
