const METABASE_URL = () => process.env.METABASE_INSTANCE_URL!;
const USERNAME = () => process.env.METABASE_USER_EMAIL!;
const PASSWORD = () => process.env.METABASE_USER_PASSWORD!;

export type DashboardCardType = "question" | "model" | "metric";

export interface DashboardCard {
  type: DashboardCardType;
  id: number;
  name: string;
  uri: string;
}

export interface DashboardScope {
  id: number;
  cards: DashboardCard[];
  cardSourceIds: Set<string>;
  metricSources: Map<
    string,
    { sourceCardId?: string; sourceTable?: [string, string | null, string] }
  >;
}

let sessionToken: string | undefined;
let sessionTokenRequest: Promise<string> | undefined;

async function createSession(): Promise<string> {
  const response = await fetch(`${METABASE_URL()}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME(), password: PASSWORD() }),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Metabase session login ${response.status}: ${body}`);
  }

  let session: unknown;
  try {
    session = JSON.parse(body);
  } catch {
    throw new Error("Metabase session login returned invalid JSON");
  }

  if (
    typeof session !== "object" ||
    session === null ||
    !("id" in session) ||
    typeof session.id !== "string" ||
    !session.id
  ) {
    throw new Error("Metabase session login response did not contain a session id");
  }

  return session.id;
}

async function getSessionToken(): Promise<string> {
  if (sessionToken) return sessionToken;

  if (!sessionTokenRequest) {
    sessionTokenRequest = createSession();
  }

  try {
    sessionToken = await sessionTokenRequest;
    return sessionToken;
  } finally {
    sessionTokenRequest = undefined;
  }
}

async function agentRequest(path: string, options?: RequestInit) {
  const url = `${METABASE_URL()}/api/agent${path}`;
  const request = (token: string) =>
    fetch(url, {
      ...options,
      headers: {
        "X-Metabase-Session": token,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

  let token = await getSessionToken();
  let response = await request(token);

  if (response.status === 401) {
    if (sessionToken === token) sessionToken = undefined;
    token = await getSessionToken();
    response = await request(token);
  }

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Metabase API ${response.status}: ${body}`);
  }

  return JSON.parse(body);
}

export async function search(
  termQueries?: string[],
  semanticQueries?: string[],
) {
  return agentRequest("/v1/search", {
    method: "POST",
    body: JSON.stringify({
      term_queries: termQueries,
      semantic_queries: semanticQueries,
    }),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asPortableTableSource(
  value: unknown,
): [string, string | null, string] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    typeof value[0] !== "string" ||
    (typeof value[1] !== "string" && value[1] !== null) ||
    typeof value[2] !== "string"
  ) {
    return undefined;
  }

  return [value[0], value[1], value[2]];
}

async function readResources(uris: string[]) {
  if (uris.length > 5) {
    throw new Error("Metabase read-resource accepts at most five URIs per request");
  }

  const result = await agentRequest("/v1/read-resource", {
    method: "POST",
    body: JSON.stringify({ uris }),
  });
  if (!Array.isArray(result.resources)) {
    throw new Error("Metabase read-resource response did not contain resources");
  }
  return result.resources;
}

async function readResource(uri: string) {
  const resources = await readResources([uri]);

  const resource = resources.find(
    (item: { uri?: string }) => item.uri === uri,
  );

  if (!resource) {
    throw new Error(`Metabase read-resource returned no result for ${uri}`);
  }
  if (resource.error) {
    throw new Error(`Metabase could not read ${uri}: ${resource.error}`);
  }
  if (!resource.content) {
    throw new Error(`Metabase read-resource returned no content for ${uri}`);
  }

  return (
    resource.content.structured_output ??
    resource.content["structured-output"] ??
    resource.content
  );
}

export async function loadDashboardScope(id: number): Promise<DashboardScope> {
  const resource = asRecord(
    await readResource(`metabase://dashboard/${id}/items`),
  );
  const rawCards = resource?.items;

  if (!Array.isArray(rawCards)) {
    throw new Error("Metabase dashboard response did not contain dashboard items");
  }
  if (resource?.truncated === true || resource?.truncated === "true") {
    throw new Error(
      "This dashboard has more items than the current dashboard chat can scope safely",
    );
  }

  const cards = rawCards.flatMap((rawCard): DashboardCard[] => {
    const card = asRecord(rawCard);
    if (
      (card?.type !== "question" &&
        card?.type !== "model" &&
        card?.type !== "metric") ||
      typeof card.id !== "number" ||
      typeof card.name !== "string" ||
      typeof card.uri !== "string"
    ) {
      return [];
    }

    return [{
      type: card.type,
      id: card.id,
      name: card.name,
      uri: card.uri,
    }];
  });

  if (cards.length === 0) {
    throw new Error("This dashboard has no queryable questions, models, or metrics");
  }

  const scope: DashboardScope = {
    id,
    cards,
    cardSourceIds: new Set(),
    metricSources: new Map(),
  };

  for (let index = 0; index < cards.length; index += 5) {
    const batch = cards.slice(index, index + 5);
    const resources = await readResources(batch.map((card) => card.uri));
    for (const card of batch) {
      const resource = resources.find(
        (item: { uri?: string }) => item.uri === card.uri,
      );
      if (!resource || resource.error || !resource.content) {
        throw new Error(
          `Unable to read dashboard card "${card.name}" while setting chat scope`,
        );
      }

      const content = asRecord(resource.content);
      const details = asRecord(
        content?.structured_output ?? content?.["structured-output"],
      );
      if (!details) continue;

      const portableEntityId =
        typeof details.portable_entity_id === "string"
          ? details.portable_entity_id
          : undefined;
      if (!portableEntityId) continue;

      if (card.type === "question" || card.type === "model") {
        scope.cardSourceIds.add(portableEntityId);
      } else if (card.type === "metric") {
        const sourceCardId =
          typeof details.source_card_portable_entity_id === "string"
            ? details.source_card_portable_entity_id
            : undefined;
        const sourceTable =
          asPortableTableSource(details.base_table_portable_fk) ??
          asPortableTableSource(
            typeof details.database_name === "string" &&
              typeof details.base_table_name === "string"
              ? [
                details.database_name,
                typeof details.base_table_schema === "string"
                  ? details.base_table_schema
                  : null,
                details.base_table_name,
              ]
              : undefined,
          );
        const unavailable =
          details.source_unavailable === true ||
          details.source_unavailable === "true";

        if (!unavailable && (sourceCardId || sourceTable)) {
          scope.metricSources.set(portableEntityId, {
            sourceCardId,
            sourceTable,
          });
        }
      }
    }
  }

  return scope;
}

function cardKey(type: DashboardCardType, id: number) {
  return `${type}:${id}`;
}

export async function searchDashboard(
  scope: DashboardScope,
  termQueries?: string[],
  semanticQueries?: string[],
) {
  const result = await search(termQueries, semanticQueries);
  const allowedCards = new Map(
    scope.cards.map((card) => [cardKey(card.type, card.id), card]),
  );
  const data = Array.isArray(result.data)
    ? result.data.flatMap((rawItem: unknown) => {
        const item = asRecord(rawItem);
        if (
          (item?.type !== "question" &&
            item?.type !== "model" &&
            item?.type !== "metric") ||
          typeof item.id !== "number"
        ) {
          return [];
        }

        const card = allowedCards.get(cardKey(item.type, item.id));
        if (!card) return [];

        const portableEntityId =
          typeof item.portable_entity_id === "string"
            ? item.portable_entity_id
            : undefined;

        if (portableEntityId && (card.type === "question" || card.type === "model")) {
          scope.cardSourceIds.add(portableEntityId);
        }

        if (portableEntityId && card.type === "metric") {
          const sourceCardId =
            typeof item.source_card_portable_entity_id === "string"
              ? item.source_card_portable_entity_id
              : undefined;
          const sourceTable =
            asPortableTableSource(item.base_table_portable_fk) ??
            asPortableTableSource(
              typeof item.database_name === "string" &&
                typeof item.base_table_name === "string"
                ? [
                    item.database_name,
                    typeof item.base_table_schema === "string"
                      ? item.base_table_schema
                      : null,
                    item.base_table_name,
                  ] as [string, string | null, string]
                : undefined,
            );
          const unavailable =
            item.source_unavailable === true ||
            item.source_unavailable === "true";

          if (!unavailable && (sourceCardId || sourceTable)) {
            scope.metricSources.set(portableEntityId, {
              sourceCardId,
              sourceTable,
            });
          }
        }
        return [rawItem];
      })
    : [];

  return { ...result, data, total_count: data.length };
}

function dashboardCard(
  scope: DashboardScope,
  type: DashboardCardType,
  id: number,
) {
  const card = scope.cards.find((item) => item.type === type && item.id === id);
  if (!card) {
    throw new Error(`${type} ${id} is not on dashboard ${scope.id}`);
  }
  return card;
}

export async function getDashboardCardDetails(
  scope: DashboardScope,
  type: DashboardCardType,
  id: number,
) {
  const card = dashboardCard(scope, type, id);
  const detailsUri =
    type === "metric" ? `${card.uri}/dimensions` : `${card.uri}/fields`;
  return readResource(detailsUri);
}

export async function getDashboardFieldValues(
  scope: DashboardScope,
  type: DashboardCardType,
  entityId: number,
  fieldId: number,
) {
  const card = dashboardCard(scope, type, entityId);
  const uri =
    type === "metric"
      ? `${card.uri}/dimensions/${fieldId}`
      : `${card.uri}/fields/${fieldId}`;
  return readResource(uri);
}

interface PortableQuery {
  "lib/type": "mbql/query";
  stages: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export async function executeQuery(query: PortableQuery, limit = 100) {
  const stages = query.stages.map((stage) => ({ ...stage }));
  const finalStage = stages.at(-1);
  if (!finalStage) {
    throw new Error("Metabase query must contain at least one stage");
  }
  if (finalStage.limit === undefined) {
    finalStage.limit = limit;
  }

  const result = await agentRequest("/v2/query", {
    method: "POST",
    body: JSON.stringify({ query: { ...query, stages } }),
  });

  if (result.status === "failed") {
    throw new Error(`Metabase query failed: ${result.error ?? "Unknown error"}`);
  }

  return {
    status: result.status,
    error: result.error,
    columns: result.data?.cols?.map(
      (c: { display_name: string; name: string; base_type: string }) => ({
        display_name: c.display_name,
        name: c.name,
        base_type: c.base_type,
      }),
    ),
    rows: result.data?.rows,
    row_count: result.row_count,
    running_time: result.running_time,
  };
}

export function assertDashboardQuery(
  scope: DashboardScope,
  query: PortableQuery,
) {
  const firstStage = query.stages[0];
  if (!firstStage) {
    throw new Error("Dashboard chats require a query source");
  }

  const sourceCard =
    typeof firstStage["source-card"] === "string"
      ? firstStage["source-card"]
      : undefined;
  const rawSourceTable = firstStage["source-table"];
  const sourceTable = asPortableTableSource(rawSourceTable);

  if (sourceCard && rawSourceTable !== undefined) {
    throw new Error("A query stage cannot use both a saved card and a table source");
  }

  if (sourceCard && !scope.cardSourceIds.has(sourceCard)) {
    const isMetricSource = [...scope.metricSources.values()].some(
      (metric) => metric.sourceCardId === sourceCard,
    );
    if (!isMetricSource) {
      throw new Error("Query source is not a saved question or model on this dashboard");
    }
  }

  const metricIds = new Set<string>();
  const visit = (value: unknown, path = "query"): void => {
    if (Array.isArray(value)) {
      if (value[0] === "metric" && typeof value[2] === "string") {
        if (!scope.metricSources.has(value[2])) {
          throw new Error("Query uses a metric that is not available on this dashboard");
        }
        metricIds.add(value[2]);
      }
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    const record = asRecord(value);
    if (!record) return;

    if ("joins" in record) {
      throw new Error("Dashboard-scoped queries cannot add joins");
    }
    for (const [key, nestedValue] of Object.entries(record)) {
      if (key === "source-card" && path !== "query.stages[0]") {
        throw new Error("Only the first query stage can select a source card");
      }
      if (key === "source-table" && path !== "query.stages[0]") {
        throw new Error("Only the first query stage can select a source table");
      }
      if (key === "source-table" && !sourceTable) {
        throw new Error("Query source table must be a portable database/schema/table tuple");
      }
      visit(nestedValue, `${path}.${key}`);
    }
  };

  visit(query);

  if (sourceTable) {
    const matchingMetric = [...metricIds]
      .map((id) => scope.metricSources.get(id))
      .some(
        (metric) =>
          metric?.sourceTable &&
          JSON.stringify(metric.sourceTable) === JSON.stringify(sourceTable),
      );
    if (!matchingMetric) {
      throw new Error(
        "Table sources are allowed only when they are the source of a metric on this dashboard",
      );
    }
  } else if (sourceCard && !scope.cardSourceIds.has(sourceCard)) {
    const matchingMetric = [...metricIds]
      .map((id) => scope.metricSources.get(id))
      .some((metric) => metric?.sourceCardId === sourceCard);
    if (!matchingMetric) {
      throw new Error(
        "This dashboard metric must be included in the query when using its source card",
      );
    }
  } else if (!sourceCard) {
    throw new Error("Dashboard queries must use a saved card or dashboard metric source");
  }

  return firstStage;
}
