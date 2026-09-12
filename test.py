import json
import subprocess
import sys
import time

PYTHON_EXE = r"C:\Users\casmm\schmemcp\mcpservervenv\Scripts\python.exe"
BRIDGE_SCRIPT = r"C:\Users\casmm\schmemcp\bridge_server.py"

print("==================================================")
print("     EASYEDA MCP DIRECT SUBPROCESS PROBE          ")
print("==================================================")

# 1. Spawn bridge_server.py
print(f"\n[1/3] Launching bridge server using: {PYTHON_EXE}")
try:
    proc = subprocess.Popen(
        [PYTHON_EXE, BRIDGE_SCRIPT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1
    )
    time.sleep(1) # Allow process initialization
except Exception as e:
    print(f"CRITICAL ERROR: Failed to launch subprocess.\n{e}")
    sys.exit(1)

if proc.poll() is not None:
    _, stderr = proc.communicate()
    print("CRITICAL ERROR: Process exited immediately.")
    print(f"Stderr Output:\n{stderr}")
    sys.exit(1)

print(" -> Process launched successfully (PID:", proc.pid, ")")

# 2. Send JSON-RPC initialize request over stdin
init_request = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "test-probe", "version": "1.0.0"}
    }
}

print("\n[2/3] Sending MCP initialize handshake...")
try:
    proc.stdin.write(json.dumps(init_request) + "\n")
    proc.stdin.flush()

    response_line = proc.stdout.readline()
    if response_line:
        data = json.loads(response_line)
        print(" -> Received Handshake Response:")
        print("    Server Info:", data.get("result", {}).get("serverInfo", "N/A"))
        print("    Protocol Version:", data.get("result", {}).get("protocolVersion", "N/A"))
    else:
        print(" -> No response line received.")
except Exception as e:
    print(f"Error during handshake: {e}")

# 3. Clean up
print("\n[3/3] Closing probe connection...")
proc.terminate()
print("\n==================================================")
print("PROBE COMPLETE: Server binary and MCP stdio are working!")
print("==================================================")