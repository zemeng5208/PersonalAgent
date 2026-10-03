import { ProtocolError } from '@personal-agent/contracts';
import type { GitHubInputs, GitHubOperation, GitHubOutputs, GitHubProvider, GitHubReadContext } from './provider.js';
import { checkContext } from './service.js';
import { validateInput } from './schemas.js';
export type GitHubFakeFixtures = Partial<{[K in GitHubOperation]: GitHubOutputs[K] | ProtocolError | ((input: GitHubInputs[K], context: GitHubReadContext) => GitHubOutputs[K] | Promise<GitHubOutputs[K]>)} >;
/** Explicit test-only fake; missing fixtures fail rather than simulate success. */
export class FakeGitHubProvider implements GitHubProvider {
  readonly verification = 'mock' as const;
  readonly calls: {operation: GitHubOperation; input: unknown}[] = [];
  constructor(private readonly fixtures: GitHubFakeFixtures) {}
  async execute<K extends GitHubOperation>(operation: K, input: GitHubInputs[K], context: GitHubReadContext): Promise<GitHubOutputs[K]> {
    validateInput(operation, input); checkContext(context);
    this.calls.push({operation, input: structuredClone(input)});
    const fixture = this.fixtures[operation];
    if (fixture === undefined) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'GitHub fake fixture missing');
    if (fixture instanceof ProtocolError) throw fixture;
    const value = typeof fixture === 'function' ? await (fixture as (input: GitHubInputs[K], context: GitHubReadContext) => GitHubOutputs[K] | Promise<GitHubOutputs[K]>)(input, context) : fixture;
    checkContext(context);
    return structuredClone(value) as GitHubOutputs[K];
  }
}
