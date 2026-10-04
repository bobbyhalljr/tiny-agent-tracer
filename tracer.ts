// tiny-agent-tracer: trace one agent run with OpenTelemetry GenAI span names.
// The model, the tools and every duration are a MOCK on a virtual clock, so
// the output is the same on every run. No network. No API key.

// Step 1: Model the span

type Attr = string | number | boolean | null;

type Span = {
  spanId: string;
  parentId: string | null;
  name: string;
  attrs: Record<string, Attr>;
  start: number;
  end: number;
  status: "ok" | "error";
};

// Step 2: A tracer with a virtual clock

class Tracer {
  spans: Span[] = [];
  private stack: Span[] = [];
  private now = 0;
  private nextId = 1;

  advance(ms: number) {
    this.now += ms;
  }

  span<T>(name: string, attrs: Record<string, Attr>, fn: (s: Span) => T): T {
    const parent = this.stack[this.stack.length - 1];
    const s: Span = {
      spanId: `s${this.nextId++}`,
      parentId: parent ? parent.spanId : null,
      name,
      attrs,
      start: this.now,
      end: this.now,
      status: "ok",
    };
    this.spans.push(s);
    this.stack.push(s);
    try {
      return fn(s);
    } catch (err) {
      s.status = "error";
      s.attrs["error.type"] = (err as Error).message;
      throw err;
    } finally {
      s.end = this.now;
      this.stack.pop();
    }
  }
}

// Step 3: Instrument the agent loop

const tracer = new Tracer();

function chat(model: string, ms: number, input: number | null, output: number | null) {
  return tracer.span(
    `chat ${model}`,
    {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model,
      "gen_ai.usage.input_tokens": input,
      "gen_ai.usage.output_tokens": output,
    },
    () => tracer.advance(ms),
  );
}

function tool(name: string, ms: number, fail?: string) {
  return tracer.span(
    `execute_tool ${name}`,
    { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name },
    () => {
      tracer.advance(ms);
      if (fail) throw new Error(fail);
    },
  );
}

function agent<T>(name: string, fn: () => T): T {
  return tracer.span(
    `invoke_agent ${name}`,
    { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name },
    fn,
  );
}

// MOCK run: a release-notes agent with one subagent.
const finalAnswer = agent("release-notes", () => {
  tracer.span(
    "plan release-notes",
    { "gen_ai.operation.name": "plan", "gen_ai.agent.name": "release-notes" },
    () => chat("mock-large", 820, 900, 120),
  );
  tool("read_file", 30);
  chat("mock-large", 640, 1400, 210);
  agent("changelog-checker", () => {
    chat("mock-small", 210, 600, 40);
    tool("git_log", 120);
    chat("mock-small", 180, null, null); // usage not reported yet
  });
  try {
    tool("send_email", 5000, "timeout");
  } catch {
    // the loop swallows the error and keeps going
  }
  chat("mock-large", 450, 1800, 90);
  return "Release notes drafted and sent to the team.";
});

// Step 4: Print the trace tree

function children(id: string | null): Span[] {
  return tracer.spans.filter((s) => s.parentId === id);
}

function tokens(s: Span): string {
  const i = s.attrs["gen_ai.usage.input_tokens"];
  const o = s.attrs["gen_ai.usage.output_tokens"];
  if (s.attrs["gen_ai.operation.name"] !== "chat") return "";
  return i === null || o === null ? "  tokens=unknown" : `  in=${i} out=${o}`;
}

function printTree(id: string | null, prefix: string) {
  const kids = children(id);
  kids.forEach((s, i) => {
    const last = i === kids.length - 1;
    const branch = id === null ? "" : prefix + (last ? "└─ " : "├─ ");
    const ms = `${s.end - s.start}ms`.padStart(7);
    const label = (branch + s.name).padEnd(40);
    const err = s.status === "error" ? `  error.type=${s.attrs["error.type"]}` : "";
    console.log(`${label} ${s.status.padEnd(5)} ${ms}${tokens(s)}${err}`);
    printTree(s.spanId, id === null ? "" : prefix + (last ? "   " : "│  "));
  });
}

// Step 5: Ask the trace questions

function ancestors(s: Span): string[] {
  const out: string[] = [];
  let p = tracer.spans.find((x) => x.spanId === s.parentId);
  while (p) {
    out.push(p.name);
    p = tracer.spans.find((x) => x.spanId === p!.parentId);
  }
  return out;
}

function failures() {
  for (const s of tracer.spans.filter((x) => x.status === "error")) {
    console.log(`  ${s.name} (${s.attrs["error.type"]}) <- ${ancestors(s).join(" <- ")}`);
  }
}

function claimCheck(answer: string) {
  const emailFailed = tracer.spans.some(
    (s) => s.attrs["gen_ai.tool.name"] === "send_email" && s.status === "error",
  );
  if (answer.includes("sent") && emailFailed) {
    console.log(`  answer says "sent", but execute_tool send_email failed`);
  }
}

function timeByOperation() {
  const total = new Map<string, number>();
  for (const s of tracer.spans) {
    const op = String(s.attrs["gen_ai.operation.name"]);
    if (op === "invoke_agent" || op === "plan") continue; // parents, not work
    total.set(op, (total.get(op) ?? 0) + (s.end - s.start));
  }
  for (const [op, ms] of total) console.log(`  ${op.padEnd(13)} ${ms}ms`);
}

function tokensByAgent() {
  for (const a of tracer.spans.filter((s) => s.attrs["gen_ai.operation.name"] === "invoke_agent")) {
    let known = 0;
    let unknown = 0;
    const own = (id: string): Span[] =>
      children(id).flatMap((c) =>
        c.attrs["gen_ai.operation.name"] === "invoke_agent" ? [] : [c, ...own(c.spanId)],
      );
    for (const c of own(a.spanId)) {
      if (c.attrs["gen_ai.operation.name"] !== "chat") continue;
      const i = c.attrs["gen_ai.usage.input_tokens"];
      const o = c.attrs["gen_ai.usage.output_tokens"];
      if (i === null || o === null) unknown++;
      else known += Number(i) + Number(o);
    }
    const note = unknown ? `, ${unknown} chat span unknown` : "";
    console.log(`  ${String(a.attrs["gen_ai.agent.name"]).padEnd(18)} ${known} tokens${note}`);
  }
}

// Step 6: Run it

console.log("Trace (MOCK model, virtual clock)\n");
printTree(null, "");
console.log(`\nFinal answer: "${finalAnswer}"`);
console.log("\nWhat failed, and under what?");
failures();
console.log("\nDoes the answer match the trace?");
claimCheck(finalAnswer);
console.log("\nWhere did the time go?");
timeByOperation();
console.log("\nTokens per agent (subagents counted separately):");
tokensByAgent();
