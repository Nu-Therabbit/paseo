import type {
  AgentMessage,
  AgentModeOption,
  LocalAgentOptions,
  McpServerConfig,
  ModelListItem,
  Run,
  RunResult,
  SDKAgent,
  SDKUserMessage,
} from "@cursor/sdk";
import type {
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderError,
  ProviderEvent,
  ProviderInput,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Catalog,
  defaultMode,
  findModel,
  modelSelection,
  modelSettings,
  modes,
  presentModels,
} from "./catalog.js";
import { providerError } from "./errors.js";
import { historyItems } from "./history.js";
import { promptMessage } from "./prompt.js";
import {
  type CursorCommand,
  discoverCommands,
  expandCommand,
  presentCommands,
} from "./commands.js";
import { type CursorSdk, loadCursorSdk, localStore } from "./sdk.js";
import { TurnTimeline } from "./turn.js";

const PERSISTENCE_VERSION = 1;

const persistenceSchema = z.object({
  agentId: z.string().min(1),
  cwd: z.string(),
  model: z.string().optional(),
  thinkingOption: z.string().optional(),
});

const providerOptionsSchema = z
  .object({
    settingSources: z
      .array(z.enum(["project", "user", "team", "mdm", "plugins", "all"]))
      .default(["all"]),
    sandbox: z.boolean().default(false),
    autoReview: z.boolean().default(false),
  })
  .strip();

interface ActiveTurn {
  turnId: string;
  run: Run | undefined;
  /** Settles once `agent.send()` returns the run, or with undefined when it fails. */
  started: Promise<Run | undefined>;
  canceled: boolean;
  ended: boolean;
}

interface PendingPrompt {
  prompt: ProviderPrompt;
  /** Expanded command or skill text sent in place of the typed `/name args`. */
  text?: string;
}

interface SessionOptions {
  id: string;
  config: ProviderSessionConfig;
  capabilities: readonly string[];
  catalog: Catalog;
  emit(event: ProviderEvent): void;
}

export class CursorSession {
  private agent: SDKAgent | undefined;
  private config: ProviderSessionConfig;
  private models: ModelListItem[] = [];
  private active: ActiveTurn | undefined;
  private readonly queued: PendingPrompt[] = [];
  private commands: CursorCommand[] = [];
  private publishedCommands: string | undefined;
  private freshConversation = true;
  private closed = false;

  constructor(private readonly options: SessionOptions) {
    this.config = options.config;
  }

  async open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const sdk = await loadCursorSdk();
    this.models = await this.options.catalog.models();
    const saved = input.persistence ? parsePersistence(input.persistence) : undefined;
    this.config = {
      ...this.config,
      model: this.config.model ?? saved?.model ?? this.models[0]?.id,
      thinkingOption: this.config.thinkingOption ?? saved?.thinkingOption,
      mode: this.config.mode ?? defaultMode,
    };
    if (!this.config.model) throw new Error("Cursor returned no models for this account");

    const local = localOptions(sdk, this.config);
    const agentOptions = {
      model: this.selection(),
      mode: this.mode(),
      mcpServers: mcpServers(this.config),
      local,
    };
    if (saved) {
      try {
        this.agent = await sdk.Agent.resume(saved.agentId, agentOptions);
      } catch (error) {
        // An agent closed before its first message was never written to the store.
        if (!(error instanceof sdk.AgentNotFoundError)) throw error;
        this.agent = await sdk.Agent.create({ ...agentOptions, agentId: saved.agentId });
      }
    } else {
      this.agent = await sdk.Agent.create({ ...agentOptions, name: this.config.title });
    }

    this.options.emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: this.options.id,
      capabilities: this.options.capabilities,
      restoration: "core",
      persistence: this.persistence(),
      title: this.config.title,
      cwd: this.config.cwd,
    });
    if (saved) {
      const turns = await this.storedTurns(saved.agentId);
      this.freshConversation = turns.length === 0;
      if (input.history === "replay") {
        for (const item of historyItems(turns)) {
          this.options.emit({ type: "timeline.item", sessionId: this.options.id, item });
        }
      }
    }
    await this.refreshCommands();
    this.publishConfig();
    this.options.emit({
      type: "session.ready",
      requestId: input.requestId,
      sessionId: this.options.id,
    });
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed) throw new Error("Cursor session is closed");
    if (prompt.delivery === "steer") {
      await this.steer(prompt);
      return;
    }
    const pending = await this.resolvePrompt(prompt);
    if (!pending) return;
    if (this.active) {
      // Cursor runs one turn at a time. The daemon cancels a turn before replacing it, so this
      // only covers a prompt that arrives while that turn is still unwinding.
      this.queued.push(pending);
      return;
    }
    this.startTurn(pending);
  }

  private async resolvePrompt(prompt: ProviderPrompt): Promise<PendingPrompt | undefined> {
    if (prompt.input.type === "command") {
      const { name, arguments: args } = prompt.input;
      const command = this.commands.find((candidate) => candidate.name === name);
      if (!command) {
        this.promptFailed(prompt, { message: `Unknown command /${name}` });
        return undefined;
      }
      return { prompt, text: await expandCommand(command, args.trim()) };
    }
    // The daemon turns `/name args` into a command only for plain-string prompts; clients that
    // send content blocks (the CLI, attachments) arrive as messages, so match them here too.
    const [only, ...rest] = prompt.input.content;
    const typed =
      rest.length === 0 && only?.type === "text" && !("mimeType" in only) ? only.text : "";
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(typed.trim());
    const command = match && this.commands.find((candidate) => candidate.name === match[1]);
    if (!match || !command) return { prompt };
    return { prompt, text: await expandCommand(command, (match[2] ?? "").trim()) };
  }

  // Commands and skills are files the user can add at any time; re-read them after each turn
  // and publish only when the list changed.
  private async refreshCommands(): Promise<void> {
    this.commands = await discoverCommands(this.config.cwd);
    const commands = presentCommands(this.commands);
    const serialized = JSON.stringify(commands);
    if (serialized === this.publishedCommands || this.closed) return;
    this.publishedCommands = serialized;
    this.options.emit({ type: "session.commands", sessionId: this.options.id, commands });
  }

  // A steer answers with exactly one result: `steer` when Cursor took the message into the
  // active turn, `failed` otherwise. The daemon owns the fallback (a new or replacing turn),
  // so a steer that Cursor reverts must never start a turn here.
  private async steer(prompt: ProviderPrompt): Promise<void> {
    const active = this.active;
    // `agent.send()` can take seconds while Cursor loads rules, hooks and MCP servers; a steer
    // sent in that window waits for the run instead of failing and replacing the turn.
    const run = active ? (active.run ?? (await active.started)) : undefined;
    const { display, message } = promptMessage(prompt);
    const steerable =
      this.active === active && run?.steer && prompt.input.type === "message" && !message.images;
    const outcome = steerable ? await run.steer?.(message.text) : undefined;
    if (!active || outcome !== "complete_delivered") {
      this.promptFailed(prompt, {
        message: "Cursor could not add this message to the running turn",
      });
      return;
    }
    this.emitItem({
      type: "user_message",
      id: `user:${randomUUID()}`,
      text: display,
      clientMessageId: prompt.clientMessageId,
    });
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "steer", turnId: active.turnId },
    });
  }

  async interrupt(): Promise<void> {
    for (const { prompt } of this.queued.splice(0)) {
      this.promptFailed(prompt, { message: "Interrupted before this message was sent" });
    }
    const active = this.active;
    if (!active) return;
    active.canceled = true;
    if (active.run) {
      await active.run.cancel();
      return;
    }
    // `agent.send()` has not returned a run yet and can take seconds; end the turn now and
    // cancel the run as soon as it exists.
    this.endTurn(active, "canceled");
  }

  configure(changes: ProviderConfigChanges): void {
    this.config = {
      ...this.config,
      model: changes.model === null ? this.models[0]?.id : (changes.model ?? this.config.model),
      mode: changes.mode === null ? defaultMode : (changes.mode ?? this.config.mode),
      // A model change resets the thinking level to the new model's default.
      thinkingOption:
        changes.thinkingOption === null
          ? undefined
          : (changes.thinkingOption ??
            (changes.model !== undefined ? undefined : this.config.thinkingOption)),
      settings: changes.settings
        ? { ...this.config.settings, ...changes.settings }
        : this.config.settings,
    };
    this.publishConfig();
    this.options.emit({
      type: "session.persistence",
      sessionId: this.options.id,
      persistence: this.persistence(),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const { prompt } of this.queued.splice(0)) {
      this.promptFailed(prompt, { message: "The session closed before this message was sent" });
    }
    const active = this.active;
    if (active) {
      active.canceled = true;
      await active.run?.cancel().catch(() => undefined);
    }
    this.agent?.close();
  }

  private startTurn({ prompt, text }: PendingPrompt): void {
    const agent = this.requireAgent();
    const turnId = randomUUID();
    const { display, message } = promptMessage(
      prompt,
      this.freshConversation ? this.config.systemPrompt : undefined,
      text,
    );
    let settle: (run: Run | undefined) => void = () => {};
    const started = new Promise<Run | undefined>((resolve) => {
      settle = resolve;
    });
    const active: ActiveTurn = { turnId, run: undefined, started, canceled: false, ended: false };
    this.active = active;
    this.emitItem({
      type: "user_message",
      id: `user:${turnId}`,
      text: display,
      clientMessageId: prompt.clientMessageId,
    });
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.options.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId,
      state: "started",
    });
    void this.runTurn(agent, active, message, settle).finally(() => {
      this.active = undefined;
      const next = this.queued.shift();
      if (next && !this.closed) this.startTurn(next);
      void this.refreshCommands().catch(() => undefined);
    });
  }

  private async runTurn(
    agent: SDKAgent,
    active: ActiveTurn,
    message: SDKUserMessage,
    settle: (run: Run | undefined) => void,
  ): Promise<void> {
    const timeline = new TurnTimeline(this.options.id, active.turnId, this.options.emit);
    let result: RunResult | undefined;
    try {
      const run = await agent.send(message, {
        model: this.selection(),
        mode: this.mode(),
        mcpServers: mcpServers(this.config),
      });
      active.run = run;
      settle(run);
      this.freshConversation = false;
      if (active.canceled) {
        await run.cancel();
        this.endTurn(active, "canceled");
        return;
      }
      for await (const event of run.stream()) timeline.apply(event);
      result = await run.wait();
    } catch (error) {
      settle(undefined);
      timeline.finish(undefined);
      this.endTurn(active, active.canceled ? "canceled" : "failed", providerError(error));
      return;
    }
    timeline.finish(result);
    if (result.status === "finished") this.endTurn(active, "completed");
    else if (result.status === "cancelled" || active.canceled) this.endTurn(active, "canceled");
    else {
      const error = {
        message: result.error?.message ?? "Cursor run failed",
        code: result.error?.code,
      };
      this.emitItem({ type: "error", id: `error:${active.turnId}`, message: error.message });
      this.endTurn(active, "failed", error);
    }
  }

  private endTurn(
    active: ActiveTurn,
    state: "completed" | "failed" | "canceled",
    error?: ProviderError,
  ): void {
    // An interrupt before the run started already ended this turn.
    if (active.ended) return;
    active.ended = true;
    this.options.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: active.turnId,
      state,
      ...(state === "failed" && error ? { error } : {}),
    });
  }

  private async storedTurns(agentId: string): Promise<AgentMessage[]> {
    const sdk = await loadCursorSdk();
    return sdk.Agent.messages.list(agentId, {
      cwd: this.config.cwd,
      store: localStore(sdk, this.config.cwd),
    });
  }

  private publishConfig(): void {
    this.options.emit({ type: "session.config", sessionId: this.options.id, config: this.state() });
  }

  private state(): ProviderConfigState {
    const models = presentModels(this.models);
    const current = models.find((model) => model.id === this.config.model);
    const thinkingOptions = current?.thinkingOptions ?? [];
    return {
      model: this.config.model,
      mode: this.mode(),
      thinkingOption:
        thinkingOptions.find((option) => option.id === this.config.thinkingOption)?.id ??
        current?.defaultThinkingOptionId,
      models,
      modes,
      thinkingOptions,
      settings: modelSettings(this.currentModel(), this.config.settings),
    };
  }

  private persistence(): ProviderPersistence {
    return {
      version: PERSISTENCE_VERSION,
      data: {
        agentId: this.requireAgent().agentId,
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOption ? { thinkingOption: this.config.thinkingOption } : {}),
      },
    };
  }

  private selection() {
    const model = this.config.model ?? "default";
    return modelSelection(
      this.currentModel(),
      model,
      this.config.thinkingOption,
      this.config.settings,
    );
  }

  private currentModel(): ModelListItem | undefined {
    return findModel(this.models, this.config.model);
  }

  private mode(): AgentModeOption {
    return this.config.mode === "plan" ? "plan" : "agent";
  }

  private requireAgent(): SDKAgent {
    if (!this.agent) throw new Error("Cursor session is not open");
    return this.agent;
  }

  private promptFailed(prompt: ProviderPrompt, error: ProviderError): void {
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "failed", error },
    });
  }

  private emitItem(item: ProviderTimelineItem): void {
    this.options.emit({ type: "timeline.item", sessionId: this.options.id, item });
  }
}

function parsePersistence(persistence: ProviderPersistence): z.infer<typeof persistenceSchema> {
  if (persistence.version !== PERSISTENCE_VERSION) {
    throw new Error(`Unsupported Cursor SDK persistence version ${persistence.version}`);
  }
  return persistenceSchema.parse(persistence.data);
}

function localOptions(sdk: CursorSdk, config: ProviderSessionConfig): LocalAgentOptions {
  const options = providerOptionsSchema.parse(config.providerOptions ?? {});
  const store = localStore(sdk, config.cwd);
  return {
    cwd: config.cwd,
    ...(store ? { store } : {}),
    settingSources: options.settingSources,
    ...(options.sandbox ? { sandboxOptions: { enabled: true } } : {}),
    ...(options.autoReview ? { autoReview: true } : {}),
  };
}

// Inline MCP servers are not persisted by the SDK, so every create, resume and send passes them.
function mcpServers(config: ProviderSessionConfig): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]): [string, McpServerConfig] =>
      server.type === "stdio"
        ? [name, { type: "stdio", command: server.command, args: server.args, env: server.env }]
        : [name, { type: server.type, url: server.url, headers: server.headers }],
    ),
  );
}
