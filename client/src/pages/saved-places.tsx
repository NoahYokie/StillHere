import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getOneShotPosition } from "@/lib/location-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Plus, MapPin, Home, Briefcase, Trash2, Pencil, Search, X } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { geofences } from "@shared/schema";
type Geofence = typeof geofences.$inferSelect;

interface PlacePrediction {
  placeId: string;
  name: string;
  subtitle: string;
  description: string;
}

const TYPE_ICONS: Record<string, typeof Home> = {
  home: Home,
  work: Briefcase,
  custom: MapPin,
};

const TYPE_LABELS: Record<string, string> = {
  home: "Home",
  work: "Work",
  custom: "Custom",
};

const TYPE_COLORS: Record<string, string> = {
  home: "bg-blue-500",
  work: "bg-purple-500",
  custom: "bg-teal-500",
};

type DistanceUnit = "metric" | "imperial";

// Locales that default to imperial measurements for short distances.
// US, Liberia, Myanmar — everything else defaults to metric.
function detectDefaultUnit(): DistanceUnit {
  if (typeof navigator === "undefined") return "metric";
  const lang = (navigator.language || "").toLowerCase();
  if (lang === "en-us" || lang.startsWith("en-us") || lang === "en-lr" || lang === "my-mm") return "imperial";
  return "metric";
}

function loadUnit(): DistanceUnit {
  if (typeof window === "undefined") return "metric";
  const stored = window.localStorage.getItem("stillhere:distanceUnit");
  if (stored === "metric" || stored === "imperial") return stored;
  return detectDefaultUnit();
}

function saveUnit(u: DistanceUnit) {
  try { window.localStorage.setItem("stillhere:distanceUnit", u); } catch {}
}

// Render a radius (meters) in the user's chosen unit. Imperial uses feet
// below ~528ft (~160m), then switches to yards for readability.
function formatRadius(meters: number, unit: DistanceUnit): string {
  if (unit === "imperial") {
    const feet = Math.round(meters * 3.28084);
    if (feet < 1000) return `${feet} ft`;
    const miles = meters / 1609.344;
    return miles >= 0.1 ? `${miles.toFixed(2)} mi` : `${feet} ft`;
  }
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${meters} m`;
}

export default function SavedPlacesPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [editingPlace, setEditingPlace] = useState<Geofence | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<"home" | "work" | "custom">("custom");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlacePrediction[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedCoords, setSelectedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [radius, setRadius] = useState(200);

  const searchTimeoutRef = { current: null as ReturnType<typeof setTimeout> | null };
  const searchIdRef = { current: 0 };

  const { data: places, isLoading } = useQuery<Geofence[]>({
    queryKey: ["/api/geofences"],
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; lat: number; lng: number; radiusMeters: number; type: string }) =>
      apiRequest("POST", "/api/geofences", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/geofences"] });
      toast({ title: "Place saved" });
      resetForm();
    },
    onError: () => {
      toast({ title: "Error", description: "Could not save place.", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; radiusMeters?: number; type?: string } }) =>
      apiRequest("PUT", `/api/geofences/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/geofences"] });
      toast({ title: "Place updated" });
      resetForm();
    },
    onError: () => {
      toast({ title: "Error", description: "Could not update place.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/geofences/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/geofences"] });
      toast({ title: "Place deleted" });
      setDeleteId(null);
    },
  });

  const resetForm = () => {
    setShowAdd(false);
    setEditingPlace(null);
    setName("");
    setType("custom");
    setSearchQuery("");
    setSearchResults([]);
    setSelectedCoords(null);
    setSelectedAddress("");
    setRadius(200);
  };

  const searchAddress = useCallback(async (query: string) => {
    if (query.length < 2) { setSearchResults([]); setSearching(false); return; }
    const thisId = ++searchIdRef.current;
    setSearching(true);
    try {
      const url = `/api/places/autocomplete?input=${encodeURIComponent(query)}`;
      const res = await fetch(url, { credentials: "include" });
      const data = await res.json();
      if (thisId !== searchIdRef.current) return;
      setSearchResults(data.predictions || []);
    } catch {
      if (thisId !== searchIdRef.current) return;
      setSearchResults([]);
    } finally {
      if (thisId === searchIdRef.current) setSearching(false);
    }
  }, []);

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    setSelectedCoords(null);
    setSelectedAddress("");
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (value.length < 2) { setSearchResults([]); return; }
    searchTimeoutRef.current = setTimeout(() => searchAddress(value), 300);
  };

  const selectPlace = async (prediction: PlacePrediction) => {
    setSearchQuery(prediction.name);
    setSearchResults([]);
    if (!name) setName(prediction.name);

    try {
      const res = await fetch(`/api/places/details?placeId=${encodeURIComponent(prediction.placeId)}`, { credentials: "include" });
      const data = await res.json();
      if (data.lat && data.lng) {
        setSelectedCoords({ lat: data.lat, lng: data.lng });
        setSelectedAddress(data.address || prediction.subtitle);
      }
    } catch {
      toast({ title: "Error", description: "Could not get place details.", variant: "destructive" });
    }
  };

  const handleSave = () => {
    if (!name.trim()) {
      toast({ title: "Enter a name", variant: "destructive" });
      return;
    }

    if (editingPlace) {
      updateMutation.mutate({ id: editingPlace.id, data: { name: name.trim(), radiusMeters: radius, type } });
    } else {
      if (!selectedCoords) {
        toast({ title: "Select a location", description: "Search and pick a place first.", variant: "destructive" });
        return;
      }
      createMutation.mutate({ name: name.trim(), lat: selectedCoords.lat, lng: selectedCoords.lng, radiusMeters: radius, type });
    }
  };

  const startEdit = (place: Geofence) => {
    setEditingPlace(place);
    setShowAdd(true);
    setName(place.name);
    setType(place.type as "home" | "work" | "custom");
    setRadius(place.radiusMeters);
    setSelectedCoords({ lat: place.lat, lng: place.lng });
    setSelectedAddress("");
    setSearchQuery("");
  };

  const useCurrentLocation = async () => {
    const pos = await getOneShotPosition();
    if (pos) {
      setSelectedCoords({ lat: pos.lat, lng: pos.lng });
      setSelectedAddress("Current location");
      setSearchQuery("Current location");
    } else {
      toast({ title: "Could not get location", variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary text-primary-foreground px-4 py-3">
        <div className="max-w-md mx-auto flex items-center gap-3">
          <BackButton to="/" tone="onPrimary" />
          <h1 className="text-lg font-semibold flex-1">Saved Places</h1>
          {!showAdd && (
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground"
              onClick={() => { resetForm(); setShowAdd(true); }}
              data-testid="button-add-place"
            >
              <Plus className="h-5 w-5" />
            </Button>
          )}
        </div>
      </header>

      <div className="max-w-md mx-auto p-4 space-y-4">
        {showAdd && (
          <Card>
            <CardContent className="pt-4 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm">{editingPlace ? "Edit Place" : "Add New Place"}</h2>
                <Button variant="ghost" size="icon" onClick={resetForm} className="h-8 w-8">
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {(["home", "work", "custom"] as const).map((t) => {
                  const Icon = TYPE_ICONS[t];
                  return (
                    <button
                      key={t}
                      onClick={() => {
                        setType(t);
                        if (!name || name === TYPE_LABELS[type]) setName(TYPE_LABELS[t]);
                      }}
                      className={`flex flex-col items-center gap-1.5 py-2.5 px-2 rounded-xl transition-all duration-150 active:scale-95 ${
                        type === t ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground"
                      }`}
                      data-testid={`button-type-${t}`}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="text-xs font-medium">{TYPE_LABELS[t]}</span>
                    </button>
                  );
                })}
              </div>

              <Input
                placeholder="Place name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="input-place-name"
              />

              {!editingPlace && (
                <>
                  <div className="relative">
                    <Input
                      placeholder="Search location..."
                      value={searchQuery}
                      onChange={(e) => handleSearchInput(e.target.value)}
                      className="pr-8"
                      data-testid="input-place-search"
                    />
                    {searching && (
                      <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </div>

                  {searchResults.length > 0 && (
                    <div className="border rounded-xl divide-y max-h-48 overflow-y-auto bg-background shadow-lg">
                      {searchResults.map((r, i) => (
                        <button
                          key={r.placeId}
                          className="w-full text-left px-3 py-2.5 hover:bg-muted/60 transition-colors flex items-start gap-2.5"
                          onClick={() => selectPlace(r)}
                          data-testid={`button-search-result-${i}`}
                        >
                          <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{r.name}</p>
                            {r.subtitle && <p className="text-xs text-muted-foreground truncate">{r.subtitle}</p>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={useCurrentLocation}
                    className="w-full text-sm text-primary flex items-center gap-2 py-2 hover:underline"
                    data-testid="button-use-current-location"
                  >
                    <MapPin className="h-4 w-4" />
                    Use my current location
                  </button>

                  {selectedCoords && (
                    <div className="bg-muted/40 rounded-lg px-3 py-2 text-xs text-muted-foreground">
                      Location set: {selectedAddress || `${selectedCoords.lat.toFixed(4)}, ${selectedCoords.lng.toFixed(4)}`}
                    </div>
                  )}
                </>
              )}

              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Alert radius</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={50}
                    max={1000}
                    step={50}
                    value={radius}
                    onChange={(e) => setRadius(parseInt(e.target.value))}
                    className="flex-1 accent-primary"
                    data-testid="input-radius"
                  />
                  <span className="text-sm font-medium w-16 text-right">{radius} m</span>
                </div>
              </div>

              <Button
                className="w-full"
                onClick={handleSave}
                disabled={createMutation.isPending || updateMutation.isPending}
                data-testid="button-save-place"
              >
                {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingPlace ? "Update Place" : "Save Place"}
              </Button>
            </CardContent>
          </Card>
        )}

        {(!places || places.length === 0) && !showAdd && (
          <div className="text-center py-12 space-y-3">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
              <MapPin className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="font-semibold text-lg">No saved places yet</h2>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              Save your frequently visited places like home, work, or gym. They'll appear as quick picks in Safe Walk.
            </p>
            <Button onClick={() => { resetForm(); setShowAdd(true); }} data-testid="button-add-first-place">
              <Plus className="h-4 w-4 mr-2" />
              Add your first place
            </Button>
          </div>
        )}

        {places && places.length > 0 && (
          <div className="space-y-2">
            {places.map((place) => {
              const Icon = TYPE_ICONS[place.type] || MapPin;
              return (
                <Card key={place.id}>
                  <CardContent className="py-3 px-4 flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl ${TYPE_COLORS[place.type] || "bg-gray-500"} flex items-center justify-center shrink-0`}>
                      <Icon className="h-5 w-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate" data-testid={`text-place-name-${place.id}`}>{place.name}</p>
                      <p className="text-xs text-muted-foreground">{TYPE_LABELS[place.type] || "Place"} &middot; {place.radiusMeters}m radius</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(place)} data-testid={`button-edit-${place.id}`}>
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDeleteId(place.id)} data-testid={`button-delete-${place.id}`}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground text-center leading-relaxed px-4">
          Saved places appear as quick-pick destinations in Safe Walk so you don't have to search every time.
        </p>
      </div>

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this place?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the saved place. You can always add it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
