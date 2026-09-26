import {
  AgentArtsCloudAgentPort,
  CompetitionCoordinator,
  type AgentArtsAuthorizationProvider,
  type AgentArtsFetch,
} from '@personal-agent/coordination';
import {ProtocolError} from '@personal-agent/contracts';
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
    authorizationProvider,
    fetchImpl,
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
      ...(options.repairCandidateVersion === undefined ? {} : {repairCandidateVersion: options.repairCandidateVersion}),
    },
    authorizationProvider,
    fetchImpl,
    request => application.assertCompetitionExportAllowed(request),
    request => {
      if (!request.availableTools) throw new ProtocolError('UNAUTHORIZED', 'Initial Competition tool catalog is missing');
      return application.assertCompetitionToolCatalogAllowed({taskId: request.taskId,
        revision: request.revision, deadline: request.deadline, signal: request.signal,
        availableTools: request.availableTools});
    },
  );
  application = createRuntimeApplication({
    ...runtimeOptions,
    profile: 'huawei_ict_agentarts',
    coordination: new CompetitionCoordinator(cloud),
  });
  return application;
}
