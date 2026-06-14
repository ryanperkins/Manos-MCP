// Manos OCR helper — recognizes text in an image via Apple's Vision framework
// and prints JSON: [{text, x, y, width, height, confidence}] in pixel coords
// (top-left origin). Compiled once and cached by core/ocr.ts.
//
//   swiftc vision-ocr.swift -O -o vision-ocr   &&   ./vision-ocr image.png
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write("usage: vision-ocr <image>\n".data(using: .utf8)!)
  exit(2)
}
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("could not load image\n".data(using: .utf8)!)
  exit(3)
}
let W = CGFloat(cg.width), H = CGFloat(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false // UI text — don't autocorrect labels
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([req])
var out: [[String: Any]] = []
for obs in (req.results ?? []) {
  guard let c = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox // normalized, origin bottom-left
  out.append([
    "text": c.string,
    "x": Int((b.minX * W).rounded()),
    "y": Int(((1 - b.maxY) * H).rounded()),
    "width": Int((b.width * W).rounded()),
    "height": Int((b.height * H).rounded()),
    "confidence": c.confidence,
  ])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out))
