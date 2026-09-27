import {spawn} from 'node:child_process';
import {realpathSync, statSync} from 'node:fs';
import {isAbsolute, relative, sep} from 'node:path';
import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {RegisteredTool, ToolContext, ToolDescriptor, ToolHost} from '@personal-agent/contracts';

export const WORKSPACE_COMMAND_TOOL_NAME = 'workspace.run_allowed_command';
export const WORKSPACE_COMMAND_TOOL_VERSION = '1.0.0';
export const WORKSPACE_COMMAND_SCOPE = 'workspace:execute';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_DURATION_MS = 30_000;
const MAX_DURATION_MS = 120_000;
const STOP_GRACE_MS = 2_000;
const recipeIdPattern = /^[a-z][a-z0-9._-]{0,63}$/u;

export interface WorkspaceCommandRecipe {
  /** A trusted host chooses the exact executable and arguments; tool input cannot override either. */
  id: string;
  executable: string;
  args: readonly string[];
}

export interface WorkspaceCommandOptions {
  /** Trusted, user-authorized workspace. This sets cwd; it is not an OS sandbox. */
  rootPath: string;
  recipes: readonly WorkspaceCommandRecipe[];
  maxOutputBytes?: number;
  maxDurationMs?: number;
  now?: () => number;
}

export interface WorkspaceCommandResult {
  recipeId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function bounded(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new ProtocolError('INVALID_ARGUMENT', `${name} must be a positive integer no greater than ${maximum}`);
  }
  return result;
}

function checkedRecipes(root: string, recipes: readonly WorkspaceCommandRecipe[]): Map<string, WorkspaceCommandRecipe> {
  if (!Array.isArray(recipes) || recipes.length < 1 || recipes.length > 32) {
    throw new ProtocolError('INVALID_ARGUMENT', 'A bounded host command allowlist is required');
  }
  const checked = new Map<string, WorkspaceCommandRecipe>();
  for (const recipe of recipes) {
    if (!recipe || !recipeIdPattern.test(recipe.id) || checked.has(recipe.id)
      || typeof recipe.executable !== 'string' || !isAbsolute(recipe.executable)
      || !Array.isArray(recipe.args) || recipe.args.length > 32
      || recipe.args.some((arg: unknown) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Host command recipe is invalid');
    }
    const executable = realpathSync.native(recipe.executable);
    if (!statSync(executable).isFile()) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Host command executable must be a regular file');
    }
    const fromRoot = relative(root, executable);
    if (fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Host command executable must be outside the writable workspace');
    }
    checked.set(recipe.id, {id: recipe.id, executable, args: [...recipe.args]});
  }
  return checked;
}

export function createWorkspaceCommandTool(options: WorkspaceCommandOptions): RegisteredTool {
  const root = realpathSync.native(options.rootPath);
  if (!statSync(root).isDirectory()) throw new ProtocolError('INVALID_ARGUMENT', 'Workspace root must be a directory');
  const recipes = checkedRecipes(root, options.recipes);
  const maxOutputBytes = bounded(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'maxOutputBytes');
  const maxDurationMs = bounded(options.maxDurationMs, DEFAULT_MAX_DURATION_MS, MAX_DURATION_MS, 'maxDurationMs');
  const now = options.now ?? Date.now;
  const descriptor: ToolDescriptor = {
    name: WORKSPACE_COMMAND_TOOL_NAME,
    version: WORKSPACE_COMMAND_TOOL_VERSION,
    inputSchema: {
      type: 'object',
      required: ['recipeId'],
      additionalProperties: false,
      properties: {recipeId: {type: 'string', enum: [...recipes.keys()]}},
    },
    outputSchema: {
      type: 'object',
      required: ['recipeId', 'exitCode', 'stdout', 'stderr'],
      additionalProperties: false,
      properties: {
        recipeId: {type: 'string', enum: [...recipes.keys()]},
        exitCode: {type: 'integer'},
        stdout: {type: 'string'},
        stderr: {type: 'string'},
      },
    },
    sideEffect: 'local_write',
    requiredScopes: [WORKSPACE_COMMAND_SCOPE],
    idempotencySupport: false,
    recoverySupport: false,
    requiresPresence: false,
  };

  return {
    descriptor,
    execute: async (input: unknown, context: ToolContext): Promise<WorkspaceCommandResult> => {
      validateToolValue(descriptor.inputSchema, input);
      if (!context.scopes.includes(WORKSPACE_COMMAND_SCOPE)) {
        throw new ProtocolError('SCOPE_DENIED', 'Workspace command scope is required');
      }
      if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Workspace command was cancelled');
      const deadline = Date.parse(context.deadline);
      const remaining = Math.min(deadline - now(), maxDurationMs);
      if (!Number.isFinite(deadline) || remaining <= 0) {
        throw new ProtocolError('TIMEOUT', 'Workspace command deadline expired');
      }
      const recipeId = (input as {recipeId: string}).recipeId;
      const recipe = recipes.get(recipeId)!;
      // No shell, caller-provided argv, caller-provided cwd, or inherited environment.
      // A recipe can still access anything its OS account can access: this is not isolation.
      return new Promise<WorkspaceCommandResult>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(recipe.executable, recipe.args, {
            cwd: root,
            env: {},
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          reject(new ProtocolError('EXTERNAL_FAILURE', 'Workspace command could not start'));
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let finished = false;
        let stopReason: ProtocolError | undefined;
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: ProtocolError, result?: WorkspaceCommandResult): void => {
          if (finished) return;
          finished = true;
          if (deadlineTimer) clearTimeout(deadlineTimer);
          if (stopTimer) clearTimeout(stopTimer);
          context.signal.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(result!);
        };
        const stop = (reason: ProtocolError): void => {
          if (stopReason || finished) return;
          stopReason = reason;
          try { child.kill('SIGKILL'); } catch { /* close or grace timeout reports unknown */ }
          stopTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(new ProtocolError('RESULT_UNKNOWN', 'Workspace command stop could not be confirmed'));
          }, STOP_GRACE_MS);
        };
        const onAbort = (): void => stop(new ProtocolError('CANCELLED', 'Workspace command was cancelled'));
        const collect = (chunk: Buffer, target: Buffer[]): void => {
          outputBytes += chunk.length;
          if (outputBytes > maxOutputBytes) {
            stop(new ProtocolError('RESULT_UNKNOWN', 'Workspace command output limit exceeded'));
          } else {
            target.push(chunk);
          }
        };
        child.stdout?.on('data', (chunk: Buffer) => collect(chunk, stdout));
        child.stderr?.on('data', (chunk: Buffer) => collect(chunk, stderr));
        child.once('error', () => finish(new ProtocolError('EXTERNAL_FAILURE', 'Workspace command could not start')));
        child.once('close', (code: number | null) => {
          if (stopReason) return finish(stopReason);
          if (code === null) return finish(new ProtocolError('RESULT_UNKNOWN', 'Workspace command exit is unknown'));
          try {
            const decoder = new TextDecoder('utf-8', {fatal: true});
            const out = decoder.decode(Buffer.concat(stdout));
            const err = decoder.decode(Buffer.concat(stderr));
            finish(undefined, {recipeId, exitCode: code, stdout: out, stderr: err});
          } catch {
            finish(new ProtocolError('EXTERNAL_FAILURE', 'Workspace command output is not UTF-8 text'));
          }
        });
        context.signal.addEventListener('abort', onAbort, {once: true});
        deadlineTimer = setTimeout(() => stop(new ProtocolError('TIMEOUT', 'Workspace command deadline expired')), remaining);
        if (context.signal.aborted) onAbort();
      });
    },
  };
}

export function registerWorkspaceCommand(host: ToolHost, options: WorkspaceCommandOptions): () => void {
  return host.register(createWorkspaceCommandTool(options));
}
