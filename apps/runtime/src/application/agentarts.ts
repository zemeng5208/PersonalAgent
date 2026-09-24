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
    authorizationProvider,
    fetchImpl,
    ...runtimeOptions
  } = options;
  const cloud = new AgentArtsCloudAgentPort(
    {
      gatewayUrl,
      runtimeName,
      ...(invokeMode === undefined ? {} : {invokeMode}),
      ...(workflowGoalInput === undefined ? {} : {workflowGoalInput}),
    },
    authorizationProvider,
    fetchImpl,
  );
  return createRuntimeApplication({
    ...runtimeOptions,
    profile: 'huawei_ict_agentarts',
    coordination: new CompetitionCoordinator(cloud),
  });
}
