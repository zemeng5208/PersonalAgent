import {TaskRuntime} from './index.js';
import type {RuntimeOptions} from './index.js';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';
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
  policy: InMemoryAuthorizationPolicy;
  gateway: ToolGateway;
  dispose(): void;
}

/**
 * Compose the Runtime with the policy-checked gateway and the weather tool.
 * The provider is intentionally required so tests cannot silently enable a fake.
 */
export function createWeatherRuntime(options: WeatherRuntimeOptions): WeatherRuntime {
  const now = options.now ?? (() => new Date());
  const policy = new InMemoryAuthorizationPolicy();
  const gateway = new ToolGateway({policy, now: () => now().getTime()});
  const weatherRegistration = registerWeather(gateway, {
    provider: options.provider,
    now: () => now().getTime(),
    ...(options.defaultLocation === undefined ? {} : {defaultLocation: options.defaultLocation}),
    ...(options.cacheTtlMs === undefined ? {} : {cacheTtlMs: options.cacheTtlMs}),
  });

  const runtimeOptions: RuntimeOptions = {now, toolGateway: gateway};
  if (options.idFactory !== undefined) runtimeOptions.idFactory = options.idFactory;
  const runtime = new TaskRuntime(options.path, runtimeOptions);

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
