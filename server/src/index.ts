import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { ToolLoopAgent, pipeAgentUIStreamToResponse, UIMessage, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { systemPrompt } from "./prompt.js";
import { createAgentTools } from "./tools.js";
import { loadDashboardScope } from "./metabase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const PORT = parseInt(process.env.SERVER_PORT || "3001");

// Verify required env vars
const requiredEnvVars = [
  "METABASE_INSTANCE_URL",
  "METABASE_USER_EMAIL",
  "METABASE_USER_PASSWORD",
  "ANTHROPIC_API_KEY",
  "X-API-KEY",
];
for (const v of requiredEnvVars) {
  if (!process.env[v]) {
    console.error(`Missing required environment variable: ${v}`);
    process.exit(1);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/dashboards", async (_req, res) => {
  try {
    const response = await fetch(
      "https://reports.thearena.ai/api/dashboard/public",
      {
        headers: {
          "x-api-key": process.env["X-API-KEY"]!,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Dashboard service returned HTTP ${response.status}`);
    }

    const result: unknown = await response.json();
    const dashboards = Array.isArray(result)
      ? result
      : typeof result === "object" && result !== null && "data" in result
        ? result.data
        : null;

    if (
      !Array.isArray(dashboards) ||
      !dashboards.every(
        (dashboard) =>
          typeof dashboard === "object" &&
          dashboard !== null &&
          "id" in dashboard &&
          Number.isSafeInteger(dashboard.id) &&
          "name" in dashboard &&
          typeof dashboard.name === "string",
      )
    ) {
      throw new Error("Dashboard service returned an invalid dashboard list");
    }

    res.json({
      data: dashboards.map(({ id, name }) => ({ id, name })),
    });
  } catch (error) {
    console.error("Failed to load dashboard list", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(502).json({ error: "Unable to load dashboards" });
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages, dashboardId: rawDashboardId } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "Missing 'messages' array" });
    return;
  }

  const dashboardId =
    typeof rawDashboardId === "number"
      ? rawDashboardId
      : typeof rawDashboardId === "string" && /^\d+$/.test(rawDashboardId)
        ? Number(rawDashboardId)
        : NaN;
  if (!Number.isSafeInteger(dashboardId) || dashboardId <= 0) {
    res.status(400).json({ error: "A valid 'dashboardId' is required" });
    return;
  }

  try {
    const scope = await loadDashboardScope(dashboardId);
    const agent = new ToolLoopAgent({
      model: anthropic("claude-sonnet-5-5"),
      instructions: systemPrompt(scope.cards),
      tools: createAgentTools(scope),
      stopWhen: stepCountIs(15),
    });

    await pipeAgentUIStreamToResponse({
      response: res,
      agent,
      uiMessages: messages as UIMessage[],
    });
  } catch (error) {
    console.error("Dashboard chat failed", {
      dashboard_id: dashboardId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) {
      res.status(502).json({
        error: "Unable to answer using this dashboard",
        message: error instanceof Error ? error.message : String(error),
      });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
