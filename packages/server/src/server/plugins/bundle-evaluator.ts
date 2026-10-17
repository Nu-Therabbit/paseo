import { createRequire } from "node:module";
import path from "node:path";
import * as pluginSharedRuntime from "@getpaseo/plugin";
import * as pluginProviderRuntime from "@getpaseo/plugin/server/provider";
import * as pluginAcpRuntime from "@getpaseo/plugin/server/acp";
import * as pluginUsageRuntime from "@getpaseo/plugin/server/usage";
import * as pluginServerRuntime from "@getpaseo/plugin/server";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import * as zod from "zod";
import { isPluginClientOnlySdkSpecifier } from "./plugin-sdk-specifiers.js";

const nodeRequire = createRequire(import.meta.url);

export interface PluginServerModules {
  pluginDirectory: string;
  /** Packages the compiler left unbundled; they load from the plugin's own installation. */
  serverExternals: readonly string[];
}

function createRuntimeRequire(modules: PluginServerModules): (name: string) => unknown {
  const pluginRequire =
    modules.serverExternals.length > 0
      ? createRequire(path.join(modules.pluginDirectory, "package.json"))
      : null;
  return function runtimeRequire(name: string): unknown {
    if (isPluginClientOnlySdkSpecifier(name)) {
      throw new Error(`${name} is available only in plugin client code`);
    }
    if (name === "@getpaseo/plugin") return pluginSharedRuntime;
    if (name === "@getpaseo/plugin/server") return pluginServerRuntime;
    if (name === "@getpaseo/plugin/server/provider") return pluginProviderRuntime;
    if (name === "@getpaseo/plugin/server/acp") return pluginAcpRuntime;
    if (name === "@getpaseo/plugin/server/usage") return pluginUsageRuntime;
    if (name === "zod") return zod;
    if (name === "@getpaseo/plugin/client/host")
      throw new Error(`${name} is private to the app host`);
    if (
      pluginRequire &&
      modules.serverExternals.some(
        (external) => name === external || name.startsWith(`${external}/`),
      )
    ) {
      return pluginRequire(name);
    }
    return nodeRequire(name);
  };
}

export function evaluateBundle(
  bundle: string,
  modules: PluginServerModules,
): PluginServerContribution {
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(createRuntimeRequire(modules));
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  return setup as PluginServerContribution;
}
