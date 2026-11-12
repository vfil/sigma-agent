# sigma-agent

A small coding-agent in a handful of files, written to show how an LLM agent works. [Effect](https://effect.website) is the core dependency. The session log adds SQLite through `drizzle-orm` and `@effect/sql-sqlite-bun`.

You chat with it in the terminal, and the reply appears as the model writes it. The model can't touch your files directly. It can only ask the program to run one of five **tools** (see [GLOSSARY.md](GLOSSARY.md) for the terms used here), and the program runs the tool and feeds the result back. Tools that change things ask you to confirm first.

| Tool         | What it does                                                                                              | Confirms first? |
| ------------ | --------------------------------------------------------------------------------------------------------- | --------------- |
| `list_files` | List a directory (directories end with `/`)                                                               | No              |
| `read_file`  | Read a text file                                                                                          | No              |
| `edit_file`  | Replace one exact piece of text in a file, or create a file (`old_str` empty)                             | Yes             |
| `write_file` | Write a whole file, replacing it if it exists and creating missing folders                                | Yes             |
| `bash`       | Run a shell command in the current directory and return its exit code and output (stops after 30 s, output cut at 10,000 characters) | Yes             |

## How it works

```
(on start: say how many queued prompts the last run left, then finish any turn it left unfinished, see Sessions below)

reader, always asking "You: ", even while a turn runs:
  You: <prompt>  ─► admit it to the inbox, print "[queued]", wake the worker, ask again

worker, one turn at a time:
  deliver the oldest queued prompt: it moves from the inbox into the session as a `prompt` event
      rebuild the history from the session's events
      the protocol encodes the full history + tool definitions, and sends them to the provider, asking for a stream
        the protocol decodes the stream into model events: pieces of text, finished tool calls, and a final "finish"
        ├─ text pieces                     ─► print "Agent: ..." piece by piece as they arrive
        └─ model asks for tool call(s)     ─► record the finished step, then for each call, print "[tool] name(args)", then:
              ├─ tool needs confirmation   ─► ask "Allow: ...? [y/N]"; anything but "y" declines
              ├─ run the tool              ─► result
              └─ tool failure             ─► print "[error] ...", and the error text becomes the result
            record each result as soon as its tool finishes, rebuild the history, call the model again
      (repeat until the model answers without a tool call, then deliver the next queued prompt, or wait for one)
```

One prompt and everything the agent does in answer to it is a **turn**. Failures are typed errors (see [src/errors.ts](src/errors.ts)), and the loop handles each kind in one place:

- **Tool failures** (unknown tool, invalid arguments, a declined confirmation, a command timeout, a missing file) are sent back to the model as an error result, so it can read the message and try something else.
- **Provider errors** (server unreachable, a non-OK status, a stream that breaks off, ends before the model finished, or can't be read) are printed as `[provider error] ...` for you only. The model never sees them.
- **Bugs** in the program are printed as `[bug] ...`.
- **Config errors** (an unknown `PROVIDER`, a missing `ANTHROPIC_API_KEY`) are raised when the model client is built, before the first prompt. The program prints the message and exits with code 1.
- **Session errors** (a stored session event that no longer matches the schema, for example after a hand edit or a change of version) name the session and the event, and the program exits with code 1 like a config error. Unlike a config error, this can also happen in the middle of a session, because the history is read from the log before every step.

After a provider error or a bug the turn is recorded as failed and the agent moves on to the next queued prompt, or waits for one. The log keeps the failed turn, but the history leaves it out, so the next prompt starts from a consistent conversation. If the error hits in the middle of a reply, the text already printed stays on screen, the line is ended, and then the error is printed.

The loop never sees a wire format. The conversation is a `history` of protocol-neutral messages made of text, tool-call and tool-result parts ([src/messages.ts](src/messages.ts)), and the active **protocol** encodes it for the wire and decodes the reply. A reply comes back as server-sent events ([src/sse.ts](src/sse.ts) cuts the bytes into frames), and the protocol turns the frames into **model events** ([src/events.ts](src/events.ts)): `text-delta`, `tool-call` (sent once its arguments are complete) and `finish` (with the reason `tool-calls`, `stop` or `refusal`). The loop builds the assistant message from those events. Two details differ by protocol:

- **OpenAI Chat Completions** has no error flag on tool results, so an error result is sent as text starting with `Error: `.
- **Anthropic Messages** marks failures with `is_error`, and the `finish` event carries the provider's own reply content (thinking blocks included) so the loop can send it back unchanged.

The conversation is kept in a **session** on disk (see Sessions below), and the `history` is rebuilt from it before every model call, so it survives a restart.

## Services and layers

The loop in [src/agent.ts](src/agent.ts) does not import readline, `fetch`, SQLite or the tool list. It asks for four **services** (Effect `Context.Service`s), and [src/index.ts](src/index.ts) wires the real ones in as **layers**:

| Service       | What the loop needs from it                                | Real layer        | Defined in                                 |
| ------------- | ---------------------------------------------------------- | ----------------- | ------------------------------------------ |
| `ModelClient` | `chat(history, tools)`: one model call, as a stream of model events | `ModelClientLive` | [src/model-client.ts](src/model-client.ts) |
| `Terminal`    | `ask(prompt)` to read a line, `say(line)` to print one, `write(text)` to print without ending the line | `TerminalLive`    | [src/terminal.ts](src/terminal.ts)         |
| `Tools`       | the list of tools the model may call                       | `ToolsLive`       | [src/tools.ts](src/tools.ts)               |
| `Session`     | `admit(text)` to save a prompt in the inbox, `deliver` to move the oldest one into the log, `pending` to count the queued prompts, `append(event)` to record a session event, `events` and `history` to read them back (each call reads the log again) | `SessionLive`     | [src/session.ts](src/session.ts)           |

Building `ModelClientLive` reads the environment, so provider selection happens once at startup instead of at import time. `TerminalLive` opens readline and closes it when the program ends. `SessionLive` opens the SQLite file, applies the migrations and closes the file when the program ends (the schema is in [src/db/schema.ts](src/db/schema.ts)). Because the loop only sees the services, a test can swap in fakes without touching the network, the keyboard or the disk.

## Sessions

A **session** is a named conversation that survives restarts. It is stored as an append-only list of **session events**, the facts the agent cannot work out from the other events ([src/session-event.ts](src/session-event.ts)). The `history` is not stored. [src/history.ts](src/history.ts) rebuilds it from the events before every model call. (Session events are not the same as the streamed **model events** above: only the finished message is recorded, not the pieces.)

| Session event   | Recorded when                                                           |
| --------------- | ----------------------------------------------------------------------- |
| `prompt`        | a queued prompt is delivered, which is when its turn starts, not when you type it |
| `step-finished` | a model call ends: the whole assistant message and why it ended         |
| `tool-result`   | one tool call finishes (a step with three calls records three, one by one) |
| `turn-failed`   | a provider error or a bug ends the turn; the history leaves that turn out |

**Resume.** If the process dies in the middle of a turn, the next start finds a turn that did not finish. It prints `[resuming session ...]`, gives every tool call that has no result an error result saying it may or may not have run (`[interrupted] ...`), and then continues the turn. Such a call is never run again, because a command that already ran must not run twice. The model reads the error result and can check the state before repeating the call.

**Typing while the agent works.** The loop has two halves that do not wait for each other. The reader asks for a line, **admits** it (saves it in the **inbox**, a second table next to the log), prints `[queued]` and asks again, even while a turn is running. The worker runs one turn at a time. When a turn ends it **delivers** the oldest queued prompt. Delivering deletes the inbox row and writes the `prompt` event in one transaction, so a crash cannot lose a prompt or deliver it twice. The reader never sends the prompt to the worker: it only rings a bell, and the worker looks in the inbox. A prompt you type in the middle of a turn is saved at once and runs after the turn, in the order you typed them.

The inbox survives a restart. On start, if the last run left queued prompts, the agent prints `[N queued prompts from an earlier run]`. It finishes any interrupted turn first (see Resume), then runs the queued prompts in order. When input ends (`Ctrl+D`), the agent still runs every queued prompt before it exits.

**Where it lives.** The database is a SQLite file. The agent starts in `playground/`, so the default `../my-agent.db` puts it next to the project, outside the folder the agent works in. The file is git-ignored. Two env vars choose the file and the session:

- `DB_PATH`: the database file (default `../my-agent.db`).
- `SESSION`: the session id (default `default`). A new id starts an empty conversation in the same file, and the old one stays there.

## Adding a tool

A tool is built with `defineTool` and added to the `tools` array in [src/tools.ts](src/tools.ts), which `ToolsLive` provides to the loop:

```ts
defineTool({
  name: "word_count",
  description: "Count the words in a text file.",   // the model reads this to decide when to use it
  input: Schema.Struct({                            // one Schema: validates the input and becomes the JSON Schema the model receives
    path: Schema.String.annotate({ description: "Path of the file to count, e.g. 'notes.txt'" }),
  }),
  execute: async ({ path }) => String((await readFile(path, "utf8")).split(/\s+/).length), // receives the validated, typed input
  confirm: ({ path }) => `count words in ${path}`,  // optional: set it to require confirmation
})
```

`runTool` (in [src/tool.ts](src/tool.ts)) takes the tool list from the `Tools` service, looks the tool up and runs it. The tool checks the input against its `Schema`, asks for confirmation through the `Terminal` service when `confirm` is set, then runs `execute`. Bad input becomes an `InvalidInput` error result that lists each problem and the fields the tool takes, and anything `execute` throws becomes an error result, so the model can read it and fix its call.

## Providers

One agent loop, three **providers**. Pick one with the `PROVIDER` env var (default `ollama`):

| `PROVIDER`  | Talks to                       | Protocol                | Default base URL            | Default model       |
| ----------- | ------------------------------ | ----------------------- | --------------------------- | ------------------- |
| `ollama`    | Ollama                         | OpenAI Chat Completions | `http://127.0.0.1:11434/v1` | `qwen3.5:9b`        |
| `llamacpp`  | llama.cpp server               | OpenAI Chat Completions | `http://127.0.0.1:9931/v1`  | `qwen3.5:9b`        |
| `claude`    | Anthropic API                  | Anthropic Messages      | `https://api.anthropic.com` | `claude-sonnet-5-5` |

```bash
bun src/index.ts                               # Ollama
PROVIDER=llamacpp bun src/index.ts             # llama.cpp on :9931
PROVIDER=claude ANTHROPIC_API_KEY=... bun src/index.ts
```

Env vars:

- `PROVIDER`: `ollama`, `llamacpp` or `claude`. Any other value stops the program with the list of valid ones.
- `ANTHROPIC_API_KEY`: required when `PROVIDER=claude`, ignored otherwise.
- `BASE_URL`, `MODEL`: override the chosen provider's defaults, whichever provider it is. `ANTHROPIC_BASE_URL` is no longer read; use `BASE_URL` to point `claude` at another endpoint.
- `DB_PATH`, `SESSION`: the session database file and the session id (see Sessions).

## Adding a provider

A **route** binds a **protocol** to one provider's endpoint, headers and model. A server that speaks an existing protocol needs only a new entry in `routes` in [src/provider.ts](src/provider.ts). `routes` is a function of the environment, so the entry goes inside the object it returns:

```ts
vllm: { protocol: openaiChat, baseUrl: "http://127.0.0.1:8000/v1", headers: {}, model: "my-model" },
```

A new wire format needs a new `Protocol` object in [src/protocols.ts](src/protocols.ts) with three members: `path` (the URL path to call), `body` (turns the history and tools into the request body, with streaming turned on) and `events` (turns the stream of server-sent frames into model events: `text-delta`, `tool-call` and a last `finish` with the reason `tool-calls`, `stop` or `refusal`). Then reference it from a route.

## Setup

Requires [Bun](https://bun.com). The project uses Bun for everything (see [CLAUDE.md](CLAUDE.md)).

```bash
bun install
bun check        # type check (same as `bun run typecheck`)
bun test         # run the automated tests (same as `bun run test`)
bun run db:generate   # only after changing src/db/schema.ts: writes a new migration into drizzle/
```

## Tests

`bun test` runs without a network, a keyboard or a real model. The session tests use a temporary SQLite file. There are eight groups:

- [test/agent.test.ts](test/agent.test.ts) runs the agent loop against a scripted model and a scripted terminal, with two small in-memory tools. The fakes live in [test/fakes.ts](test/fakes.ts) and are provided as layers in place of the real services. It covers:
  - a tool call followed by a final answer
  - a declined confirmation reaching the model as an error result
  - a turn whose model call fails being recorded as failed and left out of the history
  - a reply shown piece by piece
  - a reply that breaks off: the line is ended and the turn is recorded as failed
  - every prompt saved first and then run one at a time, in the order typed
  - a prompt typed while a turn runs being saved at once and run after that turn
- [test/protocols.test.ts](test/protocols.test.ts) feeds recorded streams from [test/fixtures/](test/fixtures/) (Ollama, llama.cpp and Claude) through the framing and each protocol. It checks the events, that a tool call sent in fragments comes out as one `tool-call` event, and that the result does not depend on where the bytes are cut.
- [test/provider.test.ts](test/provider.test.ts) runs one step against a small local HTTP server: the request asks for a stream, and a stream that stops early, a frame that isn't JSON, an error status and an unreachable server each fail with a `ProviderError`.
- [test/history.test.ts](test/history.test.ts) checks that session events become messages in order, that a failed turn is left out, and which tool calls still lack a result.
- [test/session.test.ts](test/session.test.ts) checks that events read back in order after the file is closed and reopened, that two sessions stay apart, and that a stored event that does not match the schema is named.
- [test/inbox.test.ts](test/inbox.test.ts) checks that prompts are delivered in the order they were admitted, that delivering moves a prompt from the inbox into the log, that the inbox survives closing and reopening the file, that two sessions keep separate inboxes, and that a delivery that fails leaves the prompt in the inbox.
- [test/lines.test.ts](test/lines.test.ts) checks `makeLines` ([src/lines.ts](src/lines.ts)): lines that arrive early are kept in order, a waiting question gets the line, the newest of several questions gets it, open questions fail when input ends, and an interrupted question does not take the next line. The live terminal does not use it yet.
- [test/resume.test.ts](test/resume.test.ts) writes the log a crash would leave, starts the agent again on it, and checks that an unanswered call gets an error result and is never run again, that finished and failed turns are left alone, and that queued prompts left by the crash run in order, after the interrupted turn.

They do not cover a real model or the built-in tools.

## Try it (manual smoke test)

The tests do not exercise a real model. To check the agent works end to end, run it against the [playground/](playground/) folder, which contains a riddle in `secret-file.txt`.

> **Warning:** the tools are not sandboxed. Paths are resolved against the directory you launch from and absolute paths work. `bash` can run any command as your user, and `edit_file` and `write_file` can create or overwrite any file you can write. The only protection is the confirmation prompt, so read the path or command it shows before typing `y`. Always run the agent from `playground/`, not from a directory you care about.

1. Make sure a model is available:
   - **`ollama`** (default): start Ollama and pull the model (`ollama pull qwen3.5:9b`).
   - **`llamacpp`**: start your llama.cpp server on port `9931`.
   - **`claude`**: `export ANTHROPIC_API_KEY=...`
2. Start the agent from inside `playground/`:

   ```bash
   cd playground
   bun ../src/index.ts                      # Ollama
   PROVIDER=llamacpp bun ../src/index.ts    # llama.cpp
   PROVIDER=claude bun ../src/index.ts      # Claude
   ```

3. Ask it about the riddle. Example session:

   ```
   You: Hello!
   Agent: Hello! How can I help you today?
   You: There is a text file in this directory with a riddle in it. What's the answer to the riddle?
   [tool] list_files({"path":"."})
   [tool] read_file({"path":"secret-file.txt"})
   Agent: The answer to the riddle is **a keyboard**.

   Here's why:
   - "I have keys but no locks" - A keyboard has keys (the buttons) but no physical locks
   - "I have space but no room" - A keyboard has a "space" bar, but no actual room
   - "You can enter, but you can't go outside" - You can enter data (type on it), but you can't exit the keyboard itself

   Classic riddle!
   ```

**What to look for:** the `[tool] ...` lines show the model chose to list the directory and then read the file before answering. Exact wording varies between runs and models. What matters is that tool calls happen and the answer is "a keyboard".

You can also try a tool that changes things, for example *"add 'call mom' to notes/todo.txt"*. The agent stops and asks before it edits:

```
[tool] edit_file({"path":"notes/todo.txt","old_str":"- water the plants","new_str":"- water the plants\n- call mom"})
Allow: edit notes/todo.txt? [y/N]
```

Type `y` to let it run. Anything else declines, and the model is told so and can ask what you'd like instead. Afterwards check `playground/notes/todo.txt` (use `git diff` to review and `git checkout playground` to undo).

Press `Ctrl+C` to quit. Ending the input with `Ctrl+D` also exits cleanly.

To check that the session survives a restart, quit, start the agent again with the same command, and ask *"what did I just ask you?"*. The model answers from the stored history. To see the inbox, type a second prompt while the agent is still answering the first: it prints `[queued]` at once and runs after the first turn ends. Set `SESSION=other` to start a fresh conversation. The database is `my-agent.db` in the project root (git-ignored); delete it to forget everything.

## Known limitations

- No sandboxing.
- One process per session. The sequence number of the events is counted in memory, so two processes on the same `SESSION` would collide. The inbox ids come from the database, but a second writer still makes `deliver` fail, and the prompt stays in the inbox when it does.
- A queued prompt cannot be cancelled, edited or listed, and a running turn cannot be interrupted. You can only wait for it.
- `Ctrl+D` does not exit at once: the agent runs every queued prompt first. `Ctrl+C` leaves the queued prompts in the inbox, and the next start runs them.
- The live terminal still reads one line at a time with readline, while the reader is always asking `You: `. A confirmation (`Allow: ...? [y/N]`) asked during a turn is a second open question. [src/lines.ts](src/lines.ts) is the module meant to settle which question gets a typed line (the newest one), but `TerminalLive` does not use it yet, so confirming while a prompt is being read may not work.
- No way to list, switch or delete sessions from inside the agent. You pick one with `SESSION` when you launch it.
- The log only grows, and the whole history is sent on every call. There is no compaction.
- A turn that fails with a provider error or a bug is left out of the history, including any tool calls it already ran. If the model had already edited a file or run a command before the failure, that change stays on disk but the model no longer remembers making it.
- A tool call interrupted by a crash is never run again. The model is told it may or may not have run, so it has to check the result itself.
- Confirmation covers only `edit_file`, `write_file` and `bash`. `read_file` and `list_files` can read any path without asking, and the prompt shows only the path or command, not the file content or a diff.

## Repo layout

- [src/index.ts](src/index.ts): the entry point: wires the live layers together, runs the loop and reports config errors
- [src/agent.ts](src/agent.ts): the agent loop (`run`, the steps of one turn; `step`, one model call, which prints the text as it arrives and records the assistant message), `resume` for an unfinished turn, and the `repl`, made of a reader that admits prompts and a worker that delivers them and runs their turns, and handles provider errors and bugs
- [src/events.ts](src/events.ts): the model events a step streams
- [src/sse.ts](src/sse.ts): cuts a byte stream into server-sent events
- [src/model-client.ts](src/model-client.ts): the `ModelClient` service and its live layer
- [src/messages.ts](src/messages.ts): the protocol-neutral message types, as Schemas so the same definitions check what is read back from the log
- [src/session.ts](src/session.ts): the `Session` service (inbox and log) and its live SQLite layer
- [src/session-event.ts](src/session-event.ts): the four kinds of session event
- [src/db/schema.ts](src/db/schema.ts): the two database tables, the event log and the inbox (the Drizzle schema)
- [src/lines.ts](src/lines.ts): `makeLines`, which hands typed lines to the open questions (not used by the live terminal yet)
- [src/history.ts](src/history.ts): rebuilds the history from session events (`toHistory`) and finds the tool calls an unfinished turn left without a result (`unansweredCalls`)
- [drizzle/](drizzle/): the database migrations, applied when the session opens
- [src/tool.ts](src/tool.ts): `defineTool`, `runTool` and the `Tools` service
- [src/tools.ts](src/tools.ts): the five tools and `ToolsLive`
- [src/protocols.ts](src/protocols.ts): the OpenAI Chat Completions and Anthropic Messages protocols, each turning stream frames into model events
- [src/provider.ts](src/provider.ts): the routes, provider selection from env vars (`selectRoute`), and the model call (a stream of events; it fails if the stream ends before a `finish`)
- [src/errors.ts](src/errors.ts): the typed errors (including `SessionCorrupt`)
- [src/terminal.ts](src/terminal.ts): the `Terminal` service (read a line, print a line, print without ending the line) and its live layer
- [test/](test/): the loop, protocol, provider, history, session, inbox, lines and resume tests, the fake model and terminal, and recorded streams in `fixtures/`
- [GLOSSARY.md](GLOSSARY.md): the project's vocabulary
- [playground/](playground/): scratch folder to run the agent in
- `.claude/skills/`: Claude Code dev-workflow skills used when working on this repo. They are not part of the agent and you can ignore them.
