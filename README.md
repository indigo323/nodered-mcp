# nodered-mcp

Minimal MCP server (Streamable HTTP) wrapping the Node-RED admin API.
No third-party Node-RED client libraries — plain `fetch` calls only.

## Tools

- `list_flows` — GET /flows, returns tab id/label list
- `get_flow` — GET /flow/:id
- `deploy_flow` — PUT /flow/:id (single-tab replace, never touches other tabs).
  Reads the existing tab first and logs existing vs. incoming node count so an
  accidental overwrite is obvious.
- `create_flow` — POST /flow (single new tab, not the whole flowset)
- `get_nodes` — GET /nodes
- `get_context` — GET /context/global (requires Context API enabled on the target instance)
- `install_modules` — POST /nodes `{module}`. **Runs `npm install` inside the
  Node-RED runtime.** This is equivalent to shell access on that host — there
  is no allowlist. Do not expose this server to anything you wouldn't hand a
  shell to.

## Config

Copy `.env.example` to `.env` and set `NODE_RED_URL` / `NODE_RED_TOKEN`.

## Run

```
docker compose up -d --build
```
