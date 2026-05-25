import { useEffect, useRef, useState, useCallback } from "react";
import { loadGoogleMaps } from "@/lib/google-maps";

const MAP_ID = "f9da6ed7427098cf6c184d26";

const DARK_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#1a1a2e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a1a2e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8b8ba7" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#b8b8d0" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#6b6b8d" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1e3a2f" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#3a7d5e" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a2a4a" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a1a35" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a3a6a" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#2a2a50" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#a0a0c0" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2a2a45" }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#7070a0" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1a2b" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3d5a80" }] },
];

interface MapPoint {
  lat: number;
  lng: number;
  activity?: string | null;
  timestamp?: string;
}

export interface MapPerson {
  id: string;
  name: string;
  lat: number;
  lng: number;
  activity?: string | null;
  speed?: number | null;
  heading?: number | null;
  lastUpdated?: string;
  isMe?: boolean;
  accuracy?: number | null;
  safetyState?: string | null;
  hasSafetyEvent?: boolean;
  safetyStateReason?: string | null;
  incidentReason?: string | null;
  groupedNames?: string[];
}

interface GeofenceCircle {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusMeters: number;
}

interface NearbyPlace {
  name: string;
  lat: number;
  lng: number;
  type: "hospital" | "police" | "fire_station";
}

interface GoogleMapProps {
  center: { lat: number; lng: number };
  points?: MapPoint[];
  people?: MapPerson[];
  zoom?: number;
  className?: string;
  showTrail?: boolean;
  fitTrailBounds?: boolean;
  followMarker?: boolean;
  markerLabel?: string;
  onPersonTap?: (personId: string) => void;
  mapType?: "roadmap" | "satellite" | "terrain" | "hybrid";
  showTraffic?: boolean;
  showMapTypeControl?: boolean;
  showStreetView?: boolean;
  startAddress?: string;
  endAddress?: string;
  routePolyline?: string;
  geofences?: GeofenceCircle[];
  nearbyPlaces?: NearbyPlace[];
  showInfoWindows?: boolean;
  darkMode?: boolean;
  animateMarkers?: boolean;
  heatmapData?: { lat: number; lng: number; weight?: number }[];
  replayMode?: boolean;
  replayIndex?: number;
  safeWalkRoute?: { polyline: string; destLat: number; destLng: number; destName?: string; progress?: number };
  showMyLocation?: boolean;
  onRecenter?: () => void;
  isLocating?: boolean;
  focusPersonId?: string | null;
  smartCamera?: boolean;
  tilt?: number;
  heading?: number;
}

const activityColors: Record<string, string> = {
  stationary: "#9ca3af",
  walking: "#22c55e",
  running: "#f97316",
  cycling: "#3b82f6",
  driving: "#a855f7",
};

const activityLabels: Record<string, string> = {
  stationary: "Stationary",
  walking: "Walking",
  running: "Running",
  cycling: "Cycling",
  driving: "Driving",
};

function createMarkerElement(activity?: string | null): HTMLElement {
  const color = activityColors[activity || "stationary"] || "#3b82f6";
  const container = document.createElement("div");
  container.style.cssText = "position:relative;width:36px;height:36px;transition:transform 0.5s ease";
  container.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.3;animation:gmap-pulse 1.5s ease-out infinite"></div>
    <div style="position:absolute;top:4px;left:4px;width:28px;height:28px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3)"></div>
  `;
  ensurePulseStyle();
  return container;
}

function getSafetyColor(person: MapPerson): string {
  if (person.isMe) return "#3b82f6";
  if (person.safetyState === "concern") return "#ef4444";
  if (person.hasSafetyEvent) return "#ef4444";
  if (person.safetyState === "quiet") return "#f59e0b";
  return "#22c55e";
}

function getSafetyLabel(person: MapPerson): string | null {
  if (person.isMe) return null;
  if (person.safetyState === "concern") return "Concern";
  if (person.safetyState === "quiet") return "Quiet";
  if (person.hasSafetyEvent) return "Help";
  return null;
}

function getActivityGlyphSvg(activity: string | null | undefined, color: string): string {
  switch (activity) {
    case "driving":
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="${color}" aria-hidden="true"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H19v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-1h-.5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1H5zm2.2 0h9.6l-1-3H8.2l-1 3zM7 14a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm10 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg>`;
    case "cycling":
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="${color}" aria-hidden="true"><circle cx="5.5" cy="17.5" r="3.5" fill="none" stroke="${color}" stroke-width="1.6"/><circle cx="18.5" cy="17.5" r="3.5" fill="none" stroke="${color}" stroke-width="1.6"/><path d="M15 4a1 1 0 1 1 .001 2.001A1 1 0 0 1 15 4zm-3.5 4l2 2.5-3 3 2 2v3h-2v-2l-3-3 4-4-1.5-2H7V6h3l1.5 2z"/></svg>`;
    case "running":
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="${color}" aria-hidden="true" class="gmap-walk"><path d="M13.5 5.5a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zM10 22l1.6-7-2.4-2 .9-4.8c.2-1 1.1-1.7 2-1.5l3.4.6c.4.1.8.4 1 .8l1.5 3 2.6.5-.4 1.9-3.6-.7-1.3-2.6-.7 3.5 2.4 2L16.4 22h-2l-.9-4.4-2.2-2.1L10 22H8z"/></svg>`;
    case "walking":
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="${color}" aria-hidden="true" class="gmap-walk"><path d="M13 4a1.8 1.8 0 1 1 0-3.6A1.8 1.8 0 0 1 13 4zm-2.6 18l1.4-6.5-2.2-2 .8-4.6c.2-1.1 1.2-1.8 2.2-1.6l3.2.6c.4.1.7.4.9.7l1.5 3 2.6.6-.4 1.9-3.5-.7-1.4-2.7-.7 3.5 2.3 2L15.6 22h-2l-1-4.6-2-1.9L9.4 22H7.4z"/></svg>`;
    default:
      return "";
  }
}

function createPersonMarker(person: MapPerson): HTMLElement {
  const color = getSafetyColor(person);
  const safetyLabel = getSafetyLabel(person);
  const activity = person.activity || "stationary";
  const isMoving = activity !== "stationary" && activity !== null;
  const shouldPulse = person.safetyState === "concern" || person.hasSafetyEvent;
  const isGroup = !!(person.groupedNames && person.groupedNames.length > 1);

  const displayName = isGroup
    ? person.groupedNames!.length <= 2
      ? person.groupedNames!.map(firstName).join(" + ")
      : `${firstName(person.groupedNames![0])} + ${person.groupedNames!.length - 1}`
    : person.isMe
    ? "You"
    : firstName(person.name);

  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;transition:transform 0.25s ease";

  // Subtle bob for movers, none for stationary (battery + visual calm)
  const bobAnim = isMoving ? "animation:gmap-bob 2.4s ease-in-out infinite;" : "";

  // Pill background by safety
  const pillBg = person.safetyState === "concern"
    ? "rgba(254, 242, 242, 0.97)"
    : person.safetyState === "quiet"
    ? "rgba(255, 251, 235, 0.97)"
    : person.isMe
    ? "rgba(239, 246, 255, 0.97)"
    : "rgba(255, 255, 255, 0.97)";
  const pillBorder = person.safetyState === "concern"
    ? "#fca5a5"
    : person.safetyState === "quiet"
    ? "#fcd34d"
    : person.isMe
    ? "#bfdbfe"
    : "#e5e7eb";
  const pillText = person.safetyState === "concern"
    ? "#991b1b"
    : person.safetyState === "quiet"
    ? "#92400e"
    : "#0f172a";

  // Glyph (activity icon)  -  cars rotate with heading, others sit still
  const glyphSvg = isMoving ? getActivityGlyphSvg(activity, color) : "";
  const headingDeg = activity === "driving" && typeof person.heading === "number"
    ? Math.round(person.heading) - 90  // car SVG faces "right" (east), so subtract 90 to align north=0
    : 0;
  const glyphRotate = activity === "driving" ? `transform:rotate(${headingDeg}deg);transition:transform 0.6s ease;` : "";

  // Pin tail (the little anchor under the pill)
  const tailHtml = `<div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${pillBorder};margin-top:-1px"><div style="width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid ${pillBg};margin:-6px 0 0 -4px"></div></div>`;

  // Concern halo
  const halo = shouldPulse
    ? `<div style="position:absolute;inset:-6px;border-radius:9999px;border:2px solid ${color};opacity:0.55;animation:gmap-pulse 1.6s ease-out infinite;pointer-events:none"></div>`
    : "";

  // Status dot
  const statusDot = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};box-shadow:0 0 0 1.5px white"></span>`;

  // Glyph cell  -  bigger if it's a group (carpool look)
  const glyphCell = glyphSvg
    ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;${glyphRotate}">${glyphSvg}</span>`
    : statusDot;

  container.innerHTML = `
    <div style="position:relative;display:inline-flex;align-items:center;gap:6px;background:${pillBg};color:${pillText};border:1px solid ${pillBorder};border-radius:9999px;padding:4px 10px 4px 8px;box-shadow:0 4px 14px rgba(15,23,42,0.18),0 1px 2px rgba(15,23,42,0.08);backdrop-filter:blur(6px);max-width:200px;font-family:system-ui,-apple-system,sans-serif;font-size:12px;font-weight:600;line-height:1;white-space:nowrap;${bobAnim}">
      ${halo}
      ${glyphCell}
      <span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(displayName)}</span>
      ${safetyLabel ? `<span style="display:inline-flex;align-items:center;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:${color};background:rgba(255,255,255,0.6);padding:2px 5px;border-radius:9999px;border:1px solid ${pillBorder}">${escapeHtml(safetyLabel)}</span>` : ""}
    </div>
    ${tailHtml}
  `;
  ensurePulseStyle();
  return container;
}

function firstName(name: string): string {
  if (!name) return "?";
  const trimmed = name.trim();
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

function clusterPeople(input: MapPerson[]): MapPerson[] {
  // Group people who are within ~50m AND moving with the same activity (e.g. carpool).
  const GROUP_RADIUS_METERS = 50;
  const result: MapPerson[] = [];
  const used = new Set<number>();

  function meters(a: MapPerson, b: MapPerson): number {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  for (let i = 0; i < input.length; i++) {
    if (used.has(i)) continue;
    const seed = input[i];
    used.add(i);

    const isMover = seed.activity && seed.activity !== "stationary" && !seed.isMe;
    if (!isMover) {
      result.push(seed);
      continue;
    }

    const cluster: MapPerson[] = [seed];
    for (let j = i + 1; j < input.length; j++) {
      if (used.has(j)) continue;
      const cand = input[j];
      if (cand.isMe) continue;
      if (cand.activity !== seed.activity) continue;
      if (meters(seed, cand) > GROUP_RADIUS_METERS) continue;
      cluster.push(cand);
      used.add(j);
    }

    if (cluster.length === 1) {
      result.push(seed);
    } else {
      // Merge into one virtual moving marker. Use the freshest/fastest member's
      // exact pin instead of an averaged midpoint so a shared car stays pinned
      // to a real device location.
      const fastest = cluster.reduce((m, p) => ((p.speed ?? 0) > (m.speed ?? 0) ? p : m), cluster[0]);
      const freshest = cluster.reduce((m, p) => {
        const mt = m.lastUpdated ? new Date(m.lastUpdated).getTime() : 0;
        const pt = p.lastUpdated ? new Date(p.lastUpdated).getTime() : 0;
        return pt > mt ? p : m;
      }, fastest);
      const worstState = cluster.find(p => p.safetyState === "concern")
        ?? cluster.find(p => p.hasSafetyEvent)
        ?? cluster.find(p => p.safetyState === "quiet")
        ?? cluster[0];
      result.push({
        id: "group:" + cluster.map(p => p.id).sort().join("+"),
        name: cluster.map(p => p.name).join(", "),
        lat: freshest.lat,
        lng: freshest.lng,
        activity: seed.activity,
        speed: fastest.speed,
        heading: fastest.heading,
        accuracy: freshest.accuracy ?? fastest.accuracy ?? null,
        lastUpdated: cluster.map(p => p.lastUpdated).filter(Boolean).sort().pop(),
        safetyState: worstState.safetyState,
        hasSafetyEvent: cluster.some(p => p.hasSafetyEvent),
        groupedNames: cluster.map(p => p.name),
      });
    }
  }
  return result;
}

function createLabelMarker(letter: string, color: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `background:${color};color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)`;
  el.textContent = letter;
  return el;
}

function createPlaceMarker(type: "hospital" | "police" | "fire_station"): HTMLElement {
  const icons: Record<string, { emoji: string; bg: string }> = {
    hospital: { emoji: "🏥", bg: "#ef4444" },
    police: { emoji: "👮", bg: "#3b82f6" },
    fire_station: { emoji: "🚒", bg: "#f97316" },
  };
  const { emoji, bg } = icons[type] || icons.hospital;
  const el = document.createElement("div");
  el.style.cssText = `background:${bg};border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)`;
  el.textContent = emoji;
  return el;
}

function createDestinationMarker(name?: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:2px";
  el.innerHTML = `
    <div style="background:#ef4444;color:white;border-radius:50% 50% 50% 0;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;transform:rotate(-45deg);border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)">
      <span style="transform:rotate(45deg)">📍</span>
    </div>
    ${name ? `<div style="background:white;border-radius:12px;padding:1px 6px;font-size:10px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);border:1px solid #e5e7eb;max-width:120px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>` : ""}
  `;
  return el;
}

function ensurePulseStyle() {
  if (!document.getElementById("gmap-pulse-style")) {
    const style = document.createElement("style");
    style.id = "gmap-pulse-style";
    style.textContent = `
      @keyframes gmap-pulse{0%{transform:scale(0.8);opacity:0.4}100%{transform:scale(1.6);opacity:0}}
      @keyframes gmap-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
      @keyframes gmap-walk{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-1px) rotate(2deg)}}
      .gmap-walk{transform-origin:50% 80%;animation:gmap-walk 0.55s ease-in-out infinite}
    `;
    document.head.appendChild(style);
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatInfoSpeed(speed: number | null | undefined): string {
  if (speed == null || speed < 0.5) return "0 km/h";
  return `${Math.round(speed * 3.6)} km/h`;
}

const FOCUS_MIN_ZOOM = 14;
const SELECTED_PERSON_ZOOM = 17;
const OVERVIEW_MIN_ZOOM = 3;
const OVERVIEW_MAX_ZOOM = 16;
const MAX_ZOOM = 18;

function isPersonCameraEligible(p: MapPerson): boolean {
  if (p.accuracy != null && p.accuracy > 500) return false;
  if (p.lastUpdated) {
    const age = Date.now() - new Date(p.lastUpdated).getTime();
    if (age > 180_000) return false;
  }
  return true;
}

function getVelocityZoom(people: MapPerson[]): number {
  let maxSpeedMs = 0;
  for (const p of people) {
    if (p.speed != null && p.speed > maxSpeedMs) maxSpeedMs = p.speed;
  }
  const speedKmh = maxSpeedMs * 3.6;
  if (speedKmh > 60) return 14;
  if (speedKmh > 15) return 15;
  if (speedKmh > 3) return 16;
  return 17;
}

function determineFocusTarget(people: MapPerson[], focusOverride?: string | null): MapPerson | null {
  if (!people.length) return null;

  const eligible = people.filter(isPersonCameraEligible);
  if (!eligible.length) return people.find(p => p.isMe) || people[0];

  const concern = eligible.filter(p => p.safetyState === "concern");
  if (concern.length) {
    concern.sort((a, b) => {
      const ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
      const tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
      return tb - ta;
    });
    return concern[0];
  }

  const safetyEvent = eligible.filter(p => p.hasSafetyEvent);
  if (safetyEvent.length) {
    safetyEvent.sort((a, b) => {
      const ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
      const tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
      return tb - ta;
    });
    return safetyEvent[0];
  }

  if (focusOverride) {
    const found = eligible.find(p => p.id === focusOverride);
    if (found) return found;
  }

  const moving = eligible.filter(p => p.speed != null && p.speed > 1);
  if (moving.length) {
    moving.sort((a, b) => (b.speed || 0) - (a.speed || 0));
    return moving[0];
  }

  return eligible.find(p => p.isMe) || eligible[0];
}

const activeAnimations = new WeakMap<google.maps.marker.AdvancedMarkerElement, number>();

function personVisualSignature(p: MapPerson): string {
  return [
    p.activity ?? "",
    p.safetyState ?? "",
    p.hasSafetyEvent ? 1 : 0,
    p.isMe ? 1 : 0,
    p.name,
    (p.groupedNames || []).join("|"),
    p.incidentReason ?? "",
    p.safetyStateReason ?? "",
  ].join("\u0001");
}
const personSignatures = new WeakMap<google.maps.marker.AdvancedMarkerElement, string>();

function animateMarkerPosition(
  marker: google.maps.marker.AdvancedMarkerElement,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  duration = 800,
  onStep?: (pos: { lat: number; lng: number }) => void
) {
  const prev = activeAnimations.get(marker);
  if (prev) cancelAnimationFrame(prev);

  const start = performance.now();
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const useLinear = duration > 1500;

  function step(now: number) {
    const elapsed = now - start;
    const t = Math.min(elapsed / duration, 1);
    const eased = useLinear ? t : (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
    const pos = {
      lat: from.lat + dLat * eased,
      lng: from.lng + dLng * eased,
    };
    marker.position = pos;
    if (onStep) onStep(pos);
    if (t < 1) {
      const id = requestAnimationFrame(step);
      activeAnimations.set(marker, id);
    } else {
      activeAnimations.delete(marker);
    }
  }
  const id = requestAnimationFrame(step);
  activeAnimations.set(marker, id);
}

export default function GoogleMapComponent({
  center,
  points,
  people,
  zoom = 16,
  className = "w-full h-full min-h-64",
  showTrail = true,
  fitTrailBounds = true,
  followMarker = false,
  markerLabel,
  onPersonTap,
  mapType = "roadmap",
  showTraffic = false,
  showMapTypeControl = true,
  showStreetView = false,
  startAddress,
  endAddress,
  routePolyline,
  geofences,
  nearbyPlaces,
  showInfoWindows = true,
  darkMode = false,
  animateMarkers = true,
  heatmapData,
  replayMode = false,
  replayIndex = 0,
  safeWalkRoute,
  showMyLocation = false,
  onRecenter,
  isLocating = false,
  focusPersonId,
  smartCamera = false,
  tilt,
  heading,
}: GoogleMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const peopleMarkersRef = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
  const peoplePositionsRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const peopleDataRef = useRef<Map<string, MapPerson>>(new Map());
  const lastUpdateAtRef = useRef<number>(0);
  const idleResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accuracyCirclesRef = useRef<Map<string, google.maps.Circle>>(new Map());
  const trailPolylinesRef = useRef<google.maps.Polyline[]>([]);
  const routePolylineRef = useRef<google.maps.Polyline | null>(null);
  const trafficLayerRef = useRef<google.maps.TrafficLayer | null>(null);
  const startMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const endMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const geofenceCirclesRef = useRef<google.maps.Circle[]>([]);
  const geofenceLabelsRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const nearbyMarkersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const heatmapRef = useRef<google.maps.visualization.HeatmapLayer | null>(null);
  const replayMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const replayTrailRef = useRef<google.maps.Polyline | null>(null);
  const safeWalkPolylineRef = useRef<google.maps.Polyline | null>(null);
  const safeWalkDestMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const prevCenterRef = useRef<{ lat: number; lng: number } | null>(null);
  const userInteractedRef = useRef(false);
  const initialFitDoneRef = useRef(false);
  const programmaticMoveRef = useRef(false);
  const myLocationMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const mapListenersRef = useRef<google.maps.MapsEventListener[]>([]);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [showRecenter, setShowRecenter] = useState(false);
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
      tilt: typeof tilt === "number" ? tilt : undefined,
      heading: typeof heading === "number" ? heading : undefined,
    });

    mapInstanceRef.current = map;
    infoWindowRef.current = new google.maps.InfoWindow();

    const onUserInteract = () => {
      userInteractedRef.current = true;
      setShowRecenter(true);
      if (idleResumeTimerRef.current) clearTimeout(idleResumeTimerRef.current);
      if (followMarker || smartCamera) {
        idleResumeTimerRef.current = setTimeout(() => {
          userInteractedRef.current = false;
          setShowRecenter(false);
          const m = mapInstanceRef.current;
          if (m) {
            programmaticMoveRef.current = true;
            m.panTo({ lat: center.lat, lng: center.lng });
            setTimeout(() => { programmaticMoveRef.current = false; }, 300);
          }
        }, 6000);
      }
    };
    const l1 = map.addListener("dragstart", onUserInteract);
    const l2 = map.addListener("zoom_changed", () => {
      if (programmaticMoveRef.current) return;
      if (initRef.current) onUserInteract();
    });
    mapListenersRef.current = [l1, l2];

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

    prevCenterRef.current = { lat: center.lat, lng: center.lng };
  }, [mapsLoaded]);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;
    if (darkMode) {
      map.setOptions({ styles: DARK_STYLES as any });
    } else {
      map.setOptions({ styles: [] });
    }
  }, [darkMode, mapsLoaded]);

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

      const renderPeople = clusterPeople(people);
      const currentIds = new Set(renderPeople.map(p => p.id));
      peopleMarkersRef.current.forEach((marker, id) => {
        if (!currentIds.has(id)) {
          marker.map = null;
          peopleMarkersRef.current.delete(id);
          peoplePositionsRef.current.delete(id);
          peopleDataRef.current.delete(id);
          accuracyCirclesRef.current.get(id)?.setMap(null);
          accuracyCirclesRef.current.delete(id);
        }
      });

      renderPeople.forEach(person => {
        peopleDataRef.current.set(person.id, person);
        const existing = peopleMarkersRef.current.get(person.id);
        const prevPos = peoplePositionsRef.current.get(person.id);
        const newPos = { lat: person.lat, lng: person.lng };

        const accRadius = person.accuracy != null && person.accuracy > 10 ? person.accuracy : 0;
        const existingCircle = accuracyCirclesRef.current.get(person.id);
        const circleColor = person.isMe ? "#3b82f6" : "#8b5cf6";
        if (accRadius > 0 && accRadius < 500) {
          if (existingCircle) {
            existingCircle.setCenter(newPos);
            existingCircle.setRadius(accRadius);
          } else {
            const circle = new google.maps.Circle({
              map,
              center: newPos,
              radius: accRadius,
              fillColor: circleColor,
              fillOpacity: 0.08,
              strokeColor: circleColor,
              strokeOpacity: 0.25,
              strokeWeight: 1,
              clickable: false,
              zIndex: person.isMe ? 500 : 0,
            });
            accuracyCirclesRef.current.set(person.id, circle);
          }
        } else if (existingCircle) {
          existingCircle.setMap(null);
          accuracyCirclesRef.current.delete(person.id);
        }

        if (existing) {
          if (animateMarkers && prevPos) {
            animateMarkerPosition(existing, prevPos, newPos);
          } else {
            existing.position = newPos;
          }
          const sig = personVisualSignature(person);
          if (personSignatures.get(existing) !== sig) {
            existing.content = createPersonMarker(person);
            personSignatures.set(existing, sig);
          }
        } else {
          const marker = new google.maps.marker.AdvancedMarkerElement({
            map,
            position: newPos,
            content: createPersonMarker(person),
            title: person.name,
            zIndex: person.isMe ? 1000 : 0,
          });
          personSignatures.set(marker, personVisualSignature(person));

          const personId = person.id;
          marker.addListener("click", () => {
            const current = peopleDataRef.current.get(personId) ?? person;
            if (onPersonTap && !current.isMe) {
              onPersonTap(current.id);
            }
            if (showInfoWindows && infoWindowRef.current) {
              const actLabel = activityLabels[current.activity || "stationary"] || "Stationary";
              const actColor = activityColors[current.activity || "stationary"] || "#9ca3af";
              const speedStr = formatInfoSpeed(current.speed);
              const timeStr = current.lastUpdated
                ? new Date(current.lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : "";
              const isConcern = current.safetyState === "concern";
              const incidentLabels: Record<string, string> = {
                sos: "SOS triggered",
                missed_checkin: "Missed check-in",
                test: "Safety drill",
              };
              const concernText = current.incidentReason
                ? incidentLabels[current.incidentReason] || current.incidentReason
                : current.safetyStateReason || "Needs attention";
              infoWindowRef.current.setContent(`
                <div style="font-family:system-ui;min-width:160px;max-width:220px;padding:4px 0">
                  <div style="font-weight:700;font-size:14px;margin-bottom:6px">${escapeHtml(current.name)}${current.isMe ? " (You)" : ""}</div>
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${actColor}"></span>
                    <span style="font-size:13px">${escapeHtml(actLabel)}</span>
                  </div>
                  <div style="font-size:12px;color:#666;display:flex;gap:12px">
                    <span>🏎️ ${escapeHtml(speedStr)}</span>
                    ${timeStr ? `<span>🕐 ${escapeHtml(timeStr)}</span>` : ""}
                  </div>
                  ${isConcern ? `
                    <div style="margin-top:8px;padding:6px 8px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px">
                      <div style="font-size:11px;font-weight:700;color:#b91c1c;letter-spacing:0.04em">CONCERN</div>
                      <div style="font-size:12px;color:#7f1d1d;margin-top:2px;line-height:1.3">${escapeHtml(concernText)}</div>
                    </div>
                  ` : ""}
                </div>
              `);
              infoWindowRef.current.open(map, marker);
            }
          });

          peopleMarkersRef.current.set(person.id, marker);
        }
        peoplePositionsRef.current.set(person.id, newPos);
      });

      if (smartCamera) {
        const hasSafetyOverride = people.some(p => p.safetyState === "concern");
        if (hasSafetyOverride) {
          userInteractedRef.current = false;
          setShowRecenter(false);
        }
        if (isLocating) {
          // skip
        } else if (!userInteractedRef.current) {
          const hasSafetyPriority = people.some(p => p.safetyState === "concern");
          const focus = determineFocusTarget(people, focusPersonId);
          const eligible = people.filter(isPersonCameraEligible);
          const explicitFocus = focusPersonId ? people.find(p => p.id === focusPersonId) : null;

          programmaticMoveRef.current = true;

          if (explicitFocus) {
            map.panTo({ lat: explicitFocus.lat, lng: explicitFocus.lng });
            map.setZoom(SELECTED_PERSON_ZOOM);
          } else if (hasSafetyPriority && focus) {
            const vZoom = getVelocityZoom([focus]);
            map.panTo({ lat: focus.lat, lng: focus.lng });
            map.setZoom(Math.max(FOCUS_MIN_ZOOM, Math.min(MAX_ZOOM, vZoom)));
          } else if (eligible.length > 1) {
            const bounds = new google.maps.LatLngBounds();
            eligible.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
            map.fitBounds(bounds, 50);
            const listener = map.addListener("idle", () => {
              const z = map.getZoom();
              if (z != null && z < OVERVIEW_MIN_ZOOM) map.setZoom(OVERVIEW_MIN_ZOOM);
              if (z != null && z > OVERVIEW_MAX_ZOOM) map.setZoom(OVERVIEW_MAX_ZOOM);
              google.maps.event.removeListener(listener);
            });
          } else if (focus) {
            const vZoom = getVelocityZoom(eligible.length ? eligible : [focus]);
            map.panTo({ lat: focus.lat, lng: focus.lng });
            map.setZoom(Math.max(FOCUS_MIN_ZOOM, Math.min(MAX_ZOOM, vZoom)));
          }

          initialFitDoneRef.current = true;
          setTimeout(() => { programmaticMoveRef.current = false; }, 300);
        }
      } else if (!initialFitDoneRef.current || !userInteractedRef.current) {
        initialFitDoneRef.current = true;
        programmaticMoveRef.current = true;
        if (people.length > 1) {
          const bounds = new google.maps.LatLngBounds();
          people.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
          map.fitBounds(bounds, 50);
        } else {
          map.panTo({ lat: people[0].lat, lng: people[0].lng });
        }
        setTimeout(() => { programmaticMoveRef.current = false; }, 300);
      }
    } else if (markersRef.current.length > 0) {
      const marker = markersRef.current[0];
      const prevPos = prevCenterRef.current;
      const newPos = { lat: center.lat, lng: center.lng };

      if (animateMarkers && prevPos && (prevPos.lat !== newPos.lat || prevPos.lng !== newPos.lng)) {
        const now = performance.now();
        const lastT = lastUpdateAtRef.current;
        lastUpdateAtRef.current = now;
        const gap = lastT ? now - lastT : 0;
        const duration = gap > 1200 ? Math.min(Math.max(gap, 1500), 8000) : 800;
        const onStep = followMarker && !userInteractedRef.current
          ? (pos: { lat: number; lng: number }) => {
              programmaticMoveRef.current = true;
              map.panTo(pos);
            }
          : undefined;
        animateMarkerPosition(marker, prevPos, newPos, duration, onStep);
      } else {
        marker.position = newPos;
        if (followMarker && !userInteractedRef.current) {
          programmaticMoveRef.current = true;
          map.panTo(newPos);
          setTimeout(() => { programmaticMoveRef.current = false; }, 300);
        }
      }
      marker.content = createMarkerElement(points?.[points.length - 1]?.activity);
      if (!followMarker && !userInteractedRef.current) {
        programmaticMoveRef.current = true;
        map.panTo(newPos);
        setTimeout(() => { programmaticMoveRef.current = false; }, 300);
      }
      prevCenterRef.current = newPos;
    }
  }, [center.lat, center.lng, points, people, focusPersonId, isLocating, smartCamera]);

  // When a parent component changes focusPersonId (e.g. user taps a member chip
  // outside the map), clear the "user has interacted" flag so smartCamera will
  // actually re-zoom onto the new focus instead of staying frozen.
  useEffect(() => {
    if (focusPersonId === undefined) return;
    userInteractedRef.current = false;
    setShowRecenter(false);
  }, [focusPersonId]);

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

    if (fitTrailBounds && points.length > 2 && !userInteractedRef.current) {
      programmaticMoveRef.current = true;
      const bounds = new google.maps.LatLngBounds();
      points.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
      map.fitBounds(bounds, 40);
      setTimeout(() => { programmaticMoveRef.current = false; }, 300);
    }
  }, [points, showTrail, fitTrailBounds]);

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
      decodedPath.forEach((p: google.maps.LatLngLiteral) => bounds.extend(p));
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
    const map = mapInstanceRef.current;
    if (!map || !mapsLoaded) return;

    geofenceCirclesRef.current.forEach(c => c.setMap(null));
    geofenceCirclesRef.current = [];
    geofenceLabelsRef.current.forEach(m => m.map = null);
    geofenceLabelsRef.current = [];

    if (!geofences || geofences.length === 0) return;

    geofences.forEach(gf => {
      const circle = new google.maps.Circle({
        map,
        center: { lat: gf.lat, lng: gf.lng },
        radius: gf.radiusMeters,
        fillColor: "#3b82f6",
        fillOpacity: 0.08,
        strokeColor: "#3b82f6",
        strokeWeight: 2,
        strokeOpacity: 0.4,
        clickable: false,
      });
      geofenceCirclesRef.current.push(circle);

      const labelEl = document.createElement("div");
      labelEl.style.cssText = "background:rgba(59,130,246,0.9);color:white;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2)";
      labelEl.textContent = gf.name;
      const labelMarker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: gf.lat, lng: gf.lng },
        content: labelEl,
        zIndex: 500,
      });
      geofenceLabelsRef.current.push(labelMarker);
    });
  }, [geofences, mapsLoaded]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapsLoaded) return;

    nearbyMarkersRef.current.forEach(m => m.map = null);
    nearbyMarkersRef.current = [];

    if (!nearbyPlaces || nearbyPlaces.length === 0) return;

    nearbyPlaces.forEach(place => {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: place.lat, lng: place.lng },
        content: createPlaceMarker(place.type),
        title: place.name,
        zIndex: 100,
      });

      marker.addListener("click", () => {
        if (infoWindowRef.current) {
          const typeLabels: Record<string, string> = { hospital: "Hospital", police: "Police Station", fire_station: "Fire Station" };
          infoWindowRef.current.setContent(`
            <div style="font-family:system-ui;padding:4px 0">
              <div style="font-weight:700;font-size:13px">${escapeHtml(place.name)}</div>
              <div style="font-size:12px;color:#666;margin-top:2px">${escapeHtml(typeLabels[place.type] || place.type)}</div>
              <a href="https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}" target="_blank" rel="noopener" style="font-size:12px;color:#3b82f6;text-decoration:none;display:block;margin-top:4px">Get directions ↗</a>
            </div>
          `);
          infoWindowRef.current.open(map, marker);
        }
      });

      nearbyMarkersRef.current.push(marker);
    });
  }, [nearbyPlaces, mapsLoaded]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapsLoaded) return;

    heatmapRef.current?.setMap(null);
    heatmapRef.current = null;

    if (!heatmapData || heatmapData.length === 0) return;

    try {
      const heatmapPoints = heatmapData.map(p => ({
        location: new google.maps.LatLng(p.lat, p.lng),
        weight: p.weight || 1,
      }));

      heatmapRef.current = new google.maps.visualization.HeatmapLayer({
        data: heatmapPoints,
        map,
        radius: 30,
        opacity: 0.6,
        gradient: [
          "rgba(0, 255, 255, 0)",
          "rgba(0, 255, 255, 1)",
          "rgba(0, 191, 255, 1)",
          "rgba(0, 127, 255, 1)",
          "rgba(0, 63, 255, 1)",
          "rgba(0, 0, 255, 1)",
          "rgba(0, 0, 223, 1)",
          "rgba(0, 0, 191, 1)",
          "rgba(0, 0, 159, 1)",
          "rgba(0, 0, 127, 1)",
          "rgba(63, 0, 91, 1)",
          "rgba(127, 0, 63, 1)",
          "rgba(191, 0, 31, 1)",
          "rgba(255, 0, 0, 1)",
        ],
      });
    } catch {}
  }, [heatmapData, mapsLoaded]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapsLoaded || !replayMode || !points || points.length === 0) {
      if (replayMarkerRef.current) {
        replayMarkerRef.current.map = null;
        replayMarkerRef.current = null;
      }
      if (replayTrailRef.current) {
        replayTrailRef.current.setMap(null);
        replayTrailRef.current = null;
      }
      return;
    }

    const idx = Math.min(replayIndex, points.length - 1);
    const pt = points[idx];

    if (!replayMarkerRef.current) {
      replayMarkerRef.current = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: pt.lat, lng: pt.lng },
        content: createMarkerElement(pt.activity),
        zIndex: 2000,
      });
    } else {
      if (replayMarkerRef.current.map !== map) {
        replayMarkerRef.current.map = map;
      }
      const prevIdx = Math.max(0, idx - 1);
      const prevPt = points[prevIdx];
      animateMarkerPosition(replayMarkerRef.current, { lat: prevPt.lat, lng: prevPt.lng }, { lat: pt.lat, lng: pt.lng }, 300);
      replayMarkerRef.current.content = createMarkerElement(pt.activity);
    }

    replayTrailRef.current?.setMap(null);
    const replayPath = points.slice(0, idx + 1).map(p => ({ lat: p.lat, lng: p.lng }));
    if (replayPath.length >= 2) {
      replayTrailRef.current = new google.maps.Polyline({
        path: replayPath,
        strokeColor: "#3b82f6",
        strokeWeight: 4,
        strokeOpacity: 0.8,
        map,
      });
    }

    map.panTo({ lat: pt.lat, lng: pt.lng });
  }, [replayMode, replayIndex, points, mapsLoaded]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapsLoaded) return;

    safeWalkPolylineRef.current?.setMap(null);
    safeWalkPolylineRef.current = null;
    if (safeWalkDestMarkerRef.current) safeWalkDestMarkerRef.current.map = null;
    safeWalkDestMarkerRef.current = null;

    if (!safeWalkRoute) return;

    try {
      if (safeWalkRoute.polyline) {
        const decodedPath = google.maps.geometry.encoding.decodePath(safeWalkRoute.polyline);
        safeWalkPolylineRef.current = new google.maps.Polyline({
          path: decodedPath,
          strokeColor: "#10b981",
          strokeWeight: 4,
          strokeOpacity: 0.6,
          icons: [{
            icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 3, strokeColor: "#10b981" },
            offset: "50%",
          }],
          map,
        });
      }

      safeWalkDestMarkerRef.current = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: safeWalkRoute.destLat, lng: safeWalkRoute.destLng },
        content: createDestinationMarker(safeWalkRoute.destName),
        zIndex: 900,
      });
    } catch {}
  }, [safeWalkRoute, mapsLoaded]);

  useEffect(() => {
    return () => {
      markersRef.current.forEach(m => m.map = null);
      markersRef.current = [];
      peopleMarkersRef.current.forEach(m => m.map = null);
      peopleMarkersRef.current.clear();
      peoplePositionsRef.current.clear();
      peopleDataRef.current.clear();
      trailPolylinesRef.current.forEach(p => p.setMap(null));
      trailPolylinesRef.current = [];
      routePolylineRef.current?.setMap(null);
      trafficLayerRef.current?.setMap(null);
      if (startMarkerRef.current) startMarkerRef.current.map = null;
      if (endMarkerRef.current) endMarkerRef.current.map = null;
      geofenceCirclesRef.current.forEach(c => c.setMap(null));
      geofenceLabelsRef.current.forEach(m => m.map = null);
      nearbyMarkersRef.current.forEach(m => m.map = null);
      heatmapRef.current?.setMap(null);
      if (replayMarkerRef.current) replayMarkerRef.current.map = null;
      replayTrailRef.current?.setMap(null);
      safeWalkPolylineRef.current?.setMap(null);
      if (safeWalkDestMarkerRef.current) safeWalkDestMarkerRef.current.map = null;
      if (myLocationMarkerRef.current) myLocationMarkerRef.current.map = null;
      accuracyCirclesRef.current.forEach(c => c.setMap(null));
      accuracyCirclesRef.current.clear();
      infoWindowRef.current?.close();
      mapListenersRef.current.forEach(l => google.maps.event.removeListener(l));
      mapListenersRef.current = [];
      initRef.current = false;
      initialFitDoneRef.current = false;
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

  const handleRecenter = () => {
    const map = mapInstanceRef.current;
    if (!map) return;
    userInteractedRef.current = false;
    setShowRecenter(false);
    programmaticMoveRef.current = true;

    if (smartCamera && people && people.length > 0) {
      const focus = determineFocusTarget(people, focusPersonId);
      const eligible = people.filter(isPersonCameraEligible);
      const explicitFocus = focusPersonId ? people.find(p => p.id === focusPersonId) : null;
      if (explicitFocus) {
        map.panTo({ lat: explicitFocus.lat, lng: explicitFocus.lng });
        map.setZoom(SELECTED_PERSON_ZOOM);
      } else if (eligible.length > 1 && !people.some(p => p.safetyState === "concern")) {
        const bounds = new google.maps.LatLngBounds();
        eligible.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
        map.fitBounds(bounds, 50);
        const listener = map.addListener("idle", () => {
          const z = map.getZoom();
          if (z != null && z < OVERVIEW_MIN_ZOOM) map.setZoom(OVERVIEW_MIN_ZOOM);
          if (z != null && z > OVERVIEW_MAX_ZOOM) map.setZoom(OVERVIEW_MAX_ZOOM);
          google.maps.event.removeListener(listener);
        });
      } else if (focus) {
        const vZoom = getVelocityZoom(eligible.length ? eligible : [focus]);
        map.panTo({ lat: focus.lat, lng: focus.lng });
        map.setZoom(Math.max(FOCUS_MIN_ZOOM, Math.min(MAX_ZOOM, vZoom)));
      }
    } else if (people && people.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      people.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
      map.fitBounds(bounds, 50);
    } else if (people && people.length === 1) {
      map.panTo({ lat: people[0].lat, lng: people[0].lng });
      map.setZoom(zoom);
    } else {
      map.panTo({ lat: center.lat, lng: center.lng });
      map.setZoom(zoom);
    }
    setTimeout(() => { programmaticMoveRef.current = false; }, 300);
  };

  return (
    <>
      <div ref={mapRef} className={`${className} rounded-lg`} data-testid="google-map" />
      {showRecenter && mapRef.current && (
        <button
          onClick={handleRecenter}
          style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 20 }}
          className="bg-white dark:bg-gray-800 shadow-xl rounded-full pl-3 pr-4 py-2 flex items-center gap-2 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          data-testid="button-recenter-map"
          title="Re-center map"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v4" />
            <path d="M12 18v4" />
            <path d="M2 12h4" />
            <path d="M18 12h4" />
          </svg>
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Recenter</span>
        </button>
      )}
    </>
  );
}
