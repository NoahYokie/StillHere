import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Phone, PhoneOff, Video } from "lucide-react";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/lib/auth";

interface IncomingCallData {
  callId: string;
  callerId: string;
  callerName: string;
  callType: "video" | "audio";
  offer: RTCSessionDescriptionInit;
}

let pendingIncomingCall: IncomingCallData | null = null;

export function getPendingIncomingCall(): IncomingCallData | null {
  const call = pendingIncomingCall;
  pendingIncomingCall = null;
  return call;
}

export function IncomingCallOverlay() {
  const [incomingCall, setIncomingCall] = useState<IncomingCallData | null>(null);
  const [, setLocation] = useLocation();
  const { auth } = useAuth();

  useEffect(() => {
    if (!auth?.authenticated) return;

    const socket = getSocket();

    const handleIncoming = (data: IncomingCallData) => {
      setIncomingCall(data);
    };

    socket.on("call:incoming", handleIncoming);

    return () => {
      socket.off("call:incoming", handleIncoming);
    };
  }, [auth?.authenticated]);

  function acceptCall() {
    if (!incomingCall) return;
    pendingIncomingCall = incomingCall;
    setIncomingCall(null);
    setLocation(`/call/${incomingCall.callerId}?mode=answer`);
  }

  function rejectCall() {
    if (!incomingCall) return;

    const socket = getSocket();
    socket.emit("call:reject", {
      callId: incomingCall.callId,
      callerId: incomingCall.callerId,
    });
    setIncomingCall(null);
  }

  if (!incomingCall) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" data-testid="incoming-call-overlay">
      <div className="bg-card rounded-2xl p-8 max-w-sm w-full mx-4 text-center shadow-xl">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <Video className="w-8 h-8 text-primary" />
        </div>

        <h2 className="text-lg font-semibold mb-1" data-testid="text-caller-name">
          {incomingCall.callerName}
        </h2>
        <p className="text-muted-foreground mb-6" data-testid="text-call-type">
          Incoming {incomingCall.callType} call
        </p>

        <div className="flex justify-center gap-6">
          <Button
            variant="destructive"
            size="icon"
            className="w-16 h-16 rounded-full"
            onClick={rejectCall}
            data-testid="button-reject-call"
          >
            <PhoneOff className="w-7 h-7" />
          </Button>
          <Button
            size="icon"
            className="w-16 h-16 rounded-full bg-green-500 hover:bg-green-600 text-white"
            onClick={acceptCall}
            data-testid="button-accept-call"
          >
            <Phone className="w-7 h-7" />
          </Button>
        </div>
      </div>
    </div>
  );
}
