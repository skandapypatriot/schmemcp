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


async def _send_to_browser(action: str, args: Dict[str, Any]) -> Any:
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
        result = await asyncio.wait_for(future, timeout=60.0)
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
