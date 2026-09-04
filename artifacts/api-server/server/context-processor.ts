import { db } from "./db";
import { contextEvents, geofences } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { storage } from "./storage";
import { notifyArrival } from "./notification-engine";

const DWELL_RADIUS_M = 50;
const DWELL_MIN_MS = 5 * 60 * 1000;
const TRIP_CUMULATIVE_DISTANCE_M = 200;
const TRIP_MIN_SPEED_KMH = 10;
const TRIP_END_SLOW_SAMPLES = 3;
const STATE_TTL_MS = 30 * 60 * 1000;

interface UserContextState {
  dwellLat: number | null;
  dwellLng: number | null;
  dwellStartedAt: number | null;
  isDwelling: boolean;
  dwellPlaceName: string | null;
  isTripping: boolean;
  tripStartLat: number | null;
  tripStartLng: number | null;
  tripStartedAt: number | null;
  tripCumulativeDistanceM: number;
  slowSampleCount: number;
  lastActivity: string;
  lastLat: number | null;
  lastLng: number | null;
  lastUpdateAt: number;
}

const userStates = new Map<string, UserContextState>();
const userLocks = new Map<string, Promise<void>>();

function getState(userId: string): UserContextState {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      dwellLat: null, dwellLng: null, dwellStartedAt: null,
      isDwelling: false, dwellPlaceName: null,
      isTripping: false, tripStartLat: null, tripStartLng: null, tripStartedAt: null,
      tripCumulativeDistanceM: 0, slowSampleCount: 0,
      lastActivity: "stationary",
      lastLat: null, lastLng: null, lastUpdateAt: Date.now(),
    });
  }
  return userStates.get(userId)!;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function withUserLock(userId: string, fn: () => Promise<void>): Promise<void> {
  const prev = userLocks.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn);
  userLocks.set(userId, next);
  await next;
}

async function resolvePlace(userId: string, lat: number, lng: number): Promise<string | null> {
  try {
    const fences = await storage.getGeofences(userId);
    for (const fence of fences) {
      const dist = haversineM(lat, lng, fence.lat, fence.lng);
      if (dist <= fence.radiusMeters) {
        if (fence.type === "home") return "Home";
        if (fence.type === "work") return "Work";
        return fence.name;
      }
    }

    const watchers = await storage.getContactsLinkedToUser(userId);
    for (const contact of watchers) {
      if (contact.linkedUserId) {
        const watcherFences = await storage.getGeofences(contact.linkedUserId);
        for (const fence of watcherFences) {
          const dist = haversineM(lat, lng, fence.lat, fence.lng);
          if (dist <= fence.radiusMeters) {
            if (fence.type === "home") return "Home";
            if (fence.type === "work") return "Work";
            return fence.name;
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[CONTEXT] Geofence lookup failed:`, err?.message || err);
  }

  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (key) {
      const resp = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}&result_type=neighborhood|locality|sublocality`
      );
      const data = await resp.json();
      if (data.results && data.results.length > 0) {
        const components = data.results[0].address_components;
        const neighborhood = components?.find((c: any) => c.types.includes("neighborhood"));
        const sublocality = components?.find((c: any) => c.types.includes("sublocality"));
        const locality = components?.find((c: any) => c.types.includes("locality"));
        const best = neighborhood || sublocality || locality;
        if (best) return best.short_name;
      }
    }
  } catch (err: any) {
    console.error(`[CONTEXT] Reverse geocode failed:`, err?.message || err);
  }

  return null;
}

export async function processLocationContext(
  userId: string,
  lat: number,
  lng: number,
  speed: number | null,
  activity: string
): Promise<void> {
  await withUserLock(userId, async () => {
    const state = getState(userId);
    const now = Date.now();
    const speedKmh = speed != null ? speed * 3.6 : 0;
    state.lastActivity = activity;

    if (state.dwellLat != null && state.dwellLng != null) {
      const distFromDwell = haversineM(state.dwellLat, state.dwellLng, lat, lng);

      if (distFromDwell <= DWELL_RADIUS_M) {
        if (!state.isDwelling && state.dwellStartedAt && (now - state.dwellStartedAt) >= DWELL_MIN_MS) {
          state.isDwelling = true;
          if (!state.dwellPlaceName) {
            state.dwellPlaceName = await resolvePlace(userId, state.dwellLat, state.dwellLng);
          }
          await emitEvent(userId, "dwell_start", state.dwellLat, state.dwellLng, state.dwellPlaceName);
        }
      } else {
        if (state.isDwelling) {
          await emitEvent(userId, "dwell_end", state.dwellLat, state.dwellLng, state.dwellPlaceName);
          state.isDwelling = false;
        }
        state.dwellLat = lat;
        state.dwellLng = lng;
        state.dwellStartedAt = now;
        state.dwellPlaceName = null;
      }
    } else {
      state.dwellLat = lat;
      state.dwellLng = lng;
      state.dwellStartedAt = now;
    }

    if (!state.isTripping) {
      if (state.lastLat != null && state.lastLng != null) {
        const stepDist = haversineM(state.lastLat, state.lastLng, lat, lng);
        if (speedKmh > TRIP_MIN_SPEED_KMH) {
          state.tripCumulativeDistanceM += stepDist;
        } else {
          state.tripCumulativeDistanceM = 0;
        }

        if (state.tripCumulativeDistanceM >= TRIP_CUMULATIVE_DISTANCE_M) {
          state.isTripping = true;
          state.tripStartLat = state.lastLat;
          state.tripStartLng = state.lastLng;
          state.tripStartedAt = now;
          state.slowSampleCount = 0;
          const fromPlace = state.isDwelling ? state.dwellPlaceName : null;
          await emitEvent(userId, "trip_start", state.lastLat, state.lastLng, fromPlace);
          if (state.isDwelling) {
            await emitEvent(userId, "dwell_end", state.dwellLat!, state.dwellLng!, state.dwellPlaceName);
            state.isDwelling = false;
          }
          state.tripCumulativeDistanceM = 0;
        }
      }
    } else {
      if (speedKmh < 5 && activity !== "driving") {
        state.slowSampleCount++;
        if (state.slowSampleCount >= TRIP_END_SLOW_SAMPLES) {
          state.isTripping = false;
          state.slowSampleCount = 0;
          state.tripCumulativeDistanceM = 0;
          const arrivalPlace = await resolvePlace(userId, lat, lng);
          const arrivalLabel = arrivalPlace
            ? `Arrived at ${arrivalPlace}`
            : "Arrived safely";
          await emitEvent(userId, "trip_end", lat, lng, arrivalPlace, arrivalLabel);

          const arrivalUser = await storage.getUser(userId);
          if (arrivalUser) {
            notifyArrival(userId, arrivalUser.name, arrivalPlace).catch(() => {});
          }

          state.dwellLat = lat;
          state.dwellLng = lng;
          state.dwellStartedAt = now;
          state.dwellPlaceName = arrivalPlace;
        }
      } else {
        state.slowSampleCount = 0;
      }
    }

    state.lastLat = lat;
    state.lastLng = lng;
    state.lastUpdateAt = now;
  });
}

async function emitEvent(
  userId: string,
  type: "dwell_start" | "dwell_end" | "trip_start" | "trip_end",
  lat: number,
  lng: number,
  placeName: string | null,
  detail?: string
): Promise<void> {
  try {
    await db.insert(contextEvents).values({
      userId,
      type,
      lat,
      lng,
      placeName,
      detail: detail || null,
    });
  } catch (err) {
    console.error(`[Context] Failed to emit ${type} for ${userId}:`, err);
  }
}

export interface UserContext {
  currentState: "dwelling" | "traveling" | "unknown";
  placeName: string | null;
  dwellingSince: string | null;
  tripStartedAt: string | null;
  contextLine: string;
}

export function getUserContext(userId: string): UserContext {
  const state = getState(userId);
  const now = Date.now();

  if (state.isDwelling && state.dwellStartedAt) {
    const durationMs = now - state.dwellStartedAt;
    const durationStr = formatDuration(durationMs);
    const place = state.dwellPlaceName || "nearby";
    return {
      currentState: "dwelling",
      placeName: state.dwellPlaceName,
      dwellingSince: new Date(state.dwellStartedAt).toISOString(),
      tripStartedAt: null,
      contextLine: `At ${place} for ${durationStr}`,
    };
  }

  if (state.isTripping && state.tripStartedAt) {
    const activity = state.lastActivity;
    let verb = "Heading out";
    if (activity === "driving") verb = "Driving";
    else if (activity === "transit") verb = "On transit";
    else if (activity === "scooter") verb = "On a scooter";
    else if (activity === "walking") verb = "Heading out";
    else if (activity === "running") verb = "On a run";
    else if (activity === "cycling") verb = "Cycling";

    return {
      currentState: "traveling",
      placeName: null,
      dwellingSince: null,
      tripStartedAt: new Date(state.tripStartedAt).toISOString(),
      contextLine: verb,
    };
  }

  return {
    currentState: "unknown",
    placeName: null,
    dwellingSince: null,
    tripStartedAt: null,
    contextLine: "",
  };
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"}`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (remainMins === 0) return `${hrs} ${hrs === 1 ? "hour" : "hours"}`;
  return `${hrs}h ${remainMins}m`;
}

export async function getRecentContextEvents(userId: string, limit: number = 20) {
  return db.select().from(contextEvents)
    .where(eq(contextEvents.userId, userId))
    .orderBy(desc(contextEvents.createdAt))
    .limit(limit);
}

export function setPlaceName(userId: string, name: string): void {
  const state = getState(userId);
  if (state.isDwelling || state.dwellStartedAt) {
    state.dwellPlaceName = name;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of userStates) {
    if (now - state.lastUpdateAt > STATE_TTL_MS) {
      userStates.delete(userId);
      userLocks.delete(userId);
    }
  }
}, 5 * 60 * 1000);
