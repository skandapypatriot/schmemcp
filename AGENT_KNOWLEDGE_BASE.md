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

### 4. `add_wire(x1, y1, x2, y2, points)`

Draws a **REAL** schematic wire (electrically connected, passes ERC).

**Parameters:**
- `x1, y1`: Start point coordinates (pixels)
- `x2, y2`: End point coordinates (pixels)
- `points`: Optional list of `[x,y]` or `{"x":..,"y":..}` — draws ONE polyline with
  all bends in a single call (fast). When given, x1/y1/x2/y2 are ignored.

**Mechanism (FIXED — now uses the editor's own import path):** the extension
(`easyeda-extension/main.js` `handleAddWire`) no longer uses `createShape`. It finds the
editor frame (`iframe` whose window exposes `callCommand.hooks.importShape`), then injects an
SVG polyline with `c_etype="wire"`:

```javascript
cc.hooks.importShape.call(w, '<polyline points="' + pts + '" stroke="#008800" stroke-width="1" fill="none" c_shapetype="line" c_etype="wire" id="' + gid + '" locked="0"/>', {});
```

This is byte-for-byte the same injection as the manual `eval_browser_js` method (section 4b),
so every MCP/bridge/add_wire/batch wire is now a genuine net wire. A unique id is generated per
call (`gge_wireNNNN`), and the result is verified against `getSource().wire` before replying.

Fast bulk rail: pass a `points` list to draw an entire power/ground rail with all its bends in
one round-trip, or use `run_batch` with several `add_wire` calls. Never chain dozens of
two-point segments when one polyline reaches all targets.

> **Deployment note:** this behaviour lives in `easyeda-extension/main.js` `handleAddWire` and
> `bridge_server.py` `add_wire`. After editing either file you MUST reload the EasyEDA page (to
> re-inject the extension `main.js`) and restart the MCP `bridge_server.py` process, otherwise
> `add_wire` still uses the old cosmetic path.

### 4b. Creating REAL Logic Wires — VERIFIED via `eval_browser_js` (THE method — use this)

Wrap every wire operation in **one** `easyeda-std_eval_browser_js` call. Prefer the dedicated
`add_wire` tool (section 4) — it is now implemented via this same importShape injection — for
anything that benefits from a normal tool call / batching.

```javascript
// Run via easyeda-std_eval_browser_js in iframe 0 (the schematic editor frame)
(function(){
  const w = document.querySelectorAll('iframe')[0].contentWindow;
  const cc = w.callCommand;
  const svg = '<polyline points="380,400 1020,400" stroke="#008800" stroke-width="1" fill="none" c_shapetype="line" c_etype="wire" id="gge_wire0001" locked="0"/>';
  cc.hooks.importShape.call(w, svg, {});   // 2nd arg options {} is REQUIRED
  const c = cc.hooks.gJsonCache.call(w);
  return JSON.stringify({ json: c.wire && c.wire['gge_wire0001'], domPts: w.document.getElementById('gge_wire0001') && w.document.getElementById('gge_wire0001').getAttribute('points') });
})();
```

**How the wiring API works:**

1. `c_etype="wire"` on the `<polyline>` is what makes it a REAL wire. The editor maps
   `polyline` + `c_etype="wire"` → command key `"wire"` (see `getSCHCmdKey` in
   `editorSCH.min.js`), and its serializer then puts the object into the top-level
   `"wire": { "gId": { gId, strokeColor, strokeWidth, strokeStyle, fillColor, locked, pointArr } }`
   JSON section — NOT the `polyline` section. The interactive wire tool builds exactly this shape.
2. Coordinates: use `points="x1,y1 x2,y2"` (comma between x and y, space between points).
   **This preserved exact coords** in both the DOM and JSON (`pointArr`). A space-only string
   (`"x1 y1 x2 y2"`) produced SHIFTED points in one test (380,400 740,420 → 375,400 735,415),
   so keep the comma-x,y form.
3. Typical attributes: `stroke="#008800"` (green — the editor's default schematic wire color),
   `stroke-width="1"`, `fill="none"`, `c_shapetype="line"`, `locked="0"`.
4. `importShape` hook signature is `importShape(svgString, options)` — the options object is
   MANDATORY; omitting it throws `Cannot read properties of undefined (reading 'appendTo')`.

**How to wire FAST (multi-point polyline — one call per net):**

A single `<polyline>` may contain ANY number of `x,y` points. Build one polyline per rail/net —
all its bends included — instead of chaining many tiny two-point segments. One `importShape`
call (or one `add_wire` with a `points` list) = one whole rail:

```javascript
// + rail: battery + (1880,1195) → down → right → up through LED2+ → LED1+
cc.hooks.importShape.call(w, '<polyline points="1880,1195 1880,1500 2166,1500 2166,1395 2166,1195" stroke="#008800" stroke-width="1" fill="none" c_shapetype="line" c_etype="wire" id="gge_wireP01" locked="0"/>', {});
```

For a whole board, run ALL wires in one eval script (loop over an array of wire defs):

```javascript
var defs = [
  { id: 'gge_wireP01', pts: '1880,1195 1880,1500 2166,1500 2166,1395 2166,1195' },
  { id: 'gge_wireM01', pts: '1916,1195 1916,1100 2126,1100 2126,1195 2126,1395' }
];
defs.forEach(function(d){
  cc.hooks.importShape.call(w, '<polyline points="'+d.pts+'" stroke="#008800" stroke-width="1" fill="none" c_shapetype="line" c_etype="wire" id="'+d.id+'" locked="0"/>', {});
});
```

Wire ids are free-form (`gge_wireP01`, ...) — you do NOT need real `gId`s. Gaps ≤ 50 px between
bends look like a clean continuous rail.

**What happens automatically:**

- Where a wire runs THROUGH a pin coordinate, the editor auto-creates a junction object in the
  top-level `"junction"` section (red dot). Wire endpoints that land exactly ON a pin need no
  junction — connection is implied by shared coordinates.
- The canvas will snap a wire to grid; endpoints should be placed ON the pin's exact `x,y`
  (read back from `gJsonCache`: `schlib.<gid>.pin.<pinid>.configure.x/y`).

**CRITICAL wiring rule — never let a rail run OVER another pin:**

A rail segment passing across ANY pin coordinate joins that pin to the net (junction appears).
This is a real electrical short / unintended connection. Example: battery(+) rail run straight
along y=1460 to switch pin 2 passed over switch pin 1 and silently shorted pin1+pin2 together,
bypassing the switch entirely. **Always route rails so they only touch the intended pins** —
approach each target pin from below/above/side on its own column, never straddling a neighbor:

- Battery side wire ends on switch THROW pin (e.g. (1976,1460)).
- LED-side wire starts on switch COMMON/POLE pin (e.g. (1996,1460)), drops below the switch to
  y=1500, runs right, then rises up the LED + column — pin 3 stays floating with no junction.

After wiring, verify junctions: read `gJsonCache.junction` — the set of junction coords must
exactly match the intended tap points (no extras on pins you meant to leave open).

**How to delete/replace a wire:**

1. `cc.hooks.deleteObjs.call(w, [w.document.getElementById('gge_wire0001')])` — needs the REAL DOM
   node, not an id string (an id string throws `appendChild: parameter 1 is not of type Node`).
2. Deleting a wire removes its auto-created junctions from the cache; re-import the corrected
   wire, then re-verify junctions.
3. If the DOM node was already removed but the wire lingers in the JSON cache (orphan), re-create
   the node via `importShape` with the same id, then call `deleteObjs` with the fresh node.

**DANGER — never call `jsonMgr_calAll` / `updateJsonCache` / `drawShape` hooks.** Calling these
after manually mutating `gJsonCache` regenerated the whole document from the editor's stale
stored sheet — old/abandoned components came back and the placed parts were wiped from live
cache + DOM. Only use `importShape`, `deleteObjs`, and `gJsonCache` (read) directly.

**Other notes:**
- `window.api()` is NOT reachable from `eval_browser_js` (undefined in both the frame and parent);
  unregistered commands like `moveObjsTo` silently return `undefined` and do nothing. The
  extension manager lives at `parent.top.easyeda.extension` (has `instances` incl. `mcpbridge`,
  plus `exec`/`quickScript`/`doCommand`). Editor commands are exposed as `callCommand.hooks.*`:
  `gJsonCache` (get doc), `getSource`, `getShape`, `deleteObjs`, `move`, `setOriginXY`,
  `undo`/`redo`. There is NO `moveObjsTo` hook — lay out components by placing them at final
  coordinates instead of moving later.
- `place_component` drifts ~+396 px X / +295 px Y from the requested coords and its returned gId
  is unreliable. Always read back real gIds + pin coords via `gJsonCache` before wiring.

### 4c. Wiring a Board End-to-End (the proven workflow)

Verified end-to-end in a real schematic (CR2032 bed lamp). Follow this order — it never
short-circuits and is fast:

1. **Place ALL components first.** `place_component` drifts ~+396/+295 px from the requested
   coord, so plan placement ~ (target − 396, target − 295). The returned gId in the MCP reply is
   unreliable (repeat placements can echo a wrong id) — ignore it.
2. **Read back real geometry** with ONE `gJsonCache` probe. Every component's pins are in
   `schlib.<gid>.pin.<pinid>.configure.x/y` (+ `rotation`, `spicePin`). Collect head coords,
   pin coords and pin labels (+/−/1/2/3) for all parts. Use these numbers for wiring — not the
   requested place coords.
3. **Plan rails as orthogonal polylines.** Decide, per net, an axis-aligned path that only
   passes through the intended pin coordinates. Keep + and − rails on separate rows/columns so
   they never cross. For a switch, its pins lie on a row — reach the target pin from its own
   column and never straddle a neighbour pin.
4. **Wire each rail with ONE call** — `easyeda-std_add_wire` with `points=[[x,y],...]` (or
   `cc.hooks.importShape` with a single `c_etype="wire"` polyline). Wire endpoints land ON a pin
   → connected by shared coords; a wire passing THROUGH a pin → the editor auto-creates a
   junction dot. That is correct and intended.
5. **Verify junctions.** Read `gJsonCache.junction` — junction coords must EXACTLY equal your
   intended tap points and nothing else. A junction on a pin you meant to leave floating means a
   short (see the switch trap in §4b). Verify `schlib` still contains every placed part and the
   `wire` section holds every rail.
6. **Fix a mistake** by deleting the offending wire (`deleteObjs` with the real DOM node — it
   removes its junctions too), re-importing the corrected polyline, and re-running step 5. Do
   NOT call `jsonMgr_calAll` / `updateJsonCache` / `drawShape` (§4b DANGER).

**Worked reference — CR2032 bed lamp (4 parts, 3 wires).** Layout produced by placing at
(1500,900), (1750,900), (1750,1100), (1600,1140) and reading back:

| Ref | Part (LCSC) | gId | Head | Pins |
|-----|-------------|-----|------|------|
| BT1 | Keystone 1025 (C238060) | gge11483 | (1896,1200) | `+`(1876,1200) `−`(1916,1200) |
| SW1 | SPDT slide 12D18G4 (C49023767) | gge11632 | (1996,1440) | pin1(1976,1460) pin2/com(1996,1460) pin3(2016,1460) |
| LED1 | LED0805 white (C110099) | gge11405 | (2146,1195) | `−`(2126,1195) `+`(2166,1195) |
| LED2 | LED0805 white (C110099) | gge11552 | (2146,1395) | `−`(2126,1395) `+`(2166,1395) |

Three rail polylines (this is the whole circuit):

```javascript
// BT+ -> switch throw pin1  (one rail, lands only on pin1)
add_wire points=[[1876,1200],[1876,1460],[1976,1460]]
// switch common pin2 -> LED1+/LED2+ (+ rail, routed BELOW the switch so pin3 stays open)
add_wire points=[[1996,1460],[1996,1500],[2166,1500],[2166,1395],[2166,1195]]
// BT- -> LED1-/LED2- (- rail)
add_wire points=[[1916,1200],[1916,1100],[2126,1100],[2126,1195],[2126,1395]]
```

Resulting junctions — the ONLY 2: (2126,1195) [LED1−] and (2166,1395) [LED2+, a pass-through on
the + rail]. Nothing on SW pin1/pin2/pin3 (1976/1996/2016,1460) — the switch throws and common
stay clean, so the SPDT genuinely opens/closes the lamp. If any switch pin shows a junction, a
rail is straddling it and shorting both throws to the LED rail.

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

### 6. `run_batch(operations)`

Executes a list of operations **in order** with a single round-trip. Operations run
sequentially inside the browser — each one waits for completion before the next starts.
Use this for multi-step designs (place components, then wire them, then rename nets)
instead of issuing many individual tool calls.

**Parameters:**
- `operations`: JSON array of operation objects, each `{"action": "...", "args": {...}}`.
  `action` accepts either the MCP tool name (`place_component`, `add_wire`, `add_line`,
  `update_net_name`, `move_component`, `move_components`, `get_canvas_source`,
  `search_lcsc_component`, `eval_browser_js`) or the raw bridge action (`PLACE_LCSC`,
  `ADD_WIRE`, `ADD_LINE`, `UPDATE_NET_NAME`, `MOVE_OBJS_TO`, `MOVE_OBJS`, `GET_SOURCE`,
  `SEARCH_LCSC`, `EXEC_JS`). `args` holds that operation's parameters (using the MCP
  tool parameter names). `add_wire` / `ADD_WIRE` creates REAL wires via the editor's
  `importShape` hook (`c_etype="wire"`), so it is electrically connected.

**Returns:** Array of per-operation results in the **same order** as the input
operations:
```json
{
  "results": [
    { "status": "success", "data": { "placed": true, "id": "gge5", "gId": "gge5" } },
    { "status": "success", "data": { "placed": true, "id": "gge6", "gId": "gge6" } },
    { "status": "error", "error": "missing gid or net_name" }
  ]
}
```

If one operation fails, the remaining operations still execute (no rollback). Large
async operations (component placement, LCSC search, `eval_browser_js` promises) keep
their own per-op completion; the result slot for that operation is written exactly when
that operation settles, so results never shift order. Responses that arrive after an
operation already timed out are dropped and never leak into the batch reply.

Each operation has a 30 s safety timeout; a hung operation is recorded as an error and
the batch continues.

**Example:**
```json
{
  "operations": [
    { "action": "place_component", "args": { "lcsc_id": "C123302", "x": 200, "y": 200 } },
    { "action": "place_component", "args": { "lcsc_id": "C123302", "x": 500, "y": 200 } },
    { "action": "add_wire", "args": { "points": [[250, 200], [450, 200]] } },
    { "action": "update_net_name", "args": { "gid": "gge5", "net_name": "VCC" } }
  ]
}
```

### 7. `move_component(gid, x, y)` / `move_components(gids, dx, dy)`

Moves one or more components on the schematic/PCB canvas.

**`move_component(gid, x, y)`** — absolute move of a single component to canvas
position `(x, y)`.
- `gid`: Global ID of the shape (e.g. `"gge5"`).
- `x, y`: Target coordinates in internal pixels (1 px = 10 mil = 0.254 mm), absolute to
  the canvas origin (top-left of the editor).

**`move_components(gids, dx, dy)`** — relative move of one or more components by an
offset.
- `gids`: Array of gIds to move together.
- `dx, dy`: Offsets in internal pixels (positive = right/down).

**Internal API calls:**
```javascript
// Absolute (single or multiple shapes), native api('moveObjsTo')
api('moveObjsTo', { objs: [{ gId: 'gge5' }], x: 200, y: 200 });

// Relative (one or more shapes), native api('moveObjs')
api('moveObjs', { objs: [{ gId: 'gge5' }, { gId: 'gge6' }], addX: 20, addY: -10 });
```

Coordinates are always canvas pixels, NOT the schematic origin cross — read
`get_canvas_source` first if you need the current shape position before moving.

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
| `api("moveObjs", {objs:[{gId:"gge1"}], addX:20, addY:20})` | Move shapes by relative offset (array of `{gId}` or plain gId strings) |
| `api("moveObjsTo", {objs:[{gId:"gge1"}], x:200, y:200})` | Move shapes to absolute canvas position |
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
1. Place all components first, then get canvas source / gJsonCache to find
   the EXACT pin coordinates (schlib.<gid>.pin.<pinid>.configure.x/y)
2. Wire with easyeda-std_add_wire, passing a points=[[x,y],...] list per
   rail (or eval_browser_js + cc.hooks.importShape) — see section 4 / 4b.
3. Verify junctions in the gJsonCache "junction" section match the intended
   tap points, and that no unintended pin got shorted into a rail.
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
