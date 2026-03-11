import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, Video, VideoOff, PhoneOff, SwitchCamera, Phone } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import { WebRTCConnection, fetchIceServers } from "@/lib/webrtc";
import { useToast } from "@/hooks/use-toast";
import { getPendingIncomingCall } from "@/components/incoming-call";
import { startOutgoingRingtone, stopRingtone, playCallConnected, playCallEnded } from "@/lib/ringtone";

type CallState = "connecting" | "ringing" | "active" | "ended";

export default function CallPage() {
  const { userId: otherUserId } = useParams<{ userId: string }>();
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { auth } = useAuth();
  const { toast } = useToast();
  const currentUserId = auth?.user?.id;

  const isAnswerMode = searchString.includes("mode=answer");

  const [callState, setCallState] = useState<CallState>("connecting");
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const rtcRef = useRef<WebRTCConnection | null>(null);
  const callIdRef = useRef<string | null>(null);
  const hasInitiatedRef = useRef(false);
  const hasEndedRef = useRef(false);

  const { data: userProfile } = useQuery<{ id: string; name: string }>({
    queryKey: ["/api/users", otherUserId, "profile"],
    enabled: !!otherUserId,
  });

  const otherUserName = userProfile?.name || "User";

  const showLocalVideo = useCallback((stream: MediaStream) => {
    const el = localVideoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    el.play().catch((e) => console.warn("[CALL] Local video play failed:", e));
  }, []);

  const showRemoteVideo = useCallback((stream: MediaStream) => {
    console.log("[CALL] Got remote stream, tracks:", stream.getTracks().map(t => `${t.kind}:${t.enabled}`));
    const el = remoteVideoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = false;
    el.volume = 1.0;
    const playPromise = el.play();
    if (playPromise) {
      playPromise.catch((e) => {
        console.warn("[CALL] Remote video play failed, retrying on interaction:", e);
        const retryPlay = () => {
          el.play().catch(() => {});
          document.removeEventListener("touchstart", retryPlay);
          document.removeEventListener("click", retryPlay);
        };
        document.addEventListener("touchstart", retryPlay, { once: true });
        document.addEventListener("click", retryPlay, { once: true });
      });
    }
  }, []);

  const doCleanup = useCallback(() => {
    stopRingtone();
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, []);

  const handleCallEnd = useCallback((reason?: string, emitToServer = false) => {
    if (hasEndedRef.current) return;
    hasEndedRef.current = true;
    console.log("[CALL] Call ending:", reason, "emit:", emitToServer);
    stopRingtone();
    playCallEnded();
    if (emitToServer && callIdRef.current && otherUserId) {
      const socket = getSocket();
      socket.emit("call:end", { callId: callIdRef.current, targetUserId: otherUserId });
    }
    if (reason) {
      toast({ title: "Call ended", description: reason });
    }
    doCleanup();
    setCallState("ended");
    setTimeout(() => setLocation("/watched"), 1500);
  }, [otherUserId, doCleanup, setLocation, toast]);

  useEffect(() => {
    if (!currentUserId || !otherUserId || hasInitiatedRef.current) return;
    hasInitiatedRef.current = true;

    const socket = getSocket();

    console.log("[CALL] Page mounted. Mode:", isAnswerMode ? "answer" : "caller", "Socket connected:", socket.connected);

    function onCallAnswered(data: { callId: string; answer: any }) {
      console.log("[CALL] Received call:answered for callId:", data.callId);
      stopRingtone();
      playCallConnected();
      if (rtcRef.current) {
        rtcRef.current.handleAnswer(data.answer).then(() => {
          console.log("[CALL] Remote description set from answer");
        }).catch((err) => {
          console.error("[CALL] Failed to set remote description:", err);
        });
      }
    }

    function onIceCandidate(data: { candidate: any; fromUserId: string }) {
      if (rtcRef.current && data.candidate) {
        rtcRef.current.addIceCandidate(data.candidate).catch((err) => {
          console.error("[CALL] ICE candidate error:", err);
        });
      }
    }

    function onCallEnded() {
      handleCallEnd(`${otherUserName} ended the call`);
    }

    function onCallRejected() {
      handleCallEnd(`${otherUserName} declined the call`);
    }

    socket.on("call:answered", onCallAnswered);
    socket.on("call:ice-candidate", onIceCandidate);
    socket.on("call:ended", onCallEnded);
    socket.on("call:rejected", onCallRejected);

    async function startCall() {
      try {
        console.log("[CALL] Fetching ICE servers...");
        const iceServers = await fetchIceServers();
        console.log("[CALL] Got ICE servers:", iceServers.length);

        const rtc = new WebRTCConnection(iceServers);
        rtcRef.current = rtc;

        rtc.onRemoteStream = (stream) => {
          console.log("[CALL] onRemoteStream fired");
          stopRingtone();
          playCallConnected();
          showRemoteVideo(stream);
          setCallState("active");
        };

        rtc.onIceCandidate = (candidate) => {
          socket.emit("call:ice-candidate", {
            targetUserId: otherUserId,
            candidate: candidate.toJSON(),
          });
        };

        rtc.onConnectionStateChange = (state) => {
          console.log("[CALL] Connection state:", state);
          if (state === "connected") {
            setCallState("active");
          }
          if (state === "disconnected" || state === "failed" || state === "closed") {
            handleCallEnd("Connection lost");
          }
        };

        console.log("[CALL] Getting local media...");
        const localStream = await rtc.getLocalStream();
        console.log("[CALL] Got local stream, tracks:", localStream.getTracks().map(t => `${t.kind}:${t.enabled}`));
        showLocalVideo(localStream);

        if (isAnswerMode) {
          const pendingCall = getPendingIncomingCall();
          if (!pendingCall) {
            console.error("[CALL] No pending call data found");
            toast({ title: "Call not found", variant: "destructive" });
            setLocation("/watched");
            return;
          }

          console.log("[CALL] Answering call:", pendingCall.callId);
          callIdRef.current = pendingCall.callId;

          const answer = await rtc.handleOffer(pendingCall.offer);
          console.log("[CALL] Created answer, sending to caller:", pendingCall.callerId);

          socket.emit("call:answer", {
            callId: pendingCall.callId,
            callerId: pendingCall.callerId,
            answer,
          });

          setCallState("active");
        } else {
          console.log("[CALL] Creating offer...");
          const offer = await rtc.createOffer();
          console.log("[CALL] Offer created, initiating call to:", otherUserId);
          setCallState("ringing");
          startOutgoingRingtone();

          socket.emit("call:initiate", {
            receiverId: otherUserId,
            callType: "video",
            offer,
          }, (response: any) => {
            console.log("[CALL] call:initiate response:", response);
            if (response?.success) {
              callIdRef.current = response.callId;
            } else {
              handleCallEnd(response?.error || "Could not connect");
            }
          });
        }
      } catch (err: any) {
        console.error("[CALL] Failed to start call:", err);
        toast({
          title: "Camera/Mic access denied",
          description: "Please allow camera and microphone access.",
          variant: "destructive",
        });
        setLocation("/watched");
      }
    }

    startCall();

    return () => {
      console.log("[CALL] Page unmounting, cleaning up listeners");
      socket.off("call:answered", onCallAnswered);
      socket.off("call:ice-candidate", onIceCandidate);
      socket.off("call:ended", onCallEnded);
      socket.off("call:rejected", onCallRejected);
      doCleanup();
    };
  }, [currentUserId, otherUserId]);

  function toggleMute() {
    setIsMuted((prev) => {
      rtcRef.current?.toggleAudio(prev);
      return !prev;
    });
  }

  function toggleVideo() {
    setIsVideoOff((prev) => {
      rtcRef.current?.toggleVideo(prev);
      return !prev;
    });
  }

  async function flipCamera() {
    try {
      await rtcRef.current?.switchCamera();
      if (rtcRef.current) {
        const stream = rtcRef.current.getLocalMediaStream();
        if (stream) showLocalVideo(stream);
      }
    } catch {
      toast({ title: "Could not switch camera", variant: "destructive" });
    }
  }

  return (
    <div className="fixed inset-0 bg-black flex flex-col" data-testid="call-screen">
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        data-testid="video-remote"
      />

      {callState !== "active" && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-10">
          <div className="text-center text-white">
            <div className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-4">
              <Phone className="w-10 h-10 text-primary animate-pulse" />
            </div>
            <h2 className="text-xl font-medium mb-2" data-testid="text-call-user">{otherUserName}</h2>
            <p className="text-white/60" data-testid="text-call-state">
              {callState === "connecting" && "Connecting..."}
              {callState === "ringing" && "Ringing..."}
              {callState === "ended" && "Call ended"}
            </p>
            {callState === "ringing" && (
              <div className="mt-4 flex justify-center gap-2">
                <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            )}
          </div>
        </div>
      )}

      <video
        ref={localVideoRef}
        autoPlay
        playsInline
        muted
        className="absolute top-4 right-4 w-32 h-44 rounded-xl object-cover z-20 border-2 border-white/20"
        data-testid="video-local"
      />

      <div className="absolute bottom-8 left-0 right-0 z-20">
        <div className="flex justify-center gap-4">
          <Button
            variant="secondary"
            size="icon"
            className="w-14 h-14 rounded-full bg-white/20 hover:bg-white/30 text-white"
            onClick={toggleMute}
            data-testid="button-toggle-mute"
          >
            {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
          </Button>

          <Button
            variant="secondary"
            size="icon"
            className="w-14 h-14 rounded-full bg-white/20 hover:bg-white/30 text-white"
            onClick={toggleVideo}
            data-testid="button-toggle-video"
          >
            {isVideoOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
          </Button>

          <Button
            variant="secondary"
            size="icon"
            className="w-14 h-14 rounded-full bg-white/20 hover:bg-white/30 text-white"
            onClick={flipCamera}
            data-testid="button-flip-camera"
          >
            <SwitchCamera className="w-6 h-6" />
          </Button>

          <Button
            variant="destructive"
            size="icon"
            className="w-14 h-14 rounded-full"
            onClick={() => handleCallEnd(undefined, true)}
            data-testid="button-end-call"
          >
            <PhoneOff className="w-6 h-6" />
          </Button>
        </div>
      </div>
    </div>
  );
}
