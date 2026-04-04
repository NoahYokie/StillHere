import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Car, X } from "lucide-react";
import { drivingMonitor } from "@/lib/driving-monitor";

interface CrashCountdownProps {
  impactForce: number;
  onCancel: () => void;
  onConfirmSos: () => void;
}

const COUNTDOWN_SECONDS = 60;

export default function CrashCountdown({ impactForce, onCancel, onConfirmSos }: CrashCountdownProps) {
  const [seconds, setSeconds] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    if (seconds <= 0) {
      onConfirmSos();
      return;
    }
    const timer = setTimeout(() => setSeconds(s => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds, onConfirmSos]);

  useEffect(() => {
    if ("vibrate" in navigator) {
      navigator.vibrate([500, 200, 500, 200, 500]);
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if ("vibrate" in navigator) {
        navigator.vibrate([300, 100, 300]);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="fixed inset-0 bg-red-900/95 z-[9999] flex flex-col items-center justify-center p-6" data-testid="crash-countdown-overlay">
      <div className="animate-pulse mb-6">
        <Car className="w-20 h-20 text-white" />
      </div>

      <h1 className="text-3xl font-bold text-white mb-2" data-testid="text-crash-detected">
        Crash Detected
      </h1>
      <p className="text-white/80 text-center mb-8">
        A possible vehicle crash has been detected. SOS will send automatically if you do not respond.
      </p>

      <div className="w-32 h-32 rounded-full border-4 border-white flex items-center justify-center mb-8">
        <span className="text-5xl font-bold text-white" data-testid="text-crash-countdown">
          {seconds}
        </span>
      </div>

      <p className="text-white/70 text-sm mb-8">
        Emergency contacts will be notified in {seconds} seconds
      </p>

      <div className="flex flex-col gap-4 w-full max-w-xs">
        <Button
          size="lg"
          className="w-full bg-green-600 hover:bg-green-700 text-white text-lg py-6"
          onClick={onCancel}
          data-testid="button-im-ok-crash"
        >
          <X className="w-6 h-6 mr-2" />
          I'm OK - Cancel
        </Button>

        <Button
          size="lg"
          variant="destructive"
          className="w-full text-lg py-6"
          onClick={onConfirmSos}
          data-testid="button-sos-now-crash"
        >
          <AlertTriangle className="w-6 h-6 mr-2" />
          Send SOS Now
        </Button>
      </div>
    </div>
  );
}
