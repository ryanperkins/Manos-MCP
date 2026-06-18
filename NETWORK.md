# Network capture for debug apps

Goal: let an agent **see and validate the HTTP endpoints a debug app calls** —
filtered to specific endpoints so it isn't flooded — to test and debug API
behavior. This documents how manos does it, and the exploration that led
there (the dead ends are instructive).

## TL;DR

Same four tools, two backends picked by platform:

| Platform | Backend | Why |
| --- | --- | --- |
| **Android** | Frida + OkHttp hook | apps bypass the proxy and pin certs; hook above TLS |
| **iOS Simulator** | mitmproxy + `simctl keychain` CA + macOS proxy | sim shares host net, NSURLSession respects the proxy, CA trust is sim-only |

```
network_start  { device_id, app_id?, filter? }   # filter = URL regex, recorded at the source
network_requests { device_id, filter?, include_body?, include_headers?, limit? }
network_clear  { device_id }
network_stop   { device_id }   # restores the macOS proxy on iOS
```

Both backends emit the same JSONL, so `network_requests` (merge by method+url,
pick the most readable body, filter, limit) is shared.

Verified end-to-end on both: Android captured `GET /v2/search/transient → 200`
with the decoded JSON body (and surfaced a `GET /users/0/favorite-facilities → 401`);
iOS captured simulator HTTPS through the MCP tools with the host proxy restored on stop.

## What we tried, and what each told us

### 1. Proxy (mitmproxy) — works for *some* apps, not all
Set the device proxy (`settings put global http_proxy 10.0.2.2:8080`) and point it
at mitmproxy. For HTTPS you also need the app to trust the proxy's CA.

- **Decryption is feasible for debug builds.** The app's `network_security_config.xml`
  has a `<debug-overrides>` block trusting **user** CA certs — active *only* because
  the build is `android:debuggable=true`. Release builds trust system certs only, which
  is why you can't easily MITM them. (This is the real reason "debug apps are
  inspectable" — it's the app trusting user certs, not an adb feature.)
- **But the app bypassed the proxy.** `ss` showed the app holding TLS connections
  **directly** to the API IPs, never to the proxy. Chrome routed through the proxy fine
  (`GET example.com → 200` captured), so the proxy worked — the app just ignores the
  system proxy (common with Cronet or a custom OkHttp `ProxySelector`).

Conclusion: proxy mode is great for Chrome/web and apps that respect the system
proxy, but can't capture apps that connect directly.

### 2. Frida hooking native `SSL_read`/`SSL_write` — wrong layer here
The classic "SSL bypass" hooks BoringSSL's read/write in `libssl.so`.

- Those symbols **are** exported by the platform `libssl.so`, but the app **never calls
  them** (0 writes captured). The app's TLS goes through **Conscrypt**
  (`libjavacrypto.so`), which **statically links its own BoringSSL** with non-exported
  `SSL_read`/`SSL_write`. Hooking by symbol misses it; you'd need fragile pattern-scanning.
- Even if hooked, the SSL layer carries **HTTP/2 binary frames** (HPACK-compressed),
  not parseable HTTP/1.1 text.

Conclusion: native SSL hooking is the wrong altitude for clean, structured capture.

### 3. Frida hooking OkHttp at the Java layer — the winner ✅
Hook the HTTP client *above* TLS. OkHttp gives the logical request/response, so the
TLS stack, HTTP/2 framing, pinning, and proxy-bypass are all irrelevant.

- A **debuggable** build keeps `okhttp3.*` class names un-obfuscated, so the hook can
  target them by name — the debug-app advantage again.
- Hook points used (stable across OkHttp 3.x/4.x):
  - `okhttp3.OkHttpClient.newCall(Request)` → one record per request (method, URL,
    headers, body).
  - `okhttp3.Response$Builder.build()` → status + response body (already gunzipped by
    OkHttp at the app layer).
- Note: frida **17** removed the global `Java` bridge; manos's setup uses frida
  **16.x** (where `Java.perform` works out of the box).

This is what's implemented. See [`assets/frida/okhttp-capture.js`](assets/frida/okhttp-capture.js)
and [`assets/frida/sidecar.py`](assets/frida/sidecar.py).

## How the implemented feature works

```
network_start ──► spawn assets/frida/sidecar.py (python + frida module)
                    └─ attach to the app pid (or spawn it for startup traffic)
                    └─ inject okhttp-capture.js with the URL filter baked in
                    └─ append each captured exchange as JSON to a temp file
network_requests ──► read that file, merge req+res per (method,url), pick the most
                     readable body, filter/limit, return compact lines
network_stop ──► SIGTERM the sidecar (Frida detaches)
```

The `filter` (a URL regex) is applied **inside the hook**, so only matching endpoints
are ever recorded — capture is scoped at the source. `network_requests` can filter
again at read time and caps the count, so the agent asks for exactly the endpoints it
cares about.

## iOS Simulator — mitmproxy path

On iOS the situation *inverts* from Android: the simulator shares the Mac's
network stack, **NSURLSession respects the system HTTP proxy**, and the
mitmproxy CA can be trusted **sim-only** with no root. So a proxy works cleanly
where on Android it was useless. `network_start` on an iOS device:

1. **Trust the CA in the sim:** `xcrun simctl keychain <udid> add-root-cert <mitmproxy CA>`.
2. **Point the macOS proxy at mitmproxy:** `networksetup -setsecurewebproxy <service> 127.0.0.1 <port>`
   (and `-setwebproxy`). No `sudo` required. The previous proxy state is saved and
   **restored on `network_stop`** (and best-effort on process exit).
3. **Run `mitmdump`** with the same JSONL addon + URL filter as everything else.

mitmproxy handles HTTP/2 and request/response parsing for free, so the captured
records are clean. Caveat: this temporarily routes *host* HTTP/HTTPS through
mitmproxy while capturing — fine for a capture session, restored on stop.

`app_id` is optional on iOS (the proxy is device-wide; filter by URL instead).
For cert-**pinned** iOS apps, the roadmap is a Frida **NSURLSession** hook —
Frida attaches to simulator app processes directly from the Mac (no jailbreak,
no `frida-server`), the same above-TLS idea as the Android OkHttp hook.

## Mocking responses (iOS) — `network_mock`

Because the iOS path is a real MITM proxy, manos can also **manipulate** responses, not just capture them — the thing test teams usually stand up a separate WireMock/MockServer for. `network_mock` takes a list of rules; each matches requests by `url` (regex) and optional `method`, and applies the **first match**:

- **Synthesize** a response (`status` / `headers` / `body`) — short-circuits the request, so the server is never hit (force a `500`, an empty list, a malformed field, a feature-flag value…).
- **Inject latency** (`delay_ms`) — exercise spinners/timeouts.
- **Override headers** on the live response (`headers` alone, no `status`/`body`).
- **Abort** the request (`abort: true`) — exercise offline/error paths.

Rules are written to a JSON file the mitmproxy addon **re-reads on every request**, so you can add/change/clear mocks live with no proxy restart. Capture keeps logging throughout; mocked exchanges are flagged `"mock": true`. `network_mock` auto-starts the proxy if nothing is capturing yet. `replace: true` (default) replaces all rules; an empty list clears mocking.

```jsonc
// force the search endpoint to return an empty result set
network_mock { device_id, rules: [
  { "url": "v2/search", "method": "GET", "status": 200,
    "headers": { "Content-Type": "application/json" }, "body": "{\"results\":[]}" }
]}
// 1.5s latency + 503 on the same endpoint
{ "url": "v2/search", "status": 503, "delay_ms": 1500 }
// kill a dependency to test the offline path
{ "url": "telemetry\\.example\\.com", "abort": true }
```

iOS only in this version (Android OkHttp mocking is on the roadmap). Field-level JSON patching of *live* responses (change one field, pass the rest through) is also roadmap; today you replace the whole body.

## Setup / prerequisites

1. **Host:** `python3 -m pip install --user 'frida==16.7.19'` (the `frida` Python module).
2. **Device:** download `frida-server` for the device ABI from
   <https://github.com/frida/frida/releases> (match the host version, e.g. 16.7.19),
   then:
   ```bash
   adb push frida-server-16.7.19-android-arm64 /data/local/tmp/frida-server
   adb shell su 0 chmod 755 /data/local/tmp/frida-server
   adb shell su 0 /data/local/tmp/frida-server &   # needs root (emulators have it)
   ```
3. The target app must be a **debuggable** build that uses **OkHttp**.

`network_start` checks both and returns actionable setup hints if either is missing.

**iOS Simulator** needs only **mitmproxy** on the host (`brew install mitmproxy`)
and Xcode's `xcrun`/`simctl` — no Frida, no root.

## Limitations & honest caveats

- **iOS uses the proxy path**, which temporarily routes host traffic and is
  blocked by certificate pinning (a Frida NSURLSession hook is the roadmap for
  pinned iOS apps).
- **Android OkHttp only.** Apps using Cronet or a custom native HTTP client aren't covered by
  the OkHttp hook (Cronet would need native BoringSSL pattern-scanning). Most Android
  apps use OkHttp/Retrofit.
- **Requires root** to run frida-server (fine on emulators; a rooted/dev device
  otherwise).
- **Pinning is a non-issue** at this layer (we're above TLS) — unlike the proxy
  approach, even pinned endpoints (e.g. an auth host) are captured if they go through
  OkHttp.
- Response bodies are best-effort: OkHttp emits both the gzipped wire body and the
  decoded one; manos keeps the most human-readable.

## Roadmap

- iOS support (NSURLSession hook).
- Cronet support (pattern-scan static BoringSSL, or hook Cronet's Java bridge).
- Auto-provision `frida-server` (download + push for the detected ABI) on `network_start`.
- A proxy-mode fallback for non-OkHttp apps that *do* respect the system proxy
  (mitmproxy handles HTTP/2 cleanly there).
