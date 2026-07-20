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

The container reads its config from a host-mounted `.env` file at `/app/.env`
(loaded via `dotenv/config`), not from compose `environment:` entries or
Portainer stack variables — see `docker-compose.yml`'s volume mount. On the
deployment host, create the secrets directory and file yourself (mode 700 /
600, root-owned) rather than entering values through Portainer's UI:

```
/opt/nodered-mcp/secrets/.env
```

using the format in `.env.example`:
- `NODE_RED_URL` — base URL of the Node-RED instance
- `NODE_RED_USERNAME` / `NODE_RED_PASSWORD` — HTTP Basic credentials for the
  auth proxy in front of Node-RED (sent as `Authorization: Basic ...`)
- `MCP_API_KEY` — random key required as an `x-api-key` header on every
  request to `/mcp`. This server has no Node-RED-side auth of its own beyond
  what Node-RED enforces, so `MCP_API_KEY` is the only thing gating access to
  it directly — generate a long random value and don't reuse it elsewhere.

## Run

```
docker compose up -d --build
```
