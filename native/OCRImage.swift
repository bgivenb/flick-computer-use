import Foundation
import Vision
import ImageIO

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("Invalid PNG input\n", stderr)
    exit(1)
}

do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    let lines: [[String: Any]] = (request.results ?? []).compactMap { line in
        guard let candidate = line.topCandidates(1).first else { return nil }
        let box = line.boundingBox
        return ["text": candidate.string, "confidence": candidate.confidence,
                "x": box.minX * CGFloat(image.width), "y": (1 - box.maxY) * CGFloat(image.height),
                "width": box.width * CGFloat(image.width), "height": box.height * CGFloat(image.height)]
    }
    let output: [String: Any] = ["width": image.width, "height": image.height, "lines": lines]
    let encoded = try JSONSerialization.data(withJSONObject: output)
    FileHandle.standardOutput.write(encoded)
} catch {
    fputs("OCR failed\n", stderr)
    exit(1)
}
