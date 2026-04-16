export interface StorageBackend {
  getAgentState(): Uint8Array | null;
  setAgentState(blob: Uint8Array): void;
  getConfig(key: string): string | null;
  setConfig(key: string, value: string): void;
}
