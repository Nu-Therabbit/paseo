import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
  type ProviderSessionSummary,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { Catalog } from "./catalog.js";
import { LOGIN_DIAGNOSTIC, providerError } from "./errors.js";
import { describe, loadCursorSdk, localStore } from "./sdk.js";
import { CursorSession } from "./session.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "permission",
  "session.configure",
  "session.list",
  "session.persistence",
] as const;

export function createCursorSdkProvider(): ProviderRegistration {
  const catalog = new Catalog();
  return {
    id: "cursor-sdk",
    label: "Cursor (SDK)",
    description: "Cursor agents through @cursor/sdk, signed in with your Cursor account",
    icon: "icon.svg",
    status,
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return connect(catalog, negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

async function status(): Promise<ProviderStatus> {
  try {
    const sdk = await loadCursorSdk();
    if (process.env.CURSOR_API_KEY) return { available: true };
    const auth = await sdk.Cursor.auth.status();
    if (auth.status === "logged-out") return { available: false, diagnostic: LOGIN_DIAGNOSTIC };
    return { available: true, diagnostic: auth.email ? `Signed in as ${auth.email}` : undefined };
  } catch (error) {
    return { available: false, diagnostic: describe(error) };
  }
}

function connect(catalog: Catalog, capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, CursorSession>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        emit({ type: "catalog", requestId: input.requestId, catalog: await catalog.read() });
        return;
      case "sessions":
        emit({ type: "sessions", requestId: input.requestId, sessions: await listSessions(input) });
        return;
      case "session.open": {
        if (sessions.has(input.sessionId)) throw new Error("Cursor session is already open");
        const session = new CursorSession({
          id: input.sessionId,
          config: input.config,
          capabilities,
          catalog,
          emit,
        });
        sessions.set(input.sessionId, session);
        try {
          await session.open(input);
        } catch (error) {
          sessions.delete(input.sessionId);
          await session.close();
          throw error;
        }
        return;
      }
      case "session.archive":
      case "session.unarchive":
      case "session.revert":
        throw new Error(`Cursor (SDK) does not support ${input.type}`);
    }
    const session = sessions.get(input.sessionId);
    if (!session) throw new Error("Cursor session is not open");
    switch (input.type) {
      case "session.prompt":
        await session.prompt(input.prompt);
        return;
      case "session.permission":
        // Permission inputs carry no request id to complete.
        await session.respond(input.permissionId, input.response);
        return;
      case "session.configure":
        session.configure(input.changes);
        break;
      case "session.interrupt":
        await session.interrupt();
        break;
      case "session.close":
        sessions.delete(input.sessionId);
        await session.close();
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
    }
    emit({ type: "request.completed", requestId: input.requestId });
  }

  function failed(input: ProviderInput, failure: unknown): void {
    const error = providerError(failure);
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error });
    } else {
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error });
    }
  }

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Cursor (SDK) connection is closed");
      requireProviderCapabilities(capabilities, input);
      queueMicrotask(() => {
        if (!closed) void dispatch(input).catch((error: unknown) => failed(input, error));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...sessions.values()].map((session) => session.close()));
      sessions.clear();
      listeners.clear();
    },
  };
}

async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
): Promise<ProviderSessionSummary[]> {
  // Local agents are stored per workspace; without one there is nothing to scope the list to.
  const cwd = input.cwd;
  if (!cwd) return [];
  const sdk = await loadCursorSdk();
  const { items } = await sdk.Agent.list({
    runtime: "local",
    cwd,
    store: localStore(sdk, cwd),
    limit: input.limit,
  });
  const query = input.query?.toLowerCase();
  return items
    .filter((agent) => !agent.archived)
    .filter(
      (agent) =>
        !query ||
        agent.name.toLowerCase().includes(query) ||
        agent.summary.toLowerCase().includes(query),
    )
    .map((agent) => ({
      persistence: { version: 1, data: { agentId: agent.agentId, cwd } },
      cwd: agent.runtime === "local" && agent.cwd ? agent.cwd : cwd,
      title: agent.name || undefined,
      description: agent.summary || undefined,
      updatedAt: new Date(agent.lastModified).toISOString(),
    }));
}
