import { ProtocolError } from '@personal-agent/contracts';
import type { ConnectorManifest, ConnectorPort } from '@personal-agent/contracts';
import type { GitHubService } from './service.js';
import { githubOperations } from './provider.js';
export const GITHUB_CONNECTOR_VERSION = '0.1.0-alpha.1';
/** ConnectorPort lacks execution context: operations use registered tools. */
export class GitHubConnector implements ConnectorPort {
  readonly manifest: ConnectorManifest;
  private connected = false;
  constructor(private readonly service: GitHubService) {
    this.manifest = {id: 'github', version: GITHUB_CONNECTOR_VERSION, accountTypes: ['github'], capabilities: [...githubOperations], configSchema: {type: 'object', properties: {repositories: {type: 'array', minItems: 1, items: {type: 'string'}}}, required: ['repositories'], additionalProperties: false}, authentication: 'host-injected-token', requiresPresence: false, syncStrategy: 'on-demand', verification: service.provider.verification};
  }
  connect(): {sessionRef: string; interactionRequired: boolean} { this.connected = true; return {sessionRef: 'github:configured', interactionRequired: false}; }
  disconnect(): {disconnected: boolean; cleanupState: string} { this.connected = false; this.service.dispose(); return {disconnected: true, cleanupState: 'complete'}; }
  getCapabilities(): string[] { return [...this.manifest.capabilities]; }
  health(): {state: 'disconnected' | 'unavailable'} { return {state: this.connected ? 'unavailable' : 'disconnected'}; }
  fetchChanges(): never { throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'GitHub has no incremental sync'); }
  search(): never { throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Use GitHub registered tools through Runtime'); }
  getItem(): never { throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Use GitHub registered tools through Runtime'); }
  performAction(): never { throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Writes require Runtime Policy and ToolGateway context'); }
}
