import { defaultPanthersState, type PanthersState } from './schema.js';

export interface StateAdapter {
  serialize(): Promise<Uint8Array>;
  deserialize(data: Uint8Array): Promise<void>;
  onSuccessionComplete(): Promise<void>;
}

export class PanthersStateAdapter implements StateAdapter {
  private state: PanthersState = defaultPanthersState();

  async serialize(): Promise<Uint8Array> {
    const json = JSON.stringify(this.state);
    return new TextEncoder().encode(json);
  }

  async deserialize(data: Uint8Array): Promise<void> {
    const json = new TextDecoder().decode(data);
    this.state = JSON.parse(json) as PanthersState;
  }

  async onSuccessionComplete(): Promise<void> {
    console.log('Panthers agent is now primary');
  }

  getState(): PanthersState {
    return this.state;
  }

  setState(state: PanthersState): void {
    this.state = state;
  }
}
