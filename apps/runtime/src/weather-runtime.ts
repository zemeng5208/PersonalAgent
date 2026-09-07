import {TaskRuntime} from './index.js';
import type {RuntimeOptions} from './index.js';
import type {AuthorizationPolicy} from '@personal-agent/policy';
import {createRuntimeApplication} from './application/runtime-application.js';
import type {RuntimeApplicationOptions} from './application/runtime-application.js';
import type {RegisteredTool} from '@personal-agent/contracts';
import {ToolGateway} from '@personal-agent/tool-gateway';
import {OpenMeteoProvider, register as registerWeather} from '@personal-agent/weather';
import type {WeatherProvider} from '@personal-agent/weather';

export interface WeatherRuntimeOptions {
  path: string;
  provider: WeatherProvider;
  now?: () => Date;
  idFactory?: () => string;
  defaultLocation?: string;
  cacheTtlMs?: number;
}

export interface WeatherRuntime {
  runtime: TaskRuntime;
  policy: AuthorizationPolicy;
  gateway: ToolGateway;
  dispose(): void;
}

/**
 * Compose the Runtime with the policy-checked gateway and the weather tool.
 * The provider is intentionally required so tests cannot silently enable a fake.
 */
export function createWeatherRuntime(options: WeatherRuntimeOptions): WeatherRuntime {
  const now = options.now ?? (() => new Date());
  let gateway!: ToolGateway;
  const runtimeOptions: RuntimeOptions = {now, createToolGateway: policy => {
    gateway = new ToolGateway({policy, now: () => now().getTime()});
    return gateway;
  }};
  if (options.idFactory !== undefined) runtimeOptions.idFactory = options.idFactory;
  const runtime = new TaskRuntime(options.path, runtimeOptions);
  const policy = runtime.policy;
  const weatherRegistration = registerWeather(gateway, {
    provider: options.provider,
    now: () => now().getTime(),
    ...(options.defaultLocation === undefined ? {} : {defaultLocation: options.defaultLocation}),
    ...(options.cacheTtlMs === undefined ? {} : {cacheTtlMs: options.cacheTtlMs}),
  });

  return {
    runtime,
    policy,
    gateway,
    dispose() {
      weatherRegistration();
      runtime.close();
    },
  };
}

/** Production composition. Real network access remains conditional on runtime use. */
export function createOpenMeteoRuntime(options: Omit<WeatherRuntimeOptions, 'provider'>): WeatherRuntime {
  return createWeatherRuntime({
    ...options,
    provider: new OpenMeteoProvider({locationResolution: 'strict'}),
  });
}

/** Full application entry; provider selection is explicit, including offline tests. */
export function createWeatherApplication(options: WeatherRuntimeOptions & {text?: RuntimeApplicationOptions['text']}) {
  const tools: RegisteredTool[] = [];
  registerWeather({register(tool) { tools.push(tool); return () => {}; }}, {
    provider: options.provider,
    ...(options.now ? {now: () => options.now!().getTime()} : {}),
    ...(options.defaultLocation ? {defaultLocation: options.defaultLocation} : {}),
  });
  return createRuntimeApplication({path: options.path, tools, ...(options.text ? {text: options.text} : {}), ...(options.now ? {now: options.now} : {})});
}

export function createOpenMeteoApplication(options: Omit<WeatherRuntimeOptions, 'provider'> & {text?: RuntimeApplicationOptions['text']}) {
  return createWeatherApplication({...options, provider: new OpenMeteoProvider({locationResolution: 'strict'})});
}
