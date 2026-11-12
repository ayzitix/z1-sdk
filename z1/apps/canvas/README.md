# @z1/canvas

Browser editor and runner for the z1 node-graph SDK. The canvas talks to
`z1 serve` over the JSON-RPC WebSocket protocol in `@z1/protocol`.

## Run

Start the server (it prints the socket URL and a token):

```sh
pnpm z1 serve --json
# {"url":"ws://127.0.0.1:43219","token":"..."}
```

Start the canvas:

```sh
pnpm z1:canvas
# VITE ready — http://localhost:5173
```

Open `http://localhost:5173/?url=ws%3A%2F%2F127.0.0.1%3A43219&token=<token>`,
or paste the server URL and token into the toolbar and press **Connect**. A
bare origin such as `ws://127.0.0.1:43219` becomes `/ws?token=...`
automatically.

## Use

- **Palette** — click a node to add it near the last free grid slot.
- **Canvas** — drag nodes, connect output handles (right) to input handles
  (left). Data edges are solid black, flow edges dashed grey. Incompatible
  schemas, mixed kinds, self-edges and a second data edge into one port are
  refused.
- **Inspector** — ports, config JSON with **Apply**, and per-node autonomy
  (`auto | ask | deny`).
- **Run / Cancel** — validates the graph, then starts a run. Node rings show
  running / completed / failed / cached.
- **Runs & events** — journal list with `↳ parent@seq` ancestry, event summary
  per run, and **Fork at path** (a node path or a sequence number).
- **Approvals** — a server `approval/request` opens a modal with
  **Approve once** / **Reject**.
- **Save JSON / Open JSON** — download or load a `GraphDocument`.

The server URL and token persist in `localStorage`.

## Build

```sh
pnpm z1:canvas:build
# z1/apps/canvas/dist/index.html
```

Tests (pure conversion rules):

```sh
pnpm -C z1 exec vitest run apps/canvas/tests
```

## Layout

```
src/
  api.ts        WebSocket transport + CanvasClient
  graph.ts      toFlow / fromFlow / canConnect / mergeRunEvent
  store.ts      zustand state, run overlay, approvals
  components/   Toolbar, Palette, GraphCanvas, Z1Node, Inspector,
                OutputsPanel, ApprovalDialog, RunsPanel
```
