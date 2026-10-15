import Foundation
import Darwin

@main
struct SnapshotTests {
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
    }

    static func main() throws {
        // The runner supplies a dedicated bundle fixture. Never fall back to the
        // actual user's display cache while testing the reader.
        guard let file = SnapshotReader.cacheURL,
              file.path.hasPrefix("/private/tmp/xipu-widget-smoke-tests-"),
              file.lastPathComponent == "snapshot.json" else {
            fatalError("Tests require an isolated /private/tmp bundle fixture")
        }
        expect(geteuid() != 0, "Run widget tests without sudo so permission-denied checks are meaningful")

        let json = #"{"version":1,"courses":[{"id":"c1","name":"软件工程","shortName":"CSE201","url":"https://example.invalid/course/1"},{"id":"c2","name":"线性代数","shortName":""},{"id":"c3","name":"课程全名"}],"deadlines":[{"id":"b","courseId":"c1","name":"中文课程项目长标题提交","at":"2026-10-14T16:00:00.000Z","kind":"assignment_due","timezone":"Asia/Shanghai","url":"https://example.invalid/assignment/1","source":"moodle","observedAt":"2026-10-14T10:00:00.000Z"},{"id":"a","courseId":"c1","name":"习题","at":"2026-10-14T16:00:00Z"},{"id":"later","courseId":"c2","name":"课程论文","at":"2026-10-15T10:00:00+08:00"},{"id":"past","courseId":"c1","name":"已到期","at":"2026-10-14T10:00:00.000Z"},{"id":"bad","courseId":"c1","name":"无效日期","at":"invalid"}],"lastSuccessfulSyncAt":"2026-10-14T10:00:00.000Z","connectionState":"connected","warnings":[]}"#
        let bytes = Data(json.utf8)
        let snapshot = try JSONDecoder().decode(DeadlineSnapshot.self, from: bytes)
        let now = SnapshotReader.parseDate("2026-10-14T10:00:00Z")!
        let midnight = SnapshotReader.parseDate("2026-10-14T16:00:00.000Z")!

        expect(snapshot.upcoming(at: now).map { $0.id } == ["a", "b", "later"], "Sort by due time and ID; remove invalid and expired dates")
        expect(snapshot.upcoming(at: midnight).map { $0.id } == ["later"], "Deadlines disappear exactly at their due time")
        expect(SnapshotReader.parseDate("2026-10-15T00:00:00+08:00") == midnight, "Parse ISO time-zone offsets and fractional seconds consistently")
        expect(SnapshotReader.parseDate("invalid") == nil, "Reject an invalid date")
        expect(snapshot.courseName("c1") == "CSE201", "Prefer the course short name")
        expect(snapshot.courseName("c2") == "线性代数" && snapshot.courseName("c3") == "课程全名", "Empty or missing short names use the full name")
        expect(snapshot.courseName("unknown") == "unknown", "Unknown courses retain their ID")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        expect(calendar.component(.day, from: midnight) == 15 && calendar.component(.hour, from: midnight) == 0, "Use Shanghai midnight regardless of the host time zone")

        let missing = SnapshotReader.read()
        expect(!missing.readFailed && missing.snapshot.connectionState == "unconfigured", "Missing cache is an unconfigured state")
        try bytes.write(to: file, options: .atomic)
        let valid = SnapshotReader.read()
        expect(!valid.readFailed && valid.snapshot.deadlines.count == 5, "Read a compatible public snapshot, ignoring extra public Deadline fields")
        try Data("{broken".utf8).write(to: file)
        expect(SnapshotReader.read().readFailed, "Corrupt JSON is a cache failure")
        try Data().write(to: file)
        expect(SnapshotReader.read().readFailed, "An empty cache is a cache failure")
        try Data(#"{"version":2,"courses":[],"deadlines":[],"connectionState":"unconfigured","warnings":[]}"#.utf8).write(to: file)
        expect(SnapshotReader.read().readFailed, "Reject incompatible snapshot versions")
        try Data(#"{"version":1,"courses":[],"deadlines":[],"connectionState":"unconfigured","warnings":[]}"#.utf8).write(to: file)
        expect(!SnapshotReader.read().readFailed, "A valid empty snapshot may omit the optional last-sync time")
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
        expect(SnapshotReader.read().readFailed, "Permission denial must not be misreported as a missing cache")

        print("Native widget snapshot tests passed: contract, ISO dates, sort/expiry, Shanghai midnight, course names and reader failure states")
    }
}
