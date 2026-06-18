'use strict';
/*
 * manos network capture + mocking — Frida OkHttp hook.
 *
 * Captures decrypted HTTP at OkHttp's logical layer (works regardless of TLS
 * stack, HTTP/2, cert pinning, or proxy bypass; requires a debuggable build so
 * okhttp3.* names are not obfuscated), and optionally MOCKS responses: a rule
 * matching the request URL (+ method) can override status/headers, replace the
 * body, regex-rewrite the live body, and/or inject latency.
 *
 * The host sidecar injects `__FILTER__` (a JS regex source or "") and `__MOCKS__`
 * (the initial rules array) before loading, and posts {type:'mocks',rules} to
 * hot-reload the rules without re-injecting.
 */
var FILTER = __FILTER__;
var rx = FILTER ? new RegExp(FILTER) : null;
var MOCKS = __MOCKS__;

// Hot-reload rules pushed from the sidecar (re-arms itself).
function armRecv() {
  recv('mocks', function (m) {
    MOCKS = (m && m.rules) || [];
    armRecv();
  });
}
armRecv();

function matches(url) {
  return !rx || rx.test(url);
}

function matchRule(url, method) {
  for (var i = 0; i < MOCKS.length; i++) {
    var r = MOCKS[i];
    try {
      if (!new RegExp(r.url).test(url)) continue;
    } catch (e) { continue; }
    if (r.method && ('' + r.method).toUpperCase() !== ('' + method).toUpperCase()) continue;
    return r;
  }
  return null;
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
  var ResponseBody = Java.use('okhttp3.ResponseBody');
  var Thread = Java.use('java.lang.Thread');

  function makeBody(mediaType, str) {
    try { return ResponseBody.create.overload('okhttp3.MediaType', 'java.lang.String').call(ResponseBody, mediaType, str); } catch (e) {}
    try { return ResponseBody.create.overload('java.lang.String', 'okhttp3.MediaType').call(ResponseBody, str, mediaType); } catch (e) {}
    return null;
  }

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
  //     We capture here, and apply response mocks (override/rewrite). ---
  try {
    var RB = Java.use('okhttp3.Response$Builder');
    RB.build.implementation = function () {
      var resp = this.build();
      try {
        var req = resp.request();
        var url = req.url().toString();
        var method = req.method();

        // Mock: skip if we already produced this response (recursion guard).
        if (resp.header('X-Manos-Mock') === null) {
          var rule = matchRule(url, method);
          if (rule) {
            // OkHttp builds a response several times (cache/network shells, then the
            // final body-bearing one). Gate on a readable, non-empty body so we only
            // act on the real response the app consumes — never the empty shells,
            // which would otherwise set the guard and let the real body slip through.
            var cur = null;
            try { cur = resp.peekBody(2000000).string(); } catch (e) { cur = null; }
            if (cur !== null && cur.length > 0) {
              var bodyStr = null;
              if (rule.body !== undefined && rule.body !== null) {
                bodyStr = '' + rule.body; // full replacement
              } else if (rule.rewrite && rule.rewrite.length) {
                var rewritten = cur;
                for (var i = 0; i < rule.rewrite.length; i++) {
                  rewritten = rewritten.replace(new RegExp(rule.rewrite[i].find, 'g'), rule.rewrite[i].replace);
                }
                if (rewritten !== cur) bodyStr = rewritten; // only if it actually changed
              }
              var hasOverride = (rule.status !== undefined && rule.status !== null) || !!rule.headers;
              if (bodyStr !== null || hasOverride) {
                if (rule.delay_ms) { try { Thread.sleep(Math.max(0, rule.delay_ms | 0)); } catch (e) {} }
                var nb = resp.newBuilder().header('X-Manos-Mock', '1');
                if (rule.status !== undefined && rule.status !== null) nb.code(rule.status | 0);
                if (rule.headers) {
                  var ks = Object.keys(rule.headers);
                  for (var j = 0; j < ks.length; j++) nb = nb.header(ks[j], '' + rule.headers[ks[j]]);
                }
                if (bodyStr !== null) {
                  var mt = null; try { mt = resp.body().contentType(); } catch (e) {}
                  var newBody = makeBody(mt, bodyStr);
                  if (newBody !== null) nb.body(newBody);
                }
                var mocked = nb.build();
                send({ k: 'res', method: method, url: url, code: mocked.code(), headers: headersToObj(mocked.headers()), body: bodyStr ? bodyStr.substring(0, 16384) : null, mock: true });
                return mocked;
              }
            }
          }
        }

        // Capture (non-mocked) — OkHttp has already gunzipped the app-level body.
        if (matches(url)) {
          var body = null;
          try { body = resp.peekBody(65536).string(); } catch (e) {}
          send({
            k: 'res',
            method: method,
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

  send({ k: 'ready', filter: FILTER || null, mocks: MOCKS.length });
});
