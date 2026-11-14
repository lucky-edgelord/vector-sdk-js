/** aoi.js's `LoadCommands` helper: `const loader = new LoadCommands(client); loader.load(client.cmd, "./commands/")`. */
import type { AoiClient } from "./index";

export class LoadCommands {
  constructor(private readonly client: AoiClient) {}
  /** aoi.js passes `client.cmd` first; it's ignored here. */
  load(_cmd: unknown, directory: string, debug = false): number {
    return this.client.loadCommands(directory, debug);
  }
  setColors(_c: unknown): this {
    return this;
  }
}
