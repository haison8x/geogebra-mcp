# geogebra-mcp

An MCP server that lets an AI (Claude Desktop, Claude Code, Cursor, …) draw and edit plane-geometry figures **directly on GeoGebra Calculator** (`https://www.geogebra.org/calculator`).

Unlike the copy/paste workflow of the GeoGebra AutoDraw AI extension, the AI here works in a loop: it runs commands, reads errors and the figure state, verifies properties, looks at a screenshot, and fixes the figure itself — and it can edit the figure on request ("H must be the foot from A").

## How it works

```
AI client ──MCP (stdio)──► geogebra-mcp ──Playwright──► Chrome window: geogebra.org/calculator
                                                            └─ window.ggbApplet (GeoGebra JS API)
```

- On the first tool call the server opens a Chrome (or Edge) window on GeoGebra Calculator. The user watches the figure being drawn and can drag/edit it by hand.
- Tools call the GeoGebra JS API (`ggbApplet`) inside the page through `page.evaluate` — no simulated clicks.
- Commands run through `asyncEvalCommandGetLabels`, which lazy-loads GeoGebra modules, so prover/scripting commands (`AreCollinear`, `Incircle`, `TriangleCenter`, `ClosestPoint(line, point)`…) work.
- GeoGebra reports a failed command only as `null`, so the server adds its own diagnostics (unknown names, unknown commands, unbalanced brackets, known pitfalls) and warnings (undefined results, reserved names, two-point intersections without an index).
- If the window is closed or reloaded, the next tool call reopens it and restores the last known figure.
- Undo is managed by the server (XML history), because `ggbApplet.undo()` does not revert API commands.

## Tools

| Tool | Purpose |
|---|---|
| `ggb_run_commands` | Run commands in order; per-command result, created/removed objects, warnings, failure hints. Assigning to an existing name redefines it. |
| `ggb_get_state` | Objects with type, definition, value, coordinates, visibility, `dependsOn` / `usedBy`. |
| `ggb_screenshot` | PNG of the drawing area (or the whole window) for visual checking. |
| `ggb_evaluate` | Evaluate expressions without adding objects (`Angle(B, A, C)`, `AreCollinear(A, H, O)`…). |
| `ggb_set_style` | Color, visibility, label, caption, thickness, line style, point size, fill, fixed. |
| `ggb_delete` | Delete objects (and their dependents). |
| `ggb_clear` | Start a new figure. |
| `ggb_undo` | Revert changes made through the server. |
| `ggb_snapshot` | Save / restore / list named versions. |
| `ggb_fit_view` | Fit every visible point and circle in view (1:1 ratio), toggle axes/grid. |
| `ggb_export` | Save as `.ggb` or `.png`. |

Also: resource `geogebra://rules` (construction rules), resource `geogebra://commands` (command catalog), prompt `draw_geometry_problem`.

## Setup

Requirements: Node.js ≥ 20 and Google Chrome or Microsoft Edge (otherwise run `npx playwright install chromium`).

```bash
npm install
npm run build
```

### Claude Code

```bash
claude mcp add geogebra -- node C:/Data/Son/geogebra-mcp/dist/index.js
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "geogebra": {
      "command": "node",
      "args": ["C:/Data/Son/geogebra-mcp/dist/index.js"]
    }
  }
}
```

Then restart Claude Desktop and ask, for example: *"Vẽ tam giác ABC nội tiếp đường tròn (O), đường cao AH, M là trung điểm BC."*

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `GGB_BROWSER` | try `chrome`, `msedge`, then Playwright Chromium | Browser channel |
| `GGB_HEADLESS` | `0` | `1` to run without a window (testing) |
| `GGB_PROFILE_DIR` | `~/.geogebra-mcp/profile` | Browser profile (keeps the GeoGebra login). One server instance per profile. |
| `GGB_URL` | `https://www.geogebra.org/calculator` | Page to open |

## Development

```bash
npm run build
npm run smoke              # end-to-end test through a real MCP client (headless)
npm run smoke -- --headed  # same, with a visible window
```

## Notes

- GeoGebra is free for non-commercial use; check the GeoGebra license before any commercial use of this automation.
- Snapshots and undo history live in memory while the server runs.
