import type { StorageBackend } from './storage-backend.js';

export interface ConfigEntry {
  envKey?: string;
  required?: boolean;
  defaultValue?: string;
}

export class ConfigStore {
  constructor(private readonly backend: StorageBackend) {}

  get(dbKey: string, entry: ConfigEntry = {}): string | null {
    const fromDb = this.backend.getConfig(dbKey);
    if (fromDb !== null) return fromDb;

    const fromEnv = entry.envKey ? (process.env[entry.envKey] ?? null) : null;
    if (fromEnv !== null) {
      this.backend.setConfig(dbKey, fromEnv);
      console.log(`[ConfigStore] Seeded ${dbKey} from env ${entry.envKey}`);
      return fromEnv;
    }

    if (entry.defaultValue !== undefined) {
      this.backend.setConfig(dbKey, entry.defaultValue);
      console.log(`[ConfigStore] Seeded ${dbKey} from default`);
      return entry.defaultValue;
    }

    if (entry.required) {
      throw new Error(
        `[ConfigStore] Required config missing: ${dbKey}` +
          (entry.envKey ? ` (set env ${entry.envKey} on first boot)` : ''),
      );
    }

    return null;
  }

  getJson<T>(dbKey: string, defaultValue: T, envKey?: string): T {
    const raw = this.get(dbKey, { envKey });
    if (raw !== null) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        console.warn(
          `[ConfigStore] Failed to parse JSON for ${dbKey}, using default`,
        );
      }
    }
    this.backend.setConfig(dbKey, JSON.stringify(defaultValue));
    return defaultValue;
  }

  set(dbKey: string, value: string): void {
    this.backend.setConfig(dbKey, value);
  }

  setJson<T>(dbKey: string, value: T): void {
    this.backend.setConfig(dbKey, JSON.stringify(value));
  }
}
