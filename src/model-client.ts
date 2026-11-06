import { Context, Effect, Layer } from "effect"
import type { ProviderError } from "./errors"
import type { Message } from "./messages"
import { chat, selectRoute, type Route } from "./provider"
import type { Reply } from "./protocols"
import type { Tool } from "./tool"

// What the agent needs from a model: one step. Which provider answers is not its business.
export class ModelClient extends Context.Service<
  ModelClient,
  {
    readonly chat: (history: Message[], tools: Tool[]) => Effect.Effect<Reply, ProviderError>
  }
>()("@agent/ModelClient") {}

// The real model client. Building the layer reads the environment, so a bad PROVIDER fails here, before the first prompt.
export const ModelClientLive = Layer.effect(
  ModelClient,
  Effect.gen(function* () {
    const route: Route = yield* selectRoute(process.env)
    return ModelClient.of({ chat: (history, tools) => chat(route, history, tools) })
  }),
)