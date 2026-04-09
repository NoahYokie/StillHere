import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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

interface LocationMapProps {
  center: { lat: number; lng: number };
  points?: MapPoint[];
  people?: MapPerson[];
  zoom?: number;
  className?: string;
  showTrail?: boolean;
  markerLabel?: string;
  onPersonTap?: (personId: string) => void;
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
  style.textContent = `@keyframes pulse-ring{0%{transform:scale(0.8);opacity:0.4}100%{transform:scale(1.6);opacity:0}}
.person-label{background:white;border-radius:12px;padding:2px 8px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);border:1px solid #e5e7eb;pointer-events:none}`;
  document.head.appendChild(style);
  pulseStyleInjected = true;
}

function createPulsingIcon(activity?: string | null, isMe?: boolean) {
  const color = activityColors[activity || "stationary"] || "#3b82f6";
  const size = isMe ? 36 : 32;
  const inner = isMe ? 28 : 24;
  const offset = (size - inner) / 2;
  return L.divIcon({
    className: "custom-marker",
    html: `<div style="position:relative;width:${size}px;height:${size}px">
      <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.3;animation:pulse-ring 1.5s ease-out infinite"></div>
      <div style="position:absolute;top:${offset}px;left:${offset}px;width:${inner}px;height:${inner}px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3)"></div>
      ${isMe ? `<div style="position:absolute;top:${offset + 2}px;left:${offset + 2}px;width:${inner - 4}px;height:${inner - 4}px;display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:700">Me</div>` : ""}
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function LocationMap({ center, points, people, zoom = 16, className = "w-full h-64", showTrail = true, markerLabel, onPersonTap }: LocationMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const trailLayersRef = useRef<L.Layer[]>([]);
  const peopleMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const peopleLabelLayersRef = useRef<Map<string, L.Marker>>(new Map());
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

    if (!people || people.length === 0) {
      const marker = L.marker([center.lat, center.lng], {
        icon: createPulsingIcon(points?.[points.length - 1]?.activity),
      }).addTo(map);

      if (markerLabel) {
        marker.bindPopup(markerLabel);
      }

      markerRef.current = marker;
    }

    mapInstanceRef.current = map;
    initializedRef.current = true;

    resizeTimerRef.current = setTimeout(() => map.invalidateSize(), 100);

    return () => {};
  }, []);

  useEffect(() => {
    if (!mapInstanceRef.current) return;

    if (people && people.length > 0) {
      const existingIds = new Set(peopleMarkersRef.current.keys());
      const currentIds = new Set(people.map(p => p.id));

      existingIds.forEach(id => {
        if (!currentIds.has(id)) {
          peopleMarkersRef.current.get(id)?.remove();
          peopleMarkersRef.current.delete(id);
          peopleLabelLayersRef.current.get(id)?.remove();
          peopleLabelLayersRef.current.delete(id);
        }
      });

      people.forEach(person => {
        const existing = peopleMarkersRef.current.get(person.id);
        if (existing) {
          existing.setLatLng([person.lat, person.lng]);
          existing.setIcon(createPulsingIcon(person.activity, person.isMe));
          const labelMarker = peopleLabelLayersRef.current.get(person.id);
          if (labelMarker) {
            labelMarker.setLatLng([person.lat, person.lng]);
          }
        } else {
          const marker = L.marker([person.lat, person.lng], {
            icon: createPulsingIcon(person.activity, person.isMe),
            zIndexOffset: person.isMe ? 1000 : 0,
          }).addTo(mapInstanceRef.current!);

          if (onPersonTap && !person.isMe) {
            marker.on("click", () => onPersonTap(person.id));
          }

          peopleMarkersRef.current.set(person.id, marker);

          if (!person.isMe) {
            const label = L.marker([person.lat, person.lng], {
              icon: L.divIcon({
                className: "",
                html: `<div class="person-label">${person.name}</div>`,
                iconSize: [0, 0],
                iconAnchor: [0, -22],
              }),
              interactive: false,
              zIndexOffset: 500,
            }).addTo(mapInstanceRef.current!);
            peopleLabelLayersRef.current.set(person.id, label);
          }
        }
      });

      if (people.length > 1) {
        const bounds = L.latLngBounds(people.map(p => [p.lat, p.lng] as [number, number]));
        mapInstanceRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
      } else {
        mapInstanceRef.current.panTo([people[0].lat, people[0].lng]);
      }

      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
    } else if (markerRef.current) {
      markerRef.current.setLatLng([center.lat, center.lng]);
      const latestActivity = points?.[points.length - 1]?.activity;
      markerRef.current.setIcon(createPulsingIcon(latestActivity));
      mapInstanceRef.current.panTo([center.lat, center.lng]);
    }
  }, [center.lat, center.lng, points, people]);

  useEffect(() => {
    trailLayersRef.current.forEach(layer => layer.remove());
    trailLayersRef.current = [];

    if (!mapInstanceRef.current || !showTrail || !points || points.length < 2) return;

    let segStart = 0;
    for (let i = 1; i <= points.length; i++) {
      const prevAct = points[i - 1].activity || "stationary";
      const currAct = i < points.length ? (points[i].activity || "stationary") : null;

      if (currAct !== prevAct || i === points.length) {
        const segPoints = points.slice(segStart, i);
        if (segPoints.length >= 2) {
          const color = activityColors[prevAct] || "#3b82f6";
          const latLngs = segPoints.map(p => [p.lat, p.lng] as [number, number]);
          const line = L.polyline(latLngs, {
            color,
            weight: prevAct === "stationary" ? 2 : 4,
            opacity: prevAct === "stationary" ? 0.4 : 0.8,
            dashArray: prevAct === "stationary" ? "4, 8" : undefined,
          }).addTo(mapInstanceRef.current!);
          trailLayersRef.current.push(line);
        }
        segStart = i;
      }
    }
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
        trailLayersRef.current = [];
        peopleMarkersRef.current.clear();
        peopleLabelLayersRef.current.clear();
        initializedRef.current = false;
      }
    };
  }, []);

  return <div ref={mapRef} className={`${className} rounded-lg z-0`} data-testid="location-map" />;
}
