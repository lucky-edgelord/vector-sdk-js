import type { Client } from "../client/Client";

export abstract class Base {
  constructor(public readonly client: Client) {
    Object.defineProperty(this, "client", { enumerable: false, value: client });
  }
  /** The native bot (internal). */
  protected get native() {
    return this.client._native();
  }
}
