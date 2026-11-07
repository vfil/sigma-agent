# sigma-agent

A small coding-agent in a handful of files, written to show how an LLM agent works. [Effect](https://effect.website) is the only dependency.

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
You: <prompt>
  └─► the protocol encodes the full history + tool definitions, and sends them to the provider, asking for a stream
        the protocol decodes the stream into events: pieces of text, finished tool calls, and a final "finish"
        ├─ text pieces                     ─► print "Agent: ..." piece by piece as they arrive
        └─ model asks for tool call(s)     ─► for each one, print "[tool] name(args)", then:
              ├─ tool needs confirmation   ─► ask "Allow: ...? [y/N]"; anything but "y" declines
              ├─ run the tool              ─► result
              └─ tool failure             ─► print "[error] ...", and the error text becomes the result
            append the results, call the model again
      (repeat until the model answers without a tool call, then wait for your next prompt)
```

One prompt and everything the agent does in answer to it is a **turn**. Failures are typed errors (see [src/errors.ts](src/errors.ts)), and the loop handles each kind in one place:

- **Tool failures** (unknown tool, invalid arguments, a declined confirmation, a command timeout, a missing file) are sent back to the model as an error result, so it can read the message and try something else.
- **Provider errors** (server unreachable, a non-OK status, a stream that breaks off, ends before the model finished, or can't be read) are printed as `[provider error] ...` for you only. The model never sees them.
- **Bugs** in the program are printed as `[bug] ...`.
- **Config errors** (an unknown `PROVIDER`, a missing `ANTHROPIC_API_KEY`) are raised when the model client is built, before the first prompt. The program prints the message and exits with code 1.

After a provider error or a bug the whole turn is dropped from the history and the prompt returns, so the next prompt starts from a consistent conversation. If the error hits in the middle of a reply, the text already printed stays on screen, the line is ended, and then the error is printed.

The loop never sees a wire format. The conversation is a `history` of protocol-neutral messages made of text, tool-call and tool-result parts, and the active **protocol** encodes it for the wire and decodes the reply. A reply comes back as server-sent events ([src/sse.ts](src/sse.ts) cuts the bytes into frames), and the protocol turns the frames into **model events** ([src/events.ts](src/events.ts)): `text-delta`, `tool-call` (sent once its arguments are complete) and `finish` (with the reason `tool-calls`, `stop` or `refusal`). The loop builds the assistant message from those events. Two details differ by protocol:

- **OpenAI Chat Completions** has no error flag on tool results, so an error result is sent as text starting with `Error: `.
- **Anthropic Messages** marks failures with `is_error`, and the `finish` event carries the provider's own reply content (thinking blocks included) so the loop can send it back unchanged.

The whole conversation lives in memory (`history`) and is lost when the process exits.

## Services and layers

The loop in [src/agent.ts](src/agent.ts) does not import readline, `fetch` or the tool list. It asks for three **services** (Effect `Context.Service`s), and [src/index.ts](src/index.ts) wires the real ones in as **layers**:

| Service       | What the loop needs from it                                | Real layer        | Defined in                                 |
| ------------- | ---------------------------------------------------------- | ----------------- | ------------------------------------------ |
| `ModelClient` | `chat(history, tools)`: one model call, as a stream of events | `ModelClientLive` | [src/model-client.ts](src/model-client.ts) |
| `Terminal`    | `ask(prompt)` to read a line, `say(line)` to print one, `write(text)` to print without ending the line | `TerminalLive`    | [src/terminal.ts](src/terminal.ts)         |
| `Tools`       | the list of tools the model may call                       | `ToolsLive`       | [src/tools.ts](src/tools.ts)               |

Building `ModelClientLive` reads the environment, so provider selection happens once at startup instead of at import time. `TerminalLive` opens readline and closes it when the program ends. Because the loop only sees the services, a test can swap in fakes without touching the network, the keyboard or the disk.

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
```

## Tests

`bun test` runs without a network, a keyboard or a real model. There are three groups:

- [test/agent.test.ts](test/agent.test.ts) runs the agent loop against a scripted model and a scripted terminal, with two small in-memory tools. The fakes live in [test/fakes.ts](test/fakes.ts) and are provided as layers in place of the real services. It covers:
  - a tool call followed by a final answer
  - a declined confirmation reaching the model as an error result
  - a turn whose model call fails being dropped from the history
  - a reply shown piece by piece
  - a reply that breaks off: the line is ended and the turn is dropped
- [test/protocols.test.ts](test/protocols.test.ts) feeds recorded streams from [test/fixtures/](test/fixtures/) (Ollama, llama.cpp and Claude) through the framing and each protocol. It checks the events, that a tool call sent in fragments comes out as one `tool-call` event, and that the result does not depend on where the bytes are cut.
- [test/provider.test.ts](test/provider.test.ts) runs one step against a small local HTTP server: the request asks for a stream, and a stream that stops early, a frame that isn't JSON, an error status and an unreachable server each fail with a `ProviderError`.

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

## Known limitations

- No sandboxing, no history persistence.
- A turn that fails with a provider error or a bug is dropped from the history, including any tool calls it already ran. If the model had already edited a file or run a command before the failure, that change stays on disk but the model no longer remembers making it.
- Confirmation covers only `edit_file`, `write_file` and `bash`. `read_file` and `list_files` can read any path without asking, and the prompt shows only the path or command, not the file content or a diff.

## Repo layout

- [src/index.ts](src/index.ts): the entry point: wires the live layers together, runs the loop and reports config errors
- [src/agent.ts](src/agent.ts): the agent loop (`turn`, one per prompt; `step`, one model call, which prints the text as it arrives and builds the assistant message) and the `repl` that reads prompts and handles provider errors and bugs
- [src/events.ts](src/events.ts): the model events a step streams
- [src/sse.ts](src/sse.ts): cuts a byte stream into server-sent events
- [src/model-client.ts](src/model-client.ts): the `ModelClient` service and its live layer
- [src/messages.ts](src/messages.ts): the protocol-neutral message types
- [src/tool.ts](src/tool.ts): `defineTool`, `runTool` and the `Tools` service
- [src/tools.ts](src/tools.ts): the five tools and `ToolsLive`
- [src/protocols.ts](src/protocols.ts): the OpenAI Chat Completions and Anthropic Messages protocols, each turning stream frames into model events
- [src/provider.ts](src/provider.ts): the routes, provider selection from env vars (`selectRoute`), and the model call (a stream of events; it fails if the stream ends before a `finish`)
- [src/errors.ts](src/errors.ts): the typed errors
- [src/terminal.ts](src/terminal.ts): the `Terminal` service (read a line, print a line, print without ending the line) and its live layer
- [test/](test/): the loop, protocol and provider tests, the fake model and terminal, and recorded streams in `fixtures/`
- [GLOSSARY.md](GLOSSARY.md): the project's vocabulary
- [playground/](playground/): scratch folder to run the agent in
- `.claude/skills/`: Claude Code dev-workflow skills used when working on this repo. They are not part of the agent and you can ignore them.
