import {parseCoordinationResult} from './index.js';
import type {
  CloudAgentPort, CoordinationPort, CoordinationRequest, CoordinationResult,
} from './index.js';

type Reply = (request: CoordinationRequest) => string | CoordinationResult | Promise<string | CoordinationResult>;

/** Explicit offline fixture; never selected automatically by production composition. */
export class FakeCoordinationPort implements CoordinationPort {
  readonly requests: CoordinationRequest[] = [];
  constructor(private readonly reply: Reply) {}
  async execute(request: CoordinationRequest): Promise<CoordinationResult> {
    this.requests.push({...request});
    const reply = await this.reply(request);
    return typeof reply === 'string' ? {kind: 'text', text: reply, verification: 'mock'} : parseCoordinationResult(reply);
  }
}

export class FakeCloudAgentPort implements CloudAgentPort {
  readonly requests: CoordinationRequest[] = [];
  constructor(private readonly reply: Reply) {}
  async invoke(request: CoordinationRequest): Promise<CoordinationResult> {
    this.requests.push({...request});
    const reply = await this.reply(request);
    return typeof reply === 'string' ? {kind: 'text', text: reply, verification: 'mock'} : parseCoordinationResult(reply);
  }
}
