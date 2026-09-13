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
  if (_batch) { _batchRecord('success', data, null); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ req_id: reqId, status: 'success', data: data }));
  } catch (e) {
    log('Send error: ' + e.message);
  }
}

function sendError(reqId, errorMsg) {
  if (_batch) { _batchRecord('error', null, errorMsg); return; }
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

var LCSC_LOOKUP_URL = 'https://easyeda.com/api/products/CODE/components?version=6.4.19.5';

function handlePlaceLcsc(msg) {
  var args = msg.args || {};
  var code = args.lcscPartNumber;
  var posX = args.x;
  var posY = args.y;
  log('PLACE_LCSC: ' + safeStr(args));

  if (!code) { sendError(msg.req_id, 'missing lcscPartNumber'); return; }

  var url = LCSC_LOOKUP_URL.replace('CODE', encodeURIComponent(code));
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(j) {
      var res = j && j.result;
      if (!j || j.success !== true || !res) {
        sendError(msg.req_id, 'LCSC lookup failed for ' + code + ': ' + safeStr(j).substring(0, 300));
        return;
      }
      if (!res.uuid || !res.datastrid) {
        sendError(msg.req_id, 'LCSC lookup returned no uuid/datastrid for ' + code + ': ' + safeStr(res).substring(0, 300));
        return;
      }
      log('LCSC lookup OK for ' + code + ' uuid=' + res.uuid + ' datastrid=' + res.datastrid);
      placeLibShape(msg.req_id, code, res.uuid, res.datastrid, posX, posY);
    })
    .catch(function(err) {
      sendError(msg.req_id, 'LCSC fetch failed: ' + (err && err.message || err));
    });
}

function placeLibShape(reqId, code, uuid, datastrid, x, y) {
  var before, beforeKeys = [];
  try { before = api('getSource', { type: 'json' }); } catch (e) { before = null; }
  if (before && before.schlib) beforeKeys = Object.keys(before.schlib);

  var ret;
  try {
    ret = api('createShape', {
      shapeType: 'schlib',
      uuid: uuid,
      datastrid: datastrid,
      from: 'system',
      title: code,
      x: x,
      y: y
    });
  } catch (e) {
    sendError(reqId, 'createShape threw: ' + e.message);
    return;
  }
  log('createShape issued for ' + code + ', ret=' + safeStr(ret) + ', waiting for shape...');

  var attempts = 0;
  var timer = setInterval(function() {
    attempts++;
    var after, afterKeys = [];
    try { after = api('getSource', { type: 'json' }); } catch (e) { after = null; }
    if (after && after.schlib) afterKeys = Object.keys(after.schlib);
    var added = afterKeys.filter(function(k) { return beforeKeys.indexOf(k) === -1; });
    if (added.length) {
      clearInterval(timer);
      log('createShape placed gId=' + added[0]);
      sendResponse(reqId, { placed: true, id: added[0], gId: added[0] });
      return;
    }
    if (attempts >= 20) {
      clearInterval(timer);
      sendError(reqId, 'createShape issued but no new shape appeared within 10s');
    }
  }, 500);
}

function handleGetSource(msg) {
  var args = msg.args || {};
  var sourceType = args.type || 'json';
  log('GET_SOURCE type=' + sourceType);
  try {
    var src = api('getSource', { type: sourceType });
    sendResponse(msg.req_id, src);
  } catch (e) {
    sendError(msg.req_id, 'getSource threw: ' + e.message);
  }
}

function handleSearchLcsc(msg) {
  var args = msg.args || {};
  var query = args.query;
  log('SEARCH_LCSC query=' + query);
  if (!query) { sendError(msg.req_id, 'missing query'); return; }

  fetch('/api/components/search', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wd: query })
  })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      log('SEARCH_LCSC result keys: ' + Object.keys(j).join(','));
      sendResponse(msg.req_id, j.result || j);
    })
    .catch(function(err) {
      sendError(msg.req_id, 'search fetch failed: ' + (err && err.message || err));
    });
}

function nextGid(src) {
  var max = 0, match;
  var scan = function(obj) {
    if (!obj || typeof obj !== 'object') return obj === undefined;
    if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) scan(obj[i]); return obj === undefined; }
    for (var k in obj) {
      if (typeof k === 'string' && (match = /^gge(\d+)$/.exec(k))) {
        var n = parseInt(match[1], 10);
        if (n > max) max = n;
      }
      scan(obj[k]);
    }
    return obj === undefined;
  };
  scan(src);
  return 'gge' + (max + 1);
}

function _editorFrame() {
  var frames = document.querySelectorAll('iframe');
  for (var i = 0; i < frames.length; i++) {
    var w = frames[i].contentWindow;
    try {
      if (w && w.callCommand && w.callCommand.hooks && w.callCommand.hooks.importShape) {
        return w;
      }
    } catch (e) { /* cross-origin frames are skipped */ }
  }
  return null;
}

function nextWireId(src) {
  var max = 0, m;
  var scan = function(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) scan(obj[i]); return; }
    for (var k in obj) {
      if (typeof k === 'string' && (m = /^gge_wire(\d+)$/.exec(k))) {
        var n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
      scan(obj[k]);
    }
  };
  scan(src);
  return 'gge_wire' + (max + 1);
}

function handleAddWire(msg) {
  var args = msg.args || {};
  log('ADD_WIRE ' + safeStr(args).substring(0, 300));

  var pts = null;
  if (Array.isArray(args.points) && args.points.length >= 2) {
    pts = args.points.map(function(p) {
      if (Array.isArray(p)) return { x: p[0], y: p[1] };
      return { x: p.x, y: p.y };
    });
  } else if (args.x1 !== undefined && args.y1 !== undefined &&
             args.x2 !== undefined && args.y2 !== undefined) {
    pts = [{ x: args.x1, y: args.y1 }, { x: args.x2, y: args.y2 }];
  } else {
    sendError(msg.req_id, 'missing points: pass points=[[x,y],...]/{x,y} array or x1/y1/x2/y2');
    return;
  }

  for (var i = 0; i < pts.length; i++) {
    if (typeof pts[i].x !== 'number' || typeof pts[i].y !== 'number') {
      sendError(msg.req_id, 'all points must have numeric x and y');
      return;
    }
  }

  try {
    var w = _editorFrame();
    if (!w) {
      sendError(msg.req_id, 'editor frame with callCommand.hooks.importShape not found');
      return;
    }
    var cc = w.callCommand;

    var src = api('getSource', { type: 'json', compress: false });
    var gid = nextWireId(src);
    var ptsStr = pts.map(function(p) { return p.x + ',' + p.y; }).join(' ');
    var svg = '<polyline points="' + ptsStr + '" stroke="#008800" stroke-width="1" fill="none" c_shapetype="line" c_etype="wire" id="' + gid + '" locked="0"/>';

    cc.hooks.importShape.call(w, svg, {});
    log('ADD_WIRE importShape issued gId=' + gid);

    var after = api('getSource', { type: 'json', compress: false });
    var wireObj = after.wire && after.wire[gid];
    if (wireObj) {
      sendResponse(msg.req_id, { placed: true, id: gid, gId: gid, pointArr: wireObj.pointArr, wire: true });
    } else {
      sendResponse(msg.req_id, { placed: true, id: gid, gId: gid, note: 'wire imported but not found in wire container' });
    }
  } catch (e) {
    log('ADD_WIRE error: ' + e.stack);
    sendError(msg.req_id, 'add wire threw: ' + e.message);
  }
}

function handleAddLine(msg) {
  var args = msg.args || {};
  var x1 = args.x1, y1 = args.y1, x2 = args.x2, y2 = args.y2;
  var strokeColor = args.strokeColor || '#00FF00';
  var strokeWidth = args.strokeWidth || 1;
  log('ADD_LINE ' + x1 + ',' + y1 + ' -> ' + x2 + ',' + y2);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    sendError(msg.req_id, 'missing x1/y1/x2/y2');
    return;
  }
  try {
    var src = api('getSource', { type: 'json', compress: false });
    var gid = nextGid(src);

    var ret = api('createShape', {
      shapeType: 'line',
      jsonCache: {
        gId: gid,
        x1: x1,
        y1: y1,
        x2: x2,
        y2: y2,
        strokeColor: strokeColor,
        strokeWidth: strokeWidth,
        strokeStyle: 'solid'
      }
    });
    log('ADD_LINE createShape issued gId=' + gid + ' ret=' + safeStr(ret));

    var after = api('getSource', { type: 'json', compress: false });
    var lineObj = after.line && after.line[gid];
    if (lineObj) {
      sendResponse(msg.req_id, { placed: true, id: gid, gId: gid });
    } else {
      sendResponse(msg.req_id, { placed: true, id: gid, gId: gid, note: 'line issued but not found in line container' });
    }
  } catch (e) {
    log('ADD_LINE error: ' + e.stack);
    sendError(msg.req_id, 'add line threw: ' + e.message);
  }
}

function handleUpdateNetName(msg) {
  var args = msg.args || {};
  var gid = args.gid;
  var netName = args.net_name;
  log('UPDATE_NET_NAME gid=' + gid + ' net=' + netName);
  if (!gid || !netName) { sendError(msg.req_id, 'missing gid or net_name'); return; }
  try {
    var ret = api('updateShape', {
      shapeType: 'PAD',
      jsonCache: { gId: gid, net: netName }
    });
    log('UPDATE_NET_NAME updateShape ret=' + safeStr(ret));
    sendResponse(msg.req_id, { updated: true, gid: gid, net: netName, ret: ret });
  } catch (e) {
    sendError(msg.req_id, 'updateShape threw: ' + e.message);
  }
}

function handleMoveObjsTo(msg) {
  var args = msg.args || {};
  var gids = Array.isArray(args.gids) ? args.gids
           : (args.gid !== undefined ? [args.gid] : []);
  var x = args.x, y = args.y;
  log('MOVE_OBJS_TO gids=' + safeStr(gids) + ' x=' + x + ' y=' + y);
  if (!gids.length || x === undefined || y === undefined) {
    sendError(msg.req_id, 'missing gids or x/y');
    return;
  }
  try {
    var ret = api('moveObjsTo', {
      objs: gids.map(function(g) { return { gId: g }; }),
      x: x,
      y: y
    });
    log('MOVE_OBJS_TO ret=' + safeStr(ret));
    sendResponse(msg.req_id, { moved: true, gids: gids, x: x, y: y, ret: ret });
  } catch (e) {
    sendError(msg.req_id, 'moveObjsTo threw: ' + e.message);
  }
}

function handleMoveObjs(msg) {
  var args = msg.args || {};
  var gids = args.gids || [];
  var dx = args.dx !== undefined ? args.dx : 0;
  var dy = args.dy !== undefined ? args.dy : 0;
  log('MOVE_OBJS gids=' + safeStr(gids) + ' dx=' + dx + ' dy=' + dy);
  if (!Array.isArray(gids) || !gids.length) {
    sendError(msg.req_id, 'missing gids');
    return;
  }
  if (dx === 0 && dy === 0) {
    sendError(msg.req_id, 'nothing to move: dx=0 and dy=0');
    return;
  }
  try {
    var ret = api('moveObjs', {
      objs: gids.map(function(g) { return { gId: g }; }),
      addX: dx,
      addY: dy
    });
    log('MOVE_OBJS ret=' + safeStr(ret));
    sendResponse(msg.req_id, { moved: true, gids: gids, dx: dx, dy: dy, ret: ret });
  } catch (e) {
    sendError(msg.req_id, 'moveObjs threw: ' + e.message);
  }
}

var ACTION_ALIASES = {
  'PLACE_LCSC': 'PLACE_LCSC', 'place_component': 'PLACE_LCSC',
  'EXEC_JS': 'EXEC_JS', 'eval_browser_js': 'EXEC_JS',
  'GET_SOURCE': 'GET_SOURCE', 'get_canvas_source': 'GET_SOURCE',
  'SEARCH_LCSC': 'SEARCH_LCSC', 'search_lcsc_component': 'SEARCH_LCSC',
  'ADD_WIRE': 'ADD_WIRE', 'add_wire': 'ADD_WIRE',
  'ADD_LINE': 'ADD_LINE', 'add_line': 'ADD_LINE',
  'UPDATE_NET_NAME': 'UPDATE_NET_NAME', 'update_net_name': 'UPDATE_NET_NAME',
  'MOVE_OBJS_TO': 'MOVE_OBJS_TO', 'move_component': 'MOVE_OBJS_TO',
  'MOVE_OBJS': 'MOVE_OBJS', 'move_components': 'MOVE_OBJS'
};

var BATCH_OP_TIMEOUT_MS = 30000;
var _batch = null;

function dispatch(msg) {
  var action = msg.action && ACTION_ALIASES[msg.action];
  if (!action) {
    sendError(msg.req_id, 'unknown action: ' + msg.action);
    return;
  }
  if (action === 'PLACE_LCSC')       handlePlaceLcsc(msg);
  else if (action === 'EXEC_JS')     handleExecJs(msg);
  else if (action === 'GET_SOURCE')  handleGetSource(msg);
  else if (action === 'SEARCH_LCSC') handleSearchLcsc(msg);
  else if (action === 'ADD_WIRE')    handleAddWire(msg);
  else if (action === 'ADD_LINE')    handleAddLine(msg);
  else if (action === 'UPDATE_NET_NAME') handleUpdateNetName(msg);
  else if (action === 'MOVE_OBJS_TO')   handleMoveObjsTo(msg);
  else if (action === 'MOVE_OBJS')      handleMoveObjs(msg);
}

function handleBatch(msg) {
  var ops = (msg.args && msg.args.operations) || [];
  log('BATCH: ' + ops.length + ' operation(s)');
  if (!ops.length) {
    sendResponse(msg.req_id, { results: [] });
    return;
  }
  _batch = { reqId: msg.req_id, ops: ops, results: new Array(ops.length), index: -1, opIndex: -1, timer: null };
  _batchNext();
}

function _batchClearTimer() {
  if (_batch && _batch.timer) {
    clearTimeout(_batch.timer);
    _batch.timer = null;
  }
}

// Record the result of the currently running batch op. Returns true when the
// response completed a batch op (result stored in its slot, next op started).
// Returns false when there is no active batch or the response is stale, i.e.
// it belongs to an op that already finished or timed out - in that case it is
// dropped so it can never corrupt the batch results nor leak a stray reply.
function _batchRecord(status, data, error) {
  if (!_batch) return false;
  var idx = _batch.opIndex;
  if (idx === -1 || idx !== _batch.index) return false;
  _batchClearTimer();
  _batch.results[idx] = (status === 'success')
    ? { status: 'success', data: data }
    : { status: 'error', error: String(error) };
  _batchNext();
  return true;
}

function _batchNext() {
  if (!_batch) return;
  _batchClearTimer();
  _batch.index++;
  if (_batch.index >= _batch.ops.length) {
    var results = _batch.results;
    var reqId = _batch.reqId;
    _batch = null;
    sendResponse(reqId, { results: results });
    return;
  }
  var op = _batch.ops[_batch.index];
  var subMsg = { req_id: _batch.reqId, action: op.action, args: op.args || {} };
  _batch.opIndex = _batch.index;
  log('BATCH #' + (_batch.index + 1) + '/' + _batch.ops.length + ': ' + op.action + ' ' + safeStr(op.args).substring(0, 200));
  _batch.timer = setTimeout(function() {
    if (!_batch || _batch.opIndex !== _batch.index) return;
    _batch.results[_batch.index] = { status: 'error', error: 'batch op timeout after ' + (BATCH_OP_TIMEOUT_MS / 1000) + 's: ' + op.action };
    _batchNext();
  }, BATCH_OP_TIMEOUT_MS);
  dispatch(subMsg);
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

    if (!msg || !msg.req_id || !msg.action) return;
    if (msg.action === 'BATCH') {
      handleBatch(msg);
    } else {
      dispatch(msg);
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
