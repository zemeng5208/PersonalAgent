import {LocalLayaHttpTransport, readSmallJson} from './laya-decision.js';
import type {LayaPayload} from './laya-decision.js';
import type {LayaBatchInferencePort, LayaBatchPayload} from './laya-triage.js';

/** Explicit project batch-server capability; never silently falls back to per-item requests. */
export class LocalLayaBatchHttpTransport implements LayaBatchInferencePort {
  private readonly single: LocalLayaHttpTransport;
  constructor(private readonly port: number, private readonly getApiKey: () => string,
    private readonly request: typeof fetch = fetch) {
    this.single = new LocalLayaHttpTransport(port, getApiKey, request);
  }
  infer(payload: LayaPayload, signal: AbortSignal): Promise<unknown> { return this.single.infer(payload, signal); }
  async inferBatch(payload: LayaBatchPayload, signal: AbortSignal): Promise<unknown> {
    const key = this.getApiKey();
    if (!key || /[\r\n]/.test(key)) throw new Error('Laya key unavailable');
    const response = await this.request(`http://127.0.0.1:${this.port}/v1/systemone/batch`, {
      method: 'POST', redirect: 'error', signal,
      headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body: JSON.stringify(payload),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Local Laya batch unavailable'); }
    return readSmallJson(response);
  }
}
