import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "@/lib/google-maps";

const MAP_ID = "f9da6ed7427098cf6c184d26";

interface MapPoint {
  lat: number;
  lng: number;
  activity?: string | null;
  timestamp?: string;
}

interface MapPerson {
  id: string;
  name: string;
  lat: number;
  lng: number;
  activity?: string | null;
  isMe?: boolean;
}

interface GoogleMapProps {
  center: { lat: number; lng: number };
  points?: MapPoint[];
  people?: MapPerson[];
  zoom?: number;
  className?: string;
  showTrail?: boolean;
  markerLabel?: string;
  onPersonTap?: (personId: string) => void;
  mapType?: "roadmap" | "satellite" | "terrain" | "hybrid";
  showTraffic?: boolean;
  showMapTypeControl?: boolean;
  showStreetView?: boolean;
  startAddress?: string;
  endAddress?: string;
  routePolyline?: string;
}

const activityColors: Record<string, string> = {
  stationary: "#9ca3af",
  walking: "#22c55e",
  running: "#f97316",
  cycling: "#3b82f6",
  driving: "#a855f7",
};

function createMarkerElement(activity?: string | null): HTMLElement {
  const color = activityColors[activity || "stationary"] || "#3b82f6";
  const container = document.createElement("div");
  container.style.cssText = "position:relative;width:36px;height:36px";
  container.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.3;animation:gmap-pulse 1.5s ease-out infinite"></div>
    <div style="position:absolute;top:4px;left:4px;width:28px;height:28px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3)"></div>
  `;
  ensurePulseStyle();
  return container;
}

function createPersonMarker(person: MapPerson): HTMLElement {
  const color = activityColors[person.activity || "stationary"] || "#3b82f6";
  const size = person.isMe ? 40 : 34;
  const innerSize = person.isMe ? 32 : 26;
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:2px";
  container.innerHTML = `
    <div style="position:relative;width:${size}px;height:${size}px">
      <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.3;animation:gmap-pulse 1.5s ease-out infinite"></div>
      <div style="position:absolute;top:4px;left:4px;width:${innerSize}px;height:${innerSize}px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-size:${person.isMe ? 11 : 10}px;font-weight:700">${person.isMe ? "Me" : ""}</div>
    </div>
    ${!person.isMe ? `<div style="background:white;border-radius:12px;padding:1px 6px;font-size:10px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);border:1px solid #e5e7eb">${person.name}</div>` : ""}
  `;
  ensurePulseStyle();
  return container;
}

function createLabelMarker(letter: string, color: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `background:${color};color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)`;
  el.textContent = letter;
  return el;
}

function ensurePulseStyle() {
  if (!document.getElementById("gmap-pulse-style")) {
    const style = document.createElement("style");
    style.id = "gmap-pulse-style";
    style.textContent = "@keyframes gmap-pulse{0%{transform:scale(0.8);opacity:0.4}100%{transform:scale(1.6);opacity:0}}";
    document.head.appendChild(style);
  }
}

export default function GoogleMapComponent({
  center,
  points,
  people,
  zoom = 16,
  className = "w-full h-64",
  showTrail = true,
  markerLabel,
  onPersonTap,
  mapType = "roadmap",
  showTraffic = false,
  showMapTypeControl = true,
  showStreetView = false,
  startAddress,
  endAddress,
  routePolyline,
}: GoogleMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const peopleMarkersRef = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
  const trailPolylinesRef = useRef<google.maps.Polyline[]>([]);
  const routePolylineRef = useRef<google.maps.Polyline | null>(null);
  const trafficLayerRef = useRef<google.maps.TrafficLayer | null>(null);
  const startMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const endMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const initRef = useRef(false);

  useEffect(() => {
    loadGoogleMaps()
      .then(() => setMapsLoaded(true))
      .catch((err) => {
        console.error("[MAPS] GoogleMap component failed to load:", err);
        setLoadError(true);
      });
  }, []);

  useEffect(() => {
    if (!mapsLoaded || !mapRef.current || initRef.current) return;
    initRef.current = true;

    const map = new google.maps.Map(mapRef.current, {
      center: { lat: center.lat, lng: center.lng },
      zoom,
      mapTypeId: mapType,
      mapTypeControl: showMapTypeControl,
      mapTypeControlOptions: {
        style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
        position: google.maps.ControlPosition.TOP_RIGHT,
      },
      streetViewControl: showStreetView,
      fullscreenControl: false,
      zoomControl: true,
      zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
      gestureHandling: "greedy",
      mapId: MAP_ID,
    });

    mapInstanceRef.current = map;

    if (!people || people.length === 0) {
      const markerEl = createMarkerElement(points?.[points.length - 1]?.activity);
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: center.lat, lng: center.lng },
        content: markerEl,
        title: markerLabel || "Location",
      });
      markersRef.current.push(marker);
    }
  }, [mapsLoaded]);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    if (showTraffic) {
      if (!trafficLayerRef.current) {
        trafficLayerRef.current = new google.maps.TrafficLayer();
      }
      trafficLayerRef.current.setMap(mapInstanceRef.current);
    } else {
      trafficLayerRef.current?.setMap(null);
    }
  }, [showTraffic, mapsLoaded]);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.setMapTypeId(mapType);
  }, [mapType]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (people && people.length > 0) {
      markersRef.current.forEach(m => m.map = null);
      markersRef.current = [];

      const currentIds = new Set(people.map(p => p.id));
      peopleMarkersRef.current.forEach((marker, id) => {
        if (!currentIds.has(id)) {
          marker.map = null;
          peopleMarkersRef.current.delete(id);
        }
      });

      people.forEach(person => {
        const existing = peopleMarkersRef.current.get(person.id);
        if (existing) {
          existing.position = { lat: person.lat, lng: person.lng };
          existing.content = createPersonMarker(person);
        } else {
          const marker = new google.maps.marker.AdvancedMarkerElement({
            map,
            position: { lat: person.lat, lng: person.lng },
            content: createPersonMarker(person),
            title: person.name,
            zIndex: person.isMe ? 1000 : 0,
          });
          if (onPersonTap && !person.isMe) {
            marker.addListener("click", () => onPersonTap(person.id));
          }
          peopleMarkersRef.current.set(person.id, marker);
        }
      });

      if (people.length > 1) {
        const bounds = new google.maps.LatLngBounds();
        people.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
        map.fitBounds(bounds, 50);
      } else {
        map.panTo({ lat: people[0].lat, lng: people[0].lng });
      }
    } else if (markersRef.current.length > 0) {
      const marker = markersRef.current[0];
      marker.position = { lat: center.lat, lng: center.lng };
      marker.content = createMarkerElement(points?.[points.length - 1]?.activity);
      map.panTo({ lat: center.lat, lng: center.lng });
    }
  }, [center.lat, center.lng, points, people]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    trailPolylinesRef.current.forEach(p => p.setMap(null));
    trailPolylinesRef.current = [];

    if (!showTrail || !points || points.length < 2) return;

    let segStart = 0;
    for (let i = 1; i <= points.length; i++) {
      const prevAct = points[i - 1].activity || "stationary";
      const currAct = i < points.length ? (points[i].activity || "stationary") : null;

      if (currAct !== prevAct || i === points.length) {
        const segPoints = points.slice(segStart, i);
        if (segPoints.length >= 2) {
          const color = activityColors[prevAct] || "#3b82f6";
          const path = segPoints.map(p => ({ lat: p.lat, lng: p.lng }));
          const polyline = new google.maps.Polyline({
            path,
            strokeColor: color,
            strokeWeight: prevAct === "stationary" ? 2 : 4,
            strokeOpacity: prevAct === "stationary" ? 0.4 : 0.8,
            map,
          });
          trailPolylinesRef.current.push(polyline);
        }
        segStart = i;
      }
    }

    if (points.length > 2) {
      const bounds = new google.maps.LatLngBounds();
      points.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
      map.fitBounds(bounds, 40);
    }
  }, [points, showTrail]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    routePolylineRef.current?.setMap(null);
    routePolylineRef.current = null;

    if (!routePolyline) return;

    try {
      const decodedPath = google.maps.geometry.encoding.decodePath(routePolyline);
      const polyline = new google.maps.Polyline({
        path: decodedPath,
        strokeColor: "#3b82f6",
        strokeWeight: 5,
        strokeOpacity: 0.7,
        map,
      });
      routePolylineRef.current = polyline;

      const bounds = new google.maps.LatLngBounds();
      decodedPath.forEach(p => bounds.extend(p));
      map.fitBounds(bounds, 40);
    } catch {}
  }, [routePolyline]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapsLoaded) return;

    if (startMarkerRef.current) startMarkerRef.current.map = null;
    if (endMarkerRef.current) endMarkerRef.current.map = null;

    if (startAddress && points && points.length > 0) {
      const startPt = points[0];
      startMarkerRef.current = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: startPt.lat, lng: startPt.lng },
        content: createLabelMarker("A", "#22c55e"),
        title: startAddress,
      });
    }

    if (endAddress && points && points.length > 1) {
      const endPt = points[points.length - 1];
      endMarkerRef.current = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: endPt.lat, lng: endPt.lng },
        content: createLabelMarker("B", "#ef4444"),
        title: endAddress,
      });
    }
  }, [startAddress, endAddress, points, mapsLoaded]);

  useEffect(() => {
    return () => {
      markersRef.current.forEach(m => m.map = null);
      markersRef.current = [];
      peopleMarkersRef.current.forEach(m => m.map = null);
      peopleMarkersRef.current.clear();
      trailPolylinesRef.current.forEach(p => p.setMap(null));
      trailPolylinesRef.current = [];
      routePolylineRef.current?.setMap(null);
      trafficLayerRef.current?.setMap(null);
      if (startMarkerRef.current) startMarkerRef.current.map = null;
      if (endMarkerRef.current) endMarkerRef.current.map = null;
      initRef.current = false;
    };
  }, []);

  if (loadError) {
    return (
      <div className={`${className} rounded-lg bg-muted flex items-center justify-center`}>
        <p className="text-sm text-muted-foreground">Map unavailable</p>
      </div>
    );
  }

  if (!mapsLoaded) {
    return (
      <div className={`${className} rounded-lg bg-muted flex items-center justify-center`}>
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <div ref={mapRef} className={`${className} rounded-lg`} data-testid="google-map" />;
}
