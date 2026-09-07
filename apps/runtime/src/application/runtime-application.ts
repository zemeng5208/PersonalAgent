import type {Event, Request, Response} from '@personal-agent/contracts';
import {TaskRuntime} from '../index.js';
import {createTextApplication, type TextApplication, type TextApplicationOptions} from './text.js';
type SuccessfulResponse = Extract<Response, {outcome: 'ok'}>;

export interface RuntimeApplicationOptions { path: string; now?: () => Date; idFactory?: () => string; text?: TextApplicationOptions; }
export interface RuntimeApplicationTransport { send(request: Request, signal: AbortSignal): Promise<Response>; }

export class RuntimeApplication implements RuntimeApplicationTransport {
  readonly runtime: TaskRuntime;
  private textApplication: TextApplication;
  private readonly activeTextTasks = new Map<string, Promise<unknown>>();

  constructor(options: RuntimeApplicationOptions) {
    this.runtime = new TaskRuntime(options.path, {
      ...(options.now ? {now: options.now} : {}),
      ...(options.idFactory ? {idFactory: options.idFactory} : {}),
    });
    this.textApplication = createTextApplication(options.text ?? {mode: 'unavailable'});
  }

  get deployment(): TextApplication['deployment'] { return structuredClone(this.textApplication.deployment); }
  get activeTaskCount(): number { return this.activeTextTasks.size; }

  async send(request: Request, signal: AbortSignal): Promise<Response> {
    const response = await this.runtime.send(request, signal);
    if (request.operation === 'task.submit' && response.outcome === 'ok') this.dispatchSubmittedTextTask(request, response);
    return response;
  }

  readEvents(afterSequence = 0): Event[] { return this.runtime.readEvents(afterSequence); }

  configureText(options: TextApplicationOptions): TextApplication['deployment'] {
    if (this.activeTextTasks.size) throw new Error('Cannot reconfigure text model while tasks are active');
    this.textApplication = createTextApplication(options);
    return this.deployment;
  }

  testTextConnection(options?: Parameters<TextApplication['testConnection']>[0]) { return this.textApplication.testConnection(options); }
  close(): void { this.runtime.close(); }

  private dispatchSubmittedTextTask(request: Request, response: SuccessfulResponse): void {
    const taskId = response.data && typeof response.data === 'object' && 'taskId' in response.data ? response.data.taskId : undefined;
    const goal = request.operation === 'task.submit' ? request.payload.goal : undefined;
    if (typeof taskId !== 'string' || typeof goal !== 'string' || this.activeTextTasks.has(taskId)) return;
    if (this.runtime.getTask(taskId).state !== 'created') return;
    const application = this.textApplication;
    const execution = Promise.resolve().then(() => application.startTask(this.runtime, taskId, goal)).finally(() => this.activeTextTasks.delete(taskId));
    this.activeTextTasks.set(taskId, execution);
    void execution.catch(() => {
      // TaskRuntime persists the failure. This catch only prevents an unhandled rejection.
    });
  }
}

export function createRuntimeApplication(options: RuntimeApplicationOptions): RuntimeApplication { return new RuntimeApplication(options); }
