import type { SDKCustomTool, SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk";
import type {
  ProviderEvent,
  ProviderPermissionResponse,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// Local SDK runs reject Cursor's built-in askQuestion, so the provider removes it and offers
// this tool instead. Paseo answers it through its question form.
export const QUESTION_TOOL = "ask_question";

const DISMISSED =
  "The user dismissed these questions without answering. Continue with your best judgment, or ask in your reply.";

const questionSchema = z.object({
  header: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z
    .array(z.object({ label: z.string().trim().min(1), description: z.string().optional() }))
    .default([]),
  multiSelect: z.boolean().default(false),
});
const argsSchema = z.object({ questions: z.array(questionSchema).min(1) });
const answersSchema = z.record(z.string(), z.string());

type Question = z.infer<typeof questionSchema>;

const inputSchema: Record<string, SDKJsonValue> = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          header: {
            type: "string",
            description: "Short unique label for the question, at most 12 characters",
          },
          question: { type: "string", description: "The full question, ending in a question mark" },
          options: {
            type: "array",
            description: "Choices to offer; the user can always type their own answer",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean", description: "Allow picking more than one option" },
        },
        required: ["header", "question"],
      },
    },
  },
  required: ["questions"],
};

interface Pending {
  questions: Question[];
  resolve(result: SDKCustomToolResult): void;
}

export class QuestionBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  tools(): Record<string, SDKCustomTool> {
    return {
      [QUESTION_TOOL]: {
        description:
          "Ask the user one or more multiple-choice questions and wait for the answers. Use it when a decision is the user's to make and you cannot proceed sensibly without it.",
        inputSchema,
        annotations: { title: "Ask question", readOnlyHint: true },
        execute: (args) => this.ask(args),
      },
    };
  }

  /** Returns true when the user asked to stop the turn along with dismissing. */
  respond(permissionId: string, response: ProviderPermissionResponse): boolean {
    const pending = this.pending.get(permissionId);
    // An answer can race a dismissal from an interrupt; the daemon already saw it resolved.
    if (!pending) return false;
    if (response.behavior === "allow") {
      pending.resolve(answerText(pending.questions, response.updatedInput?.answers));
    } else {
      pending.resolve(DISMISSED);
    }
    this.settle(permissionId);
    return response.behavior === "deny" && response.interrupt === true;
  }

  dismissAll(): void {
    for (const [id, pending] of this.pending) {
      pending.resolve(DISMISSED);
      this.settle(id);
    }
  }

  private ask(args: Record<string, SDKJsonValue>): Promise<SDKCustomToolResult> {
    const parsed = argsSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({
        content: [{ type: "text", text: `Invalid questions: ${parsed.error.message}` }],
        isError: true,
      });
    }
    const questions = uniqueHeaders(parsed.data.questions);
    const id = `question:${randomUUID()}`;
    return new Promise((resolve) => {
      this.pending.set(id, { questions, resolve });
      this.emit({
        type: "session.permission",
        sessionId: this.sessionId,
        request: {
          id,
          name: QUESTION_TOOL,
          kind: "question",
          title: "Question",
          input: {
            questions: questions.map((question) => ({
              header: question.header,
              question: question.question,
              options: question.options.map((option) => ({
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
              })),
              multiSelect: question.multiSelect,
              isOther: true,
            })),
          },
        },
      });
    });
  }

  private settle(id: string): void {
    this.pending.delete(id);
    this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId: id });
  }
}

// Paseo keys answers by header, so two questions must never share one.
function uniqueHeaders(questions: Question[]): Question[] {
  const seen = new Set<string>();
  return questions.map((question, index) => {
    const header = seen.has(question.header) ? `${question.header} ${index + 1}` : question.header;
    seen.add(header);
    return { ...question, header };
  });
}

function answerText(questions: Question[], raw: unknown): string {
  const answers = answersSchema.safeParse(raw);
  const lines = questions.map((question) => {
    const answer = answers.success ? answers.data[question.header]?.trim() : undefined;
    return `${question.question}\n${answer || "(no answer)"}`;
  });
  return `The user answered:\n\n${lines.join("\n\n")}`;
}

export function questionDetail(args: unknown, value: unknown): ProviderToolCallDetail | undefined {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return undefined;
  const { questions } = parsed.data;
  const label = questions.length === 1 ? questions[0].question : `${questions.length} questions`;
  // The result restates each question with its answer.
  const text = resultText(value) ?? questions.map((question) => question.question).join("\n");
  return { type: "plain_text", label, icon: "brain", text };
}

const resultSchema = z.object({
  content: z.array(z.object({ text: z.object({ text: z.string() }) })),
});

function resultText(value: unknown): string | undefined {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data.content.map((block) => block.text.text).join("\n") || undefined;
}
