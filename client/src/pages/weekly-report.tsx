import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowLeft, Shield, ShieldCheck, ShieldAlert, AlertTriangle, Clock, MapPin, CheckCircle2 } from "lucide-react";

interface TimelineItem {
  text: string;
  time: string;
}

interface WeeklyReport {
  summaryTone: "good" | "mixed" | "concern";
  summary: string;
  timeline: TimelineItem[];
  weekStart: string;
  weekEnd: string;
  totalCheckins: number;
}

const toneConfig = {
  good: {
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    border: "border-emerald-200 dark:border-emerald-800",
    accent: "text-emerald-700 dark:text-emerald-400",
    iconBg: "bg-emerald-100 dark:bg-emerald-900/50",
    icon: ShieldCheck,
    label: "All Clear",
    dot: "bg-emerald-500",
    barBg: "bg-emerald-100 dark:bg-emerald-900/30",
  },
  mixed: {
    bg: "bg-amber-50 dark:bg-amber-950/30",
    border: "border-amber-200 dark:border-amber-800",
    accent: "text-amber-700 dark:text-amber-400",
    iconBg: "bg-amber-100 dark:bg-amber-900/50",
    icon: Shield,
    label: "Some Activity",
    dot: "bg-amber-500",
    barBg: "bg-amber-100 dark:bg-amber-900/30",
  },
  concern: {
    bg: "bg-red-50 dark:bg-red-950/30",
    border: "border-red-200 dark:border-red-800",
    accent: "text-red-700 dark:text-red-400",
    iconBg: "bg-red-100 dark:bg-red-900/50",
    icon: ShieldAlert,
    label: "Needs Attention",
    dot: "bg-red-500",
    barBg: "bg-red-100 dark:bg-red-900/30",
  },
};

function getTimelineIcon(text: string) {
  if (text.includes("SOS") || text.includes("Crash")) return AlertTriangle;
  if (text.includes("Missed") || text.includes("expired") || text.includes("Late")) return Clock;
  if (text.includes("Arrived") || text.includes("Left")) return MapPin;
  if (text.includes("Confirmed") || text.includes("Resolved")) return CheckCircle2;
  return Shield;
}

function getTimelineColor(text: string) {
  if (text.includes("SOS") || text.includes("Crash")) return "text-red-500";
  if (text.includes("Missed") || text.includes("expired") || text.includes("Late") || text.includes("Awaiting")) return "text-amber-500";
  if (text.includes("Arrived") || text.includes("Left") || text.includes("trip")) return "text-blue-500";
  if (text.includes("Confirmed") || text.includes("Resolved")) return "text-emerald-500";
  return "text-gray-500";
}

export default function WeeklyReportPage() {
  const [, navigate] = useLocation();

  const { data: report, isLoading } = useQuery<WeeklyReport>({
    queryKey: ["/api/reports/weekly"],
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Preparing your safety report...</p>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
        <div className="text-center space-y-2">
          <Shield className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto" />
          <p className="text-gray-500 dark:text-gray-400">No report data available yet</p>
        </div>
      </div>
    );
  }

  const tone = toneConfig[report.summaryTone];
  const ToneIcon = tone.icon;

  const weekStart = new Date(report.weekStart);
  const weekEnd = new Date(report.weekEnd);
  const dateRange = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-lg border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 px-4 py-3 max-w-lg mx-auto">
          <button
            onClick={() => navigate("/")}
            className="p-2 -ml-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            data-testid="button-back"
          >
            <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          </button>
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white" data-testid="text-page-title">
              Weekly Safety Report
            </h1>
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="text-date-range">{dateRange}</p>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4 pb-8">
        <div className={`rounded-2xl border ${tone.border} ${tone.bg} p-6`} data-testid="card-summary">
          <div className="flex items-start gap-4">
            <div className={`p-3 rounded-xl ${tone.iconBg} shrink-0`}>
              <ToneIcon className={`w-7 h-7 ${tone.accent}`} />
            </div>
            <div className="space-y-2 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-semibold uppercase tracking-wide ${tone.accent}`} data-testid="text-tone-label">
                  {tone.label}
                </span>
                <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
              </div>
              <p className="text-[15px] leading-relaxed text-gray-700 dark:text-gray-300" data-testid="text-summary">
                {report.summary}
              </p>
            </div>
          </div>
        </div>

        <div className={`rounded-2xl ${tone.barBg} border ${tone.border} px-5 py-3 flex items-center justify-between`}>
          <span className="text-sm text-gray-600 dark:text-gray-400">Total check-ins this week</span>
          <span className={`text-xl font-bold ${tone.accent}`} data-testid="text-checkin-count">
            {report.totalCheckins}
          </span>
        </div>

        {report.timeline.length > 0 && (
          <div className="space-y-1 pt-2">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide px-1 mb-3" data-testid="text-timeline-title">
              This Week
            </h2>
            <div className="space-y-0">
              {report.timeline.map((item, i) => {
                const Icon = getTimelineIcon(item.text);
                const colorClass = getTimelineColor(item.text);
                const isLast = i === report.timeline.length - 1;

                return (
                  <div key={i} className="flex gap-3" data-testid={`timeline-item-${i}`}>
                    <div className="flex flex-col items-center">
                      <div className={`p-1.5 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-sm`}>
                        <Icon className={`w-4 h-4 ${colorClass}`} />
                      </div>
                      {!isLast && (
                        <div className="w-px h-full min-h-[32px] bg-gray-200 dark:bg-gray-700 my-1" />
                      )}
                    </div>
                    <div className={`pb-4 ${isLast ? "" : ""}`}>
                      <p className="text-[14px] font-medium text-gray-800 dark:text-gray-200 leading-snug">
                        {item.text}
                      </p>
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                        {item.time}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {report.timeline.length === 0 && (
          <div className="text-center py-8 space-y-2">
            <CheckCircle2 className="w-10 h-10 text-emerald-300 dark:text-emerald-700 mx-auto" />
            <p className="text-sm text-gray-400 dark:text-gray-500">
              A quiet week, no events to report
            </p>
          </div>
        )}

        <div className="text-center pt-4 pb-2">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            StillHere • Your safety, always watched over
          </p>
        </div>
      </div>
    </div>
  );
}
