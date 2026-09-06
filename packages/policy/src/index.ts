import { ProtocolError } from '@personal-agent/contracts';

export interface AuthorizationGrantInput {
  authorizationRef: string;
  taskId: string;
  toolName: string;
  scopes: readonly string[];
  expiresAt: string;
  maxUses?: number;
}

export interface AuthorizationRequest {
  authorizationRef: string;
  taskId: string;
  toolName: string;
  requiredScopes: readonly string[];
  now: number;
}

export interface AuthorizationDecision {
  scopes: readonly string[];
}

export interface PolicyPort {
  authorize(request: AuthorizationRequest): AuthorizationDecision;
}

export interface AuthorizationGrantView {
  authorizationRef: string;
  taskId: string;
  toolName: string;
  scopes: readonly string[];
  expiresAt: string;
  usesRemaining?: number;
}

interface StoredGrant {
  authorizationRef: string;
  taskId: string;
  toolName: string;
  scopes: string[];
  expiresAt: string;
  expiresAtMs: number;
  usesRemaining?: number;
}

const requiredText = (value: string, field: string): string => {
  const result = value.trim();
  if (!result) throw new ProtocolError('INVALID_ARGUMENT', `${field} must not be empty`);
  return result;
};

export class InMemoryAuthorizationPolicy implements PolicyPort {
  private readonly grants = new Map<string, StoredGrant>();

  grant(input: AuthorizationGrantInput): AuthorizationGrantView {
    const authorizationRef = requiredText(input.authorizationRef, 'authorizationRef');
    if (this.grants.has(authorizationRef)) {
      throw new ProtocolError('REVISION_CONFLICT', 'authorizationRef is already registered');
    }
    const taskId = requiredText(input.taskId, 'taskId');
    const toolName = requiredText(input.toolName, 'toolName');
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw new ProtocolError('INVALID_ARGUMENT', 'expiresAt must be an ISO timestamp');
    const scopes = [...new Set(input.scopes.map(scope => requiredText(scope, 'scope')))];
    if (scopes.length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'At least one scope is required');
    if (input.maxUses !== undefined && (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1)) {
      throw new ProtocolError('INVALID_ARGUMENT', 'maxUses must be a positive integer');
    }
    const grant: StoredGrant = {authorizationRef, taskId, toolName, scopes, expiresAt: input.expiresAt, expiresAtMs};
    if (input.maxUses !== undefined) grant.usesRemaining = input.maxUses;
    this.grants.set(authorizationRef, grant);
    return this.view(grant);
  }

  revoke(authorizationRef: string): boolean {
    return this.grants.delete(requiredText(authorizationRef, 'authorizationRef'));
  }

  get(authorizationRef: string): AuthorizationGrantView | undefined {
    const grant = this.grants.get(requiredText(authorizationRef, 'authorizationRef'));
    return grant ? this.view(grant) : undefined;
  }

  authorize(request: AuthorizationRequest): AuthorizationDecision {
    const grant = this.grants.get(requiredText(request.authorizationRef, 'authorizationRef'));
    if (!grant) throw new ProtocolError('UNAUTHORIZED', 'Authorization is missing or revoked');
    if (grant.taskId !== request.taskId || grant.toolName !== request.toolName) {
      throw new ProtocolError('UNAUTHORIZED', 'Authorization is not bound to this task and tool');
    }
    if (!Number.isFinite(request.now) || request.now >= grant.expiresAtMs) {
      throw new ProtocolError('UNAUTHORIZED', 'Authorization has expired');
    }
    const missing = request.requiredScopes.filter(scope => !grant.scopes.includes(scope));
    if (missing.length > 0) throw new ProtocolError('SCOPE_DENIED', `Authorization is missing scope: ${missing.join(', ')}`);
    if (grant.usesRemaining !== undefined) {
      if (grant.usesRemaining < 1) throw new ProtocolError('UNAUTHORIZED', 'Authorization usage limit is exhausted');
      grant.usesRemaining--;
    }
    return {scopes: [...grant.scopes]};
  }

  private view(grant: StoredGrant): AuthorizationGrantView {
    const view: AuthorizationGrantView = {
      authorizationRef: grant.authorizationRef,
      taskId: grant.taskId,
      toolName: grant.toolName,
      scopes: [...grant.scopes],
      expiresAt: grant.expiresAt,
    };
    if (grant.usesRemaining !== undefined) view.usesRemaining = grant.usesRemaining;
    return view;
  }
}
