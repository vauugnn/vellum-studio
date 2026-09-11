// Framed JSON transport over stdio, byte-identical to the protocol used by
// ig-export-extension-2/automate/native-host.js:
//
//   [uint32 little-endian body length][utf8 JSON body]
//
// The executor (Node) is the client; this binary is the server. Responses carry
// back the `id` they answer. Unsolicited frames (log lines, humanInput events)
// carry a `type` and no `id`.

import Foundation

private let stdoutLock = NSLock()
private let stdoutHandle = FileHandle.standardOutput

/// Write one framed JSON object to stdout. Safe to call from any thread.
func send(_ obj: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
        return
    }
    var len = UInt32(body.count).littleEndian
    var frame = Data(bytes: &len, count: 4)
    frame.append(body)
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    stdoutHandle.write(frame)
}

/// Reply to a command. `id` is echoed so the client can match the promise.
func reply(_ id: Any?, _ fields: [String: Any] = [:]) {
    var obj = fields
    if let id = id { obj["id"] = id }
    send(obj)
}

/// Reply with an error for a command that could not be served.
func replyError(_ id: Any?, _ message: String) {
    reply(id, ["ok": false, "error": message])
}

/// Unsolicited log line. The executor folds these into its own ring buffer so a
/// single log stream covers both processes.
func emitLog(_ level: String, _ msg: String) {
    send(["type": "log", "level": level, "msg": msg])
}

/// Read framed messages from stdin, calling `handler` for each decoded object.
/// Accumulates partial frames — a single read can split or coalesce frames.
func readFrames(_ handler: @escaping ([String: Any]) -> Void) {
    var buffer = Data()
    let bufferLock = NSLock()

    FileHandle.standardInput.readabilityHandler = { fh in
        let chunk = fh.availableData
        if chunk.isEmpty {
            // stdin closed — the executor is gone, so are we.
            exit(0)
        }
        bufferLock.lock()
        buffer.append(chunk)
        var frames: [[String: Any]] = []
        while buffer.count >= 4 {
            let len = buffer.prefix(4).withUnsafeBytes {
                Int($0.loadUnaligned(as: UInt32.self).littleEndian)
            }
            guard buffer.count >= 4 + len else { break }
            let body = buffer.subdata(in: 4 ..< (4 + len))
            buffer.removeSubrange(0 ..< (4 + len))
            if let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                frames.append(obj)
            }
        }
        bufferLock.unlock()
        for f in frames { handler(f) }
    }
}
