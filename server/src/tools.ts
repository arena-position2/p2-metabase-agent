import { tool } from "ai";
import { z } from "zod";
import * as metabase from "./metabase.js";
import type { DashboardScope, DashboardCardType } from "./metabase.js";

async function logToolCall<T>(
  name: string,
  input: Record<string, unknown>,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const inputSummary = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === "string"
        ? "[redacted]"
        : Array.isArray(value)
          ? `[${value.length} items]`
          : value !== null && typeof value === "object"
            ? "[object]"
            : value,
    ]),
  );

  console.info(`[tool:${name}] started`, { input: inputSummary });

  try {
    const result = await execute();
    console.info(`[tool:${name}] completed`, {
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    console.error(`[tool:${name}] failed`, {
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function createAgentTools(scope: DashboardScope) {
  const cardTypeSchema = z.enum(["question", "model", "metric"]);

  return {
    search_data_sources: tool({
      description:
        "Search the current dashboard's saved questions, models, and metrics. Results are restricted to items on this dashboard.",
      inputSchema: z.object({
        term_queries: z
          .array(z.string())
          .optional()
          .describe("Keyword search terms (e.g. ['revenue', 'orders'])"),
        semantic_queries: z
          .array(z.string())
          .optional()
          .describe("Natural-language queries (e.g. ['how much money did we make'])"),
      }),
      execute: async ({ term_queries, semantic_queries }) =>
        logToolCall(
          "search_data_sources",
          { term_queries, semantic_queries },
          () =>
            metabase.searchDashboard(scope, term_queries, semantic_queries),
        ),
    }),

    get_data_source_details: tool({
      description:
        "Get fields or dimensions for a saved question, model, or metric on the current dashboard.",
      inputSchema: z.object({
        source_type: cardTypeSchema.describe("Type from dashboard search results"),
        source_id: z.number().describe("ID from dashboard search results"),
      }),
      execute: async ({ source_type, source_id }) =>
        logToolCall(
          "get_data_source_details",
          { source_type, source_id },
          () =>
            metabase.getDashboardCardDetails(
              scope,
              source_type as DashboardCardType,
              source_id,
            ),
        ),
    }),

    get_field_values: tool({
      description:
        "Get statistics and sample values for a field on a saved question, model, or metric on the current dashboard.",
      inputSchema: z.object({
        source_type: cardTypeSchema.describe("Type from dashboard search results"),
        source_id: z.number().describe("ID from dashboard search results"),
        field_id: z.number().describe("Field ID from the detail endpoint"),
      }),
      execute: async ({ source_type, source_id, field_id }) =>
        logToolCall(
          "get_field_values",
          { source_type, source_id, field_id },
          () =>
            metabase.getDashboardFieldValues(
              scope,
              source_type as DashboardCardType,
              source_id,
              field_id,
            ),
      ),
    }),

    run_query: tool({
      description:
      "Execute a custom query based only on saved questions, models, and metrics on the current dashboard. Use portable MBQL 5. Query must have 'lib/type': 'mbql/query' and a non-empty stages array. For questions/models, the first stage must use 'source-card' with the exact portable entity ID from dashboard search. For metrics, use the metric's exact source (source-card or source-table) and include ['metric', {}, '<metric portable_entity_id>'] in aggregation. Do not use joins. Every stage must have 'lib/type': 'mbql.stage/mbql'. Clauses use ['operator', {}, ...args], for example ['count', {}] or ['sum', {}, field_reference].",
      inputSchema: z.object({
      query: z
        .object({
          "lib/type": z.literal("mbql/query"),
          stages: z
            .array(z.record(z.string(), z.unknown()))
            .min(1)
            .describe("Portable MBQL 5 query stages"),
        })
        .passthrough()
        .describe("Portable MBQL 5 query object"),
      limit: z
        .number()
        .optional()
        .describe("Maximum rows to return (default: 100)"),
      }),
      execute: async ({ query, limit }) =>
      logToolCall("run_query", { query, limit }, async () => {
        await metabase.searchDashboard(
          scope,
          scope.cards.map((card) => card.name),
        );
        metabase.assertDashboardQuery(scope, query);
        return metabase.executeQuery(query, limit);
      }),
    }),
  };
}
