import SwiftUI
import WidgetKit

struct StillHereComplication: Widget {
    let kind: String = "StillHereComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ComplicationProvider()) { entry in
            ComplicationEntryView(entry: entry)
        }
        .configurationDisplayName("StillHere")
        .description("Quick access to your safety checkin")
        .supportedFamilies([
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryCorner,
            .accessoryInline,
        ])
    }
}

struct ComplicationEntry: TimelineEntry {
    let date: Date
    let isOverdue: Bool
    let hasIncident: Bool
}

struct ComplicationProvider: TimelineProvider {
    private let sharedDefaults = UserDefaults(suiteName: "group.com.stillhere.app")

    func placeholder(in context: Context) -> ComplicationEntry {
        ComplicationEntry(date: Date(), isOverdue: false, hasIncident: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (ComplicationEntry) -> Void) {
        completion(currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ComplicationEntry>) -> Void) {
        let entry = currentEntry()
        let nextUpdate = Date().addingTimeInterval(15 * 60)
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        completion(timeline)
    }

    private func currentEntry() -> ComplicationEntry {
        let isOverdue = sharedDefaults?.bool(forKey: "complication_isOverdue") ?? false
        let hasIncident = sharedDefaults?.bool(forKey: "complication_hasIncident") ?? false
        return ComplicationEntry(date: Date(), isOverdue: isOverdue, hasIncident: hasIncident)
    }
}

struct ComplicationEntryView: View {
    var entry: ComplicationEntry

    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 1) {
                    Image(systemName: entry.hasIncident ? "sos" : "heart.fill")
                        .font(.system(size: 14))
                        .foregroundColor(entry.hasIncident ? .red : (entry.isOverdue ? .orange : .cyan))
                    Text(statusText)
                        .font(.system(size: 9, weight: .bold))
                }
            }

        case .accessoryRectangular:
            HStack(spacing: 6) {
                Image(systemName: "heart.fill")
                    .foregroundColor(statusColor)
                    .font(.system(size: 14))
                VStack(alignment: .leading, spacing: 1) {
                    Text("StillHere")
                        .font(.system(size: 12, weight: .semibold))
                    Text(statusDescription)
                        .font(.system(size: 10))
                        .foregroundColor(statusColor)
                }
            }

        case .accessoryInline:
            HStack(spacing: 4) {
                Image(systemName: "heart.fill")
                Text(statusDescription)
            }

        case .accessoryCorner:
            Image(systemName: "heart.fill")
                .foregroundColor(statusColor)

        default:
            Image(systemName: "heart.fill")
                .foregroundColor(statusColor)
        }
    }

    private var statusText: String {
        if entry.hasIncident { return "SOS" }
        if entry.isOverdue { return "DUE" }
        return "OK"
    }

    private var statusDescription: String {
        if entry.hasIncident { return "SOS Active" }
        if entry.isOverdue { return "Checkin overdue" }
        return "All good"
    }

    private var statusColor: Color {
        if entry.hasIncident { return .red }
        if entry.isOverdue { return .orange }
        return .cyan
    }
}
