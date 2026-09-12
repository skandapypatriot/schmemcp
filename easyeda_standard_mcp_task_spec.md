# Task Specification: EasyEDA Standard MCP Server & Browser Bridge

## Objective

Build a complete Model Context Protocol (MCP) tool suite in Python and a Tampermonkey JavaScript UserScript for EasyEDA Standard.

This system allows an LLM (via MCP) to dynamically read, query, search, and manipulate an active EasyEDA Standard schematic or PCB canvas in real time.

> **Important:** Do not run any local tests or attempt to launch system processes. Generate all implementation files cleanly in the workspace and stop. The user will hand-test all extensions and Python servers.

---

## System Architecture

```text
[ LLM Client (Cursor/Claude) ]
              │
              │ MCP Protocol
              ▼
[ Python MCP Server ]
              │
              ├──── Direct HTTP/REST ────> [ LCSC Public API ]
              │
              │ WebSocket JSON
              ▼
[ JS UserScript Bridge (Browser) ]
              │
              │ Native api()
              ▼
[ EasyEDA Standard Tab ]
```

---

# Component Requirements

## File 1: `bridge_server.py`

**FastMCP + WebSocket Server**

Create a Python server utilizing the `mcp[cli]` framework (`FastMCP`) combined with a `websockets` async loop.

### 1. WebSocket Handler

- Listen on `ws://localhost:8765`.
- Maintain active connections to the injected EasyEDA browser UserScript.
- Send requests to the browser.
- Await JSON response futures using unique request IDs (`req_id`).

### 2. LCSC REST API Integration

Create an `lcsc_search` helper that:

- Directly queries LCSC search/product endpoints, for example:
  - `https://easyeda.com/api/products/search`
  - `https://wmsc.lcsc.com/ftps/wmsc/search/global`
- Accepts search text or LCSC C-numbers such as `C12345`.
- Returns formatted JSON arrays in the following structure:

```json
[
  {
    "lcsc_id": "C12345",
    "mfr_part": "PART-NUMBER",
    "title": "Component title",
    "package": "Package",
    "stock": 1000,
    "price": 0.25,
    "description": "Component description"
  }
]
```

### 3. Exposed MCP Tools

#### `get_canvas_source(type="json")`

Calls the EasyEDA native API through the WebSocket bridge:

```javascript
api("getSource", { type: "json" });
```

Returns the full active document schema.

#### `search_lcsc_component(query: str)`

Performs a direct Python HTTP search against the LCSC/EasyEDA parts database.

This tool does **not** require browser execution.

#### `place_component(title: str, x: float, y: float)`

Sends a WebSocket payload to trigger the browser native API:

```javascript
api("createShape", {
  shapeType: "schlib",
  title: title,
  x: x,
  y: y
});
```

#### `add_wire(x1: float, y1: float, x2: float, y2: float)`

Sends a WebSocket payload to trigger the browser native API:

```javascript
api("createShape", {
  shapeType: "wire",
  pointArr: [
    { x: x1, y: y1 },
    { x: x2, y: y2 }
  ]
});
```

#### `update_net_name(gid: str, net_name: str)`

Calls the browser native API:

```javascript
api("updateShape", {
  shapeType: "PAD",
  jsonCache: {
    gId: gid,
    net: net_name
  }
});
```

### 4. Error Handling

If no browser tab is connected via WebSocket, browser-dependent MCP tools must fail gracefully with this readable error:

```text
EasyEDA Browser tab is not connected via WebSocket.
```

---

# File 2: `easyeda_bridge.user.js`

**Tampermonkey UserScript**

Create a JavaScript UserScript configured to run on:

- `https://easyeda.com/editor*`
- `https://std.easyeda.com/*`

## 1. Header Block

```javascript
// ==UserScript==
// @name         EasyEDA Std MCP Bridge
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Connects EasyEDA Standard workspace to local MCP Python server via WebSockets
// @match        https://easyeda.com/editor*
// @match        https://std.easyeda.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==
```

## 2. Execution Logic

### WebSocket Connection

- Establish a resilient WebSocket connection to `ws://localhost:8765`.
- Automatically reconnect every 3 seconds when the connection drops.

### Incoming Messages

Listen for incoming JSON RPC messages from the Python MCP server.

Example:

```json
{
  "req_id": "123",
  "action": "EXECUTE_API",
  "api_name": "getSource",
  "args": {
    "type": "json"
  }
}
```

### EasyEDA Native API Execution

Dynamically execute EasyEDA Standard's native `window.api()` function inside the browser context:

```javascript
const result = window.api(msg.api_name, msg.args);
```

### Return Results

Post the execution result back to the Python server through the WebSocket:

```json
{
  "req_id": "123",
  "status": "success",
  "data": {}
}
```

### Connection Status UI

Provide a small status indicator, such as a badge in the bottom corner of the EasyEDA editor, showing the current WebSocket connection status.

The indicator should clearly distinguish between:

- Connected
- Disconnected
- Reconnecting

---

# File 3: `requirements.txt`

Specify the required Python packages:

```text
mcp>=1.0.0
websockets>=12.0
requests>=2.31.0
asyncio
```

---

# File 4: `README.md`

Provide clear setup documentation containing the following.

## 1. Install Python Dependencies

Explain how to install the dependencies from `requirements.txt`.

Example:

```bash
pip install -r requirements.txt
```

## 2. Install the Tampermonkey UserScript

Explain how to:

1. Install Tampermonkey in Chrome or Firefox.
2. Create a new UserScript.
3. Replace its contents with `easyeda_bridge.user.js`.
4. Save the script.
5. Open EasyEDA Standard and verify that the bridge status indicator appears.

## 3. Configure the MCP Client

Provide an example configuration for Claude Desktop's `claude_desktop_config.json` or Cursor's MCP configuration.

Example:

```json
{
  "mcpServers": {
    "easyeda": {
      "command": "python",
      "args": [
        "bridge_server.py"
      ]
    }
  }
}
```

Document that the path to `bridge_server.py` should be adjusted as necessary.

---

# Coding Constraints

## No Testing

Do **not**:

- Run unit tests.
- Run test scripts.
- Run subprocesses.
- Open local web servers.
- Start the MCP server.
- Attempt to connect to EasyEDA.

Only generate the required implementation files.

## No Mocking

Write production-ready:

- WebSocket protocol handling.
- Request/response correlation using `req_id`.
- Async request futures.
- Connection management.
- Automatic browser reconnection.
- Complete async error trapping.

Do not use mocked EasyEDA responses or fake LCSC data.

## Pure API Interaction

Ensure all native browser-side EasyEDA operations use the EasyEDA Standard native API through the WebSocket bridge.

The implementation must use the following native APIs where applicable:

```javascript
api("getSource", ...);
api("createShape", ...);
api("updateShape", ...);
```

Do not replace these operations with simulated data, DOM manipulation, or UI automation.
