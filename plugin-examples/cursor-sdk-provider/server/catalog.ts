import type { ModelListItem, ModelParameterDefinition, ModelSelection } from "@cursor/sdk";
import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
  ProviderSetting,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { loadCursorSdk } from "./sdk.js";

// Local SDK agents run tools without approval prompts, so Agent is the unattended mode.
export const modes: ProviderMode[] = [
  {
    id: "agent",
    label: "Agent",
    description: "Implements changes directly; tools run without approval",
    isUnattended: true,
  },
  { id: "plan", label: "Plan", description: "Explores and plans before implementing" },
];

export const defaultMode = "agent";

// Cursor names its reasoning parameter per model family; any of these is shown as the
// composer's thinking selector, and every other parameter becomes a select setting.
const THINKING_PARAMETER = /reason|think|thought|effort/i;
const PARAMETER_SETTING_PREFIX = "param:";

export class Catalog {
  private cached: Promise<ModelListItem[]> | undefined;

  // Only successful lists are kept. A failed probe (logged out, offline) is retried on the
  // next request instead of being served until the plugin reloads.
  models(force = false): Promise<ModelListItem[]> {
    if (force || !this.cached) {
      const listing = loadCursorSdk().then((sdk) => sdk.Cursor.models.list());
      this.cached = listing;
      listing.catch(() => {
        if (this.cached === listing) this.cached = undefined;
      });
    }
    return this.cached;
  }

  async read(force = false): Promise<ProviderCatalog> {
    const models = presentModels(await this.models(force));
    return { models, modes, defaultModel: models[0]?.id, defaultMode };
  }
}

export function presentModels(models: readonly ModelListItem[]): ProviderModel[] {
  return models.map(presentModel);
}

function presentModel(model: ModelListItem, index: number): ProviderModel {
  const thinking = thinkingParameter(model);
  const thinkingOptions = thinking ? parameterOptions(model, thinking) : undefined;
  return {
    id: model.id,
    label: clean(model.displayName),
    description: model.description,
    aliases: model.aliases,
    // Cursor lists its default ("Auto") first.
    isDefault: index === 0,
    thinkingOptions,
    defaultThinkingOptionId: thinkingOptions?.find((option) => option.isDefault)?.id,
    metadata: thinking ? { thinkingParameter: thinking.id } : undefined,
  };
}

function thinkingParameter(model: ModelListItem): ModelParameterDefinition | undefined {
  return model.parameters?.find(
    (parameter) =>
      THINKING_PARAMETER.test(parameter.id) || THINKING_PARAMETER.test(parameter.displayName ?? ""),
  );
}

function parameterOptions(
  model: ModelListItem,
  parameter: ModelParameterDefinition,
): ProviderThinkingOption[] {
  const fallback = defaultParameterValue(model, parameter);
  const boolean = isBooleanParameter(parameter);
  return parameter.values.map((value) => ({
    id: value.value,
    label: boolean ? booleanLabel(value.value) : valueLabel(value),
    isDefault: value.value === fallback,
  }));
}

// The default variant names the value Cursor uses when a parameter is omitted;
// without one, the SDK uses the parameter's first allowed value.
function defaultParameterValue(
  model: ModelListItem,
  parameter: ModelParameterDefinition,
): string | undefined {
  const variant = model.variants?.find((candidate) => candidate.isDefault);
  return (
    variant?.params.find((param) => param.id === parameter.id)?.value ?? parameter.values[0]?.value
  );
}

// Cursor models its on/off parameters (\`fast\`, \`thinking\`) as the strings "false" and "true".
function isBooleanParameter(parameter: ModelParameterDefinition): boolean {
  return (
    parameter.values.length === 2 &&
    parameter.values.every((value) => value.value === "true" || value.value === "false")
  );
}

export function modelSettings(
  model: ModelListItem | undefined,
  values: Readonly<Record<string, unknown>>,
): ProviderSetting[] {
  if (!model?.parameters) return [];
  const thinking = thinkingParameter(model);
  return model.parameters
    .filter((parameter) => parameter !== thinking && parameter.values.length > 1)
    .map((parameter): ProviderSetting => {
      const id = settingId(parameter);
      const label = clean(parameter.displayName ?? parameter.id);
      const value =
        parameterValue(parameter, values[id]) ?? defaultParameterValue(model, parameter);
      if (isBooleanParameter(parameter)) {
        return { type: "toggle", id, label, value: value === "true" };
      }
      return {
        type: "select",
        id,
        label,
        value: value ?? null,
        options: parameter.values.map((option) => ({
          label: valueLabel(option),
          value: option.value,
        })),
      };
    });
}

export function modelSelection(
  model: ModelListItem | undefined,
  modelId: string,
  thinkingOption: string | undefined,
  settings: Readonly<Record<string, unknown>>,
): ModelSelection {
  if (!model?.parameters) return { id: modelId };
  const thinking = thinkingParameter(model);
  const params = model.parameters.flatMap((parameter) => {
    const value = parameterValue(
      parameter,
      parameter === thinking ? thinkingOption : settings[settingId(parameter)],
    );
    return value === undefined ? [] : [{ id: parameter.id, value }];
  });
  return params.length > 0 ? { id: modelId, params } : { id: modelId };
}

// Composer toggles store booleans; selects and thinking options store the raw value.
function parameterValue(parameter: ModelParameterDefinition, value: unknown): string | undefined {
  const raw = typeof value === "boolean" ? String(value) : value;
  if (typeof raw !== "string") return undefined;
  return parameter.values.some((option) => option.value === raw) ? raw : undefined;
}

function settingId(parameter: ModelParameterDefinition): string {
  return `${PARAMETER_SETTING_PREFIX}${parameter.id}`;
}

function booleanLabel(value: string): string {
  return value === "true" ? "On" : "Off";
}

function valueLabel(value: { value: string; displayName?: string }): string {
  return clean(value.displayName ?? value.value);
}

// Some Cursor display names carry zero-width characters.
function clean(label: string): string {
  return label.replace(/[\u200b-\u200d\ufeff]/g, "").trim();
}

export function findModel(
  models: readonly ModelListItem[],
  id: string | undefined,
): ModelListItem | undefined {
  if (!id) return undefined;
  return models.find((model) => model.id === id || model.aliases?.includes(id));
}
