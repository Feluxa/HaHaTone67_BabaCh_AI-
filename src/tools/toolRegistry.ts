import { actionTools } from "./actionTools";
import { investigationTools } from "./investigationTools";
import type { ToolDefinition } from "./toolSchemas";

class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown>>();

  register<TArgs>(tool: ToolDefinition<TArgs>): void {
    this.tools.set(tool.name, tool as ToolDefinition<unknown>);
  }

  get(name: string): ToolDefinition<unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<unknown>[] {
    return Array.from(this.tools.values());
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

export const toolRegistry = new ToolRegistry();

for (const tool of [...investigationTools, ...actionTools]) {
  toolRegistry.register(tool as ToolDefinition<unknown>);
}
