// Generated from schema/protocol.json. Do not edit.

export type TaskState =
  | "created"
  | "planning"
  | "running"
  | "waiting_approval"
  | "waiting_external"
  | "waiting_reconciliation"
  | "verifying"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ProtocolContracts {
  request:
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "system.handshake";
        payload: {
          supportedMajor: number;
          clientCapabilities: string[];
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey: string;
        operation: "task.submit";
        payload: {
          goal: string;
          conversationId: string;
          attachmentRefs?: string[];
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "task.get";
        payload: {
          taskId: string;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "task.cancel";
        payload: {
          taskId: string;
          reason?: string;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "event.subscribe";
        payload: {
          streamId: string;
          afterSequence?: number;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "capability.list";
        payload: {
          kind?: string;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "settings.get";
        payload: {
          namespace: string;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "settings.update";
        payload: {
          namespace: string;
          expectedRevision: number;
          patch: {
            [k: string]: unknown;
          };
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "authorization.respond";
        payload: {
          approvalId: string;
          decision: "allow_once" | "deny";
          expectedRevision: number;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "tool.invoke";
        payload: {
          toolName: string;
          toolVersion: string;
          arguments: {
            [k: string]: unknown;
          };
          scopeRef: string;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "connector.connect";
        payload: {
          connectorId: string;
          accountLabel: string;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "connector.disconnect";
        payload: {
          accountRef: string;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "voice.start";
        payload: {
          mode: "push_to_talk";
          deviceRef: string;
        };
      }
    | {
        kind: "request";
        protocolVersion: string;
        requestId: string;
        taskId?: string;
        deadline: string;
        idempotencyKey?: string;
        operation: "voice.stop";
        payload: {
          voiceSessionId: string;
          reason: string;
        };
      };
  response:
    | {
        kind: "response";
        protocolVersion: string;
        requestId: string;
        outcome: "ok";
        data: unknown;
        evidenceRefs: string[];
      }
    | {
        kind: "response";
        protocolVersion: string;
        requestId: string;
        outcome: "error";
        error: Error;
        evidenceRefs: string[];
      };
  event:
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "task.created";
        occurredAt: string;
        payload: TaskSnapshot;
      }
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "task.state_changed";
        occurredAt: string;
        payload: TaskSnapshot;
      }
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "task.progress";
        occurredAt: string;
        payload: {
          stepId: string;
          label: string;
          completedUnits?: number;
          totalUnits?: number;
        };
      }
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "task.completed";
        occurredAt: string;
        payload: TaskSnapshot;
      }
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "task.failed";
        occurredAt: string;
        payload: TaskSnapshot;
      }
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "task.cancelled";
        occurredAt: string;
        payload: TaskSnapshot;
      }
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "approval.requested";
        occurredAt: string;
        payload: {
          approvalId: string;
          taskId: string;
          revision: number;
          action: string;
        };
      }
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "tool.completed";
        occurredAt: string;
        payload: {
          runId: string;
          state: "confirmed" | "pending" | "unknown";
          evidenceRefs: string[];
        };
      }
    | {
        kind: "event";
        protocolVersion: string;
        eventId: string;
        streamId: string;
        sequence: number;
        taskId?: string;
        type: "notification.created";
        occurredAt: string;
        payload: {
          notificationId: string;
          summary: string;
        };
      };
  results: {
    "system.handshake": {
      protocolVersion: string;
      capabilities: string[];
      sessionRef: string;
    };
    "task.submit": {
      taskId: string;
      state: TaskState;
      revision: number;
    };
    "task.get": TaskSnapshot;
    "task.cancel": {
      taskId: string;
      state: TaskState;
      cancelAccepted: boolean;
    };
    "event.subscribe": {
      subscriptionId: string;
      replayFrom: number;
    };
    "capability.list": {
      manifests: (ToolDescriptor | ConnectorManifest)[];
      health: {
        id: string;
        state: "disconnected" | "connecting" | "ready" | "reauth_required" | "degraded" | "unavailable";
        lastSuccessAt?: string;
        reason?: string;
      }[];
    };
    "settings.get": {
      value: {
        [k: string]: unknown;
      };
      revision: number;
    };
    "settings.update": {
      revision: number;
    };
    "authorization.respond": {
      accepted: boolean;
      approvalState: "allowed" | "denied";
    };
    "tool.invoke": {
      runId: string;
      state: "confirmed" | "pending" | "unknown";
      result?: unknown;
      evidenceRefs: string[];
    };
    "connector.connect": {
      sessionRef: string;
      interactionRequired: boolean;
    };
    "connector.disconnect": {
      disconnected: boolean;
      cleanupState: string;
    };
    "voice.start": {
      voiceSessionId: string;
      audioFormat: string;
    };
    "voice.stop": {
      captureStopped: boolean;
      playbackStopped: boolean;
    };
  };
  snapshot: TaskSnapshot;
  tool: ToolDescriptor;
  connector: ConnectorManifest;
  evidence: Evidence;
  connectorItem: ConnectorItem;
  connectorAction: ConnectorAction;
}
export interface Error {
  code:
    | "INVALID_ARGUMENT"
    | "PROTOCOL_MISMATCH"
    | "UNAUTHORIZED"
    | "SCOPE_DENIED"
    | "NOT_FOUND"
    | "UNSUPPORTED_CAPABILITY"
    | "REVISION_CONFLICT"
    | "RATE_LIMITED"
    | "TIMEOUT"
    | "EXTERNAL_FAILURE"
    | "RESULT_UNKNOWN"
    | "CURSOR_EXPIRED"
    | "CANCELLED";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}
export interface TaskSnapshot {
  taskId: string;
  state: TaskState;
  revision: number;
  updatedAt: string;
  steps: {
    stepId: string;
    label: string;
    state: string;
  }[];
  evidenceRefs: string[];
  resultSummary?: string;
  error?: Error;
  cancelRequested?: boolean;
}
export interface ToolDescriptor {
  name: string;
  version: string;
  inputSchema: {
    [k: string]: unknown;
  };
  outputSchema: {
    [k: string]: unknown;
  };
  sideEffect: "read" | "local_write" | "external_write";
  requiredScopes: string[];
  idempotencySupport: boolean;
  recoverySupport: boolean;
  requiresPresence: boolean;
}
export interface ConnectorManifest {
  id: string;
  version: string;
  accountTypes: string[];
  capabilities: string[];
  configSchema: {
    [k: string]: unknown;
  };
  authentication: string;
  requiresPresence: boolean;
  syncStrategy: string;
  verification: "mock" | "verified" | "conditional";
}
export interface Evidence {
  evidenceId: string;
  kind: "observation" | "source" | "execution";
  sourceRef: string;
  capturedAt: string;
  summary: string;
  verification: "mock" | "verified" | "conditional";
  sensitivity: string;
}
export interface ConnectorItem {
  source: string;
  accountRef: string;
  externalId: string;
  occurredAt: string;
  fetchedAt: string;
  contentRef: string;
  sensitivity: string;
  dedupeKey: string;
  validFor?: string;
}
export interface ConnectorAction {
  actionId: string;
  state: "confirmed" | "pending" | "unknown";
  externalId?: string;
  evidenceRefs: string[];
}
