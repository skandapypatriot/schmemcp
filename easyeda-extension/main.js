// extension-mcpbridge-id
var WS_URL = 'ws://127.0.0.1:3579';
var RECONNECT_MS = 3000;
var ws = null;
var reconnectTimer = null;

function log(msg) {
  console.log('[MCP Bridge] ' + msg);
}

function safeStr(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  var s;
  try { s = JSON.stringify(v); } catch(e) { s = String(v); }
  if (typeof s !== 'string') s = String(s);
  return s;
}

function sendResponse(reqId, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ req_id: reqId, status: 'success', data: data }));
  } catch (e) {
    log('Send error: ' + e.message);
  }
}

function sendError(reqId, errorMsg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ req_id: reqId, status: 'error', error: String(errorMsg) }));
  } catch (e) {
    log('Send error: ' + e.message);
  }
}

function handleExecJs(msg) {
  var code = msg.args ? msg.args.code : msg.code;
  log('EXEC_JS: ' + (code || '').substring(0, 200));

  try {
    var result = eval(code);
    log('EXEC_JS raw result type: ' + typeof result);

    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      log('EXEC_JS result is thenable, waiting...');
      result.then(function(val) {
        log('EXEC_JS resolved: ' + safeStr(val).substring(0, 300));
        sendResponse(msg.req_id, val);
      }).catch(function(err) {
        log('EXEC_JS rejected: ' + (err.message || String(err)));
        sendError(msg.req_id, err.message || String(err));
      });
    } else {
      log('EXEC_JS result: ' + safeStr(result).substring(0, 300));
      sendResponse(msg.req_id, result);
    }
  } catch (e) {
    log('EXEC_JS error: ' + e.message);
    sendError(msg.req_id, e.message);
  }
}

function handlePlaceLcsc(msg) {
  var args = msg.args || {};
  var code = args.lcscPartNumber;
  var posX = args.x;
  var posY = args.y;
  log('PLACE_LCSC: ' + safeStr(args));

  log('Step 1: calling api searchLccComponent for ' + code);
  try {
    api('searchLccComponent', { code: code }, function(result) {
      log('Step 2: searchLccComponent callback fired: ' + safeStr(result).substring(0, 500));
      if (result && result.success && result.data && result.data.jsonStr) {
        var shapeId = 'lcsc_' + code + '_' + Date.now();
        log('Step 3: createShape jsonStr length=' + result.data.jsonStr.length + ' id=' + shapeId);
        try {
          api('createShape', {
            shapeType: 'SCHEMATIC_SYMBOL',
            jsonStr: result.data.jsonStr,
            x: posX,
            y: posY,
            id: shapeId,
          });
          log('Step 4: createShape OK');
          sendResponse(msg.req_id, { placed: true, id: shapeId });
        } catch (e2) {
          log('Step 4: createShape FAILED: ' + e2.message);
          sendError(msg.req_id, 'createShape failed: ' + e2.message);
        }
      } else {
        log('Step 2: no data, full result: ' + safeStr(result).substring(0, 500));
        sendError(msg.req_id, 'searchLccComponent returned no data');
      }
    });
    log('Step 1b: searchLccComponent called (waiting for callback...)');
  } catch (e) {
    log('Step 1: searchLccComponent threw: ' + e.message);
    sendError(msg.req_id, 'searchLccComponent threw: ' + e.message);
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  log('Connecting to ' + WS_URL + '...');
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    log('WebSocket constructor failed: ' + e);
    scheduleReconnect();
    return;
  }

  ws.onopen = function() {
    log('Connected');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onmessage = function(event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    log('Received action=' + msg.action + ' req_id=' + msg.req_id);

    if (msg.action === 'PLACE_LCSC' && msg.req_id) {
      handlePlaceLcsc(msg);
    } else if (msg.action === 'EXEC_JS' && msg.req_id) {
      handleExecJs(msg);
    }
  };

  ws.onclose = function(evt) {
    log('Disconnected code=' + evt.code);
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = function() {
    log('WebSocket error');
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function() { reconnectTimer = null; connect(); }, RECONNECT_MS);
}

log('Extension loaded');
setTimeout(connect, 2000);
