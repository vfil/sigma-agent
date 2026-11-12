import { Effect } from "effect"
import { InputClosed } from "./errors"

// Hands the lines the user types to whoever is asking for one.
// - A line that arrives while nobody is asking waits, and the next question receives it.
// - When several questions are open, the newest one receives the line: it was printed last, so it is the one being answered.
// - When input ends, every open question fails with InputClosed, and so does every later one once the waiting lines are used up.
export interface Lines {
  readonly push: (line: string) => void
  readonly end: () => void
  readonly next: Effect.Effect<string, InputClosed>
}

export const makeLines = (): Lines => {
  const waiting: string[] = []
  const asking: Array<(answer: Effect.Effect<string, InputClosed>) => void> = []
  let ended = false

  return {
    push: (line) => {
      const asker = asking.pop()
      if (asker) asker(Effect.succeed(line))
      else waiting.push(line)
    },
    end: () => {
      ended = true
      for (const asker of asking.splice(0)) asker(Effect.fail(new InputClosed()))
    },
    next: Effect.callback<string, InputClosed>((resume) => {
      const line = waiting.shift()
      if (line !== undefined) return resume(Effect.succeed(line))
      if (ended) return resume(Effect.fail(new InputClosed()))
      asking.push(resume)
      // A question that is interrupted stops asking, so it cannot take a line meant for the next one.
      return Effect.sync(() => {
        const index = asking.indexOf(resume)
        if (index >= 0) asking.splice(index, 1)
      })
    }),
  }
}