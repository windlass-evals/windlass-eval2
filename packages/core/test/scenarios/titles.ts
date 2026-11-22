import { event } from "../../src/event/durable.ts"
import { type Scenario, baseline, created, deliver, enqueue, executionStarted, executionSucceeded, m, say, stepEnded, stepStarted, usage } from "./script.ts"

export const generatedTitle: Scenario = {
  title: "A title arrives after the turn and the user replaces it",
  description: "The first prompt supplies a bounded excerpt for an independent title request. The turn finishes while that request is pending. Its usage and title are recorded outside the conversation. An explicit rename then takes precedence.",
  provider: "answers the prompt first, then returns a title and its usage",
  phases: [{
    label: "the turn completes and the independent request names it",
    events: [
      created(),
      event("inbox.enqueued", { ...enqueue("u1", "Fix the parser").data, titlePrompt: "Fix the parser" }),
      executionStarted(), baseline(), deliver("u1"), stepStarted("a1"), say("a1", "Done."), stepEnded("a1"), executionSucceeded(),
      event("session.title_usage", { messageId: m("u1"), model: "gpt-6-luna", usage }),
      event("session.renamed", { title: "Parser repair", generated: true }),
      event("session.renamed", { title: "Next steps" }),
    ],
    expect: { execution: null, history: ["u1", "a1"] },
    rejects: [{ event: event("session.renamed", { title: "Late title", generated: true }), code: "invalid_transition", why: "a generated title can only fill an empty title" }],
  }],
}
