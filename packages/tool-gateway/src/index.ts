import { ProtocolError, validateContract, validateToolValue } from '@personal-agent/contracts';
import type { RegisteredTool, ToolContext, ToolDescriptor, ToolHost } from '@personal-agent/contracts';
import type { PolicyPort } from '@personal-agent/policy';

export interface ToolInvocation {
  toolName: string;
  toolVersion: string;
  arguments: unknown;
  taskId: string;
  runId: string;
  authorizationRef: string;
  deadline: string;
  signal: AbortSignal;
  userPresent?: boolean;
}

export interface ToolGatewayOptions {
  policy: PolicyPort;
  now?: () => number;
}

const requiredText = (value: string, field: string): string => {
  const result = value.trim();
  if (!result) throw new ProtocolError('INVALID_ARGUMENT', `${field} must not be empty`);
  return result;
};

export class ToolGateway implements ToolHost {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly now: () => number;

  constructor(private readonly options: ToolGatewayOptions) {
    this.now = options.now ?? Date.now;
  }

  register(tool: RegisteredTool): () => void {
    validateContract('tool', tool.descriptor);
    if (this.tools.has(tool.descriptor.name)) {
      throw new ProtocolError('REVISION_CONFLICT', `Tool ${tool.descriptor.name} is already registered`);
    }
    this.tools.set(tool.descriptor.name, tool);
    return () => {
      if (this.tools.get(tool.descriptor.name) === tool) this.tools.delete(tool.descriptor.name);
    };
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map(tool => structuredClone(tool.descriptor));
  }

  async invoke(invocation: ToolInvocation): Promise<unknown> {
    const toolName = requiredText(invocation.toolName, 'toolName');
    const taskId = requiredText(invocation.taskId, 'taskId');
    const runId = requiredText(invocation.runId, 'runId');
    const tool = this.tools.get(toolName);
    if (!tool) throw new ProtocolError('UNSUPPORTED_CAPABILITY', `Tool ${toolName} is not registered`);
    if (tool.descriptor.version !== invocation.toolVersion) {
      throw new ProtocolError('PROTOCOL_MISMATCH', `Tool ${toolName} version ${invocation.toolVersion} is not available`);
    }
    if (invocation.signal.aborted) throw new ProtocolError('CANCELLED', 'Tool invocation was cancelled before execution');
    const deadlineMs = Date.parse(invocation.deadline);
    const remaining = deadlineMs - this.now();
    if (!Number.isFinite(deadlineMs) || remaining <= 0) throw new ProtocolError('TIMEOUT', 'Tool deadline expired before execution');
    if (tool.descriptor.requiresPresence && invocation.userPresent !== true) {
      throw new ProtocolError('UNAUTHORIZED', 'Tool requires the user to be present');
    }

    validateToolValue(tool.descriptor.inputSchema, invocation.arguments);
    const decision = this.options.policy.authorize({
      authorizationRef: requiredText(invocation.authorizationRef, 'authorizationRef'),
      taskId,
      toolName,
      requiredScopes: tool.descriptor.requiredScopes,
      now: this.now(),
    });

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = (): void => {};
    const interruption = new Promise<never>((_, reject) => {
      const rejectFor = (code: 'CANCELLED' | 'TIMEOUT', message: string): void => {
        controller.abort();
        if (tool.descriptor.sideEffect === 'external_write') {
          reject(new ProtocolError('RESULT_UNKNOWN', `${message}; reconcile the external result before retrying`));
          return;
        }
        reject(new ProtocolError(code, message));
      };
      onAbort = () => rejectFor('CANCELLED', 'Tool invocation was cancelled');
      invocation.signal.addEventListener('abort', onAbort, {once: true});
      timer = setTimeout(() => rejectFor('TIMEOUT', 'Tool invocation exceeded its deadline'), Math.min(remaining, 2_147_483_647));
      if (invocation.signal.aborted) onAbort();
    });

    const context: ToolContext = {
      taskId,
      runId,
      signal: controller.signal,
      deadline: invocation.deadline,
      authorizationRef: invocation.authorizationRef,
      scopes: decision.scopes,
    };
    try {
      const result = await Promise.race([
        tool.execute(structuredClone(invocation.arguments), context),
        interruption,
      ]);
      validateToolValue(tool.descriptor.outputSchema, result);
      return structuredClone(result);
    } finally {
      if (timer) clearTimeout(timer);
      invocation.signal.removeEventListener('abort', onAbort);
    }
  }
}
