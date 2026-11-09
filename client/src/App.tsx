import { useState, useEffect, useRef, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const TOOL_LABELS: Record<string, string> = {
  search_data_sources: "Searching for data sources",
  get_data_source_details: "Inspecting dashboard data",
  get_field_values: "Fetching field values",
  run_query: "Running query",
};

type EntityNames = Record<string, string>;
type Dashboard = { id: number; name: string };

function extractEntityNames(messages: UIMessage[], into: EntityNames): void {
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (!("output" in part) || !part.output) continue;
      const output = part.output as Record<string, unknown>;

      // Extract from search results
      if (Array.isArray(output.data)) {
        for (const entity of output.data) {
          if (!entity || typeof entity !== "object") continue;
          const item = entity as Record<string, unknown>;
          if (typeof item.id !== "number" || typeof item.name !== "string") {
            continue;
          }
          if (typeof item.type === "string") {
            into[`${item.type}:${item.id}`] = item.name;
          }
        }
      }

      // Support the legacy search response shape.
      if (Array.isArray(output.tables)) {
        for (const t of output.tables) {
          if (t.id && t.name) into[`table:${t.id}`] = t.name;
        }
      }
      if (Array.isArray(output.metrics)) {
        for (const m of output.metrics) {
          if (m.id && m.name) into[`metric:${m.id}`] = m.name;
        }
      }

      // Extract from data-source detail responses.
      if (output.id && output.name) {
        const toolName = part.type?.replace("tool-", "");
        if (toolName === "get_data_source_details") {
          const input = "input" in part
            ? (part.input as Record<string, unknown>)
            : undefined;
          if (input?.source_type) {
            into[`${input.source_type}:${output.id}`] = output.name as string;
          }
        }
      }
    }
  }
}

function getToolDetail(
  toolName: string,
  input: Record<string, unknown> | undefined,
  entityNames: EntityNames,
): string | null {
  if (!input) return null;
  switch (toolName) {
    case "search_data_sources": {
      const terms = [
        ...((input.term_queries as string[]) ?? []),
        ...((input.semantic_queries as string[]) ?? []),
      ];
      return terms.length > 0 ? terms.map((t) => `"${t}"`).join(", ") : null;
    }
    case "get_data_source_details": {
      const sourceType = input.source_type as string;
      const sourceId = input.source_id as number;
      return entityNames[`${sourceType}:${sourceId}`] ?? null;
    }
    default:
      return null;
  }
}

function formatToolValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function ToolCallStatus({
  toolName,
  state,
  input,
  output,
  errorText,
  entityNames,
}: {
  toolName: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
  entityNames: EntityNames;
}) {
  const label = TOOL_LABELS[toolName] ?? toolName;
  const detail = getToolDetail(toolName, input, entityNames);
  const done = state === "output-available" || state === "output-error";

  return (
    <div className={`tool-card ${done ? "done" : "pending"}`}>
      <span className="tool-card-label">{label}</span>
      {detail && <span className="tool-card-detail">{detail}</span>}
      {(input !== undefined || output !== undefined || errorText) && (
        <details className="tool-card-details">
          <summary>Show tool input and output</summary>
          {input !== undefined && (
            <section>
              <strong>Input</strong>
              <pre>{formatToolValue(input)}</pre>
            </section>
          )}
          {output !== undefined && (
            <section>
              <strong>Output</strong>
              <pre>{formatToolValue(output)}</pre>
            </section>
          )}
          {errorText && (
            <section>
              <strong>Error</strong>
              <pre>{errorText}</pre>
            </section>
          )}
        </details>
      )}
    </div>
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [clientSessionId] = useState(() => crypto.randomUUID());
  const searchParams = new URLSearchParams(window.location.search);
  const initialDashboardId =
    searchParams.get("dashboardId") ?? searchParams.get("dashboard_id");
  const [dashboardId, setDashboardId] = useState(
    initialDashboardId !== null &&
      /^\d+$/.test(initialDashboardId) &&
      Number(initialDashboardId) > 0
      ? initialDashboardId
      : "",
  );
  const selectedDashboard = dashboards.find(
    (dashboard) => String(dashboard.id) === dashboardId,
  );
  const validDashboardId = selectedDashboard !== undefined;
  const entityNamesRef = useMemo<EntityNames>(() => ({}), [dashboardId]);
  const chatId = `dashboard-${dashboardId || "missing"}`;
  const conversationId = `${clientSessionId}:${chatId}`;

  useEffect(() => {
    const controller = new AbortController();

    async function loadDashboards() {
      try {
        const response = await fetch("/api/dashboards", {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Dashboard list request failed (${response.status})`);
        }

        const result: unknown = await response.json();
        if (
          typeof result !== "object" ||
          result === null ||
          !("data" in result) ||
          !Array.isArray(result.data) ||
          !result.data.every(
            (dashboard) =>
              typeof dashboard === "object" &&
              dashboard !== null &&
              "id" in dashboard &&
              Number.isSafeInteger(dashboard.id) &&
              "name" in dashboard &&
              typeof dashboard.name === "string",
          )
        ) {
          throw new Error("Dashboard list response was invalid");
        }

        setDashboards(
          result.data.map(({ id, name }) => ({ id, name })),
        );
        setDashboardError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDashboardError(
          error instanceof Error ? error.message : "Unable to load dashboards",
        );
      } finally {
        if (!controller.signal.aborted) setDashboardLoading(false);
      }
    }

    void loadDashboards();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (dashboardLoading || dashboards.length === 0 || validDashboardId) return;
    setDashboardId(String(dashboards[0].id));
  }, [dashboardLoading, dashboards, validDashboardId]);

  useEffect(() => {
    if (!dashboardId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("dashboardId", dashboardId);
    url.searchParams.delete("dashboard_id");
    window.history.replaceState({}, "", url);
  }, [dashboardId]);

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: "/api/chat",
      body: { dashboardId, conversationId },
    }),
    [dashboardId, conversationId],
  );

  const { messages, sendMessage, status, stop, error } = useChat({
    id: chatId,
    transport,
  });

  const isLoading = status === "streaming" || status === "submitted";
  extractEntityNames(messages, entityNamesRef);
  const entityNames = entityNamesRef;

  useEffect(() => {
    const messagesContainer = messagesContainerRef.current;
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    sendMessage({ text });
    setInput("");
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Metabase Agent</h1>
        <p>
          {validDashboardId
            ? "Ask questions about this dashboard"
            : "Choose a dashboard to start chatting"}
        </p>
        <select
          className="dashboard-select"
          aria-label="Select dashboard"
          value={dashboardId}
          disabled={dashboardLoading || dashboards.length === 0}
          onChange={(event) => setDashboardId(event.target.value)}
        >
          <option value="">
            {dashboardLoading ? "Loading dashboards..." : "Select a dashboard"}
          </option>
          {dashboards.map((dashboard) => (
            <option key={dashboard.id} value={dashboard.id}>
              {dashboard.name}
            </option>
          ))}
        </select>
      </header>

      {dashboardError && (
        <div className="message error dashboard-error">
          <div className="message-label">Dashboard list error</div>
          <div className="message-body">{dashboardError}</div>
        </div>
      )}

      <div className="messages" ref={messagesContainerRef}>
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            <div className="message-label">
              {message.role === "user" ? "You" : "Agent"}
            </div>
            <div className="message-body">
              {message.parts?.map((part, i) => {
                if (part.type === "text") {
                  return part.text.length > 0 ? (
                    <Markdown key={`${i}-${part.text.length}`} remarkPlugins={[remarkGfm]}>
                      {part.text}
                    </Markdown>
                  ) : null;
                }
                if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                  const toolName = part.type === "dynamic-tool"
                    ? (part as { toolName: string }).toolName
                    : part.type.replace("tool-", "");
                  const state = ("state" in part ? part.state : "input-available") as string;
                  const toolInput = ("input" in part ? part.input : undefined) as Record<string, unknown> | undefined;
                  const toolOutput = "output" in part ? part.output : undefined;
                  const toolError = "errorText" in part ? part.errorText : undefined;
                  return (
                    <ToolCallStatus
                      key={`${i}-${part.type}`}
                      toolName={toolName}
                      state={state}
                      input={toolInput}
                      output={toolOutput}
                      errorText={toolError}
                      entityNames={entityNames}
                    />
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}

        {isLoading && messages.at(-1)?.role === "user" && (
          <div className="message assistant">
            <div className="message-label">Agent</div>
            <div className="message-body thinking">Thinking&hellip;</div>
          </div>
        )}

        {error && (
          <div className="message error">
            <div className="message-label">Error</div>
            <div className="message-body">{error.message}</div>
          </div>
        )}

      </div>

      <form className="input-area" onSubmit={handleSubmit}>
        <div className={`input-container ${isLoading ? "loading" : ""}`}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your data&#x2026;"
            disabled={isLoading || !validDashboardId}
          />
          {isLoading ? (
            <button type="button" className="cancel-btn" onClick={stop} aria-label="Cancel">
              &#9632;
            </button>
          ) : (
            <button type="submit" className="send-btn" disabled={!input.trim() || !validDashboardId} aria-label="Send">
              &#8593;
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
