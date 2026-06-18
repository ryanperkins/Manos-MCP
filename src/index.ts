export { createServer, serve, SERVER_INFO } from "./server.js";
export { DriverRegistry } from "./drivers/registry.js";
export { AndroidDriver } from "./drivers/android.js";
export { IosDriver } from "./drivers/ios.js";
export * from "./drivers/types.js";
export { auditScreen } from "./core/a11y.js";
export { toCompactJson, toSalientJson, diffScreens, findElements, finalizeScreen } from "./core/hierarchy.js";
export { SessionRecorder } from "./core/session.js";
export { stepsToFlowYaml } from "./core/flow.js";
export { applyConditions, resolveConditions, PRESETS } from "./core/conditions.js";
export { buildReportHtml } from "./core/report.js";
export { normalizeMockRules } from "./core/netcapture.js";
export {
  parseTesseractTsv,
  findOcrText,
  centerOfWord,
  ocrEngine,
  pngPixelSize,
  scaleOcrWords,
} from "./core/ocr.js";
