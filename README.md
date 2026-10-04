# tiny-agent-tracer

Trace one agent run with OpenTelemetry GenAI span names, in one TypeScript file.
It records agent, plan, model and tool spans on a virtual clock, prints the run as a tree, and asks the trace four questions: what failed, does the answer match, where did the time go, and who spent the tokens.
The model is a mock. No API key. No OpenTelemetry SDK.

## Why it matters

An agent's final answer is a claim. The trace is the evidence.

Two recent changes point the same way:

- OpenAI, Sep 10, 2026: [Introducing the Agents API](https://openai.com/index/introducing-the-agents-api/) (public beta). The [tracing guide](https://developers.openai.com/api/docs/guides/agents-api/tracing) says tracing is on by default for new sessions, groups agent, generation and tool spans, and exports them as OTLP JSON.
- OpenTelemetry, Sep 29 and 30, 2026: the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) merged `gen_ai.skill.*` attributes for the execute tool span (#498) and a `gen_ai.main_agent` entity (#270). The conventions are still Development status.

This repo borrows the span names (`invoke_agent`, `plan`, `chat`, `execute_tool`). It is not how OpenAI or any OpenTelemetry SDK records traces.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npx tsx tracer.ts
```

## Example output

This is real output from `npx tsx tracer.ts`:

```text
Trace (MOCK model, virtual clock)

invoke_agent release-notes               ok     7450ms
├─ plan release-notes                    ok      820ms
│  └─ chat mock-large                    ok      820ms  in=900 out=120
├─ execute_tool read_file                ok       30ms
├─ chat mock-large                       ok      640ms  in=1400 out=210
├─ invoke_agent changelog-checker        ok      510ms
│  ├─ chat mock-small                    ok      210ms  in=600 out=40
│  ├─ execute_tool git_log               ok      120ms
│  └─ chat mock-small                    ok      180ms  tokens=unknown
├─ execute_tool send_email               error  5000ms  error.type=timeout
└─ chat mock-large                       ok      450ms  in=1800 out=90

Final answer: "Release notes drafted and sent to the team."

What failed, and under what?
  execute_tool send_email (timeout) <- invoke_agent release-notes

Does the answer match the trace?
  answer says "sent", but execute_tool send_email failed

Where did the time go?
  chat          2300ms
  execute_tool  5150ms

Tokens per agent (subagents counted separately):
  release-notes      4520 tokens
  changelog-checker  640 tokens, 1 chat span unknown
```

The mocked agent says it sent the release notes. Its own trace says `send_email` timed out after 5000ms, and one more model call wrote the answer anyway.

## How it works

```text
invoke_agent release-notes
  ├── plan ──→ chat
  ├── execute_tool read_file
  ├── chat
  ├── invoke_agent changelog-checker (subagent)
  │     ├── chat
  │     ├── execute_tool git_log
  │     └── chat (usage unknown)
  ├── execute_tool send_email (error: timeout)
  └── chat ──→ final answer (a claim)
```

| File | What it does |
| --- | --- |
| `tracer.ts` | The whole tracer and demo, in the same order as the post |
| `output.txt` | Real output of `npx tsx tracer.ts` |
| `package.json` | `tsx`, `typescript` and `@types/node` as dev dependencies |
| `tsconfig.json` | Strict settings for `npx tsc --noEmit` |

Inside `tracer.ts`:

- Step 1: `Span`, with a parent id, a kind, a status and `gen_ai.*` style attributes
- Step 2: `Tracer`, a span stack on a virtual clock so durations are deterministic
- Step 3: `chat`, `tool` and `agent` wrappers, and the MOCK release-notes run with one subagent
- Step 4: `printTree`, which prints the span tree with status, duration and usage
- Step 5: `failures`, `claimCheck`, `timeByOperation` and `tokensByAgent`
- Step 6: run it

What is real and what is mocked:

- The model, the tools and every duration are a MOCK on a virtual clock. No network. No API key.
- Unknown token usage stays `null` and is reported as unknown, never as zero.
- The OpenAI and OpenTelemetry references above are real and dated.

## Limits

This is a teaching tracer.

- Spans live in an array. Real systems use an OpenTelemetry SDK, context propagation, sampling and an OTLP exporter.
- The span stack assumes synchronous work. Parallel subagents need real context propagation.
- Prompts and tool arguments are not recorded. Message content is sensitive and should be opt-in.
- The `gen_ai.*` conventions are Development status. Expect renames.

## Read more

- Dev.to: [Trust the Trace, Not the Answer: Build a Tiny Agent Tracer in TypeScript](DEVTO_URL)
- Substack: [Trust the Trace, Not the Answer: Build a Tiny Agent Tracer in TypeScript](SUBSTACK_URL)

## License

MIT. See [LICENSE](LICENSE).
