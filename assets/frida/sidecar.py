#!/usr/bin/env python3
"""manos network-capture + mocking sidecar.

Attaches Frida to a (debuggable) app, injects the OkHttp hook, appends each
captured request/response to a JSONL file, and (if --mocks is given) injects the
initial mock rules and hot-reloads them: when the rules file changes, the new
rules are posted to the running script with no re-injection.
"""
import argparse
import json
import os
import signal
import sys
import time

import frida


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", required=True)
    ap.add_argument("--pid", type=int, help="attach to a running pid")
    ap.add_argument("--spawn", help="package id to spawn (catches startup traffic)")
    ap.add_argument("--hook", required=True, help="path to okhttp-capture.js")
    ap.add_argument("--filter", default="", help="URL regex; empty = all")
    ap.add_argument("--mocks", default="", help="path to mock-rules JSON file (hot-reloaded)")
    ap.add_argument("--out", required=True, help="JSONL output path")
    args = ap.parse_args()

    def read_mocks():
        if not args.mocks:
            return []
        try:
            with open(args.mocks) as f:
                return json.load(f)
        except Exception:
            return []

    dev = frida.get_device(args.device)
    hook_src = (
        open(args.hook)
        .read()
        .replace("__FILTER__", json.dumps(args.filter or ""))
        .replace("__MOCKS__", json.dumps(read_mocks()))
    )

    spawned = False
    pid = args.pid
    if args.spawn and not pid:
        pid = dev.spawn([args.spawn])
        spawned = True

    session = dev.attach(pid)
    script = session.create_script(hook_src)
    out = open(args.out, "a", buffering=1)  # line-buffered
    last = {"sig": None}

    def on_message(msg, data):
        if msg.get("type") == "error":
            out.write(json.dumps({"k": "error", "ts": time.time(),
                                  "desc": msg.get("description")}) + "\n")
            return
        p = msg.get("payload")
        if not isinstance(p, dict):
            return
        k = p.get("k")
        if k in ("info", "ready"):
            sys.stderr.write("[sidecar] " + json.dumps(p) + "\n")
            sys.stderr.flush()
            return
        p["ts"] = time.time()
        # Response.Builder.build fires once per interceptor wrap — collapse the
        # immediate duplicates so the agent sees one record per exchange.
        if k == "res":
            sig = (p.get("method"), p.get("url"), p.get("code"), len(p.get("body") or ""))
            if sig == last["sig"]:
                return
            last["sig"] = sig
        out.write(json.dumps(p) + "\n")

    script.on("message", on_message)
    script.load()
    if spawned:
        dev.resume(pid)
    sys.stderr.write("[sidecar] attached pid=%s spawn=%s mocks=%s\n" % (pid, spawned, bool(args.mocks)))
    sys.stderr.flush()

    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    # Hot-reload mock rules: watch the file's mtime and push updates.
    mtime = None
    try:
        while True:
            if args.mocks:
                try:
                    m = os.path.getmtime(args.mocks)
                except OSError:
                    m = None
                if m != mtime:
                    mtime = m
                    script.post({"type": "mocks", "rules": read_mocks()})
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
