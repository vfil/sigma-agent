import { Effect } from "effect"
import { createInterface } from "node:readline/promises"
import { InputClosed } from "./errors"

const rl = createInterface({ input: process.stdin, output: process.stdout })

// A pending question never settles when input ends, so ending input is turned into a rejection.
const closed = new Promise<never>((_, reject) => rl.once("close", () => reject(new Error("input closed"))))
closed.catch(() => {})

// Asks one question. The type says it can fail: input may have ended.
export const ask = (prompt: string) =>
  Effect.tryPromise({
    try: () => Promise.race([rl.question(prompt), closed]),
    catch: () => new InputClosed(),
  })