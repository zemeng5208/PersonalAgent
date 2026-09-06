import {runAgent} from '@personal-agent/agents';
import {FakeModelProvider, ModelGateway} from '@personal-agent/models';

const NO_TOOLS = {
  list: () => [],
  invoke: async () => { throw new Error('Text chat does not register tools'); },
};

export function createFakeTextProvider() {
  return new FakeModelProvider([
    request => ({kind: 'final', text: `Fake Model 回答：${request.messages.at(-1)?.content ?? ''}`}),
  ], {
    provider: 'fake', deployment: 'desktop-fake-text', model: 'fake-text-model', verification: 'mock',
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false},
  });
}

export function startTextTask(runtime, taskId, goal, provider, options = {}) {
  const model = provider instanceof ModelGateway ? provider : new ModelGateway(provider);
  const deadline = new Date((options.now ?? Date.now)() + (options.deadlineMs ?? 30_000)).toISOString();
  return runtime.runTask(taskId, context => runAgent(context, {
    goal, model, tools: NO_TOOLS,
    authorizationRefFor: () => 'desktop-text-chat-no-tools', maxSteps: 1, maxTokens: options.maxTokens ?? 512,
  }), {deadline, sideEffect: 'read'});
}
