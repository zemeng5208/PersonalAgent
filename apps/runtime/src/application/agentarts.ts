import {
  AgentArtsCloudAgentPort,
  CompetitionCoordinator,
  type AgentArtsAuthorizationProvider,
  type AgentArtsFetch,
} from '@personal-agent/coordination';
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
    authorizationProvider,
    fetchImpl,
    ...runtimeOptions
  } = options;
  let application: RuntimeApplication;
  const cloud = new AgentArtsCloudAgentPort(
    {
      gatewayUrl,
      runtimeName,
      ...(invokeMode === undefined ? {} : {invokeMode}),
      ...(workflowGoalInput === undefined ? {} : {workflowGoalInput}),
      ...(responseMode === undefined ? {} : {responseMode}),
    },
    authorizationProvider,
    fetchImpl,
    request => application.assertCompetitionExportAllowed(request),
  );
  application = createRuntimeApplication({
    ...runtimeOptions,
    profile: 'huawei_ict_agentarts',
    coordination: new CompetitionCoordinator(cloud),
  });
  return application;
}
