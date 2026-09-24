import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {RegisteredTool, ToolDescriptor, ToolHost} from '@personal-agent/contracts';
import type {KnowledgePort} from './index.js';

export const KNOWLEDGE_SEARCH_TOOL_NAME = 'knowledge.search';
export const KNOWLEDGE_SEARCH_TOOL_VERSION = '0.1.0-alpha.1';
export const KNOWLEDGE_READ_SCOPE = 'knowledge:read';

const inputSchema: ToolDescriptor['inputSchema'] = {
  type: 'object',
  required: ['query', 'limit'],
  additionalProperties: false,
  properties: {
    query: {type: 'string', minLength: 1, maxLength: 128, pattern: '\\S'},
    limit: {type: 'integer', minimum: 1, maximum: 20}
  }
};

const outputSchema: ToolDescriptor['outputSchema'] = {
  type: 'object',
  required: ['hits', 'truncated'],
  additionalProperties: false,
  properties: {
    hits: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['source', 'excerpt'],
        additionalProperties: false,
        properties: {
          source: {
            type: 'object',
            required: ['vaultId', 'path', 'line', 'revision'],
            additionalProperties: false,
            properties: {
              vaultId: {type: 'string', minLength: 1, maxLength: 128},
              path: {type: 'string', minLength: 1, maxLength: 1024},
              line: {type: 'integer', minimum: 1},
              revision: {type: 'string', pattern: '^[0-9a-f]{64}$'}
            }
          },
          excerpt: {type: 'string', maxLength: 320}
        }
      }
    },
    truncated: {type: 'boolean'}
  }
};

/** The trusted host injects a scope-bound port; this does not authorize or open a Vault. */
export function createKnowledgeSearchTool(port: KnowledgePort): RegisteredTool {
  if (!port || typeof port.search !== 'function') {
    throw new ProtocolError('INVALID_ARGUMENT', 'Knowledge provider must be explicitly configured');
  }
  const descriptor: ToolDescriptor = {
    name: KNOWLEDGE_SEARCH_TOOL_NAME,
    version: KNOWLEDGE_SEARCH_TOOL_VERSION,
    inputSchema,
    outputSchema,
    sideEffect: 'read',
    requiredScopes: [KNOWLEDGE_READ_SCOPE],
    idempotencySupport: true,
    recoverySupport: true,
    requiresPresence: false
  };
  return {
    descriptor,
    execute: async (input, context) => {
      validateToolValue(inputSchema, input);
      if (!context.scopes.includes(KNOWLEDGE_READ_SCOPE)) {
        throw new ProtocolError('SCOPE_DENIED', 'Knowledge read scope is required');
      }
      const request = input as {query: string; limit: number};
      return port.search({
        query: request.query,
        limit: request.limit,
        deadline: context.deadline,
        signal: context.signal
      });
    }
  };
}

export function register(host: ToolHost, port: KnowledgePort): () => void {
  return host.register(createKnowledgeSearchTool(port));
}
