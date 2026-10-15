import SwiftUI
import WidgetKit

let deadlineWidgetKind = "XIPUDeadlines"
private let shanghai = TimeZone(identifier: "Asia/Shanghai")!

struct DeadlineEntry: TimelineEntry {
    let date: Date
    let snapshot: DeadlineSnapshot
    let readFailed: Bool
}

struct DeadlineProvider: TimelineProvider {
    func placeholder(in context: Context) -> DeadlineEntry {
        DeadlineEntry(date: Date(), snapshot: .preview(at: Date()), readFailed: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (DeadlineEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        let cache = SnapshotReader.read()
        completion(DeadlineEntry(date: Date(), snapshot: cache.snapshot, readFailed: cache.readFailed))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DeadlineEntry>) -> Void) {
        let now = Date()
        let cache = SnapshotReader.read()
        let end = now.addingTimeInterval(86_400)
        var dates = (0...24).map { now.addingTimeInterval(Double($0) * 3_600) }
        // Remove each expired item at its due time, even while the host is closed.
        dates += cache.snapshot.upcoming(at: now).prefix(64).compactMap { deadline in
            guard let due = deadline.date, due < end else { return nil }
            return due.addingTimeInterval(1)
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = shanghai
        if let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) {
            dates.append(midnight)
        }
        let entries = Array(Set(dates)).sorted().map {
            DeadlineEntry(date: $0, snapshot: cache.snapshot, readFailed: cache.readFailed)
        }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3_600))))
    }
}

private func deadlineURL(id: String? = nil) -> URL {
    var url = URLComponents()
    url.scheme = "xipu-mcp"
    url.host = "deadlines"
    if let id { url.queryItems = [URLQueryItem(name: "id", value: id)] }
    return url.url!
}

struct DeadlineWidgetView: View {
    let entry: DeadlineEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.widgetRenderingMode) private var renderingMode

    private var items: [DeadlineSnapshot.Deadline] {
        Array(entry.snapshot.upcoming(at: entry.date).prefix(family == .systemSmall ? 2 : 4))
    }

    private var footer: String {
        let updated: String? = entry.snapshot.lastSuccessfulSyncAt.flatMap(SnapshotReader.parseDate).map { time in
            let formatter = DateFormatter()
            formatter.timeZone = shanghai
            formatter.dateFormat = "MM/dd HH:mm"
            return formatter.string(from: time)
        }
        func status(_ message: String) -> String { updated.map { "\(message) · \($0)" } ?? message }
        if entry.readFailed { return "缓存不可读 · 打开 App" }
        if entry.snapshot.connectionState == "login_required" { return status("请重新登录") }
        if entry.snapshot.connectionState == "error" { return status("同步失败") }
        if !entry.snapshot.warnings.isEmpty { return status("部分来源不可用") }
        return updated.map { "更新于 \($0)" } ?? "打开 App 连接 Moodle"
    }

    private var emptyText: String {
        if entry.readFailed { return "暂时无法读取 DDL\n打开 App 后刷新" }
        switch entry.snapshot.connectionState {
        case "unconfigured": return "打开 XIPU MCP\n连接 Moodle 后显示 DDL"
        case "login_required": return "打开 XIPU MCP\n重新登录 Moodle"
        case "error": return "暂时无法同步\n打开 App 后重试"
        default: return entry.snapshot.warnings.isEmpty ? "未来 30 天\n暂无明确 DDL" : "部分来源不可用\n打开 App 查看详情"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 7 : 3) {
            HStack(spacing: 5) {
                Image(systemName: "calendar.badge.clock").foregroundStyle(.blue).widgetAccentable()
                Text("DDL").fontWeight(.bold)
                Spacer(minLength: 0)
                Text(headerDate)
                    .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
            }.font(.system(size: 14))

            if items.isEmpty {
                Spacer(minLength: 0)
                Text(emptyText).font(.system(size: 12)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading).lineSpacing(4)
                Spacer(minLength: 0)
            } else {
                ForEach(items) { deadline in
                    if family == .systemSmall {
                        smallRow(deadline)
                    } else {
                        Link(destination: deadlineURL(id: deadline.id)) { mediumRow(deadline) }
                            .buttonStyle(.plain)
                    }
                }
                Spacer(minLength: 0)
            }
            Text(footer).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.8)
        }
        .padding(family == .systemSmall ? 14 : 13)
        .widgetURL(deadlineURL())
        .containerBackground(for: .widget) {
            if renderingMode == .fullColor {
                LinearGradient(colors: colorScheme == .dark
                    ? [Color(red: 0.12, green: 0.17, blue: 0.24), Color(red: 0.10, green: 0.12, blue: 0.16)]
                    : [Color(red: 0.94, green: 0.97, blue: 1), Color.white],
                    startPoint: .topLeading, endPoint: .bottomTrailing)
            } else { Color.clear }
        }
    }

    private func smallRow(_ deadline: DeadlineSnapshot.Deadline) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(entry.snapshot.courseName(deadline.courseId))
                .font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
            Text(deadline.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
            HStack(spacing: 2) {
                Text(dueLabel(deadline)).font(.system(size: 9)).foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 0)
                Text(remaining(deadline)).font(.system(size: 10, weight: .bold))
                    .foregroundStyle(urgencyColor(deadline)).widgetAccentable()
                    .lineLimit(1).layoutPriority(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var headerDate: String {
        let formatter = DateFormatter()
        formatter.timeZone = shanghai
        formatter.dateFormat = "MM/dd"
        return formatter.string(from: entry.date)
    }

    private func mediumRow(_ deadline: DeadlineSnapshot.Deadline) -> some View {
        HStack(spacing: 8) {
            Capsule().fill(urgencyColor(deadline)).frame(width: 3).widgetAccentable()
            VStack(alignment: .leading, spacing: 0) {
                Text(deadline.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Text(entry.snapshot.courseName(deadline.courseId))
                    .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 0) {
                Text(remaining(deadline)).font(.system(size: 11, weight: .bold))
                    .foregroundStyle(urgencyColor(deadline)).widgetAccentable()
                Text(dueLabel(deadline)).font(.system(size: 9)).foregroundStyle(.secondary)
            }
        }.frame(height: 23)
        .accessibilityElement(children: .combine)
    }

    private func remaining(_ deadline: DeadlineSnapshot.Deadline) -> String {
        let seconds = max(0, (deadline.date ?? entry.date).timeIntervalSince(entry.date))
        if seconds < 3_600 { return "不足 1 小时" }
        if seconds < 86_400 { return "剩 \(Int(ceil(seconds / 3_600))) 小时" }
        return "剩 \(Int(ceil(seconds / 86_400))) 天"
    }

    private func urgencyColor(_ deadline: DeadlineSnapshot.Deadline) -> Color {
        let seconds = (deadline.date ?? entry.date).timeIntervalSince(entry.date)
        return seconds < 86_400 ? .orange : .blue
    }

    private func dueLabel(_ deadline: DeadlineSnapshot.Deadline) -> String {
        guard let date = deadline.date else { return "" }
        let formatter = DateFormatter()
        formatter.timeZone = shanghai
        formatter.dateFormat = "MM/dd HH:mm"
        let label = formatter.string(from: date)
        return deadline.kindLabel.isEmpty ? label : "\(deadline.kindLabel) \(label)"
    }
}

@main
struct XIPUDeadlineWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: deadlineWidgetKind, provider: DeadlineProvider()) { entry in
            DeadlineWidgetView(entry: entry)
        }
        .configurationDisplayName("XIPU 截止时间")
        .description("查看未来 30 天的 Moodle DDL，点击打开 XIPU MCP。")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}
