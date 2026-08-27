import assert from "node:assert/strict";

export function selectableModelIds(scopedModels, availableModels) {
  const models = scopedModels.length ? scopedModels.map(({ model }) => model) : availableModels;
  return [...new Set(models.map(({ provider, id }) => `${provider}/${id}`))].sort();
}

export function savedModel(text, available) {
  try {
    const model = JSON.parse(text).model;
    return typeof model === "string" && available.includes(model) ? model : undefined;
  } catch {
    return undefined;
  }
}

export function preferenceJson(model) {
  return `${JSON.stringify({ model }, null, 2)}\n`;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const available = selectableModelIds([], [{ provider: "openai", id: "small" }, { provider: "local", id: "worker" }]);
  assert.deepEqual(available, ["local/worker", "openai/small"]);
  assert.equal(savedModel(preferenceJson("local/worker"), available), "local/worker");
  assert.equal(savedModel('{"model":"missing/model"}', available), undefined);
}
