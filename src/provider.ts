import { Effect } from "effect"
import { messageOf, ProviderError } from "./errors"
import type { Message } from "./messages"
import { anthropicMessages, openaiChat, type Protocol, type Reply } from "./protocols"
import type { Tool } from "./tool"

// A route binds a protocol to one provider's endpoint and authentication.
export type Route = { protocol: Protocol; baseUrl: string; headers: Record<string, string>; model: string }

const routes: Record<string, Route> = {
  ollama: { protocol: openaiChat, baseUrl: "http://127.0.0.1:11434/v1", headers: {}, model: "qwen3.5:9b" },
  llamacpp: { protocol: openaiChat, baseUrl: "http://127.0.0.1:9931/v1", headers: {}, model: "qwen3.5:9b" },
  claude: {
    protocol: anthropicMessages,
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2026-10-21" },
    model: "claude-sonnet-5-5",
  },
}

const providerName = process.env.PROVIDER ?? "ollama"
const selected = routes[providerName]
if (!selected) throw new Error(`Unknown PROVIDER "${providerName}". Choose one of: ${Object.keys(routes).join(", ")}`)
if (providerName === "claude" && !process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY first")

// BASE_URL and MODEL still override the route's defaults.
const route: Route = {
  ...selected,
  baseUrl: process.env.BASE_URL ?? selected.baseUrl,
  model: process.env.MODEL ?? selected.model,
}

// One step: one model call. It fails with a ProviderError that the user reads; the model never sees it.
export const chat = (history: Message[], tools: Tool[]) =>
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