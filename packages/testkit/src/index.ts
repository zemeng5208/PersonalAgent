import {parseRequest, parseResponse, parseEvent, ProtocolError, PROTOCOL_VERSION} from '@personal-agent/contracts';
import type {Request, Response, TaskSnapshot, Event, Operation} from '@personal-agent/contracts';
import type {Transport} from '@personal-agent/client';
import {FakeClock} from './ports.js';
export * from './ports.js';

export type Scenario = 'success' | 'failure' | 'approval' | 'cancel' | 'unknown_write' | 'reconnect';
const scenarios: Scenario[] = ['success','failure','approval','cancel','unknown_write','reconnect'];
const terminal = new Set(['succeeded','failed','cancelled']);
const capabilities: Operation[] = ['system.handshake','task.submit','task.get','task.list','conversation.list','approval.list','task.cancel','event.subscribe','capability.list','settings.get','settings.update','authorization.respond'];
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string,unknown>)[key])).join(',') + '}';
}
export class FakeRuntime implements Transport {
  readonly verification = 'mock';
  readonly clock: FakeClock;
  private tasks = new Map<string, TaskSnapshot>();
  private dedupe = new Map<string, {input: string; data: unknown}>();
  private events: Event[] = [];
  private sequence = 0;
  private nextTask = 0;
  private approvals = new Map<string, {approvalId: string; taskId: string; revision: number; action: string; scopes: string[]; expiresAt: string; state: 'pending' | 'allowed' | 'denied'; argumentsDigest: string; argumentSummary: 'redacted'}>();
  private taskSequences = new Map<string, number>();
  private settings = new Map<string, {value: Record<string,unknown>; revision: number}>();
  constructor(private readonly options: {mode: 'test'; scenario: Scenario; clock?: FakeClock; replayLimit?: number}) {
    if (options.mode !== 'test' || process.env.NODE_ENV === 'production') throw new Error('FakeRuntime is test-only');
    if (!scenarios.includes(options.scenario)) throw new Error('Unknown fake scenario');
    if (options.replayLimit !== undefined && (!Number.isSafeInteger(options.replayLimit) || options.replayLimit < 1)) throw new Error('Invalid replay limit');
    this.clock = options.clock ?? new FakeClock();
  }
  async send(input: Request, signal: AbortSignal): Promise<Response> {
    const request = parseRequest(structuredClone(input));
    let response: Response;
    try {
      if (signal.aborted) throw new ProtocolError('CANCELLED', 'Call aborted');
      if (Date.parse(request.deadline) <= this.clock.now()) throw new ProtocolError('TIMEOUT', 'Request expired');
      const data = this.dispatch(request);
      response = {kind:'response',protocolVersion:PROTOCOL_VERSION,requestId:request.requestId,outcome:'ok',data,evidenceRefs:[]};
    } catch (error) {
      response = {kind:'response',protocolVersion:PROTOCOL_VERSION,requestId:request.requestId,outcome:'error',
        error:{code:(error instanceof ProtocolError ? error.code : 'EXTERNAL_FAILURE') as Extract<Response,{outcome:'error'}>['error']['code'],
          message:error instanceof ProtocolError ? error.message : 'Fake runtime error',retryable:false},evidenceRefs:[]};
    }
    return structuredClone(parseResponse(response, request.operation, request.requestId));
  }
  private task(id: string): TaskSnapshot {
    const value = this.tasks.get(id);
    if (!value) throw new ProtocolError('NOT_FOUND', 'Task not found');
    return value;
  }
  private emit(type: Event['type'], payload: unknown, taskId?: string): void {
    const sequence = ++this.sequence;
    this.events.push(parseEvent({kind:'event',protocolVersion:PROTOCOL_VERSION,eventId:'fake-event-' + sequence,streamId:'tasks',sequence,
      occurredAt:new Date(this.clock.now()).toISOString(),type,payload:structuredClone(payload),...(taskId ? {taskId} : {})}));
    if (this.events.length > (this.options.replayLimit ?? 128)) this.events.shift();
  }
  private state(task: TaskSnapshot, state: TaskSnapshot['state']): void {
    task.state = state; task.revision++; task.updatedAt = new Date(this.clock.now()).toISOString();
    this.emit('task.state_changed',task,task.taskId);
    if (terminal.has(state)) this.emit(state === 'succeeded' ? 'task.completed' : state === 'failed' ? 'task.failed' : 'task.cancelled',task,task.taskId);
  }
  private dispatch(request: Request): unknown {
    switch (request.operation) {
      case 'system.handshake':
        if (request.payload.supportedMajor !== 1) throw new ProtocolError('PROTOCOL_MISMATCH','Unsupported major');
        return {protocolVersion:PROTOCOL_VERSION,capabilities,sessionRef:'fake-session'};
      case 'task.submit': {
        const key = request.idempotencyKey!;
        const input = canonical(request.payload);
        const cached = this.dedupe.get(key);
        if (cached) {
          if (cached.input !== input) throw new ProtocolError('REVISION_CONFLICT','Idempotency key reused with different input');
          return cached.data;
        }
        const task: TaskSnapshot = {taskId:'fake-task-' + ++this.nextTask,state:'created',revision:1,
          updatedAt:new Date(this.clock.now()).toISOString(),steps:[],evidenceRefs:[],goal:request.payload.goal,
          conversationId:request.payload.conversationId,attachmentRefs:request.payload.attachmentRefs ?? []};
        this.tasks.set(task.taskId,task);
        this.emit('task.created',task,task.taskId);
        this.taskSequences.set(task.taskId,this.sequence);
        const data = {taskId:task.taskId,state:task.state,revision:task.revision};
        this.dedupe.set(key,{input,data}); return data;
      }
      case 'task.get': return this.task(request.payload.taskId);
      case 'task.list': {
        const snapshotSequence=request.payload.snapshotSequence ?? this.sequence;
        if(snapshotSequence>this.sequence)throw new ProtocolError('INVALID_ARGUMENT','Invalid snapshot sequence');
        const all=[...this.tasks.values()].filter(task=>(this.taskSequences.get(task.taskId) ?? 0)<=snapshotSequence)
          .filter(task=>request.payload.beforeSequence===undefined||(this.taskSequences.get(task.taskId) ?? 0)<request.payload.beforeSequence)
          .filter(task=>request.payload.conversationId===undefined||task.conversationId===request.payload.conversationId)
          .filter(task=>request.payload.states===undefined||request.payload.states.includes(task.state))
          .sort((a,b)=>(this.taskSequences.get(b.taskId) ?? 0)-(this.taskSequences.get(a.taskId) ?? 0));
        const limit=request.payload.limit ?? 50;const page=all.slice(0,limit);
        return {items:structuredClone(page),snapshotSequence,...(all.length>limit?{nextBeforeSequence:this.taskSequences.get(page.at(-1)!.taskId)!}:{})};
      }
      case 'conversation.list': {
        const snapshotSequence=request.payload.snapshotSequence ?? this.sequence;
        if(snapshotSequence>this.sequence)throw new ProtocolError('INVALID_ARGUMENT','Invalid snapshot sequence');
        const grouped=new Map<string,{sequence:number;tasks:TaskSnapshot[]}>();
        for(const task of this.tasks.values()){const sequence=this.taskSequences.get(task.taskId) ?? 0;if(sequence>snapshotSequence)continue;if(request.payload.conversationId!==undefined&&task.conversationId!==request.payload.conversationId)continue;const conversationId=task.conversationId!;const value=grouped.get(conversationId)??{sequence,tasks:[]};value.sequence=Math.max(value.sequence,sequence);value.tasks.push(task);grouped.set(conversationId,value);}
        const all=[...grouped.entries()].filter(([,value])=>request.payload.beforeSequence===undefined||value.sequence<request.payload.beforeSequence).sort((a,b)=>b[1].sequence-a[1].sequence);
        const limit=request.payload.limit ?? 20;const page=all.slice(0,limit);
        return {items:page.map(([conversationId,value])=>({conversationId,updatedAt:value.tasks.reduce((latest,task)=>task.updatedAt>latest?task.updatedAt:latest,value.tasks[0]!.updatedAt),taskCount:value.tasks.length,tasks:structuredClone(value.tasks).sort((a,b)=>(this.taskSequences.get(a.taskId)??0)-(this.taskSequences.get(b.taskId)??0))})),snapshotSequence,...(all.length>limit?{nextBeforeSequence:page.at(-1)![1].sequence}:{})};
      }
      case 'approval.list': {
        const all=[...this.approvals.values()].filter(item=>request.payload.approvalId===undefined||item.approvalId===request.payload.approvalId).filter(item=>request.payload.taskId===undefined||item.taskId===request.payload.taskId).filter(item=>request.payload.state===undefined||item.state===request.payload.state).reverse();
        const limit=request.payload.limit ?? 50;return {items:structuredClone(all.slice(0,limit)),snapshotSequence:this.sequence};
      }
      case 'task.cancel': {
        const task = this.task(request.payload.taskId);
        if (terminal.has(task.state)) return {taskId:task.taskId,state:task.state,cancelAccepted:false};
        if (!task.cancelRequested) {
          task.cancelRequested = true;
          if (task.state === 'waiting_reconciliation') this.state(task,'waiting_reconciliation');
          else this.state(task,'cancelling');
        }
        return {taskId:task.taskId,state:task.state,cancelAccepted:true};
      }
      case 'event.subscribe':
        this.readEvents(request.payload.streamId,request.payload.afterSequence ?? 0);
        return {subscriptionId:'fake-subscription',replayFrom:(request.payload.afterSequence ?? 0) + 1};
      case 'capability.list': return {manifests:[],health:[]};
      case 'settings.get': return this.settings.get(request.payload.namespace) ?? {value:{},revision:0};
      case 'settings.update': {
        const {namespace,expectedRevision,patch} = request.payload;
        if (JSON.stringify(patch).match(/password|secret|token|api.?key/i)) throw new ProtocolError('SCOPE_DENIED','Fake settings reject credential fields');
        const previous = this.settings.get(namespace) ?? {value:{},revision:0};
        if (previous.revision !== expectedRevision) throw new ProtocolError('REVISION_CONFLICT','Settings changed');
        const next = {value:{...previous.value,...patch},revision:previous.revision + 1};
        this.settings.set(namespace,next); return {revision:next.revision};
      }
      case 'authorization.respond': {
        const {approvalId,decision,expectedRevision} = request.payload;
        const approval = this.approvals.get(approvalId);
        if (!approval) throw new ProtocolError('NOT_FOUND','Approval not found');
        const task = this.task(approval.taskId);
        if (approval.state !== 'pending' || approval.revision !== expectedRevision || task.state !== 'waiting_approval') throw new ProtocolError('REVISION_CONFLICT','Approval changed');
        approval.state=decision === 'deny' ? 'denied' : 'allowed';approval.revision++;
        this.state(task,decision === 'deny' ? 'cancelled' : 'running');
        return {accepted:true,approvalState:decision === 'deny' ? 'denied' : 'allowed'};
      }
      default: throw new ProtocolError('UNSUPPORTED_CAPABILITY','No real tool, connector or voice provider registered');
    }
  }
  // Explicit test driver; task.submit never reports a terminal result.
  advance(taskId: string): TaskSnapshot {
    const task = this.task(taskId);
    if (terminal.has(task.state)) return structuredClone(task);
    if (task.state === 'cancelling') this.state(task,'cancelled');
    else if (task.state === 'created') this.state(task,'planning');
    else if (task.state === 'planning') {
      if (this.options.scenario === 'approval') {
        this.state(task,'waiting_approval');
        const approvalId = 'fake-approval-' + taskId;
        const approval={approvalId,taskId,revision:1,action:'fixture-read',scopes:['fixture:read'],expiresAt:new Date(this.clock.now()+60000).toISOString(),state:'pending' as const,argumentsDigest:'0'.repeat(64),argumentSummary:'redacted' as const};
        this.approvals.set(approvalId,approval);
        this.emit('approval.requested',{approvalId,taskId,revision:approval.revision,action:approval.action},taskId);
      } else this.state(task,'running');
    } else if (task.state === 'running') {
      if (this.options.scenario === 'failure') {
        task.error = {code:'EXTERNAL_FAILURE',message:'Fixed mock failure',retryable:false};
        this.state(task,'failed');
      } else if (this.options.scenario === 'unknown_write') {
        this.emit('tool.completed',{runId:'fake-run-' + taskId,state:'unknown',evidenceRefs:[]},taskId);
        this.state(task,'waiting_reconciliation');
      } else this.state(task,'verifying');
    } else if (task.state === 'verifying') {
      task.resultSummary = 'Mock scenario completed; no real action executed';
      this.state(task,'succeeded');
    }
    return structuredClone(task);
  }
  reconcile(taskId: string, confirmed: boolean): TaskSnapshot {
    const task = this.task(taskId);
    if (task.state !== 'waiting_reconciliation') throw new ProtocolError('REVISION_CONFLICT','Task is not awaiting reconciliation');
    if (confirmed) {
      task.resultSummary = 'Mock readback confirmed the earlier action';
      this.state(task,'verifying'); this.state(task,'succeeded');
    } else if (task.cancelRequested) this.state(task,'cancelled');
    else {
      task.error = {code:'EXTERNAL_FAILURE',message:'Mock readback found no completed action',retryable:false};
      this.state(task,'failed');
    }
    return structuredClone(task);
  }
  readEvents(streamId: string, afterSequence = 0): Event[] {
    if (streamId !== 'tasks') throw new ProtocolError('NOT_FOUND','Stream not found');
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > this.sequence) throw new ProtocolError('INVALID_ARGUMENT','Invalid event cursor');
    if (afterSequence < (this.events[0]?.sequence ?? 1) - 1) throw new ProtocolError('CURSOR_EXPIRED','Read snapshot then resubscribe');
    return structuredClone(this.events.filter(event => event.sequence > afterSequence));
  }
}
