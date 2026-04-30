import type { WorkflowDefinition, WorkflowHooks } from '../types'

export type WorkflowRegistryEntry = {
  definition: WorkflowDefinition
  hooks: WorkflowHooks
}

export class WorkflowRegistry {
  private entries = new Map<string, WorkflowRegistryEntry>()

  register(definition: WorkflowDefinition, hooks: WorkflowHooks = {}): void {
    this.entries.set(definition.id, { definition, hooks })
  }

  setHooks(id: string, hooks: WorkflowHooks): void {
    const current = this.entries.get(id)
    if (!current) return
    this.entries.set(id, { ...current, hooks })
  }

  get(id: string): WorkflowRegistryEntry | undefined {
    return this.entries.get(id)
  }

  list(): WorkflowDefinition[] {
    return [...this.entries.values()].map((entry) => entry.definition)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }
}

export const workflowRegistry = new WorkflowRegistry()
