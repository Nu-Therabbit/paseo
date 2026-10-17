import type { RunResult, SDKMessage, SDKToolUseMessage, TokenUsage } from "@cursor/sdk";
import type { ProviderEvent, ProviderUsage } from "@getpaseo/plugin/server/provider";
import { todoItems, toolDetail, toolError } from "./tools.js";

interface Segment {
  id: string;
  text: string;
}

// Folds one run's SDK stream into complete timeline snapshots. Text and reasoning
// deltas grow the current segment; a tool call closes both, so text after a tool
// becomes a new row in the order Cursor produced it.
export class TurnTimeline {
  private assistant: Segment | undefined;
  private reasoning: Segment | undefined;
  private segments = 0;
  private readonly tools = new Map<string, SDKToolUseMessage>();
  private usage: TokenUsage | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  apply(message: SDKMessage): void {
    switch (message.type) {
      case "assistant": {
        const text = message.message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
        if (!text) return;
        this.reasoning = undefined;
        this.assistant ??= this.segment("assistant");
        this.assistant.text += text;
        this.emitItem({
          type: "assistant_message",
          id: this.assistant.id,
          text: this.assistant.text,
        });
        return;
      }
      case "thinking": {
        if (message.text) {
          this.assistant = undefined;
          this.reasoning ??= this.segment("reasoning");
          this.reasoning.text += message.text;
          this.emitItem({ type: "reasoning", id: this.reasoning.id, text: this.reasoning.text });
        }
        if (message.thinking_duration_ms !== undefined) this.reasoning = undefined;
        return;
      }
      case "tool_call":
        this.assistant = undefined;
        this.reasoning = undefined;
        this.tools.set(message.call_id, message);
        this.emitTool(message, message.status === "error" ? "failed" : message.status);
        return;
      case "usage":
        this.usage = message.usage;
        return;
      default:
        return;
    }
  }

  // Tool calls still running when the run ends were cut off by it.
  finish(result: RunResult | undefined): void {
    const status = result?.status === "finished" ? "completed" : "canceled";
    for (const message of this.tools.values()) {
      if (message.status === "running") this.emitTool(message, status);
    }
    const usage = this.usage ?? result?.usage;
    if (usage) {
      this.emit({
        type: "session.usage",
        sessionId: this.sessionId,
        turnId: this.turnId,
        usage: presentUsage(usage),
      });
    }
  }

  private emitTool(
    message: SDKToolUseMessage,
    status: "running" | "completed" | "failed" | "canceled",
  ): void {
    const base = {
      type: "tool_call" as const,
      id: `tool:${message.call_id}`,
      callId: message.call_id,
      name: message.name,
      detail: toolDetail(message),
    };
    this.emitItem(
      status === "failed"
        ? { ...base, status, error: toolError(message) }
        : { ...base, status, error: null },
    );
    const todos = todoItems(message);
    if (todos) this.emitItem({ type: "todo", id: `todo:${this.sessionId}`, items: todos });
  }

  private segment(kind: "assistant" | "reasoning"): Segment {
    this.segments += 1;
    return { id: `${kind}:${this.turnId}:${this.segments}`, text: "" };
  }

  private emitItem(item: Extract<ProviderEvent, { type: "timeline.item" }>["item"]): void {
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
  }
}

function presentUsage(usage: TokenUsage): ProviderUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
  };
}
