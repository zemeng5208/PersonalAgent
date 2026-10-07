import {
  AgentArtsCloudAgentPort,
  CompetitionCoordinator,
  type AgentArtsAuthorizationProvider,
  type AgentArtsFailureDiagnostic,
  type AgentArtsFetch,
  type CoordinationRequest,
} from '@personal-agent/coordination';
import {ProtocolError} from '@personal-agent/contracts';
import {createHash} from 'node:crypto';
import {
  createRuntimeApplication,
  type RuntimeApplication,
  type RuntimeApplicationOptions,
} from './runtime-application.js';

export interface AgentArtsRuntimeApplicationOptions
  extends Omit<RuntimeApplicationOptions, 'profile' | 'coordination' | 'text'> {
  gatewayUrl: string;
  runtimeName: string;
  invokeMode?: 'debug' | 'published';
  workflowGoalInput?: string;
  responseMode?: 'text' | 'tool-proposal-json';
  initialRequestMode?: 'goal' | 'goal-with-tools-json';
  authorizationProvider: AgentArtsAuthorizationProvider;
  fetchImpl?: AgentArtsFetch;
  onDiagnostic?: (receipt: AgentArtsFailureDiagnostic) => void;
  /** Trusted host egress check, synchronously re-run immediately before each HTTP send. */
  beforeCompetitionSend?: (request: CoordinationRequest) => void;
}

/**
 * Trusted Competition composition root. AgentArts provides unverified text;
 * RuntimeApplication remains the task-state and persistence authority.
 */
export function createAgentArtsRuntimeApplication(
  options: AgentArtsRuntimeApplicationOptions
): RuntimeApplication {
  const {
    gatewayUrl,
    runtimeName,
    invokeMode,
    workflowGoalInput,
    responseMode,
    initialRequestMode,
    repairCandidateVersion,
    authorizationProvider,
    fetchImpl,
    onDiagnostic,
    beforeCompetitionSend,
    ...runtimeOptions
  } = options;
  if (initialRequestMode === 'goal-with-tools-json'
    && (responseMode !== 'tool-proposal-json'
      || !runtimeOptions.competitionToolAvailability?.length
      || !runtimeOptions.competitionToolExports?.length)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Competition tool catalog needs proposal mode and explicit local bindings');
  }
  if (initialRequestMode !== 'goal-with-tools-json'
    && runtimeOptions.competitionToolAvailability !== undefined) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Competition tool catalog requires explicit initial request mode');
  }
  let application: RuntimeApplication;
  const cloud = new AgentArtsCloudAgentPort(
    {
      gatewayUrl,
      runtimeName,
      ...(invokeMode === undefined ? {} : {invokeMode}),
      ...(workflowGoalInput === undefined ? {} : {workflowGoalInput}),
      ...(responseMode === undefined ? {} : {responseMode}),
      ...(initialRequestMode === undefined ? {} : {initialRequestMode}),
      ...(repairCandidateVersion === undefined ? {} : {repairCandidateVersion}),
    },
    authorizationProvider,
    fetchImpl,
    request => {
      application.assertCompetitionExportAllowed(request);
      beforeCompetitionSend?.(request);
    },
    request => {
      if (!request.availableTools) throw new ProtocolError('UNAUTHORIZED', 'Initial Competition tool catalog is missing');
      return application.assertCompetitionToolCatalogAllowed({taskId: request.taskId,
        revision: request.revision, deadline: request.deadline, signal: request.signal,
        availableTools: request.availableTools});
    },
    onDiagnostic,
  );
  application = createRuntimeApplication({
    ...runtimeOptions,
    ...(repairCandidateVersion === undefined ? {} : {repairCandidateVersion}),
    profile: 'huawei_ict_agentarts',
    coordinationBinding:createHash('sha256').update(JSON.stringify({gatewayUrl,runtimeName,
      invokeMode:invokeMode??'published',workflowGoalInput:workflowGoalInput??null,
      responseMode:responseMode??'text',initialRequestMode:initialRequestMode??'goal',
      ...(repairCandidateVersion === undefined ? {} : {repairCandidateVersion})})).digest('hex'),
    coordination: new CompetitionCoordinator(cloud),
  });
  return application;
}
