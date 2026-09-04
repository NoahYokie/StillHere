import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, SkipBack, SkipForward, Gauge } from "lucide-react";
import GoogleMap from "@/components/google-map";

interface TripPoint {
  lat: number;
  lng: number;
  speed: number | null;
  activity: string | null;
  recordedAt: string;
}

interface TripReplayProps {
  points: TripPoint[];
  className?: string;
  startAddress?: string;
  endAddress?: string;
}

export default function TripReplay({ points, className = "w-full h-64", startAddress, endAddress }: TripReplayProps) {
  const [playing, setPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [speed, setSpeed] = useState(1);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const totalPoints = points.length;
  const currentPoint = points[currentIndex] || points[0];

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
    } else {
      if (currentIndex >= totalPoints - 1) setCurrentIndex(0);
      setPlaying(true);
    }
  }, [playing, currentIndex, totalPoints]);

  useEffect(() => {
    if (!playing) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    const interval = Math.max(50, 200 / speed);
    intervalRef.current = setInterval(() => {
      setCurrentIndex(prev => {
        if (prev >= totalPoints - 1) {
          setPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, interval);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, speed, totalPoints]);

  const currentSpeed = currentPoint?.speed != null ? Math.round(currentPoint.speed * 3.6) : 0;
  const currentTime = currentPoint?.recordedAt ? new Date(currentPoint.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const progress = totalPoints > 1 ? Math.round((currentIndex / (totalPoints - 1)) * 100) : 0;

  if (!points || points.length < 2) return null;

  return (
    <div className="space-y-2" data-testid="trip-replay">
      <GoogleMap
        center={{ lat: currentPoint.lat, lng: currentPoint.lng }}
        points={points.map(p => ({ lat: p.lat, lng: p.lng, activity: p.activity }))}
        zoom={15}
        className={className}
        showTrail={false}
        replayMode={true}
        replayIndex={currentIndex}
        startAddress={startAddress}
        endAddress={endAddress}
        animateMarkers={true}
      />

      <div className="bg-muted/50 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{currentTime}</span>
          <div className="flex items-center gap-1">
            <Gauge className="h-3 w-3" />
            <span data-testid="text-replay-speed">{currentSpeed} km/h</span>
          </div>
          <span>{progress}%</span>
        </div>

        <Slider
          value={[currentIndex]}
          min={0}
          max={totalPoints - 1}
          step={1}
          onValueChange={([val]) => {
            setCurrentIndex(val);
            setPlaying(false);
          }}
          className="w-full"
          data-testid="slider-replay"
        />

        <div className="flex items-center justify-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => { setCurrentIndex(0); setPlaying(false); }}
            data-testid="button-replay-start"
          >
            <SkipBack className="h-4 w-4" />
          </Button>

          <Button
            size="icon"
            className="h-10 w-10 rounded-full"
            onClick={togglePlay}
            data-testid="button-replay-play"
          >
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => { setCurrentIndex(totalPoints - 1); setPlaying(false); }}
            data-testid="button-replay-end"
          >
            <SkipForward className="h-4 w-4" />
          </Button>

          <div className="ml-4 flex items-center gap-1">
            {[1, 2, 5, 10].map(s => (
              <button
                key={s}
                className={`text-[10px] px-1.5 py-0.5 rounded ${speed === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
                onClick={() => setSpeed(s)}
                data-testid={`button-speed-${s}x`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
