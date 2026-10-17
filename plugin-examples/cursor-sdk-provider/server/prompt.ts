import type { SDKUserMessage } from "@cursor/sdk";
import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";

export interface PromptMessage {
  /** Text shown as the user's timeline row. */
  display: string;
  /** Message sent to Cursor. */
  message: SDKUserMessage;
}

/** `body` replaces the typed text in the message, e.g. an expanded command or skill. */
export function promptMessage(
  prompt: ProviderPrompt,
  instructions?: string,
  body?: string,
): PromptMessage {
  const content = prompt.input.type === "message" ? prompt.input.content : [];
  const display =
    prompt.input.type === "command"
      ? `/${prompt.input.name} ${prompt.input.arguments}`.trim()
      : content.flatMap(contentText).join("\n\n");
  const images = content.flatMap((part) =>
    part.type === "image" ? [{ data: part.data, mimeType: part.mimeType }] : [],
  );
  // Cursor's `systemPrompt` option replaces its whole harness prompt and is gated per
  // account, so Paseo's instructions ride on the first message of a new conversation.
  const sent = body ?? display;
  const text = instructions
    ? `${INSTRUCTIONS_OPEN}\n${instructions}\n${INSTRUCTIONS_CLOSE}\n\n${sent}`
    : sent;
  return { display, message: images.length > 0 ? { text, images } : { text } };
}

const INSTRUCTIONS_OPEN = "<paseo-instructions>";
const INSTRUCTIONS_CLOSE = "</paseo-instructions>";

// Replayed user messages contain the instructions block sent with the first message.
export function withoutInstructions(text: string): string {
  if (!text.startsWith(INSTRUCTIONS_OPEN)) return text;
  const end = text.indexOf(INSTRUCTIONS_CLOSE);
  return end === -1 ? text : text.slice(end + INSTRUCTIONS_CLOSE.length).trimStart();
}

function contentText(part: ProviderContent): string[] {
  switch (part.type) {
    case "text":
      return "mimeType" in part
        ? [part.title ? `${part.title}\n\n${part.text}` : part.text]
        : [part.text];
    case "image":
      return [];
    case "uploaded_file":
      return [`Attached file: ${part.path} (${part.fileName}, ${part.mimeType})`];
    case "github_pr":
    case "forge_change_request":
      return [joined([`Pull request #${part.number}: ${part.title}`, part.url, part.body])];
    case "github_issue":
    case "forge_issue":
      return [joined([`Issue #${part.number}: ${part.title}`, part.url, part.body])];
    case "review":
      return [
        joined([
          `Review comments (${part.mode === "base" ? `against ${part.baseRef ?? "base"}` : "uncommitted changes"}):`,
          ...part.comments.map(
            (comment) =>
              `${comment.filePath}:${comment.lineNumber} (${comment.side})\n${comment.body}`,
          ),
        ]),
      ];
  }
}

function joined(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}
