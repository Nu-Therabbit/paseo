import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCursorSdkProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createCursorSdkProvider());
  return () => {};
}
