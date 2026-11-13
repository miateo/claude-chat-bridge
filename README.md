# chat-bridge

Lets a normal Claude chat (in the Claude desktop app) send messages to a Claude Code session on the same computer and read its answers.

It has two halves:

- **The connector** (`server/bridge-mcp.mjs`): a small local MCP server the desktop chat calls. Tools: `ask_claude_code`, `get_claude_code_reply`, `claude_code_status` (lists the listening sessions).
- **The mod** (`hooks/register.ts`): a Claude Code plugin that adds `/chat-bridge on [name]|off`. While on, the session listens under a name, runs each message the chat sends to that name as a prompt, and sends the final answer back.

Messages travel as files under `~/.claude/chat-bridge`. The bridge itself opens no network port and sends nothing off the computer.

> Experimental. It is built on Claude Code's early-access mod API, which changes between releases, and has been run on macOS only. Read [Security](#security) before turning it on.

## Install on a computer

Needs Node.js 18 or later, Claude Code, and the Claude desktop app.

```bash
git clone https://github.com/miateo/claude-chat-bridge.git
```

```bash
node claude-chat-bridge/install.mjs
```

The installer adds the connector to the desktop app's config (after writing a backup beside it) and installs the mod into Claude Code. Both run from the cloned folder, so keep it; run the installer again if you move it.

Then quit and reopen the Claude desktop app.

To install only the mod, at the prompt of a terminal Claude Code session:

```
/plugin install chat-bridge --marketplace miateo/claude-chat-bridge
```

## Use

1. In each Claude Code session that should answer, run `/chat-bridge on`. The session is named after its folder; pick another name with `/chat-bridge on <name>`, for example `/chat-bridge on ads`.
2. In a normal chat in the desktop app, ask for example: "use chat-bridge to ask the ads session which folder it is in". With one session listening, the name can be left out.
3. `/chat-bridge off` stops that session listening. `/chat-bridge` alone shows its state.

Listening is per session and never starts by itself: run `/chat-bridge on` again after restarting the desktop app or the session.

Options for `/chat-bridge on`:

| Option | What it does |
| --- | --- |
| `<name>` | The name the chat uses for this session. Default: the folder's name. |
| `--trust` | Skip the approval described under Security: what a relayed message leads to runs under the session's own permissions. |
| `--plain` | Submit relayed messages as if typed, without Claude Code's "plugin sent a message" wrapper. Cleaner to read; the session then gives them the weight of your own words. |

## Security

A message that comes over the bridge was written by another model. If that chat has read a web page, an email or a document with instructions hidden in it, it can be steered into sending a message you never asked for, and that message then runs in a coding agent on your computer. chat-bridge is built around that risk:

- **Off by default, per session.** Nothing listens until you run `/chat-bridge on` in a session, and a restart turns it off.
- **Actions need your approval.** While a relayed message's turn runs, every tool call the session would have run without asking, and that is not a read, is put to you in Claude Code instead. This holds in every permission mode, bypass included. Where nobody can be asked, the action is refused. `--trust` turns this off for a session; use it only when you would be comfortable typing anything the chat might send.
- **Labelled.** A relayed message arrives marked as relayed, not as typed by you, unless you choose `--plain`.
- **The chat asks too.** The desktop app asks before the chat calls the connector. Keep that on "ask", not "always allow".
- **Private to your user.** The bridge folder is created with mode 700 and tightened if it is looser. Anything that can write to `~/.claude/chat-bridge/inbox` can prompt a listening session, so a program already running as you can; the bridge adds no protection against that.
- **Logged.** Every message sent and answer read is appended to `~/.claude/chat-bridge/log.jsonl` (rotated at 2 MB).
- **Bounded.** Messages over 20,000 characters are refused.

What it does not protect:

- **Reads are not gated.** A relayed message can make the session read files in its reach, and the answer goes back to the chat, where it is stored with that conversation like any other chat content. Don't listen from a session that can read secrets you would not paste into a chat.
- **The approval is only as good as your reading of it.** Read what you approve.
- **No isolation between sessions' names.** Names are for addressing, not access control.

Found a problem? Open an issue.

## Limits

- Only the chat can start an exchange; Claude Code can only answer.
- Several sessions can listen at once, each under its own name. One session takes one message at a time; a message sent while it is busy waits for its turn to end.
- The chat waits up to about 50 seconds per call. For longer work it gets an id and asks again with `get_claude_code_reply`.
- Desktop app only: claude.ai in a browser and the mobile apps cannot reach a local connector.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## Update

```bash
git -C claude-chat-bridge pull
```

```bash
claude plugin marketplace update chat-bridge-marketplace
```
