# sigma-agent

A minimal coding-agent in a single file, written to show how an LLM agent works without a framework.

You chat with it in the terminal. The model can't touch your files directly. It can only ask the program to run one of three **tools**, and the program runs the tool and feeds the result back:

| Tool         | What it does                                                                 |
| ------------ | ---------------------------------------------------------------------------- |
| `list_files` | List a directory (directories end with `/`)                                  |
| `read_file`  | Read a text file                                                             |
| `edit_file`  | Replace one exact piece of text in a file, or create a file (`old_str` empty) |

## How it works

```
You: <prompt>
  └─► send full message history + tool definitions to the model
        ├─ model replies with text         ─► print "Agent: ..."
        └─ model asks for tool call(s)     ─► print "[tool] name(args)", run it,
                                               append the result, call the model again
      (repeat until the model answers without a tool call, then wait for your next prompt)
```

The whole conversation lives in memory (`messages`) and is lost when the process exits.

## Two entry points

Both files are the same agent loop with the same tools. They differ only in the wire protocol of the model provider.

| File                 | Provider                                                | Config (env vars)                                                                              |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [index.ts](index.ts)   | Any OpenAI-compatible server (local llama.cpp, Ollama…) | `BASE_URL` (default `http://127.0.0.1:9931/v1`), `MODEL` (default `qwen3.5:9b`)                |
| [claude.ts](claude.ts) | Anthropic API                                           | `ANTHROPIC_API_KEY` (required), `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`), `MODEL` (default `claude-sonnet-5-5`) |

`index.ts` is the main path. By default it expects a llama.cpp server on port `9931`. To use Ollama instead, set `BASE_URL=http://127.0.0.1:11434/v1`.

## Setup

Requires [Bun](https://bun.com). The project uses Bun for everything (see [CLAUDE.md](CLAUDE.md)).

```bash
bun install
bun check        # type check (same as `bun run typecheck`)
```

## Try it (manual smoke test)

There are no automated tests. To check the agent works end to end, run it against the [playground/](playground/) folder, which contains a riddle in `secret-file.txt`.

> **Warning:** the tools are not sandboxed. Paths are resolved against the directory you launch from, absolute paths work, and `edit_file` can create or overwrite any file your user can write. Always run the agent from `playground/`, not from a directory you care about.

1. Make sure a model is available:
   - **`index.ts`**: start your OpenAI-compatible server (llama.cpp on `:9931` by default, or Ollama with `BASE_URL` set as above).
   - **`claude.ts`**: `export ANTHROPIC_API_KEY=...`
2. Start the agent from inside `playground/`:

   ```bash
   cd playground
   bun ../index.ts      # or: bun ../claude.ts
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

You can also try `edit_file`, for example *"add 'call mom' to notes/todo.txt"*, then check `playground/notes/todo.txt` (use `git diff` to review and `git checkout playground` to undo).

Press `Ctrl+C` to quit.

## Known limitations

- A failing tool call (for example, reading a path that doesn't exist) throws and ends the process. Errors are not returned to the model.
- No sandboxing, no permission prompts, no streaming, no history persistence.

## Repo layout

- [index.ts](index.ts), [claude.ts](claude.ts): the agent (one file per provider)
- [playground/](playground/): scratch folder to run the agent in
- `.claude/skills/`: Claude Code dev-workflow skills used when working on this repo. They are not part of the agent and you can ignore them.
