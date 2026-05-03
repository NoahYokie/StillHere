declare namespace google {
  namespace maps {
    type LatLngLiteral = { lat: number; lng: number };
    type MapTypeStyle = any;
    const MapTypeControlStyle: { DROPDOWN_MENU: number; HORIZONTAL_BAR: number; DEFAULT: number; [k: string]: number };
    const ControlPosition: { TOP_RIGHT: number; TOP_LEFT: number; TOP_CENTER: number; BOTTOM_RIGHT: number; BOTTOM_LEFT: number; BOTTOM_CENTER: number; LEFT_CENTER: number; RIGHT_CENTER: number; LEFT_TOP: number; LEFT_BOTTOM: number; RIGHT_TOP: number; RIGHT_BOTTOM: number; [k: string]: number };
    class TrafficLayer {
      constructor(opts?: any);
      setMap(map: Map | null): void;
    }
    const geometry: any;
    class LatLng {
      constructor(lat: number, lng: number);
      lat(): number;
      lng(): number;
    }
    class LatLngBounds {
      constructor();
      extend(point: LatLng | LatLngLiteral): LatLngBounds;
      isEmpty(): boolean;
    }
    class Map {
      constructor(el: Element, opts?: any);
      setCenter(c: LatLng | LatLngLiteral): void;
      setZoom(z: number): void;
      setOptions(opts: any): void;
      setMapTypeId(id: string): void;
      panTo(c: LatLng | LatLngLiteral): void;
      fitBounds(b: LatLngBounds, padding?: number | object): void;
      getZoom(): number | undefined;
      getCenter(): LatLng | undefined;
      addListener(event: string, fn: (...args: any[]) => void): MapsEventListener;
    }
    interface MapsEventListener {
      remove(): void;
    }
    class Marker {
      constructor(opts?: any);
      setMap(map: Map | null): void;
      setPosition(p: LatLng | LatLngLiteral): void;
      setIcon(icon: any): void;
      addListener(event: string, fn: (...args: any[]) => void): MapsEventListener;
    }
    class Polyline {
      constructor(opts?: any);
      setMap(map: Map | null): void;
      setPath(path: Array<LatLng | LatLngLiteral>): void;
    }
    class Circle {
      constructor(opts?: any);
      setMap(map: Map | null): void;
      setCenter(c: LatLng | LatLngLiteral): void;
      setRadius(r: number): void;
    }
    class InfoWindow {
      constructor(opts?: any);
      open(opts?: any, anchor?: any): void;
      close(): void;
      setContent(c: string | Element): void;
    }
    namespace event {
      function clearInstanceListeners(instance: any): void;
      function addListener(instance: any, ev: string, fn: (...args: any[]) => void): MapsEventListener;
      function removeListener(listener: MapsEventListener): void;
    }
    namespace marker {
      class AdvancedMarkerElement {
        constructor(opts?: any);
        position: any;
        map: Map | null;
        content: Element | null;
        title: string;
        addListener(event: string, fn: (...args: any[]) => void): MapsEventListener;
      }
      class PinElement {
        constructor(opts?: any);
        element: Element;
      }
    }
    namespace places {
      class PlacesService {
        constructor(map: Map | Element);
        nearbySearch(req: any, cb: (results: any[] | null, status: string) => void): void;
        textSearch(req: any, cb: (results: any[] | null, status: string) => void): void;
      }
      class AutocompleteService {
        getPlacePredictions(req: any, cb: (preds: any[] | null, status: string) => void): void;
      }
    }
    namespace visualization {
      class HeatmapLayer {
        constructor(opts?: any);
        setMap(map: Map | null): void;
        setData(data: any[]): void;
      }
    }
    class Size {
      constructor(w: number, h: number);
    }
    class Point {
      constructor(x: number, y: number);
    }
    class SymbolPath {
      static CIRCLE: number;
      static FORWARD_CLOSED_ARROW: number;
      static FORWARD_OPEN_ARROW: number;
      static BACKWARD_CLOSED_ARROW: number;
      static BACKWARD_OPEN_ARROW: number;
    }
  }
}

interface Window {
  google: typeof google;
  initMap?: () => void;
}
