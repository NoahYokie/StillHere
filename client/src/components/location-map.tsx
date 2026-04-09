import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface MapPoint {
  lat: number;
  lng: number;
  activity?: string | null;
  timestamp?: string;
}

interface LocationMapProps {
  center: { lat: number; lng: number };
  points?: MapPoint[];
  zoom?: number;
  className?: string;
  showTrail?: boolean;
  markerLabel?: string;
}

const activityColors: Record<string, string> = {
  stationary: "#9ca3af",
  walking: "#22c55e",
  running: "#f97316",
  cycling: "#3b82f6",
  driving: "#a855f7",
};

let pulseStyleInjected = false;

function ensurePulseStyle() {
  if (pulseStyleInjected) return;
  const style = document.createElement("style");
  style.id = "leaflet-pulse-ring";
  style.textContent = `@keyframes pulse-ring{0%{transform:scale(0.8);opacity:0.4}100%{transform:scale(1.6);opacity:0}}`;
  document.head.appendChild(style);
  pulseStyleInjected = true;
}

function createPulsingIcon(activity?: string | null) {
  const color = activityColors[activity || "stationary"] || "#3b82f6";
  return L.divIcon({
    className: "custom-marker",
    html: `<div style="position:relative;width:32px;height:32px">
      <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.3;animation:pulse-ring 1.5s ease-out infinite"></div>
      <div style="position:absolute;top:4px;left:4px;width:24px;height:24px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3)"></div>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

export default function LocationMap({ center, points, zoom = 16, className = "w-full h-64", showTrail = true, markerLabel }: LocationMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const initializedRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!mapRef.current || initializedRef.current) return;

    ensurePulseStyle();

    const map = L.map(mapRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView([center.lat, center.lng], zoom);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);

    L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);

    const marker = L.marker([center.lat, center.lng], {
      icon: createPulsingIcon(points?.[points.length - 1]?.activity),
    }).addTo(map);

    if (markerLabel) {
      marker.bindPopup(markerLabel);
    }

    markerRef.current = marker;
    mapInstanceRef.current = map;
    initializedRef.current = true;

    resizeTimerRef.current = setTimeout(() => map.invalidateSize(), 100);

    return () => {};
  }, []);

  useEffect(() => {
    if (!mapInstanceRef.current || !markerRef.current) return;

    markerRef.current.setLatLng([center.lat, center.lng]);
    const latestActivity = points?.[points.length - 1]?.activity;
    markerRef.current.setIcon(createPulsingIcon(latestActivity));
    mapInstanceRef.current.panTo([center.lat, center.lng]);
  }, [center.lat, center.lng, points]);

  useEffect(() => {
    if (trailRef.current) {
      trailRef.current.remove();
      trailRef.current = null;
    }

    if (!mapInstanceRef.current || !showTrail || !points || points.length < 2) return;

    const latLngs = points.map(p => [p.lat, p.lng] as [number, number]);
    trailRef.current = L.polyline(latLngs, {
      color: "#3b82f6",
      weight: 4,
      opacity: 0.7,
      dashArray: "8, 8",
    }).addTo(mapInstanceRef.current);
  }, [points, showTrail]);

  useEffect(() => {
    return () => {
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markerRef.current = null;
        trailRef.current = null;
        initializedRef.current = false;
      }
    };
  }, []);

  return <div ref={mapRef} className={`${className} rounded-lg z-0`} data-testid="location-map" />;
}
