# Frida response mocking — de-risk findings & build plan

Branch: `feat/network-mock-frida` (off `feat/network-mock-proxy`, so it inherits the backend-agnostic `MockRule` schema, `normalizeMockRules`, and the `network_mock` tool — only the backend changes).

## iOS Simulator: BLOCKED (do not pursue as-is)
Goal was a per-process `NSURLSession` Frida hook to replace the invasive system-wide mitmproxy on iOS. It does not work on the simulator here:
- **Frida 16.x can't attach** to the iOS-26 sim on this macOS: `frida.NotSupportedError: module not found at "/usr/lib/libSystem.B.dylib"`.
- **Frida 17.x attaches** (runs JS in-process) but the **ObjC bridge won't bind**: `ObjC.available === false`. A module probe shows Frida resolving **host** modules for the sim process (`Process.platform="darwin"`, `libobjc.A.dylib -> /usr/lib/libobjc.A.dylib`, `Foundation -> /System/Library/...`), not the simulator's iOS runtime — so even C-level hooks would target the host frameworks, not the app's.
- **Root cause:** Frida's iOS support targets real devices (frida-server / embedded gadget); the simulator presents a host-darwin view the ObjC runtime bridge can't attach to.
- **Viable only via:** embedding `FridaGadget.dylib` into the `.app` + re-signing (a repackage/dependency step that loses the "no app change" benefit), or a physical jailbroken device. iOS stays on the (hardened) mitmproxy path for now.

## Android: PIPELINE PROVEN ✅
- Target must be **rooted** (frida-server needs root). The physical Pixel 9 Pro is not rooted; the **Pixel_3a API 34 (arm64) emulator** is. Confirmed working: emulator booted, `frida-server 16.7.19` pushed to `/data/local/tmp` and run as root, host **frida 16.7.19** enumerates the device's processes.
- **Version pin: 16.7.19** for Android — the existing `okhttp-capture.js` uses the global `Java` bridge, which **Frida 17 removed**. Stay on 16.7.x (host + frida-server matched) to reuse it.

## Build plan (Android OkHttp response mocking)
Extend the capture hook to also mock, reading rules from a file the sidecar passes (same pattern as the URL `--filter`). Reuse the `MockRule` shape (`url` regex, `method`, `status`, `headers`, `body`, `delay_ms`, `abort`).

- **Hook point — short-circuit:** intercept `RealCall.execute()` (sync) and `RealCall.enqueue(Callback)` (async). On a matching rule, build a synthetic `okhttp3.Response` and return it / deliver via the callback **without** calling the real method (true mock — no server hit). For `abort`, throw `java.io.IOException` (sync) or `callback.onFailure(...)` (async). For `delay_ms`, `Thread.sleep` first. Class path differs by version: `okhttp3.RealCall` (3.x) vs `okhttp3.internal.connection.RealCall` (4.x) — resolve whichever is present.
- **Response construction:** `Response$Builder` + `ResponseBody.create(...)` (handle the 3.x `(MediaType,String)` vs 4.x `(String,MediaType)` overload), `.protocol(Protocol.HTTP_1_1)`, `.code()`, `.message()`, `.addHeader()`, `.request(originalRequest)`.
- **Backend wiring:** `setMocks(android)` writes a rules JSON; the sidecar injects it (replace a `__MOCKS__` placeholder like `__FILTER__`, or via Frida `script.post`/RPC for hot-reload). Capture keeps logging; mocked exchanges flagged `mock`.
- **Sidecar python + frida:** the MCP's `python3` needs `frida` importable; PEP 668 blocks a global pip install on this host — use a venv or `--break-system-packages`, and document it (frida-server version must match the host module).

## Test plan (verified)
With a debuggable OkHttp app on the emulator → `network_start` (capture) confirms the OkHttp hook fires under frida-server 16.7.19 → a `network_mock` rule on a JSON endpoint (force empty results / 500 / regex-rewrite a field) → drive to the screen → the client renders the changed state → the capture log flags the exchange `mock`. Confirmed end-to-end on `emulator-5554`: a `rewrite` rule transformed a live search response field-by-field and the app rendered the rewritten payload, with no host-network disruption.
