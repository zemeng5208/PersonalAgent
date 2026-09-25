import {isDeepStrictEqual} from 'node:util';
import type {RegisteredTool, ToolContext, ToolDescriptor} from '@personal-agent/contracts';
import {GraphError} from './index.js';
import type {NodeRef, NodeVersion} from './index.js';
import {createGoal, reviseGoal} from './commands.js';
import type {GoalInput} from './commands.js';
import {CoordinationStoreError} from './store.js';
import type {CoordinationStorePort} from './store.js';

export const GOAL_CREATE_TOOL = 'goals.create';
export const GOAL_REVISE_TOOL = 'goals.revise';
export const GOAL_TOOL_VERSION = '1.0.0';
export const GOAL_WRITE_SCOPE = 'goals:write';

export interface GoalToolCreateInput { expectedGraphRevision: number; goal: GoalInput; }
export interface GoalToolReviseInput extends GoalToolCreateInput { expectedGoalRevision: number; }
export type GoalToolResult =
  | {kind: 'applied'; graphRevision: number; previousGoal: NodeRef | null; currentGoal: NodeRef}
  | {kind: 'conflict' | 'rejected'; graphRevision: number};

const refSchema = {type: 'object', required: ['id', 'revision'], additionalProperties: false,
  properties: {id: {type: 'string', minLength: 1}, revision: {type: 'integer', minimum: 1}}};
const goalSchema = {type: 'object',
  required: ['id', 'summary', 'sourceRef', 'validFrom', 'validUntil', 'sensitivity', 'state', 'reason', 'dependencies'],
  additionalProperties: false,
  properties: {
    id: {type: 'string', minLength: 1}, summary: {type: 'string', minLength: 1},
    sourceRef: {type: 'string', minLength: 1}, validFrom: {type: 'string'}, validUntil: {type: 'string'},
    sensitivity: {enum: ['public', 'private', 'restricted']}, state: {enum: ['active', 'withdrawn']},
    reason: {type: 'string', minLength: 1}, dependencies: {type: 'array', items: refSchema}
  }};
const outputSchema = {oneOf: [
  {type: 'object', required: ['kind', 'graphRevision', 'previousGoal', 'currentGoal'], additionalProperties: false,
    properties: {kind: {const: 'applied'}, graphRevision: {type: 'integer', minimum: 1},
      previousGoal: {anyOf: [refSchema, {type: 'null'}]}, currentGoal: refSchema}},
  {type: 'object', required: ['kind', 'graphRevision'], additionalProperties: false,
    properties: {kind: {enum: ['conflict', 'rejected']}, graphRevision: {type: 'integer', minimum: 0}}}
]};

function inputSchema(revise: boolean) {
  return {type: 'object',
    required: revise ? ['expectedGraphRevision', 'expectedGoalRevision', 'goal'] : ['expectedGraphRevision', 'goal'],
    additionalProperties: false,
    properties: {
      expectedGraphRevision: {type: 'integer', minimum: 0},
      ...(revise ? {expectedGoalRevision: {type: 'integer', minimum: 1}} : {}), goal: goalSchema
    }};
}

function descriptor(name: string, revise: boolean): ToolDescriptor {
  return {name, version: GOAL_TOOL_VERSION, inputSchema: inputSchema(revise), outputSchema,
    sideEffect: 'local_write', requiredScopes: [GOAL_WRITE_SCOPE],
    idempotencySupport: false, recoverySupport: false, requiresPresence: false};
}

function readback(store: CoordinationStorePort, revision: number, goal: NodeVersion): void {
  const persisted = store.read(revision);
  if (persisted.revision !== revision || !isDeepStrictEqual(persisted.history.at(-1), goal)) {
    throw new GraphError('INVALID_ARGUMENT', 'Goal commit readback failed');
  }
}

function execute(
  store: CoordinationStorePort, input: GoalToolCreateInput | GoalToolReviseInput,
  context: ToolContext, revise: boolean
): GoalToolResult {
  if (!context.scopes.includes(GOAL_WRITE_SCOPE)) throw new GraphError('INVALID_ARGUMENT', 'Goal write scope missing');
  // The host supplies a bound store and sourceRef. Policy already bound the
  // complete arguments to this task; no namespace or authorization is accepted here.
  const before = store.read().revision;
  try {
    const committed = revise
      ? reviseGoal(store, input.expectedGraphRevision,
        (input as GoalToolReviseInput).expectedGoalRevision, input.goal)
      : createGoal(store, input.expectedGraphRevision, input.goal);
    readback(store, committed.graphRevision, committed.goal);
    return {kind: 'applied', graphRevision: committed.graphRevision,
      previousGoal: committed.previous,
      currentGoal: {id: committed.goal.id, revision: committed.goal.revision}};
  } catch (error) {
    if (error instanceof GraphError && error.code === 'REVISION_CONFLICT') {
      return {kind: 'conflict', graphRevision: store.read().revision};
    }
    if (error instanceof GraphError && error.code === 'INVALID_ARGUMENT'
      && store.read().revision === before) return {kind: 'rejected', graphRevision: before};
    // A failed readback or changed graph after an unexpected error may mean a
    // write committed. Let Runtime mark it unknown for reconciliation.
    throw error;
  }
}

/** Resolve the stable host-bound store only when an approved tool executes. */
export function createGoalTools(resolveStore: () => CoordinationStorePort): readonly [RegisteredTool, RegisteredTool] {
  if (typeof resolveStore !== 'function') throw new GraphError('INVALID_ARGUMENT', 'Goal store resolver required');
  let bound: CoordinationStorePort | undefined;
  const store = (): CoordinationStorePort => {
    let selected: CoordinationStorePort;
    try { selected = resolveStore(); }
    catch { throw new CoordinationStoreError('STORAGE_UNAVAILABLE'); }
    if (!selected || typeof selected.read !== 'function' || typeof selected.append !== 'function'
      || (bound && selected !== bound)) throw new CoordinationStoreError('STORAGE_UNAVAILABLE');
    bound = selected;
    return selected;
  };
  const create: RegisteredTool = {descriptor: descriptor(GOAL_CREATE_TOOL, false),
    async execute(input, context) { return execute(store(), input as GoalToolCreateInput, context, false); }};
  const revise: RegisteredTool = {descriptor: descriptor(GOAL_REVISE_TOOL, true),
    async execute(input, context) { return execute(store(), input as GoalToolReviseInput, context, true); }};
  return [create, revise];
}
