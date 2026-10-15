import Foundation
import Darwin

// This deliberately decodes only the public display cache. It never opens App
// settings, sessions, passwords or cookies, even when reading the cache fails.
struct DeadlineSnapshot: Decodable {
    struct Course: Decodable { let id: String; let name: String; let shortName: String? }
    struct Deadline: Decodable, Identifiable {
        let id: String
        let courseId: String
        let name: String
        let at: String
        let kind: String?
        var date: Date? { SnapshotReader.parseDate(at) }
        var kindLabel: String {
            switch kind {
            case "assignment_due": return "作业"
            case "assignment_cutoff": return "停止提交"
            case "quiz_close": return "测验"
            case "calendar": return "日历"
            default: return ""
            }
        }
    }
    let version: Int
    let courses: [Course]
    let deadlines: [Deadline]
    let lastSuccessfulSyncAt: String?
    let connectionState: String
    let warnings: [String]

    func upcoming(at date: Date) -> [Deadline] {
        deadlines.filter { ($0.date ?? .distantPast) > date }.sorted {
            if $0.date == $1.date { return $0.id < $1.id }
            return ($0.date ?? .distantPast) < ($1.date ?? .distantPast)
        }
    }

    func courseName(_ id: String) -> String {
        guard let course = courses.first(where: { $0.id == id }) else { return id }
        return course.shortName.flatMap { $0.isEmpty ? nil : $0 } ?? course.name
    }

    static let empty = DeadlineSnapshot(version: 1, courses: [], deadlines: [],
        lastSuccessfulSyncAt: nil, connectionState: "unconfigured", warnings: [])

    static func preview(at now: Date) -> DeadlineSnapshot {
        let formatter = ISO8601DateFormatter()
        return DeadlineSnapshot(version: 1, courses: [
            Course(id: "preview-cse", name: "软件工程", shortName: "CSE201"),
            Course(id: "preview-mth", name: "线性代数", shortName: "MTH101")
        ], deadlines: (0..<4).map { index in
            Deadline(id: "preview-\(index)", courseId: index % 2 == 0 ? "preview-cse" : "preview-mth",
                name: ["课程项目提交", "习题与练习", "实验报告", "期末课程论文"][index],
                at: formatter.string(from: now.addingTimeInterval(Double(index + 1) * 28_800)),
                kind: ["assignment_due", "calendar", "quiz_close", "assignment_cutoff"][index])
        }, lastSuccessfulSyncAt: formatter.string(from: now), connectionState: "connected", warnings: [])
    }
}

enum SnapshotReader {
    static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static var cacheURL: URL? {
        // NSHomeDirectory() belongs to the extension's sandbox container.
        // getpwuid locates the real user's home, as required by the temporary
        // sandbox read exception. The smoke build uses a separate /private/tmp fixture.
        if let fixture = Bundle.main.object(forInfoDictionaryKey: "XIPUWidgetSmokeSnapshotPath") as? String {
            guard fixture.hasPrefix("/private/tmp/xipu-widget-smoke-") else { return nil }
            return URL(fileURLWithPath: fixture)
        }
        guard let home = getpwuid(getuid())?.pointee.pw_dir else { return nil }
        return URL(fileURLWithPath: String(cString: home), isDirectory: true)
            .appendingPathComponent("Library/Application Support/XIPU MCP/widgets/snapshot.json")
    }

    static func read() -> (snapshot: DeadlineSnapshot, readFailed: Bool) {
        guard let url = cacheURL else { return (.empty, true) }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0 && size <= 2_097_152 else { return (.empty, true) }
            let snapshot = try JSONDecoder().decode(DeadlineSnapshot.self, from: Data(contentsOf: url))
            guard snapshot.version == 1 else { return (.empty, true) }
            return (snapshot, false)
        } catch let error as NSError {
            let missing = (error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError)
                || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT))
            return (.empty, !missing)
        }
    }
}
