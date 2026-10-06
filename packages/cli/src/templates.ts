/** Files written by `cascade init agent`. Each template is a map of relative path to content. */
import type { Template } from "./args.js";

export type TemplateFiles = Record<string, string>;

function tsTemplate(name: string): TemplateFiles {
  return {
    "package.json": `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: { dev: "tsx src/main.ts", typecheck: "tsc --noEmit" },
        dependencies: { "@cascade/agent": "workspace:*" },
        devDependencies: { "@types/node": "24.19.0", tsx: "4.20.0", typescript: "5.9.3" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, types: ["node"] },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    "src/main.ts": `// A Cascade agent: MIP-003 plus Cascade endpoints (PRD 15.2).
// Env: AGENT_ID (Masumi registry asset id), AGENT_BASE_URL, AGENT_SIGNING_KEY (32-byte Ed25519 seed, hex), PORT.
import { cascadeAgent, localKeySigner, type JobHandler } from "@cascade/agent";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(\`Missing required environment variable \${name}\`);
  return value;
}

const handler: JobHandler = async (input) => {
  // Replace with your agent's work. The result must match outputSchema.
  return { result: { summary: \`Received: \${JSON.stringify(input)}\` } };
};

const app = cascadeAgent({
  name: "${name}",
  description: "Describe what this agent does.",
  baseUrl: env("AGENT_BASE_URL"),
  registryAsset: env("AGENT_ID"),
  network: "cardano:preprod",
  inputSchema: { input_data: [{ id: "topic", type: "string", name: "Topic" }] },
  outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  handler,
  pricing: { asset: "lovelace", amount: "2000000", etaMs: 60_000 },
  rails: ["native"],
  capabilities: { roles: ["specialist"], categories: ["research"], maxDepth: 1, bondLovelace: "0" },
  signer: localKeySigner(Buffer.from(env("AGENT_SIGNING_KEY"), "hex")),
});
app.listen(Number(process.env.PORT ?? 8080));
`,
    "README.md": `# ${name}

A Cascade agent built on \`@cascade/agent\`. It serves MIP-003 (\`/availability\`, \`/input_schema\`,
\`/start_job\`, \`/status\`), the Cascade endpoints (\`/jobs\` with x402, \`/cascade/*\`) and the
\`.well-known\` discovery files.

Place this folder under \`agents/\` in the Cascade workspace so \`workspace:*\` resolves, then:

\`\`\`bash
pnpm install
AGENT_ID=<registry asset id> AGENT_BASE_URL=http://localhost:8080 AGENT_SIGNING_KEY=<hex seed> pnpm dev
cascade register --registry-asset <id> --api-url http://localhost:8080 --name ${name} --payment-vkh <hex>
\`\`\`
`,
  };
}

function crewaiTemplate(name: string): TemplateFiles {
  const module = name.replace(/-/g, "_");
  return {
    "pyproject.toml": `[project]
name = "${name}"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["cascade-py", "crewai", "uvicorn"]

[tool.uv.sources]
# Path to python/cascade-py in the Cascade repository.
cascade-py = { path = "../../python/cascade-py", editable = true }
`,
    [`${module}/__init__.py`]: "",
    [`${module}/main.py`]: `"""A CrewAI crew served as a Cascade agent (MIP-003 plus Cascade endpoints).

Env: AGENT_ID (Masumi registry asset id), AGENT_BASE_URL, AGENT_SIGNING_KEY (32-byte Ed25519 seed, hex).
Run: uv run uvicorn ${module}.main:app --port 8080
"""
import os

from crewai import Agent, Crew, Task
from cascade_py import Capabilities, HandlerResult, LocalKeySigner, Pricing, cascade_agent

INPUT_SCHEMA = {"input_data": [{"id": "topic", "type": "string", "name": "Topic"}]}
OUTPUT_SCHEMA = {"type": "object", "required": ["summary"], "properties": {"summary": {"type": "string"}}}


def run_my_crew(input_data, ctx):
    researcher = Agent(role="Researcher", goal="Summarise the topic", backstory="Careful analyst")
    task = Task(description=f"Summarise: {input_data['topic']}", expected_output="A short summary", agent=researcher)
    summary = str(Crew(agents=[researcher], tasks=[task]).kickoff())
    return HandlerResult({"summary": summary})


agent = cascade_agent(
    name="${name}",
    description="Describe what this agent does.",
    base_url=os.environ["AGENT_BASE_URL"],
    registry_asset=os.environ["AGENT_ID"],
    network="cardano:preprod",
    input_schema=INPUT_SCHEMA,
    output_schema=OUTPUT_SCHEMA,
    handler=run_my_crew,
    pricing=Pricing(asset="lovelace", amount="2000000", eta_ms=60_000),
    rails=["native"],
    capabilities=Capabilities(["specialist"], ["research"], 1, "0"),
    signer=LocalKeySigner(bytes.fromhex(os.environ["AGENT_SIGNING_KEY"])),
)
app = agent.app
`,
    "README.md": `# ${name}

A CrewAI crew served as a Cascade agent with \`cascade-py\`. Place this folder two levels below the
Cascade repository root (for example \`agents/${name}\`) so the \`cascade-py\` path source resolves.

\`\`\`bash
uv sync
AGENT_ID=<registry asset id> AGENT_BASE_URL=http://localhost:8080 AGENT_SIGNING_KEY=<hex seed> \\
  uv run uvicorn ${module}.main:app --port 8080
cascade register --registry-asset <id> --api-url http://localhost:8080 --name ${name} --payment-vkh <hex>
\`\`\`
`,
  };
}

export function templateFiles(template: Template, name: string): TemplateFiles {
  return template === "ts" ? tsTemplate(name) : crewaiTemplate(name);
}
