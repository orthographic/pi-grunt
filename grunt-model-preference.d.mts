export function selectableModelIds(
  scopedModels: readonly { model: { provider: string; id: string } }[],
  availableModels: readonly { provider: string; id: string }[],
): string[];
export function preferenceJson(model: string): string;
