import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Printer, CheckCircle2, AlertTriangle, Heart, MapPin, Activity } from "lucide-react";
import type { ReportData } from "@shared/schema";

export default function ReportPage() {
  const { userId } = useParams<{ userId: string }>();
  const [, setLocation] = useLocation();
  const [period, setPeriod] = useState("week");

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

  const periodLabel = period === "day" ? "Daily" : period === "week" ? "Weekly" : period === "fortnight" ? "Fortnightly" : "Monthly";

  return (
    <div className="min-h-screen bg-background print:bg-white">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6 print:hidden">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setLocation("/watched")} data-testid="button-back">
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-xl font-semibold" data-testid="text-page-title">Safety Report</h1>
          </div>
          <Button variant="outline" size="sm" onClick={handlePrint} data-testid="button-print">
            <Printer className="w-4 h-4 mr-1.5" />
            Print
          </Button>
        </div>

        <div className="mb-4 print:hidden">
          <Select value={period} onValueChange={setPeriod}>
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
              <h2 className="text-2xl font-bold" data-testid="text-report-name">{report.userName}</h2>
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
                      <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-0" data-testid={`row-incident-${i}`}>
                        <span>{inc.date}</span>
                        <span>{inc.reason === "sos" ? "SOS Alert" : "Missed Checkin"}</span>
                        <Badge variant={inc.resolved ? "secondary" : "destructive"} className="text-xs">
                          {inc.resolved ? "Resolved" : "Open"}
                        </Badge>
                        {inc.duration && <span className="text-xs text-muted-foreground">{inc.duration}</span>}
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
                    <span>Fall detection: {report.fallDetectionEnabled ? "Enabled" : "Disabled"}</span>
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
