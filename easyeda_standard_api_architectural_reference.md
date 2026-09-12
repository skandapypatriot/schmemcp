# EasyEDA Standard API & Architectural Reference for AI Agents

This document outlines the API interface, coordinate system, payload formats, and design patterns required for an AI coding agent to interact with the **EasyEDA Standard Edition** workspace through a browser bridge.

EasyEDA Standard editor:
`https://easyeda.com/editor`

---

## 1. System Architecture Overview

```text
┌─────────────────────────────────────────────────────────┐
│                       AI Client                         │
│         Translates natural language to parameters       │
└───────────────────────────┬─────────────────────────────┘
                            │
                            │ MCP Tools (Stdio Transport)
                            ▼
┌─────────────────────────────────────────────────────────┐
│                     MCP Server                          │
│              (Python / mcp_server.py)                   │
└───────────────────────────┬─────────────────────────────┘
                            │
                            │ Async Commands (Req/Res Futures)
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  WebSocket Bridge                       │
│       (ws://127.0.0.1:8765 / ws_bridge.py)              │
└───────────────────────────┬─────────────────────────────┘
                            │
                            │ JSON-RPC Frames over WebSocket
                            ▼
┌─────────────────────────────────────────────────────────┐
│             Browser Extension / UserScript              │
│           (Tampermonkey / easyeda_bridge.js)            │
└───────────────────────────┬─────────────────────────────┘
                            │
                            │ Native JavaScript execution
                            ▼
┌─────────────────────────────────────────────────────────┐
│                EasyEDA Standard Engine                  │
│          window.api("commandName", payload)             │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Coordinate System & Unit Rules

EasyEDA Standard uses an internal coordinate unit based on pixels (`px`). When interacting with shapes, footprints, pads, and tracks, use the following conversion ratios:

- **1 px = 10 mil = 0.254 mm = 0.01 inch**
- **X-axis:** Increases from left to right.
- **Y-axis:** Increases from top to bottom.

### Convert Units via the Native API

The extension layer can use the native API for unit conversion instead of performing manual floating-point calculations.

#### Millimeters to Pixels

```javascript
const pxValue = api("unitConvert", {
  type: "mm2pixel",
  value: 10
});
// Returns approximately 39.3700...
```

#### Mils to Pixels

```javascript
const pxValue = api("unitConvert", {
  type: "mil2pixel",
  value: 100
});
// Returns 10
```

---

## 3. Core EasyEDA Standard `window.api()` Methods

All native commands are executed by invoking:

```javascript
window.api(commandName, argsObject);
```

---

### A. Document State Management

#### `getSource`

Retrieves the raw JSON object tree, compressed canvas string, or SVG vector string of the active schematic or PCB tab.

**Input payload:**

```javascript
api("getSource", {
  type: "json"
});
// Options: "json" | "compress" | "svg"
```

**Response structure for `type: "json"`:**

Returns the active canvas document. Every shape or component has a unique global ID (`gId`), such as `"gge13"`.

```json
{
  "head": {
    "docType": "1",
    "editorVersion": "6.5.22",
    "title": "Main_Board"
  },
  "canvas": "1000,1000,#FFFFFF,yes,10,10...",
  "TRACK": {
    "gge12": {
      "gId": "gge12",
      "strokeWidth": 1,
      "pointArr": [
        { "x": 100, "y": 100 },
        { "x": 200, "y": 100 }
      ],
      "net": "VCC"
    }
  },
  "WIRE": {
    "..."
  },
  "components": {
    "..."
  }
}
```

#### `applySource`

Overwrites or updates the active editor canvas using a complete modified JSON or compressed payload.

```javascript
api("applySource", {
  source: jsonObject,
  createNew: false
});
```

- `createNew: false` — Modify the active tab.
- `createNew: true` — Open the source in a new tab.

---

### B. Canvas & Shape Manipulation

#### `getShape`

Fetches a single shape or component object by its unique canvas ID (`gId`).

```javascript
const obj = api("getShape", {
  id: "gge13"
});
```

#### `createShape`

Instantiates and places a schematic library component, footprint, wire, track, or geometric primitive directly onto the active canvas.

##### Placing a Schematic Component / Symbol

```javascript
api("createShape", {
  shapeType: "schlib",
  from: "EasyEDALibs",
  title: "HDR2X2",
  x: 400,
  y: 300
});
```

##### Placing a PCB Track

```javascript
api("createShape", {
  shapeType: "TRACK",
  layerid: "1",
  net: "GND",
  strokeWidth: 10,
  pointArr: [
    { "x": 100, "y": 100 },
    { "x": 200, "y": 100 }
  ]
});
```

`layerid` examples:

- `1` — Top Layer
- `2` — Bottom Layer

`strokeWidth` is expressed in internal pixels. For example, `10 px = 100 mil`.

##### Supported `shapeType` Values

**Schematic (`sch`):**

- `schlib`
- `wire`
- `bus`
- `netlabel`
- `pin`
- `junction`
- `noconnectflag`
- `annotation`
- `rect`
- `circle`
- `polyline`
- `path`

**PCB (`pcb`):**

- `FOOTPRINT`
- `TRACK`
- `COPPERAREA`
- `SOLIDREGION`
- `RECT`
- `CIRCLE`
- `TEXT`
- `VIA`
- `PAD`
- `HOLE`

#### `updateShape`

Modifies individual properties, such as net assignments, coordinates, text labels, or line thicknesses, without recreating the object.

```javascript
api("updateShape", {
  shapeType: "PAD",
  jsonCache: {
    gId: "gge5",
    net: "GND",
    shape: "ELLIPSE"
  }
});
```

#### `delete`

Removes objects from the canvas by their unique IDs.

```javascript
api("delete", {
  ids: ["gge2", "gge3"]
});
```

---

### C. Canvas Transformation & Selection

| Action | API Signature | Notes |
|---|---|---|
| **Select Objects** | `api("select", { ids: ["gge1", "gge2"] })` | Highlights objects on screen. |
| **Deselect All** | `api("selectNone")` | Clears selection state. |
| **Get Selected** | `api("getSelectedIds")` | Returns an array of selected `gId` strings. |
| **Rotate** | `api("rotate", { ids: ["gge1"], degree: 90 })` | Rotates clockwise. |
| **Flip Horizontal** | `api("fliph", { ids: ["gge1"] })` | Flips selected elements horizontally. |
| **Flip Vertical** | `api("flipv", { ids: ["gge1"] })` | Flips selected elements vertically. |
| **Align Left** | `api("align_left", { ids: ["gge1", "gge2"] })` | Aligns left edges. |

---

## 4. OpenLCSC / JLCPCB Search API Integration

When an AI needs to search for physical components by C-number or generic parameters, the MCP server queries the public LCSC API directly through Python, bypassing the browser runtime.

### Endpoint Specification

**URL:**

`https://easyeda.com/api/products/search`

**HTTP Method:**

`GET` or `POST`

**Query Parameters:**

- `keyword` — Search string, for example:
  - `C46749`
  - `NE555P`
  - `10k 0805`
- `page` — Integer; default: `1`
- `currPage` — Integer; default: `1`

### LCSC Search Output Schema

The MCP server should normalize the raw response into the following unified structure:

```json
{
  "lcsc_number": "C46749",
  "mfr_part_number": "NE555P",
  "title": "NE555P",
  "package": "DIP-8",
  "manufacturer": "Texas Instruments",
  "description": "Single Precision Timer 100kHz 4.5V~16V DIP-8 Integrated Circuits (ICs)",
  "stock": 14200,
  "price": 0.15
}
```

---

## 5. Standard Error Handling Patterns

### Browser Bridge Injection Context

The browser script **must** execute API calls inside a `try...catch` block to handle situations such as:

- EasyEDA being in the middle of rendering.
- An unsupported document tab being active.
- `window.api` being temporarily unavailable or locked.

Recommended pattern:

```javascript
function executeEasyEDACommand(apiName, payload) {
  if (typeof window.api !== "function") {
    return {
      status: "error",
      error: "EASYEDA_API_NOT_READY",
      message: "window.api is not defined. Ensure EasyEDA editor is fully loaded."
    };
  }

  try {
    const result = window.api(apiName, payload);

    return {
      status: "success",
      data: result
    };
  } catch (err) {
    return {
      status: "error",
      error: "EXECUTION_FAILED",
      message: err.message || String(err)
    };
  }
}
```

### Response Mapping Matrix

| Error Code | Root Cause | Agent Action |
|---|---|---|
| `EASYEDA_API_NOT_READY` | Canvas tab is loading or the extension was injected on a non-editor page. | Pause execution, wait 2 seconds, and retry the socket connection. |
| `INVALID_SHAPE_TYPE` | Unknown or misspelled `shapeType` string in `createShape`. | Check `shapeType` against the supported list, such as `TRACK`, `PAD`, and `wire`. |
| `ID_NOT_FOUND` | The provided `gId` does not exist in the active document. | Call `getSource` first to refresh the active canvas IDs. |
