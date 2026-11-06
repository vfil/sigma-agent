import { Effect } from "effect"
import { ConfigError, messageOf, ProviderError } from "./errors"
import type { Message } from "./messages"
import { anthropicMessages, openaiChat, type Protocol, type Reply } from "./protocols"
import type { Tool } from "./tool"

type Env = Record<string, string | undefined>

// A route binds a protocol to one provider's endpoint and authentication.
export type Route = { protocol: Protocol; baseUrl: string; headers: Record<string, string>; model: string }

// The routes the agent knows. They read the environment they are given, so nothing happens at import time.
const routes = (env: Env): Record<string, Route> => ({
  ollama: { protocol: openaiChat, baseUrl: "http://127.0.0.1:11434/v1", headers: {}, model: "qwen3.5:9b" },
  llamacpp: { protocol: openaiChat, baseUrl: "http://127.0.0.1:9931/v1", headers: {}, model: "qwen3.5:9b" },
  claude: {
    protocol: anthropicMessages,
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2026-10-21" },
    model: "claude-sonnet-5-5",
  },
})

// PROVIDER picks the route. BASE_URL and MODEL override the route's defaults.
export const selectRoute = (env: Env): Effect.Effect<Route, ConfigError> => {
  const name = env.PROVIDER ?? "ollama"
  const selected = routes(env)[name]
  if (!selected) return Effect.fail(new ConfigError({ reason: `Unknown PROVIDER "${name}". Choose one of: ${Object.keys(routes(env)).join(", ")}` }))
  if (name === "claude" && !env.ANTHROPIC_API_KEY) return Effect.fail(new ConfigError({ reason: "Set ANTHROPIC_API_KEY first" }))
  return Effect.succeed({ ...selected, baseUrl: env.BASE_URL ?? selected.baseUrl, model: env.MODEL ?? selected.model })
}

// One step: one model call. It fails with a ProviderError that the user reads; the model never sees it.
export const chat = (route: Route, history: Message[], tools: Tool[]) =>
  Effect.gen(function* () {
    const unreachable = (error: unknown) => new ProviderError({ reason: `Could not reach ${route.baseUrl}: ${messageOf(error)}` })

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${route.baseUrl}${route.protocol.path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...route.headers },
          body: JSON.stringify(route.protocol.body(route.model, history, tools)),
        }),
      catch: unreachable
    })
    const text = yield* Effect.tryPromise({ try: () => response.text(), catch: unreachable })
    if (!response.ok) return yield* new ProviderError({ reason: `${route.baseUrl} answered ${response.status}: ${text}` })

    return yield* Effect.try({
      try: (): Reply => route.protocol.decode(JSON.parse(text)),
      catch: (error) => new ProviderError({ reason: `Could not read the reply from ${route.baseUrl}: ${messageOf(error)}` })
    })
  })