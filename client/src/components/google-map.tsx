import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "@/lib/google-maps";

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

function createCircleIcon(color: string, size: number = 18, label?: string): google.maps.Icon {
  const svg = label
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}"><circle cx="${size}" cy="${size}" r="${size - 2}" fill="${color}" stroke="white" stroke-width="3"/><text x="${size}" y="${size + 5}" text-anchor="middle" fill="white" font-size="12" font-weight="700">${label}</text></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}"><circle cx="${size}" cy="${size}" r="${size - 2}" fill="${color}" stroke="white" stroke-width="3"/></svg>`;
  return {
    url: "data:image/svg+xml," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(size * 2, size * 2),
    anchor: new google.maps.Point(size, size),
  };
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
  const markersRef = useRef<google.maps.Marker[]>([]);
  const peopleMarkersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const labelOverlaysRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const trailPolylinesRef = useRef<google.maps.Polyline[]>([]);
  const routePolylineRef = useRef<google.maps.Polyline | null>(null);
  const trafficLayerRef = useRef<google.maps.TrafficLayer | null>(null);
  const startMarkerRef = useRef<google.maps.Marker | null>(null);
  const endMarkerRef = useRef<google.maps.Marker | null>(null);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const initRef = useRef(false);

  useEffect(() => {
    loadGoogleMaps()
      .then(() => setMapsLoaded(true))
      .catch(() => setLoadError(true));
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
      styles: [
        { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
      ],
    });

    mapInstanceRef.current = map;

    if (!people || people.length === 0) {
      const activity = points?.[points.length - 1]?.activity || "stationary";
      const color = activityColors[activity] || "#3b82f6";
      const marker = new google.maps.Marker({
        map,
        position: { lat: center.lat, lng: center.lng },
        icon: createCircleIcon(color, 16),
        title: markerLabel || "Location",
        zIndex: 100,
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
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current = [];

      const currentIds = new Set(people.map(p => p.id));
      peopleMarkersRef.current.forEach((marker, id) => {
        if (!currentIds.has(id)) {
          marker.setMap(null);
          peopleMarkersRef.current.delete(id);
          labelOverlaysRef.current.get(id)?.setMap(null);
          labelOverlaysRef.current.delete(id);
        }
      });

      people.forEach(person => {
        const color = activityColors[person.activity || "stationary"] || "#3b82f6";
        const existing = peopleMarkersRef.current.get(person.id);
        if (existing) {
          existing.setPosition({ lat: person.lat, lng: person.lng });
          existing.setIcon(createCircleIcon(color, person.isMe ? 18 : 15, person.isMe ? "Me" : undefined));
          const labelMarker = labelOverlaysRef.current.get(person.id);
          if (labelMarker) labelMarker.setPosition({ lat: person.lat, lng: person.lng });
        } else {
          const marker = new google.maps.Marker({
            map,
            position: { lat: person.lat, lng: person.lng },
            icon: createCircleIcon(color, person.isMe ? 18 : 15, person.isMe ? "Me" : undefined),
            title: person.name,
            zIndex: person.isMe ? 1000 : 0,
          });
          if (onPersonTap && !person.isMe) {
            marker.addListener("click", () => onPersonTap(person.id));
          }
          peopleMarkersRef.current.set(person.id, marker);

          if (!person.isMe) {
            const nameSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24"><rect x="0" y="0" width="120" height="24" rx="12" fill="white" stroke="#e5e7eb" stroke-width="1"/><text x="60" y="16" text-anchor="middle" fill="#333" font-size="11" font-weight="600" font-family="sans-serif">${person.name.substring(0, 12)}</text></svg>`;
            const labelMarker = new google.maps.Marker({
              map,
              position: { lat: person.lat, lng: person.lng },
              icon: {
                url: "data:image/svg+xml," + encodeURIComponent(nameSvg),
                scaledSize: new google.maps.Size(120, 24),
                anchor: new google.maps.Point(60, -8),
              },
              clickable: false,
              zIndex: 500,
            });
            labelOverlaysRef.current.set(person.id, labelMarker);
          }
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
      const activity = points?.[points.length - 1]?.activity || "stationary";
      const color = activityColors[activity] || "#3b82f6";
      marker.setPosition({ lat: center.lat, lng: center.lng });
      marker.setIcon(createCircleIcon(color, 16));
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

    startMarkerRef.current?.setMap(null);
    endMarkerRef.current?.setMap(null);

    if (startAddress && points && points.length > 0) {
      const startPt = points[0];
      startMarkerRef.current = new google.maps.Marker({
        map,
        position: { lat: startPt.lat, lng: startPt.lng },
        icon: createCircleIcon("#22c55e", 14, "A"),
        title: startAddress,
        zIndex: 200,
      });
    }

    if (endAddress && points && points.length > 1) {
      const endPt = points[points.length - 1];
      endMarkerRef.current = new google.maps.Marker({
        map,
        position: { lat: endPt.lat, lng: endPt.lng },
        icon: createCircleIcon("#ef4444", 14, "B"),
        title: endAddress,
        zIndex: 200,
      });
    }
  }, [startAddress, endAddress, points, mapsLoaded]);

  useEffect(() => {
    return () => {
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current = [];
      peopleMarkersRef.current.forEach(m => m.setMap(null));
      peopleMarkersRef.current.clear();
      labelOverlaysRef.current.forEach(m => m.setMap(null));
      labelOverlaysRef.current.clear();
      trailPolylinesRef.current.forEach(p => p.setMap(null));
      trailPolylinesRef.current = [];
      routePolylineRef.current?.setMap(null);
      trafficLayerRef.current?.setMap(null);
      startMarkerRef.current?.setMap(null);
      endMarkerRef.current?.setMap(null);
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
