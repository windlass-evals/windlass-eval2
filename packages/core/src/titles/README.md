# Session titles

The step loop keeps a bounded excerpt of the first user input for an independent title request. In
`send` and `sendCommand`, take the words the user typed before a client attached files or the engine
expanded a command. Older prompts without an excerpt keep their derived title.

Once that input is delivered and the configuration for the turn is known, the engine starts the request
through the signed-in provider. Only the first delivery looks up the offered models. An explicit
`titleModel` must be available or the engine logs one debug line and skips the request. Automatic
selection prefers `gpt-6-luna`, then fast or inexpensive descriptions, then small model names, with
catalog order breaking ties. An empty or unreadable catalog leaves the derived title in place.

`titleRequest` builds the request from the excerpt and chosen model alone. The ledger
records each attempt under purpose `title` and the first user message's ID. A retry uses the same model,
including when the session resumes after an interrupted request. The trace exporter can rebuild
the same request from that message and compare it in its own lane. `session.title_usage` carries any
reported usage to clients, independently of whether the result names the session.

The background job checks the stored title before each attempt and before appending a generated
`session.renamed`. Renaming or closing the session cancels its request. The existing rename path updates
the session projection, listings and ACP clients. The turn never waits for the title.
