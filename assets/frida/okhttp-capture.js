'use strict';
/*
 * manos network capture — Frida OkHttp hook.
 *
 * Captures decrypted HTTP at OkHttp's logical layer, so it works regardless of
 * TLS stack (Conscrypt static BoringSSL), HTTP/2 framing, certificate pinning,
 * or whether the app honors the system proxy. Requires a debuggable build (so
 * okhttp3.* class names are not obfuscated) — exactly the debug-app case.
 *
 * The host sidecar injects a filter by replacing __FILTER__ with a JS regex
 * source string (or "") before loading this script.
 */
var FILTER = __FILTER__;
var rx = FILTER ? new RegExp(FILTER) : null;

function matches(url) {
  return !rx || rx.test(url);
}

function headersToObj(headers) {
  var o = {};
  try {
    var n = headers.size();
    for (var i = 0; i < n; i++) o[headers.name(i)] = headers.value(i);
  } catch (e) {}
  return o;
}

Java.perform(function () {
  // --- Requests: OkHttpClient.newCall is stable across OkHttp 3.x/4.x ---
  try {
    var Client = Java.use('okhttp3.OkHttpClient');
    Client.newCall.implementation = function (request) {
      try {
        var url = request.url().toString();
        if (matches(url)) {
          var reqBody = null;
          try {
            var rb = request.body();
            if (rb !== null) {
              var Buffer = Java.use('okio.Buffer');
              var b = Buffer.$new();
              rb.writeTo(b);
              reqBody = b.readUtf8();
            }
          } catch (e) {}
          send({
            k: 'req',
            method: request.method(),
            url: url,
            headers: headersToObj(request.headers()),
            body: reqBody ? reqBody.substring(0, 8192) : null,
          });
        }
      } catch (e) {}
      return this.newCall(request);
    };
    send({ k: 'info', m: 'hooked OkHttpClient.newCall' });
  } catch (e) {
    send({ k: 'info', m: 'newCall hook failed: ' + e });
  }

  // --- Responses: Response.Builder.build sees request + response together.
  //     OkHttp has already gunzipped the app-level body by this point. ---
  try {
    var RB = Java.use('okhttp3.Response$Builder');
    RB.build.implementation = function () {
      var resp = this.build();
      try {
        var req = resp.request();
        var url = req.url().toString();
        if (matches(url)) {
          var body = null;
          try {
            body = resp.peekBody(65536).string();
          } catch (e) {}
          send({
            k: 'res',
            method: req.method(),
            url: url,
            code: resp.code(),
            headers: headersToObj(resp.headers()),
            body: body ? body.substring(0, 16384) : null,
          });
        }
      } catch (e) {}
      return resp;
    };
    send({ k: 'info', m: 'hooked Response.Builder.build' });
  } catch (e) {
    send({ k: 'info', m: 'Response.Builder hook failed: ' + e });
  }

  send({ k: 'ready', filter: FILTER || null });
});
