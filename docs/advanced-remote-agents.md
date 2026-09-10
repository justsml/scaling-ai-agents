# Advanced appendix: remote-agent protocols

Remote execution is a distribution boundary, not another form of local fan-out. These examples are kept as advanced material because protocol discovery, streaming, cancellation, task lookup, and process-local durability can obscure the repository's introductory parallelism lessons.

Run the implementation for one framework from its package directory:

```sh
bun run advanced:remote
```

The implementations deliberately expose different framework boundaries:

- **AI SDK:** a small hand-written A2A JSON-RPC server and client because the SDK does not provide a first-party A2A server primitive.
- **LangGraph:** an A2A probe followed by the supported local Agent Protocol `RemoteGraph` route.
- **Mastra:** A2A discovery, streamed artifact assembly, and task lookup through a second process.

All three examples use in-memory task state. A successful run demonstrates the protocol seam, not restart durability, durable billing, or production authorization. For ordinary in-process concurrency, begin with example `16`; for durable admission and unknown remote outcomes, use example `11`.
