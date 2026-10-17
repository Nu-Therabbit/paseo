import type { ProviderCommand } from "@getpaseo/plugin/server/provider";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The SDK gives the model its skills as context but does not expand `/name` in message text,
// so the provider lists commands and skills itself and expands the one the user picks.
// These mirror the locations Cursor reads; project entries win over personal ones.
const COMMAND_DIRECTORIES = [path.join(".cursor", "commands"), path.join(".claude", "commands")];
const SKILL_DIRECTORIES = [".cursor", ".claude", ".codex", ".grok", ".agents"].map((configDir) =>
  path.join(configDir, "skills"),
);
const BUILTIN_SKILL_DIRECTORY = path.join(".cursor", "skills-cursor");
// Codex ships these in its skills folder; Cursor skips them.
const SKIPPED_CODEX_SKILLS = new Set([
  "imagegen",
  "openai-docs",
  "plugin-creator",
  "skill-creator",
  "skill-installer",
]);
const MAX_DESCRIPTION = 200;

export interface CursorCommand {
  kind: "command" | "skill";
  name: string;
  description: string;
  file: string;
}

export async function discoverCommands(cwd: string): Promise<CursorCommand[]> {
  const home = os.homedir();
  const roots = cwd === home ? [home] : [cwd, home];
  const groups = await Promise.all([
    ...roots.flatMap((root) =>
      COMMAND_DIRECTORIES.map((directory) => readCommands(path.join(root, directory))),
    ),
    ...roots.flatMap((root) =>
      SKILL_DIRECTORIES.map((directory) =>
        readSkills(path.join(root, directory), directory.startsWith(".codex")),
      ),
    ),
    readSkills(path.join(home, BUILTIN_SKILL_DIRECTORY), false),
  ]);
  const byName = new Map<string, CursorCommand>();
  for (const command of groups.flat()) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function presentCommands(commands: readonly CursorCommand[]): ProviderCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description || (command.kind === "skill" ? "Skill" : "Command"),
    argumentHint: command.kind === "skill" ? "[task]" : "[arguments]",
  }));
}

// A command file is the prompt itself, with the arguments after it. A skill is attached with
// its instructions so the model follows it for this request.
export async function expandCommand(command: CursorCommand, args: string): Promise<string> {
  const { body } = parseMarkdown(await readFile(command.file, "utf8"));
  if (command.kind === "command") return args ? `${body}\n\n${args}` : body;
  const skill = `<skill name="${command.name}" path="${command.file}">\n${body}\n</skill>`;
  const request = args || `Run the ${command.name} skill.`;
  return `Use the "${command.name}" skill for this request.\n\n${skill}\n\n${request}`;
}

async function readCommands(directory: string): Promise<CursorCommand[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const commands = await Promise.all(
    entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
      .map(async (entry): Promise<CursorCommand | undefined> => {
        const file = path.join(directory, entry.name);
        const content = await readFile(file, "utf8").catch(() => undefined);
        if (content === undefined) return undefined;
        const { fields, body } = parseMarkdown(content);
        return {
          kind: "command",
          name: entry.name.slice(0, -".md".length),
          description: summary(fields.description ?? firstLine(body)),
          file,
        };
      }),
  );
  return commands.filter((command) => command !== undefined);
}

async function readSkills(directory: string, codex: boolean): Promise<CursorCommand[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(
    entries
      // Installed skills are often symlinks or junctions to a shared copy.
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          !(codex && SKIPPED_CODEX_SKILLS.has(entry.name)),
      )
      .map(async (entry): Promise<CursorCommand | undefined> => {
        const file = path.join(directory, entry.name, "SKILL.md");
        const content = await readFile(file, "utf8").catch(() => undefined);
        if (content === undefined) return undefined;
        // Cursor names a skill by its folder.
        return {
          kind: "skill",
          name: entry.name,
          description: summary(parseMarkdown(content).fields.description ?? ""),
          file,
        };
      }),
  );
  return skills.filter((skill) => skill !== undefined);
}

interface Markdown {
  fields: Record<string, string>;
  body: string;
}

// Reads the flat `key: value` frontmatter these files use, including folded (`>`) and
// literal (`|`) block values. Anything richer is ignored.
function parseMarkdown(content: string): Markdown {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { fields: {}, body: text.trim() };
  const fields: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index]);
    if (!field) continue;
    let value = field[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index].trim());
      }
      value = block.join(value.startsWith(">") ? " " : "\n");
    }
    fields[field[1]] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

function firstLine(body: string): string {
  return (
    body
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? ""
  );
}

function summary(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_DESCRIPTION ? `${single.slice(0, MAX_DESCRIPTION - 1)}…` : single;
}
