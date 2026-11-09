# Metabase Agent API Demo

A sample chat app for the Metabase Agent API. Ask natural language questions about your data and get answers powered by Claude.

## Prerequisites

- A Metabase instance with the Agent API enabled under **Admin > AI > MCP**
- Anthropic API key

## Metabase setup

Use the email address and password of an existing Metabase user. The server logs in with `POST /api/session` and uses the returned session token for Agent API requests. API-key authentication is a separate alternative and isn't used by this setup.

## Configuration

```sh
cp .env.example .env
```

Fill in your `.env`:

| Variable | Description |
|----------|-------------|
| `METABASE_INSTANCE_URL` | Your Metabase URL (no trailing slash) |
| `METABASE_USER_EMAIL` | Email/username of an existing Metabase user |
| `METABASE_USER_PASSWORD` | Password for that Metabase user |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `X-API-KEY` | API key used by the dashboard-list service |

## Run

```sh
npm run install:all
npm run dev
```

Open [http://localhost:3100](http://localhost:3100). Choose a dashboard from the dropdown; its ID is stored in the URL as `dashboardId`, and chat is scoped to the selected dashboard. Query tools are read-only; dashboard edits are not available.

Tool calls are logged by the server with their request ID, dashboard ID, input, output, duration, and errors. Dashboard `read-resource` requests and responses are logged as well. In the chat, expand **Show tool input and output** on a tool card to inspect the AI tool's input and response. These logs may contain query data, so protect server logs accordingly. Dashboard context is remembered in server memory for each conversation for up to 24 hours if a later request omits `dashboardId`; a server restart clears that fallback, and the client sends the selected dashboard ID on every request.

## Reporting issues

For bugs and feature requests, please [open an issue](https://github.com/metabase/metabase-agent-api-demo/issues). For security issues, please see our [Security Policy](https://github.com/metabase/metabase/security/policy).

## License

This project is licensed under the [MIT License](./LICENSE).
