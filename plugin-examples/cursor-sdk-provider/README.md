# Cursor SDK provider

This plugin registers a `cursor-sdk` provider that runs Cursor agents in-process through
[`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript) instead of the built-in Cursor CLI over ACP.
It needs no client entry.

## Install

```bash
cd plugin-examples/cursor-sdk-provider
npm install
npm run login
paseo plugin install "$PWD"
```

`npm run login` opens the browser to sign in to Cursor and stores an expiring user API key in
`~/.cursor/sdk/auth.json`. SDK runs bill to that account's plan like IDE runs. A `CURSOR_API_KEY`
in the daemon's environment takes precedence. Until either exists, the provider reports itself
unavailable with the sign-in instruction.

The manifest lists `@cursor/sdk` in `server.externals`: the SDK loads its own chunks and native
helpers from computed paths and cannot be bundled, so it must stay installed in this directory.
It needs Node 22.13 or later on the daemon host.

## What maps to what

| Paseo                    | Cursor SDK                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Models                   | `Cursor.models.list()`; the first entry is the default                             |
| Thinking selector        | The model parameter whose id names reasoning, thinking, or effort                  |
| Composer settings        | Every other model parameter with more than one value                               |
| Modes `agent` and `plan` | `mode` on every `agent.send()`                                                     |
| Persistence and replay   | `Agent.resume()`; replay rebuilds text, reasoning, and tool rows from stored turns |
| Steering                 | `run.steer()`; a message Cursor reverts runs as the next turn                      |
| Interrupt                | `run.cancel()`                                                                     |
| Host tools               | `config.mcpServers`, passed on every create, resume, and send                      |
| System prompt            | Prepended to the first message; Cursor's `systemPrompt` replaces its harness       |

Local SDK agents run tools without approval prompts, so the provider has no permission flow and
marks Agent as the unattended mode. Use Plan mode, or the provider options below, to restrict it.

## Provider options

Set these under `agents.providers.cursor-sdk` provider options:

| Option           | Default   | Effect                                                             |
| ---------------- | --------- | ------------------------------------------------------------------ |
| `settingSources` | `["all"]` | Cursor settings layers to load: rules, skills, MCP config, hooks   |
| `sandbox`        | `false`   | Restrict writes to the workspace and deny shell network by default |
| `autoReview`     | `false`   | Send tool calls through Cursor's Auto-review classifier            |

## Limits

- The SDK has no per-agent environment, so `config.env` from Paseo does not reach Cursor's shell.
- Turns interrupted before Cursor stored them do not replay.
- The SDK's default store is SQLite under `~/.cursor/projects/<workspace>/sdk-agent-store`, a path that
  grows with the workspace path. On Windows, workspaces whose deepest store file would pass 248
  characters, and hosts without `node:sqlite`, store agents as JSONL under `~/.cursor/sdk/paseo/<hash>`
  instead. Paseo worktrees under `~/.paseo/worktrees` usually take the JSONL path.
- Cursor loads your user hooks with `settingSources: ["all"]`, and logs a line for each Claude Code hook
  event it does not support. Those lines appear in `paseo plugin logs cursor-sdk-provider`.
