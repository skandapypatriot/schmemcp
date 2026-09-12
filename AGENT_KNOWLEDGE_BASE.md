# EasyEDA Standard MCP Agent Knowledge Base

This document provides complete reference material for an AI agent operating the EasyEDA Standard schematic/PCB editor through the MCP bridge.

---

## System Architecture

```
[ AI Agent (LLM) ]
        |
        | MCP Tools (stdio)
        v
[ Python MCP Server (bridge_server.py) ]
        |
        |--- Direct HTTP ──> [ LCSC / jlcsearch API ]
        |
        | WebSocket JSON (ws://localhost:8765)
        v
[ EasyEDA Extension (main.js) ]
        |
        | window.api() calls
        v
[ EasyEDA Standard Editor ]
```

---

## Coordinate System

EasyEDA Standard uses internal pixel units:

| Unit | Pixels | Millimeters | Inches |
|------|--------|-------------|--------|
| 1 px | 1 | 0.254 | 0.01 |
| 1 mil | 0.1 | 0.0254 | 0.001 |
| 1 mm | 3.937 | 1 | 0.03937 |

- **X-axis:** Left to right (increasing)
- **Y-axis:** Top to bottom (increasing)

### Unit Conversion via API

```javascript
// Millimeters to pixels
api("unitConvert", { type: "mm2pixel", value: 10 });  // ~39.37

// Mils to pixels
api("unitConvert", { type: "mil2pixel", value: 100 }); // 10
```

---

## Available MCP Tools

### 1. `get_canvas_source(type="json")`

Retrieves the full active EasyEDA document schema.

**Parameters:**
- `type`: `"json"` | `"compress"` | `"svg"` (default: `"json"`)

**Returns:** Complete document JSON with shape objects keyed by `gId`.

**Example response structure:**
```json
{
  "head": { "docType": "1", "editorVersion": "6.5.22", "title": "Main_Board" },
  "canvas": "1000,1000,#FFFFFF,...",
  "TRACK": {
    "gge12": {
      "gId": "gge12",
      "strokeWidth": 1,
      "pointArr": [{"x": 100, "y": 100}, {"x": 200, "y": 100}],
      "net": "VCC"
    }
  }
}
```

### 2. `search_lcsc_component(query)`

Searches the LCSC/JLCPCB parts database. Does NOT require browser connection.

**Parameters:**
- `query`: Search text, part number, or C-number (e.g., `"NE555"`, `"C12345"`)

**Returns:** JSON array of component objects:
```json
[{
  "lcsc_id": "C7593",
  "mfr_part": "NE555DR",
  "title": "Timer IC",
  "package": "SOIC-8",
  "stock": 322212,
  "price": 0.091,
  "description": "..."
}]
```

### 3. `place_component(title, x, y)`

Places a schematic library component on the canvas.

**Parameters:**
- `title`: Component name (e.g., `"HDR2X2"`, `"NE555"`)
- `x`: X-coordinate in internal pixels
- `y`: Y-coordinate in internal pixels

**Internal API call:**
```javascript
api("createShape", {
  shapeType: "schlib",
  title: title,
  x: x,
  y: y
});
```

### 4. `add_wire(x1, y1, x2, y2)`

Draws a schematic wire between two points.

**Parameters:**
- `x1, y1`: Start point coordinates (pixels)
- `x2, y2`: End point coordinates (pixels)

**Internal API call:**
```javascript
api("createShape", {
  shapeType: "wire",
  pointArr: [{x: x1, y: y1}, {x: x2, y: y2}]
});
```

### 5. `update_net_name(gid, net_name)`

Updates the net assignment of a pad or track element.

**Parameters:**
- `gid`: Global ID of the shape (e.g., `"gge5"`)
- `net_name`: Net name to assign (e.g., `"VCC"`, `"GND"`)

**Internal API call:**
```javascript
api("updateShape", {
  shapeType: "PAD",
  jsonCache: { gId: gid, net: net_name }
});
```

---

## EasyEDA Native API Reference

All operations below are executed via `window.api(commandName, argsObject)` through the browser extension bridge.

### Document State

| API | Description |
|-----|-------------|
| `api("getSource", {type:"json"})` | Get full document as JSON |
| `api("getSource", {type:"compress"})` | Get compressed canvas string |
| `api("getSource", {type:"svg"})` | Get SVG representation |
| `api("applySource", {source:obj, createNew:false})` | Overwrite/modify active canvas |

### Shape Manipulation

| API | Description |
|-----|-------------|
| `api("getShape", {id:"gge13"})` | Get single shape by gId |
| `api("createShape", {...})` | Create and place a shape |
| `api("updateShape", {...})` | Modify shape properties |
| `api("delete", {ids:["gge2","gge3"]})` | Delete shapes by ID |
| `api("clone", {ids:["gge2","gge3"]})` | Clone shapes, returns new IDs |

### Selection & Transform

| API | Description |
|-----|-------------|
| `api("select", {ids:["gge1"]})` | Select objects |
| `api("selectNone")` | Deselect all |
| `api("getSelectedIds")` | Get selected gId array |
| `api("rotate", {ids:["gge1"], degree:90})` | Rotate clockwise |
| `api("fliph", {ids:["gge1"]})` | Flip horizontal |
| `api("flipv", {ids:["gge1"]})` | Flip vertical |
| `api("align_left", {ids:["gge1","gge2"]})` | Align left edges |

### Supported shapeType Values

**Schematic:**
`schlib`, `wire`, `bus`, `netlabel`, `pin`, `junction`, `noconnectflag`, `annotation`, `rect`, `circle`, `polyline`, `path`

**PCB:**
`FOOTPRINT`, `TRACK`, `COPPERAREA`, `SOLIDREGION`, `RECT`, `CIRCLE`, `TEXT`, `VIA`, `PAD`, `HOLE`

### PCB-Specific createShape Examples

**Track:**
```javascript
api("createShape", {
  shapeType: "TRACK",
  layerid: "1",      // 1=Top, 2=Bottom
  net: "GND",
  strokeWidth: 10,   // 10px = 100mil
  pointArr: [{x:100,y:100}, {x:200,y:100}]
});
```

**Via:**
```javascript
api("createShape", {
  shapeType: "VIA",
  net: "GND",
  x: 500, y: 500,
  holeR: 15,         // hole radius in px
  padR: 25           // pad radius in px
});
```

**PAD:**
```javascript
api("createShape", {
  shapeType: "PAD",
  net: "VCC",
  x: 100, y: 100,
  shape: "ELLIPSE",  // ELLIPSE, RECT, OVAL
  holeR: 10,
  padR: 20
});
```

---

## Common Agent Workflows

### 1. Read Current Design

```
1. Call get_canvas_source(type="json")
2. Parse the JSON to identify:
   - Components in "components" or "schlib" sections
   - Wires in "WIRE" section
   - Nets in track/pad "net" fields
   - gIds for each shape
```

### 2. Place a Component

```
1. Search for component: search_lcsc_component("NE555")
2. Choose position (x, y) in internal pixels
3. Call place_component("NE555", 400, 300)
4. Note the returned gId for subsequent operations
```

### 3. Connect Components with Wires

```
1. Get canvas source to find pin locations
2. Call add_wire(x1, y1, x2, y2) between pin endpoints
3. Each wire segment is one call; chain calls for paths
```

### 4. Rename Nets

```
1. Get canvas source to find pad/track gIds
2. Call update_net_name("gge5", "VCC")
3. Verify with get_canvas_source if needed
```

### 5. Modify PCB Track Widths

```
1. Get canvas source (type="json")
2. Iterate json.TRACK objects
3. For each track, modify strokeWidth
4. Apply with applySource({source: modifiedJson, createNew: false})
```

---

## Error Handling

| Error | Cause | Action |
|-------|-------|--------|
| `EASYEDA_API_NOT_READY` | `window.api` undefined | Wait 2s, retry |
| `EXECUTION_FAILED` | Invalid API call | Check shapeType, parameters |
| `ID_NOT_FOUND` | gId doesn't exist | Call getSource to refresh IDs |
| WebSocket timeout | Browser not connected | Ensure extension is loaded, check port 8765 |

---

## WebSocket Protocol

Messages between Python server and browser extension use JSON-RPC style frames:

**Request (Server → Browser):**
```json
{
  "req_id": "abc123",
  "action": "EXECUTE_API",
  "api_name": "getSource",
  "args": {"type": "json"}
}
```

**Response (Browser → Server):**
```json
{
  "req_id": "abc123",
  "status": "success",
  "data": { ... }
}
```

**Error Response:**
```json
{
  "req_id": "abc123",
  "status": "error",
  "error": "EXECUTION_FAILED",
  "message": "Error details"
}
```

---

## LCSC Component Data Fields

When using `search_lcsc_component()`, results contain:

| Field | Description |
|-------|-------------|
| `lcsc_id` | LCSC code (e.g., "C7593") |
| `mfr_part` | Manufacturer part number |
| `title` | Component title/description |
| `package` | Footprint/package (e.g., "SOIC-8") |
| `stock` | Current stock quantity |
| `price` | Unit price (USD) |
| `description` | Full description |

---

## Quick Reference: Position Estimation

For placing components, common canvas sizes:
- Default schematic: ~4000x3000 px
- Center of canvas: ~(2000, 1500)
- Component spacing: ~200-400 px apart
- Wire pin length: ~100 px from component body
