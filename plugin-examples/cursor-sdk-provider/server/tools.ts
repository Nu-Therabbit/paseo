import type { SDKToolUseMessage } from "@cursor/sdk";
import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { QUESTION_TOOL, questionDetail } from "./questions.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type TodoItem = Extract<ProviderTimelineItem, { type: "todo" }>["items"][number];

const text = z.string();
const shellArgs = z.object({ command: text, workingDirectory: text.optional() });
const pathArgs = z.object({ path: text });
const writeArgs = z.object({ path: text, fileText: text.optional() });
const editArgs = z.object({
  path: text,
  oldText: text.optional(),
  newText: text.optional(),
  patchContent: text.optional(),
});
const grepArgs = z.object({ pattern: text, path: text.optional() });
const globArgs = z.object({ globPattern: text, targetDirectory: text.optional() });
const semSearchArgs = z.object({ query: text });
const fetchArgs = z.object({ url: text });
const taskArgs = z.object({ description: text, prompt: text.optional() });
const planArgs = z.object({ plan: text });
const todosArgs = z.object({
  todos: z.array(z.object({ content: text, status: text.optional(), id: text.optional() })),
});
const mcpArgs = z.object({
  providerIdentifier: text.optional(),
  toolName: text.optional(),
  args: z.unknown().optional(),
});
// The MCP server the SDK exposes `customTools` through.
const CUSTOM_TOOLS_SERVER = "custom-user-tools";

const shellResult = z.object({
  stdout: text.optional(),
  stderr: text.optional(),
  exitCode: z.number().optional(),
});
const readResult = z.object({ content: text });
const editResult = z.object({ diffString: text.optional() });

// Tool names arrive in the SDK's public vocabulary ("shell", "updateTodos") or as raw
// proto names ("update_todos_tool_call"); compare them without case or separators.
export function toolKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/toolcall$|_tool_call$/, "")
    .replace(/[^a-z]/g, "");
}

type Mapper = (args: unknown, value: unknown) => ProviderToolCallDetail | undefined;

function parse<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function searchMapper(toolName: "search" | "web_search"): Mapper {
  return (args) => {
    const parsed = parse(semSearchArgs, args);
    return parsed && { type: "search", query: parsed.query, toolName };
  };
}

const mappers: Record<string, Mapper> = {
  shell(args, value) {
    const parsed = parse(shellArgs, args);
    if (!parsed) return undefined;
    const output = parse(shellResult, value);
    return {
      type: "shell",
      command: parsed.command,
      cwd: parsed.workingDirectory,
      output: [output?.stdout, output?.stderr].filter(Boolean).join("\n") || undefined,
      exitCode: output?.exitCode,
    };
  },
  read(args, value) {
    const parsed = parse(pathArgs, args);
    return (
      parsed && { type: "read", filePath: parsed.path, content: parse(readResult, value)?.content }
    );
  },
  write(args) {
    const parsed = parse(writeArgs, args);
    return parsed && { type: "write", filePath: parsed.path, content: parsed.fileText };
  },
  edit(args, value) {
    const parsed = parse(editArgs, args);
    return (
      parsed && {
        type: "edit",
        filePath: parsed.path,
        oldString: parsed.oldText,
        newString: parsed.newText,
        unifiedDiff: parse(editResult, value)?.diffString ?? parsed.patchContent,
      }
    );
  },
  delete(args) {
    const parsed = parse(pathArgs, args);
    return parsed && { type: "plain_text", label: `Delete ${parsed.path}`, icon: "pencil" };
  },
  grep(args) {
    const parsed = parse(grepArgs, args);
    return parsed && { type: "search", query: parsed.pattern, toolName: "grep" };
  },
  glob(args) {
    const parsed = parse(globArgs, args);
    return parsed && { type: "search", query: parsed.globPattern, toolName: "glob" };
  },
  ls(args) {
    const parsed = parse(pathArgs, args);
    return parsed && { type: "plain_text", label: `List ${parsed.path}`, icon: "eye" };
  },
  semsearch: searchMapper("search"),
  websearch: searchMapper("web_search"),
  webfetch(args) {
    const parsed = parse(fetchArgs, args);
    return parsed && { type: "fetch", url: parsed.url };
  },
  task(args, value) {
    const parsed = parse(taskArgs, args);
    return (
      parsed && {
        type: "sub_agent",
        description: parsed.description,
        log: typeof value === "string" ? value : "",
      }
    );
  },
  createplan(args) {
    const parsed = parse(planArgs, args);
    return parsed && { type: "plan", text: parsed.plan };
  },
  mcp(args, value) {
    const parsed = parse(mcpArgs, args);
    if (parsed && isQuestionCall(parsed)) return questionDetail(parsed.args, value);
    const label = [parsed?.providerIdentifier, parsed?.toolName].filter(Boolean).join(" · ");
    return label ? { type: "plain_text", label, icon: "wrench" } : undefined;
  },
};

function isQuestionCall(args: z.infer<typeof mcpArgs>): boolean {
  return args.providerIdentifier === CUSTOM_TOOLS_SERVER && args.toolName === QUESTION_TOOL;
}

// Custom tools arrive as generic `mcp` calls; name the question tool so the row reads as one.
export function displayToolName(message: SDKToolUseMessage): string {
  if (toolKey(message.name) !== "mcp") return message.name;
  const parsed = parse(mcpArgs, message.args);
  return parsed && isQuestionCall(parsed) ? QUESTION_TOOL : message.name;
}

export function toolDetail(message: SDKToolUseMessage): ProviderToolCallDetail {
  const value = resultValue(message.result);
  return (
    mappers[toolKey(message.name)]?.(message.args, value) ?? {
      type: "unknown",
      input: toJson(message.args),
      output: toJson(value),
    }
  );
}

export function todoItems(message: SDKToolUseMessage): TodoItem[] | undefined {
  // Plans carry their steps as todos too.
  if (!["updatetodos", "createplan"].includes(toolKey(message.name))) return undefined;
  const parsed = todosArgs.safeParse(message.args);
  if (!parsed.success) return undefined;
  return parsed.data.todos.map((todo) => {
    const status = todoStatus(todo.status);
    return { text: todo.content, completed: status === "completed", status, id: todo.id };
  });
}

function todoStatus(status: string | undefined): TodoItem["status"] {
  switch (status?.toLowerCase().replace(/[^a-z]/g, "")) {
    case "inprogress":
      return "in_progress";
    case "completed":
    case "cancelled":
      return "completed";
    default:
      return "pending";
  }
}

// Results arrive as `{ status: "success", value }` or `{ status: "error", error }`.
function resultValue(result: unknown): unknown {
  if (isRecord(result) && result.status === "success" && "value" in result) return result.value;
  return result;
}

export function toolError(message: SDKToolUseMessage): JsonValue {
  const result = message.result;
  if (isRecord(result) && "error" in result) return toJson(result.error);
  return toJson(result) ?? "Tool call failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
