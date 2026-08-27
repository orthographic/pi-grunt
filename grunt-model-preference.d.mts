export function selectableModelIds(
  scopedModels: readonly { model: { provider: string; id: string } }[],
  availableModels: readonly { provider: string; id: string }[],
): string[];
export function savedModel(text: string, available: readonly string[]): string | undefined;
export function preferenceJson(model: string): string;
