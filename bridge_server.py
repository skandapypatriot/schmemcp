import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

import websockets
from mcp.server.mcpserver import MCPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("easyeda_mcp")

mcp = MCPServer(name="EasyEDA Standard Bridge")

_browser_connections: Dict[str, websockets.WebSocketServerProtocol] = {}
_pending_requests: Dict[str, asyncio.Future] = {}


def _generate_req_id() -> str:
    return uuid.uuid4().hex[:12]


async def _send_to_browser(action: str, args: Dict[str, Any], timeout: float = 60.0) -> Any:
    if not _browser_connections:
        raise ConnectionError("EasyEDA browser tab not connected via WebSocket.")

    conn_id = next(iter(_browser_connections))
    ws = _browser_connections[conn_id]
    req_id = _generate_req_id()

    future: asyncio.Future = asyncio.get_event_loop().create_future()
    _pending_requests[req_id] = future

    payload = json.dumps({
        "req_id": req_id,
        "action": action,
        "args": args,
    })

    await ws.send(payload)
    logger.info("Sent to browser: action=%s req_id=%s", action, req_id)

    try:
        result = await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        _pending_requests.pop(req_id, None)
        raise TimeoutError(f"Timed out waiting for browser response (req_id={req_id})")

    return result


async def _handle_ws_message(conn_id: str, message: str) -> None:
    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        logger.warning("Invalid JSON from browser: %s", message[:200])
        return

    req_id = data.get("req_id")
    if req_id and req_id in _pending_requests:
        future = _pending_requests.pop(req_id)
        if not future.done():
            if data.get("status") == "success":
                future.set_result(data.get("data"))
            else:
                error_msg = data.get("error", data.get("message", "Unknown browser error"))
                future.set_exception(RuntimeError(error_msg))


async def _ws_handler(ws: websockets.WebSocketServerProtocol) -> None:
    conn_id = _generate_req_id()
    _browser_connections[conn_id] = ws
    logger.info("Browser connected: %s", conn_id)

    try:
        async for message in ws:
            await _handle_ws_message(conn_id, message)
    except websockets.exceptions.ConnectionClosed:
        logger.info("Browser disconnected: %s", conn_id)
    finally:
        _browser_connections.pop(conn_id, None)
        for req_id, future in list(_pending_requests.items()):
            if not future.done():
                future.set_exception(ConnectionError("Browser disconnected"))
                _pending_requests.pop(req_id, None)


@asynccontextmanager
async def _lifespan(server: MCPServer):
    _ws_server = await websockets.serve(_ws_handler, "localhost", 3579)
    logger.info("WebSocket server listening on ws://localhost:3579")
    try:
        yield
    finally:
        _ws_server.close()
        await _ws_server.wait_closed()


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------

@mcp.tool()
async def place_component(lcsc_id: str, x: float, y: float) -> str:
    """Place an LCSC component on the EasyEDA schematic canvas.

    Args:
        lcsc_id: LCSC part number, e.g. "C123302".
        x: X-coordinate in EasyEDA internal pixels (1 px = 10 mil = 0.254 mm).
        y: Y-coordinate in EasyEDA internal pixels (1 px = 10 mil = 0.254 mm).
    """
    result = await _send_to_browser("PLACE_LCSC", {
        "lcscPartNumber": lcsc_id,
        "x": x,
        "y": y,
    })
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def eval_browser_js(code: str) -> str:
    """Execute JavaScript in the EasyEDA browser context. Use for probing APIs and debugging.

    Args:
        code: JavaScript code to execute.
    """
    result = await _send_to_browser("EXEC_JS", {"code": code})
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def get_canvas_source(type: str = "json") -> str:
    """Retrieve the full active EasyEDA document.

    Args:
        type: Document format - "json" (default), "compress", or "svg".
    """
    result = await _send_to_browser("GET_SOURCE", {"type": type})
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def search_lcsc_component(query: str) -> str:
    """Search the LCSC/EasyEDA parts database by keyword or C-number.

    Args:
        query: Search term (keyword like "NE555" or C-number like "C123302").
    """
    result = await _send_to_browser("SEARCH_LCSC", {"query": query})
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def add_wire(x1: float | None = None, y1: float | None = None,
                   x2: float | None = None, y2: float | None = None,
                   points: list | None = None) -> str:
    """Draw a REAL schematic wire between two points, or along a
    multi-point polyline.

    Uses the editor's importShape hook (c_etype="wire"), so the result is a
    genuine electrically-connected net wire — NOT a cosmetic polyline.

    Args:
        x1: Start X-coordinate in EasyEDA internal pixels (1 px = 10 mil = 0.254 mm).
        y1: Start Y-coordinate.
        x2: End X-coordinate.
        y2: End Y-coordinate.
        points: Optional list of points [[x,y], ...] or [{"x":..,"y":..}, ...]
            to draw ONE polyline with all bends in a single call (much faster
            than many two-point segments). When provided, x1/y1/x2/y2 are
            ignored.
    """
    args = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
    if points is not None:
        args["points"] = points
    result = await _send_to_browser("ADD_WIRE", args)
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def add_line(x1: float, y1: float, x2: float, y2: float,
                   stroke_color: str = "#00FF00", stroke_width: float = 1) -> str:
    """Draw a real line object on the EasyEDA schematic canvas.

    Args:
        x1: Start X-coordinate in EasyEDA internal pixels (1 px = 10 mil = 0.254 mm).
        y1: Start Y-coordinate.
        x2: End X-coordinate.
        y2: End Y-coordinate.
        stroke_color: Line color as hex string, e.g. "#000000".
        stroke_width: Line width in internal pixels, e.g. 1.
    """
    result = await _send_to_browser("ADD_LINE", {
        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
        "strokeColor": stroke_color,
        "strokeWidth": stroke_width,
    })
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def update_net_name(gid: str, net_name: str) -> str:
    """Update the net assignment of a pad or track element.

    Args:
        gid: The gId of the pad/track element (e.g. "gge233_1").
        net_name: New net name to assign (e.g. "VCC", "GND", "3V3").
    """
    result = await _send_to_browser("UPDATE_NET_NAME", {
        "gid": gid,
        "net_name": net_name,
    })
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def move_component(gid: str, x: float, y: float) -> str:
    """Move a component to an absolute position on the EasyEDA schematic canvas.

    Args:
        gid: Global ID of the shape to move (e.g. "gge5").
        x: Target X-coordinate in EasyEDA internal pixels (1 px = 10 mil = 0.254 mm).
        y: Target Y-coordinate in EasyEDA internal pixels.
    """
    result = await _send_to_browser("MOVE_OBJS_TO", {
        "gids": [gid],
        "x": x,
        "y": y,
    })
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def move_components(gids: list, dx: float = 0, dy: float = 0) -> str:
    """Move one or more components by a relative offset on the schematic canvas.

    Args:
        gids: List of gIds to move (each a component id like "gge5").
        dx: Relative X-offset in EasyEDA internal pixels (1 px = 10 mil = 0.254 mm).
        dy: Relative Y-offset in EasyEDA internal pixels.
    """
    result = await _send_to_browser("MOVE_OBJS", {
        "gids": gids,
        "dx": dx,
        "dy": dy,
    })
    return json.dumps({"status": "success", "data": result})


@mcp.tool()
async def run_batch(operations: list) -> str:
    """Execute a sequence of EasyEDA operations in order as a single batch.

    Each operation is a dict: {"action": <action>, "args": {<args>}}.
    Actions may be given as MCP tool names ("place_component", "add_wire",
    "add_line", "update_net_name", "move_component", "move_components",
    "get_canvas_source", "search_lcsc_component", "eval_browser_js") or raw
    bridge actions ("PLACE_LCSC", "ADD_WIRE", "ADD_LINE", "UPDATE_NET_NAME",
    "MOVE_OBJS_TO", "MOVE_OBJS", "GET_SOURCE", "SEARCH_LCSC", "EXEC_JS").

    add_wire / ADD_WIRE creates a REAL wire via the editor's importShape hook
    (c_etype="wire"), so it IS electrically connected — see AGENT_KNOWLEDGE_BASE.md
    section 4b.

    Operations run sequentially inside the browser (waiting for each to
    finish before starting the next). Returns one result per operation in
    order: {"status": "success", "data": ...} or
    {"status": "error", "error": "..."}. A whole batch is a single WebSocket
    round-trip, so it is much faster than repeated individual tool calls.

    Args:
        operations: List of operation dicts to execute in order.
    """
    result = await _send_to_browser("BATCH", {"operations": operations}, timeout=300.0)
    return json.dumps({"status": "success", "data": result})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def run_standalone() -> None:
    """Run only the WebSocket server."""
    logger.info("Starting standalone WebSocket bridge on ws://0.0.0.0:3579")
    server = await websockets.serve(_ws_handler, "0.0.0.0", 3579)
    logger.info("WebSocket server ready. Press Ctrl+C to stop.")
    try:
        await asyncio.Future()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        server.close()
        await server.wait_closed()


async def run_mcp() -> None:
    """Run the full MCP server with WebSocket bridge."""
    logger.info("Starting EasyEDA Standard MCP Bridge Server...")
    async with _lifespan(mcp):
        await mcp.run_stdio_async()


def main() -> None:
    import sys
    if "--standalone" in sys.argv:
        asyncio.run(run_standalone())
    else:
        asyncio.run(run_mcp())


if __name__ == "__main__":
    main()
