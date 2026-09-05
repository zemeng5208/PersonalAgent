import type {ToolDescriptor,ConnectorManifest,ProtocolContracts} from './index.js';
export interface StoragePort {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
export interface ToolContext {
  taskId: string;
  runId: string;
  signal: AbortSignal;
  deadline: string;
  authorizationRef: string;
  scopes: readonly string[];
}
export interface RegisteredTool {
  descriptor: ToolDescriptor;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}
export interface ToolHost { register(tool: RegisteredTool): () => void }
export interface ConnectorPort {
  readonly manifest: ConnectorManifest;
  connect(): {sessionRef: string; interactionRequired: boolean} | Promise<{sessionRef: string; interactionRequired: boolean}>;
  disconnect(): {disconnected: boolean; cleanupState: string} | Promise<{disconnected: boolean; cleanupState: string}>;
  getCapabilities(): string[];
  fetchChanges(input: {accountRef: string; cursor?: string; limit: number}): {items: ProtocolContracts['connectorItem'][]; nextCursor: string; hasMore: boolean} | Promise<{items: ProtocolContracts['connectorItem'][]; nextCursor: string; hasMore: boolean}>;
  search(accountRef: string, query: string): ProtocolContracts['connectorItem'][] | Promise<ProtocolContracts['connectorItem'][]>;
  getItem(accountRef: string, id: string): ProtocolContracts['connectorItem'] | Promise<ProtocolContracts['connectorItem']>;
  performAction(input: {accountRef: string; action: string; input: unknown; idempotencyKey: string}): ProtocolContracts['connectorAction'] | Promise<ProtocolContracts['connectorAction']>;
  health(): {state: 'disconnected' | 'connecting' | 'ready' | 'reauth_required' | 'degraded' | 'unavailable'};
}
