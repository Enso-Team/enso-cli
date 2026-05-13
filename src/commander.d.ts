import "commander";

declare module "commander" {
  interface Command {
    action(fn: (...args: any[]) => unknown): this;
  }
}
