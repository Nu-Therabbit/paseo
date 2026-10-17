import type { AgentMessage, SDKToolUseMessage } from "@cursor/sdk";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { withoutInstructions } from "./prompt.js";
import { todoItems, toolDetail, toolError, displayToolName } from "./tools.js";

// `Agent.messages.list()` returns one entry per stored turn as a protobuf message. Its
// JSON form flattens oneofs into keys: a turn is `{ agentConversationTurn: { userMessage, steps } }`
// and each step has one of `assistantMessage`, `thinkingMessage` or `toolCall`.
const textSchema = z.object({ text: z.string() });
const stepSchema = z.object({
  assistantMessage: textSchema.optional(),
  thinkingMessage: textSchema.optional(),
  toolCall: z.record(z.string(), z.unknown()).optional(),
});
const turnSchema = z.object({
  agentConversationTurn: z.object({
    userMessage: textSchema.optional(),
    steps: z.array(stepSchema).default([]),
  }),
});
const toolCallSchema = z.object({ args: z.unknown().optional(), result: z.unknown().optional() });

export function historyItems(entries: readonly AgentMessage[]): ProviderTimelineItem[] {
  return entries.flatMap((entry) => {
    const parsed = turnSchema.safeParse(toJson(entry.message));
    if (!parsed.success) return [];
    const id = `history:${entry.uuid}`;
    const { userMessage, steps } = parsed.data.agentConversationTurn;
    const items: ProviderTimelineItem[] = [];
    if (userMessage?.text) {
      items.push({
        type: "user_message",
        id: `${id}:user`,
        text: withoutInstructions(userMessage.text),
      });
    }
    steps.forEach((step, index) => items.push(...stepItems(`${id}:${index}`, step)));
    return items;
  });
}

function stepItems(id: string, step: z.infer<typeof stepSchema>): ProviderTimelineItem[] {
  if (step.assistantMessage?.text) {
    return [{ type: "assistant_message", id, text: step.assistantMessage.text }];
  }
  if (step.thinkingMessage?.text) {
    return [{ type: "reasoning", id, text: step.thinkingMessage.text }];
  }
  return step.toolCall ? toolItems(id, step.toolCall) : [];
}

// A tool step holds its call under one `<name>ToolCall` key next to fields like `toolCallId`.
function toolItems(id: string, step: Record<string, unknown>): ProviderTimelineItem[] {
  const entry = Object.entries(step).find(([key]) => key.endsWith("ToolCall"));
  const call = entry ? toolCallSchema.safeParse(entry[1]) : undefined;
  if (!entry || !call?.success) return [];
  const message = storedToolMessage(id, entry[0], call.data.args, call.data.result);
  const base = {
    type: "tool_call" as const,
    id,
    callId: id,
    name: displayToolName(message),
    detail: toolDetail(message),
  };
  const items: ProviderTimelineItem[] = [
    message.status === "error"
      ? { ...base, status: "failed", error: toolError(message) }
      : { ...base, status: "completed", error: null },
  ];
  const todos = todoItems(message);
  if (todos) items.push({ type: "todo", id: `${id}:todo`, items: todos });
  return items;
}

// Stored results use protobuf oneof JSON (`{ success: {...} }` or `{ error: {...} }`);
// the live stream uses `{ status, value }`. Convert to the live shape.
function storedToolMessage(
  id: string,
  key: string,
  args: unknown,
  result: unknown,
): SDKToolUseMessage {
  const success = z.object({ success: z.unknown() }).safeParse(result);
  const failure = z.object({ error: z.unknown() }).safeParse(result);
  const base = { type: "tool_call" as const, agent_id: "", run_id: "", call_id: id, args };
  const name = key.replace(/ToolCall$/, "");
  if (failure.success) {
    return {
      ...base,
      name,
      status: "error",
      result: { status: "error", error: failure.data.error },
    };
  }
  return {
    ...base,
    name,
    status: "completed",
    result: success.success ? { status: "success", value: success.data.success } : result,
  };
}

// Protobuf messages serialize through their own toJSON (bigint timestamps, flattened oneofs).
function toJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
