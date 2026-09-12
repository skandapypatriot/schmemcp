# EasyEDA Standard MCP Server & Browser Bridge

A Model Context Protocol (MCP) tool suite that allows an LLM to dynamically read, query, search, and manipulate an active EasyEDA Standard schematic or PCB canvas in real time.

## Architecture

```
[ LLM Client (Cursor/Claude) ]
              |
              | MCP Protocol (stdio)
              v
[ Python MCP Server ]  <---->  [ LCSC Public API ]
              |
              | WebSocket JSON (ws://localhost:8765)
              v
[ EasyEDA Extension Bridge (Browser) ]
              |
              | Native api()
              v
[ EasyEDA Standard Tab ]
```

## 1. Install Python Dependencies

```bash
# Create and activate virtual environment (if not already done)
python -m venv mcpservervenv
source mcpservervenv/bin/activate   # Linux/macOS
mcpservervenv\Scripts\activate      # Windows

# Install dependencies
pip install -r requirements.txt
```

## 2. Install the EasyEDA Extension

1. Open [EasyEDA Standard](https://easyeda.com/editor) in your browser.
2. Go to **Settings > Advanced > Extensions Setting**.
3. Click **Load Extension**.
4. Click **Select Files** and select **all files** from the `easyeda-extension/` folder.
5. Enter a name (e.g., "MCP Bridge") and click **Load**.
6. **Close and reopen** the EasyEDA editor.
7. Verify that the MCP Bridge button appears on the toolbar and shows **Connected** (green) when the Python server is running.

## 3. Configure the MCP Client

### Claude Desktop

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "easyeda": {
      "command": "C:\\Users\\casmm\\schmemcp\\mcpservervenv\\Scripts\\python.exe",
      "args": [
        "C:\\Users\\casmm\\schmemcp\\bridge_server.py"
      ]
    }
  }
}
```

### Cursor

Add the following to your Cursor MCP settings (`.cursor/mcp.json` or via the UI):

```json
{
  "mcpServers": {
    "easyeda": {
      "command": "C:\\Users\\casmm\\schmemcp\\mcpservervenv\\Scripts\\python.exe",
      "args": [
        "C:\\Users\\casmm\\schmemcp\\bridge_server.py"
      ]
    }
  }
}
```

> **Note:** Adjust the paths to match your actual installation location.

## 4. Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_canvas_source(type)` | Retrieve the full active EasyEDA document (json, compress, or svg) |
| `search_lcsc_component(query)` | Search the LCSC/EasyEDA parts database by keyword or C-number |
| `place_component(title, x, y)` | Place a schematic component on the canvas |
| `add_wire(x1, y1, x2, y2)` | Draw a schematic wire between two points |
| `update_net_name(gid, net_name)` | Update the net assignment of a pad or track element |

## 5. Troubleshooting

- **Badge shows "Disconnected"**: Ensure `bridge_server.py` is running.
- **Badge shows "Reconnecting..."**: The WebSocket server is not reachable. Check that port **3579** is not blocked (not 8765 — this is the port actually used by `bridge_server.py` and `easyeda-extension/main.js`).
- **Tool returns browser error**: Ensure the EasyEDA editor tab is fully loaded and active.

## 6. Verified API Notes (edit 2026-09)

Findings verified by probing the live EasyEDA Standard editor (6.5.51) from the browser extension:

- **`place_component` MCP tool is broken.** `bridge_server.py` sends `PLACE_LCSC`, and `easyeda-extension/main.js` calls `api('searchLccComponent', ...)` — **not** a registered EasyEDA method. The guard inside `api()` silently drops unknown names, so no callback ever fires and the MCP request times out after 60 s.
- Only a subset of EasyEDA `api()` methods are registered in the extension's registry: verified live = `getSource`, `getShape`, `getSelectedIds`, `delete`, `rotate`, `createShape`, `doCommand`. `createShape` is **async** for lib items (returns `undefined`, lands the shape a few seconds later).
- **Working LCSC placement flow** (verified: placed `C123302` as `gge233`):

  1. `GET https://easyeda.com/api/products/{lcsc}/components?version=6.4.19.5` → `result.uuid` + `result.datastrid` (this endpoint returns only the schematic-symbol item; there is no separate footprint fetch needed for the schematic).
  2. In the extension context:

     ```js
     api('createShape', {
       shapeType: 'schlib',
       uuid: <uuid>,
       datastrid: <datastrid>,
       from: 'system',
       title: '<lcsc>',
       x: <px>, y: <px>,     // 1 px = 10 mil
     });
     ```

- `createShape` with `from:'EasyEDALibs'` + `title` returns `false` (synchronous) if the title is not resolvable; `from:'system'` + `shortUrl`/`uuid` is the path that works.
- To confirm placement, read back with `getSource({type:'json'})` and diff `schlib` keys. Canvas origin is top-left; existing title frames may sit at negative Y.
