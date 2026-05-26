import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Printer, CheckCircle2, AlertTriangle, Heart, MapPin, Activity, Car, Gauge, Zap, Bell, MessageCircleMore, PhoneCall, Shield, Clock } from "lucide-react";
import { BackButton } from "@/components/back-button";
import type { ReportData } from "@shared/schema";

function getEscalationIcon(type: string) {
  if (type === "push") return Bell;
  if (type === "sms") return MessageCircleMore;
  if (type === "call" || type === "call_failed" || type.startsWith("wellness_call")) return PhoneCall;
  if (type === "contact_alert" || type === "contact_escalation") return Shield;
  if (type.startsWith("safety_timer")) return Clock;
  if (type.startsWith("safe_walk")) return MapPin;
  if (type.startsWith("delivery")) return MessageCircleMore;
  return Clock;
}

function getEscalationColor(type: string) {
  if (type === "push") return "text-blue-600 bg-blue-50 border-blue-100";
  if (type === "sms") return "text-green-600 bg-green-50 border-green-100";
  if (type === "call" || type.startsWith("wellness_call")) return "text-purple-600 bg-purple-50 border-purple-100";
  if (type === "call_failed") return "text-red-600 bg-red-50 border-red-100";
  if (type === "contact_alert" || type === "contact_escalation") return "text-orange-600 bg-orange-50 border-orange-100";
  if (type.startsWith("safety_timer")) return "text-amber-600 bg-amber-50 border-amber-100";
  if (type.startsWith("safe_walk")) return "text-cyan-600 bg-cyan-50 border-cyan-100";
  if (type.startsWith("delivery")) return "text-slate-600 bg-slate-50 border-slate-100";
  return "text-muted-foreground bg-muted border-border";
}

function formatIncidentReason(reason: string): string {
  switch (reason) {
    case "sos": return "SOS Alert";
    case "missed_checkin": return "Missed Check-in";
    case "safety_timer": return "Safety Timer";
    case "safe_walk": return "Safe Walk";
    default: return reason.replace(/_/g, " ");
  }
}

function normalizeReportPeriod(value: string | null): string {
  return value && ["day", "week", "fortnight", "month"].includes(value) ? value : "week";
}

export default function ReportPage() {
  const { userId } = useParams<{ userId: string }>();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const initialPeriod = normalizeReportPeriod(new URLSearchParams(search).get("period"));
  const [period, setPeriod] = useState(initialPeriod);

  const { data: report, isLoading } = useQuery<ReportData>({
    queryKey: ["/api/reports", userId, period],
    queryFn: async () => {
      const res = await fetch(`/api/reports/${userId}?period=${period}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
    enabled: !!userId,
  });

  function handlePrint() {
    window.print();
  }

  function handlePeriodChange(nextPeriod: string) {
    setPeriod(nextPeriod);
    if (userId && typeof window !== "undefined") {
      window.history.replaceState(null, "", `/report/${userId}?period=${encodeURIComponent(nextPeriod)}`);
    }
  }

  function openMonitoredUserProfile() {
    if (!userId || typeof window === "undefined") return;
    const returnPath = `${window.location.pathname}${window.location.search}`;
    setLocation(`/live-location/${userId}?from=${encodeURIComponent(returnPath)}`);
  }

  const periodLabel = period === "day" ? "Daily" : period === "week" ? "Weekly" : period === "fortnight" ? "Fortnightly" : "Monthly";

  return (
    <div className="min-h-screen bg-background print:bg-white">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6 print:hidden">
          <div className="flex items-center gap-3">
            <BackButton to="/watched" />
            <h1 className="text-xl font-semibold" data-testid="text-page-title">Safety Report</h1>
          </div>
          <Button variant="outline" size="sm" onClick={handlePrint} data-testid="button-print">
            <Printer className="w-4 h-4 mr-1.5" />
            Print
          </Button>
        </div>

        <div className="mb-4 print:hidden">
          <Select value={period} onValueChange={handlePeriodChange}>
            <SelectTrigger data-testid="select-report-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Last 24 hours</SelectItem>
              <SelectItem value="week">Last 7 days</SelectItem>
              <SelectItem value="fortnight">Last 14 days</SelectItem>
              <SelectItem value="month">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {report && (
          <div className="space-y-4">
            <div className="text-center mb-6 print:mb-4">
              <button
                type="button"
                onClick={openMonitoredUserProfile}
                className="text-2xl font-bold hover:underline focus:outline-none focus-visible:underline"
                data-testid="text-report-name"
              >
                {report.userName}
              </button>
              <p className="text-muted-foreground" data-testid="text-report-period">
                {periodLabel} Report: {report.periodStart} to {report.periodEnd}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-3xl font-bold text-primary" data-testid="text-total-checkins">{report.totalCheckins}</p>
                  <p className="text-xs text-muted-foreground">Checkins</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-3xl font-bold text-green-600" data-testid="text-compliance">{report.complianceRate}%</p>
                  <p className="text-xs text-muted-foreground">Compliance</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4 text-center">
                  <p className="text-3xl font-bold text-red-500" data-testid="text-incidents">{report.incidents.length}</p>
                  <p className="text-xs text-muted-foreground">Incidents</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  Checkin History
                </CardTitle>
              </CardHeader>
              <CardContent>
                {report.checkins.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-no-checkins">No checkins in this period</p>
                ) : (
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {report.checkins.map((c, i) => (
                      <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-0" data-testid={`row-checkin-${i}`}>
                        <span>{c.date}</span>
                        <span className="text-muted-foreground">{c.time}</span>
                        <Badge variant="secondary" className="text-xs">{c.method}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {report.safetyTimeline && report.safetyTimeline.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Shield className="w-4 h-4 text-primary" />
                    Safety Activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {report.safetyTimeline.map((entry, i) => {
                      const Icon = getEscalationIcon(entry.type);
                      return (
                        <div key={`${entry.type}-${entry.time}-${i}`} className="flex items-start gap-2 text-xs" data-testid={`row-safety-activity-${i}`}>
                          <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${getEscalationColor(entry.type)}`}>
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium text-foreground">{entry.detail}</span>
                            <span className="block text-muted-foreground">{new Date(entry.time).toLocaleString()}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {report.incidents.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <AlertTriangle className="w-4 h-4 text-red-500" />
                    Incidents
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    {report.incidents.map((inc, i) => (
                      <div key={i} className="py-3 border-b border-border last:border-0" data-testid={`row-incident-${i}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span>{inc.date}</span>
                          <span>{formatIncidentReason(inc.reason)}</span>
                          <Badge variant={inc.resolved ? "secondary" : "destructive"} className="text-xs">
                            {inc.resolved ? "Resolved" : "Open"}
                          </Badge>
                          {inc.duration && <span className="text-xs text-muted-foreground">{inc.duration}</span>}
                        </div>
                        {inc.escalationTimeline.length > 0 && (
                          <div className="mt-3 space-y-2" data-testid={`incident-timeline-${i}`}>
                            {inc.escalationTimeline.map((entry, entryIndex) => {
                              const Icon = getEscalationIcon(entry.type);
                              return (
                                <div key={entryIndex} className="flex items-start gap-2 text-xs">
                                  <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${getEscalationColor(entry.type)}`}>
                                    <Icon className="h-3.5 w-3.5" />
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block font-medium text-foreground">{entry.detail}</span>
                                    <span className="block text-muted-foreground">{entry.time}</span>
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {report.heartRateSummary && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Heart className="w-4 h-4 text-red-500" />
                    Heart Rate Summary
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-xl font-bold" data-testid="text-hr-min">{report.heartRateSummary.minBpm}</p>
                      <p className="text-xs text-muted-foreground">Min BPM</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold" data-testid="text-hr-avg">{report.heartRateSummary.avgBpm}</p>
                      <p className="text-xs text-muted-foreground">Avg BPM</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold" data-testid="text-hr-max">{report.heartRateSummary.maxBpm}</p>
                      <p className="text-xs text-muted-foreground">Max BPM</p>
                    </div>
                  </div>
                  {report.heartRateSummary.alerts > 0 && (
                    <p className="text-sm text-red-500 mt-3" data-testid="text-hr-alerts">
                      {report.heartRateSummary.alerts} heart rate alert(s) during this period
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {report.drivingSummary && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Car className="w-4 h-4 text-blue-500" />
                    Driving Summary
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 text-center mb-3">
                    <div>
                      <p className="text-xl font-bold text-blue-600" data-testid="text-drive-total">{report.drivingSummary.totalDrives}</p>
                      <p className="text-xs text-muted-foreground">Drives</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold" data-testid="text-drive-distance">{report.drivingSummary.totalDistanceKm} km</p>
                      <p className="text-xs text-muted-foreground">Distance</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold" data-testid="text-drive-top-speed">{report.drivingSummary.topSpeedKmh} km/h</p>
                      <p className="text-xs text-muted-foreground">Top Speed</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {report.drivingSummary.speedingEvents > 0 && (
                      <div className="flex items-center gap-2 text-sm text-orange-500" data-testid="text-drive-speeding">
                        <Gauge className="w-4 h-4" />
                        {report.drivingSummary.speedingEvents} speeding event{report.drivingSummary.speedingEvents !== 1 ? "s" : ""}
                      </div>
                    )}
                    {report.drivingSummary.crashEvents > 0 && (
                      <div className="flex items-center gap-2 text-sm text-red-500" data-testid="text-drive-crashes">
                        <Zap className="w-4 h-4" />
                        {report.drivingSummary.crashEvents} crash event{report.drivingSummary.crashEvents !== 1 ? "s" : ""}
                      </div>
                    )}
                    {report.drivingSummary.speedingEvents === 0 && report.drivingSummary.crashEvents === 0 && (
                      <p className="text-sm text-green-500" data-testid="text-drive-clean">No driving incidents</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="w-4 h-4" />
                  Features Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-muted-foreground" />
                    <span>Location: {report.locationEnabled ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-muted-foreground" />
                    <span>Fall sensing: {report.fallDetectionEnabled ? "Enabled" : "Disabled"}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <p className="text-center text-xs text-muted-foreground py-4 print:py-2" data-testid="text-report-footer">
              Generated by StillHere Safety App. This report is shared with consent.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
