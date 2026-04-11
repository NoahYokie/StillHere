import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Car, Gauge, AlertTriangle, Clock, MapPin, Navigation, Zap, TrendingUp, Route, ChevronDown, ChevronUp } from "lucide-react";
import LocationMap from "@/components/location-map";
import type { TripPoint } from "@shared/schema";

interface DriveDetail {
  id: string;
  date: string;
  startTime: string;
  endTime: string | null;
  durationMinutes: number;
  distanceKm: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  crashDetected: boolean;
  speedAlerts: number;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
}

interface DriveReport {
  userName: string;
  periodStart: string;
  periodEnd: string;
  totalDrives: number;
  totalDistanceKm: number;
  topSpeedKmh: number;
  avgSpeedKmh: number;
  totalDriveTimeMinutes: number;
  crashCount: number;
  speedingCount: number;
  drives: DriveDetail[];
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function DriveCard({ drive, isWatcher }: { drive: DriveDetail; isWatcher: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const trailEndpoint = isWatcher ? `/api/drive/trail-public/${drive.id}` : `/api/drive/trail/${drive.id}`;

  const { data: trailPoints = [] } = useQuery<TripPoint[]>({
    queryKey: [trailEndpoint],
    queryFn: async () => {
      const res = await fetch(trailEndpoint, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: expanded,
  });

  const mapPoints = trailPoints.map(p => ({
    lat: p.lat, lng: p.lng, activity: p.activity,
  }));
  const mapCenter = drive.startLat != null && drive.startLng != null
    ? { lat: drive.startLat, lng: drive.startLng }
    : mapPoints.length > 0 ? { lat: mapPoints[0].lat, lng: mapPoints[0].lng } : null;

  return (
    <Card className="overflow-hidden" data-testid={`card-drive-report-${drive.id}`}>
      <CardContent className="pt-4 pb-4">
        <button
          className="w-full text-left"
          onClick={() => setExpanded(!expanded)}
          data-testid={`button-expand-drive-${drive.id}`}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Car className="w-4 h-4 text-blue-500" />
              <span className="font-medium text-sm">{drive.date}</span>
              <span className="text-xs text-muted-foreground">
                {drive.startTime}{drive.endTime ? ` · ${drive.endTime}` : ""}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {drive.crashDetected && (
                <Badge variant="destructive" className="text-[10px]">
                  <AlertTriangle className="w-3 h-3 mr-0.5" />
                  Crash
                </Badge>
              )}
              {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground">Duration</p>
              <p className="font-semibold text-sm">{formatDuration(drive.durationMinutes)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Distance</p>
              <p className="font-semibold text-sm">{drive.distanceKm.toFixed(1)} km</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Top Speed</p>
              <p className="font-semibold text-sm">{Math.round(drive.maxSpeedKmh)} km/h</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Avg Speed</p>
              <p className="font-semibold text-sm">{Math.round(drive.avgSpeedKmh)} km/h</p>
            </div>
          </div>
        </button>

        {expanded && (
          <div className="mt-3 pt-3 border-t space-y-3">
            <div className="flex flex-wrap gap-2">
              {drive.speedAlerts > 0 && (
                <div className="flex items-center gap-1.5 bg-orange-50 dark:bg-orange-950/30 text-orange-600 dark:text-orange-400 rounded-full px-3 py-1 text-xs font-medium">
                  <Gauge className="w-3.5 h-3.5" />
                  {drive.speedAlerts} speed alert{drive.speedAlerts !== 1 ? "s" : ""}
                </div>
              )}
              {drive.crashDetected && (
                <div className="flex items-center gap-1.5 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 rounded-full px-3 py-1 text-xs font-medium">
                  <Zap className="w-3.5 h-3.5" />
                  Crash detected
                </div>
              )}
              {drive.speedAlerts === 0 && !drive.crashDetected && (
                <div className="flex items-center gap-1.5 bg-green-50 dark:bg-green-950/30 text-green-600 dark:text-green-400 rounded-full px-3 py-1 text-xs font-medium">
                  <Navigation className="w-3.5 h-3.5" />
                  Clean drive
                </div>
              )}
            </div>

            {mapCenter && mapPoints.length > 0 && (
              <div className="rounded-lg overflow-hidden border">
                <LocationMap
                  center={mapCenter}
                  points={mapPoints}
                  zoom={13}
                  className="w-full h-48"
                  showTrail={true}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DriveReportPage() {
  const { userId } = useParams<{ userId: string }>();
  const [, navigate] = useLocation();
  const [period, setPeriod] = useState("week");
  const isWatcher = !!userId;

  const endpoint = isWatcher
    ? `/api/drive/report/${userId}?period=${period}`
    : `/api/drive/report?period=${period}`;

  const { data: report, isLoading } = useQuery<DriveReport>({
    queryKey: ["/api/drive/report", userId || "self", period],
    queryFn: async () => {
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load drive report");
      return res.json();
    },
  });

  const periodLabel = period === "day" ? "Today" : period === "week" ? "This Week" : period === "fortnight" ? "Last 2 Weeks" : "This Month";

  return (
    <div className="min-h-screen bg-background" data-testid="page-drive-report">
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-3 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(isWatcher ? "/watched" : "/drive")} data-testid="button-back">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold" data-testid="text-title">Driving Report</h1>
          {report && isWatcher && (
            <p className="text-xs text-muted-foreground">{report.userName}</p>
          )}
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
        <div className="flex items-center gap-3">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger data-testid="select-period" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Last 24 hours</SelectItem>
              <SelectItem value="week">Last 7 days</SelectItem>
              <SelectItem value="fortnight">Last 14 days</SelectItem>
              <SelectItem value="month">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{periodLabel}</span>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {report && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Card className="bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800">
                <CardContent className="py-4 text-center">
                  <p className="text-3xl font-bold text-blue-600 dark:text-blue-400" data-testid="text-total-distance">{report.totalDistanceKm}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Total km</p>
                </CardContent>
              </Card>
              <Card className="bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800">
                <CardContent className="py-4 text-center">
                  <p className="text-3xl font-bold text-purple-600 dark:text-purple-400" data-testid="text-top-speed">{report.topSpeedKmh}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Top Speed</p>
                </CardContent>
              </Card>
              <Card className="bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800">
                <CardContent className="py-4 text-center">
                  <p className="text-3xl font-bold text-green-600 dark:text-green-400" data-testid="text-total-drives">{report.totalDrives}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Total Drives</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <Gauge className="w-4 h-4 text-orange-500" />
                      <span>Speeding Events</span>
                    </div>
                    <span className={`font-semibold text-sm ${report.speedingCount > 0 ? "text-orange-500" : "text-green-500"}`} data-testid="text-speeding-count">
                      {report.speedingCount}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <Zap className="w-4 h-4 text-red-500" />
                      <span>Crash Events</span>
                    </div>
                    <span className={`font-semibold text-sm ${report.crashCount > 0 ? "text-red-500" : "text-green-500"}`} data-testid="text-crash-count">
                      {report.crashCount}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <TrendingUp className="w-4 h-4 text-blue-500" />
                      <span>Average Speed</span>
                    </div>
                    <span className="font-semibold text-sm" data-testid="text-avg-speed">
                      {report.avgSpeedKmh} km/h
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <span>Total Drive Time</span>
                    </div>
                    <span className="font-semibold text-sm" data-testid="text-total-time">
                      {formatDuration(report.totalDriveTimeMinutes)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div>
              <h3 className="font-semibold text-sm text-muted-foreground px-1 mb-3" data-testid="text-drives-header">
                Individual Drives ({report.drives.length})
              </h3>
              {report.drives.length === 0 ? (
                <Card>
                  <CardContent className="pt-6 pb-6 text-center">
                    <Car className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground" data-testid="text-no-drives">No drives recorded in this period</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {report.drives.map((drive) => (
                    <DriveCard key={drive.id} drive={drive} isWatcher={isWatcher} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
