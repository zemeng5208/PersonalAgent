import type {CloudAgentPort, CoordinationPort, CoordinationRequest, CoordinationTextResult} from './index.js';

type Reply = (request: CoordinationRequest) => string | Promise<string>;

/** Explicit offline fixture; never selected automatically by production composition. */
export class FakeCoordinationPort implements CoordinationPort {
  readonly requests: CoordinationRequest[] = [];
  constructor(private readonly reply: Reply) {}
  async execute(request: CoordinationRequest): Promise<CoordinationTextResult> {
    this.requests.push({...request});
    return {kind: 'text', text: await this.reply(request), verification: 'mock'};
  }
}

export class FakeCloudAgentPort implements CloudAgentPort {
  readonly requests: CoordinationRequest[] = [];
  constructor(private readonly reply: Reply) {}
  async invoke(request: CoordinationRequest): Promise<CoordinationTextResult> {
    this.requests.push({...request});
    return {kind: 'text', text: await this.reply(request), verification: 'mock'};
  }
}
