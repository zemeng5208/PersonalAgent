import { ProtocolError, validateContract } from '@personal-agent/contracts';
import type { ConnectorManifest, ConnectorPort } from '@personal-agent/contracts';

export interface SecretStorePort {
  read(secretRef: string, signal: AbortSignal): string | undefined | Promise<string | undefined>;
}

export interface ConnectorFactoryContext {
  signal: AbortSignal;
  readSecret(secretRef: string): Promise<string>;
}

export interface ConnectorFactory {
  readonly manifest: ConnectorManifest;
  create(context: ConnectorFactoryContext): ConnectorPort | Promise<ConnectorPort>;
}

export interface ConnectorRegistrationOptions {
  secretRefs?: readonly string[];
}

export interface ConnectorStatus {
  manifest: ConnectorManifest;
  health: ReturnType<ConnectorPort['health']>;
}

interface Registration {
  factory: ConnectorFactory;
  secretRefs: Set<string>;
  instance?: ConnectorPort;
  connecting?: Promise<{sessionRef: string; interactionRequired: boolean}>;
}

const requiredText = (value: string, field: string): string => {
  const result = value.trim();
  if (!result) throw new ProtocolError('INVALID_ARGUMENT', `${field} must not be empty`);
  return result;
};

export class ConnectorHost {
  private readonly registrations = new Map<string, Registration>();

  constructor(private readonly secretStore: SecretStorePort) {}

  register(factory: ConnectorFactory, options: ConnectorRegistrationOptions = {}): () => Promise<void> {
    validateContract('connector', factory.manifest);
    const id = factory.manifest.id;
    if (this.registrations.has(id)) throw new ProtocolError('REVISION_CONFLICT', `Connector ${id} is already registered`);
    const secretRefs = new Set((options.secretRefs ?? []).map(ref => requiredText(ref, 'secretRef')));
    const registration: Registration = {factory, secretRefs};
    this.registrations.set(id, registration);
    return async () => {
      if (this.registrations.get(id) !== registration) return;
      if (registration.connecting) await registration.connecting;
      if (registration.instance) await registration.instance.disconnect();
      this.registrations.delete(id);
    };
  }

  list(): ConnectorStatus[] {
    return [...this.registrations.values()].map(registration => ({
      manifest: structuredClone(registration.factory.manifest),
      health: registration.instance ? structuredClone(registration.instance.health()) : {state: 'disconnected'},
    }));
  }

  async connect(connectorId: string, signal: AbortSignal): Promise<{sessionRef: string; interactionRequired: boolean}> {
    const registration = this.registration(connectorId);
    if (signal.aborted) throw new ProtocolError('CANCELLED', 'Connector connection was cancelled');
    if (!registration.connecting) {
      registration.connecting = this.open(registration, signal).finally(() => {
        delete registration.connecting;
      });
    }
    return structuredClone(await registration.connecting);
  }

  private async open(registration: Registration, signal: AbortSignal): Promise<{sessionRef: string; interactionRequired: boolean}> {
    if (!registration.instance) {
      const context: ConnectorFactoryContext = {
        signal,
        readSecret: async secretRef => {
          const ref = requiredText(secretRef, 'secretRef');
          if (!registration.secretRefs.has(ref)) throw new ProtocolError('SCOPE_DENIED', 'Connector requested an undeclared secret');
          if (signal.aborted) throw new ProtocolError('CANCELLED', 'Connector connection was cancelled');
          const value = await this.secretStore.read(ref, signal);
          if (signal.aborted) throw new ProtocolError('CANCELLED', 'Connector connection was cancelled');
          if (value === undefined) throw new ProtocolError('UNAUTHORIZED', 'Required connector credential is unavailable');
          return value;
        },
      };
      const instance = await registration.factory.create(context);
      validateContract('connector', instance.manifest);
      if (instance.manifest.id !== registration.factory.manifest.id || instance.manifest.version !== registration.factory.manifest.version) {
        throw new ProtocolError('PROTOCOL_MISMATCH', 'Connector instance manifest does not match its factory');
      }
      registration.instance = instance;
    }
    if (signal.aborted) throw new ProtocolError('CANCELLED', 'Connector connection was cancelled');
    return registration.instance.connect();
  }

  async disconnect(connectorId: string): Promise<{disconnected: boolean; cleanupState: string}> {
    const registration = this.registration(connectorId);
    if (registration.connecting) await registration.connecting;
    if (!registration.instance) return {disconnected: true, cleanupState: 'not_started'};
    return structuredClone(await registration.instance.disconnect());
  }

  getCapabilities(connectorId: string): string[] {
    const registration = this.registration(connectorId);
    return registration.instance
      ? [...registration.instance.getCapabilities()]
      : [...registration.factory.manifest.capabilities];
  }

  private registration(connectorId: string): Registration {
    const id = requiredText(connectorId, 'connectorId');
    const registration = this.registrations.get(id);
    if (!registration) throw new ProtocolError('UNSUPPORTED_CAPABILITY', `Connector ${id} is not registered`);
    return registration;
  }
}
