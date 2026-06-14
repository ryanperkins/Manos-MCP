import { test } from "node:test";
import assert from "node:assert/strict";

const base = new URL("../dist/", import.meta.url).pathname;
const {
  finalizeScreen,
  toCompactJson,
  diffScreens,
  findElements,
  auditScreen,
  stepsToFlowYaml,
  SessionRecorder,
  resolveConditions,
  PRESETS,
  buildReportHtml,
  parseTesseractTsv,
  findOcrText,
  centerOfWord,
} = await import(`${base}index.js`);

function el(overrides) {
  return {
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    children: [],
    ...overrides,
  };
}

function makeScreen(raw, meta = {}) {
  return finalizeScreen(raw, {
    platform: "android",
    deviceId: "test",
    width: 1080,
    height: 1920,
    ...meta,
  });
}

test("finalizeScreen assigns stable, unique ids and flattens", () => {
  const screen = makeScreen([
    el({ cls: "Button", text: "OK", children: [el({ cls: "Button", text: "OK" })] }),
  ]);
  assert.equal(screen.flat.length, 2);
  const ids = screen.flat.map((e) => e.id);
  // Same identity -> base hash collides -> exactly one gets a numeric suffix.
  assert.equal(new Set(ids).size, 2, "ids must be unique");
  assert.equal(ids.filter((id) => id.includes("-")).length, 1);
});

test("stable id ignores volatile digits in text", () => {
  const s1 = makeScreen([el({ cls: "Text", resourceId: "counter", text: "5 items" })]);
  const s2 = makeScreen([el({ cls: "Text", resourceId: "counter", text: "6 items" })]);
  assert.equal(s1.flat[0].id, s2.flat[0].id, "id should be stable despite the number change");
});

test("toCompactJson emits abbreviated keys + bounds tuple", () => {
  const screen = makeScreen([el({ cls: "Button", text: "Login", clickable: true })]);
  const compact = toCompactJson(screen);
  assert.ok(compact.ui_schema);
  const node = compact.elements[0];
  assert.deepEqual(node.b, [0, 0, 100, 100]);
  assert.equal(node.txt, "Login");
  assert.equal(node.clickable, true);
});

test("diffScreens detects added / removed / changed", () => {
  const before = makeScreen([
    el({ resourceId: "a", text: "one" }),
    el({ resourceId: "b", text: "two" }),
  ]);
  const after = makeScreen([
    el({ resourceId: "a", text: "ONE" }), // changed text
    el({ resourceId: "c", text: "three" }), // added (b removed)
  ]);
  const diff = diffScreens(before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.changed.length, 1);
  assert.ok(diff.changed[0].changes.text);
});

test("findElements matches by text substring and resource id", () => {
  const screen = makeScreen([
    el({ text: "Sign in", clickable: true }),
    el({ resourceId: "email", text: "" }),
  ]);
  assert.equal(findElements(screen, { text: "sign" }).length, 1);
  assert.equal(findElements(screen, { resourceId: "email" }).length, 1);
  assert.equal(findElements(screen, { clickableOnly: true }).length, 1);
});

test("auditScreen flags small touch targets and missing labels", () => {
  const screen = makeScreen(
    [
      el({ cls: "Button", clickable: true, bounds: { x: 0, y: 0, width: 20, height: 20 } }), // tiny + unlabeled
      el({ cls: "Button", text: "Fine", clickable: true, bounds: { x: 0, y: 0, width: 200, height: 200 } }),
    ],
    { densityDpi: 160 }, // min target = 48px
  );
  const report = auditScreen(screen);
  const rules = report.findings.map((f) => f.rule);
  assert.ok(rules.includes("touch-target-size"));
  assert.ok(rules.includes("missing-label"));
  assert.equal(report.minTouchTargetPx, 48);
});

test("stepsToFlowYaml emits header, escaping, and bare commands", () => {
  const yaml = stepsToFlowYaml("com.example", [
    { launchApp: { appId: "com.example" } },
    { tapOn: { text: 'He said "hi"' } },
    { back: null },
  ]);
  assert.ok(yaml.startsWith("appId: com.example\n---\n"));
  assert.ok(yaml.includes('text: "He said \\"hi\\""'));
  assert.ok(yaml.includes("\n- back"));
});

test("resolveConditions: explicit overrides win, undefined does not clobber the preset", () => {
  // accessibility preset = { fontScale: 2.0, appearance: "dark" }
  const c = resolveConditions("accessibility", { fontScale: 1.3, appearance: undefined });
  assert.equal(c.fontScale, 1.3, "explicit value overrides preset");
  assert.equal(c.appearance, "dark", "undefined explicit must NOT wipe the preset value");
});

test("resolveConditions: network merges, empty stays undefined", () => {
  const off = resolveConditions("offline", {});
  assert.equal(off.network.airplaneMode, true);
  const none = resolveConditions(undefined, {});
  assert.equal(none.network, undefined);
  assert.ok(PRESETS.screenshot && PRESETS.reset && PRESETS.offline);
});

test("buildReportHtml embeds steps, screenshots, and the flow", () => {
  const html = buildReportHtml({
    appId: "com.example",
    deviceId: "emulator-5554",
    startedAt: "2026-01-01T00:00:00Z",
    steps: [
      { index: 1, at: "2026-01-01T00:00:01Z", description: 'Tapped "Login"', command: { tapOn: { text: "Login" } }, screenshot: "AAAA" },
      { index: 2, at: "2026-01-01T00:00:02Z", description: "Typed hi", command: { inputText: "hi" } },
    ],
    flowYaml: "appId: com.example\n---\n- tapOn:\n    text: \"Login\"",
    logs: "FATAL EXCEPTION: boom",
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("data:image/png;base64,AAAA"));
  assert.ok(html.includes('Tapped &quot;Login&quot;'), "descriptions are HTML-escaped");
  assert.ok(html.includes("flow.yaml"));
  assert.ok(html.includes("FATAL EXCEPTION"));
});

test("parseTesseractTsv extracts word rows with pixel boxes", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t10\t20\t80\t30\t96\tPay",
    "5\t1\t1\t1\t1\t2\t95\t20\t60\t30\t12\tand", // low conf, still parsed
    "4\t1\t1\t1\t1\t0\t0\t0\t0\t0\t-1\t",        // not a word row
  ].join("\n");
  const words = parseTesseractTsv(tsv);
  assert.equal(words.length, 2);
  assert.equal(words[0].text, "Pay");
  assert.deepEqual([words[0].x, words[0].y, words[0].width, words[0].height], [10, 20, 80, 30]);
  assert.equal(words[0].confidence, 0.96);
  assert.deepEqual(centerOfWord(words[0]), { x: 50, y: 35 });
});

test("findOcrText matches substrings and stitches adjacent runs", () => {
  const words = [
    { text: "Pay", x: 10, y: 20, width: 60, height: 30, confidence: 1 },
    { text: "and", x: 75, y: 20, width: 50, height: 30, confidence: 1 },
    { text: "Reserve", x: 130, y: 20, width: 110, height: 30, confidence: 1 },
    { text: "Cancel", x: 10, y: 200, width: 90, height: 30, confidence: 1 },
  ];
  assert.equal(findOcrText(words, "reserve").length, 1); // direct substring
  assert.equal(findOcrText(words, "cancel")[0].text, "Cancel");
  // "Pay and Reserve" spans three runs on one line -> stitched
  const stitched = findOcrText(words, "Pay and Reserve");
  assert.ok(stitched.length >= 1);
  assert.ok(stitched[0].text.toLowerCase().includes("pay and reserve"));
});

test("SessionRecorder records and exports a replayable flow", () => {
  const r = new SessionRecorder();
  r.start("com.example");
  r.record("Tapped Login", { tapOn: { text: "Login" } });
  r.record("Typed hi", { inputText: "hi" });
  r.record("Manual note"); // no command -> not replayable
  const out = r.exportFlow();
  assert.equal(out.stepCount, 3);
  assert.ok(out.yaml.includes("tapOn"));
  assert.ok(out.yaml.includes("inputText"));
  assert.ok(out.markdown.includes("manual / non-replayable"));
});
