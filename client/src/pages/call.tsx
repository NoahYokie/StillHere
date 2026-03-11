import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, Video, VideoOff, PhoneOff, SwitchCamera, Phone, Volume2 } from "lucide-react";
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
  const [needsTap, setNeedsTap] = useState(false);

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

  const playVideo = useCallback((el: HTMLVideoElement, muted: boolean) => {
    el.muted = muted;
    if (!muted) el.volume = 1.0;
    const p = el.play();
    if (p) {
      p.catch(() => {
        if (!muted) {
          console.warn("[CALL] Autoplay blocked, playing muted first");
          el.muted = true;
          el.play().then(() => {
            setNeedsTap(true);
          }).catch(() => {});
        }
      });
    }
  }, []);

  const showLocalVideo = useCallback((stream: MediaStream) => {
    const el = localVideoRef.current;
    if (!el) return;
    el.srcObject = stream;
    playVideo(el, true);
  }, [playVideo]);

  const showRemoteVideo = useCallback((stream: MediaStream) => {
    const el = remoteVideoRef.current;
    if (!el) return;
    console.log("[CALL] Showing remote stream, tracks:", stream.getTracks().map(t => `${t.kind}:${t.readyState}:enabled=${t.enabled}`).join(", "));
    el.srcObject = stream;
    playVideo(el, false);
  }, [playVideo]);

  const handleTapToUnmute = useCallback(() => {
    const el = remoteVideoRef.current;
    if (el && el.muted) {
      el.muted = false;
      el.volume = 1.0;
      el.play().catch(() => {});
      setNeedsTap(false);
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
    console.log("[CALL] Ending:", reason);
    stopRingtone();
    playCallEnded();
    if (emitToServer && callIdRef.current && otherUserId) {
      try {
        const socket = getSocket();
        socket.emit("call:end", { callId: callIdRef.current, targetUserId: otherUserId });
      } catch {}
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
    console.log("[CALL] Init. Mode:", isAnswerMode ? "answer" : "caller", "connected:", socket.connected, "id:", socket.id);

    function onCallAnswered(data: { callId: string; answer: any }) {
      console.log("[CALL] Received call:answered");
      stopRingtone();
      playCallConnected();
      if (rtcRef.current) {
        rtcRef.current.handleAnswer(data.answer)
          .then(() => console.log("[CALL] Answer applied successfully"))
          .catch((err) => console.error("[CALL] Failed to apply answer:", err));
      } else {
        console.error("[CALL] No RTC connection when answer received");
      }
    }

    function onIceCandidate(data: { candidate: any; fromUserId: string }) {
      if (rtcRef.current && data.candidate) {
        rtcRef.current.addIceCandidate(data.candidate);
      }
    }

    function onCallEnded() {
      handleCallEnd(`${otherUserName} ended the call`);
    }

    function onCallRejected() {
      handleCallEnd(`${otherUserName} declined the call`);
    }

    function onIceRestart(data: { offer: any; fromUserId: string }) {
      console.log("[CALL] Received ICE restart offer");
      if (rtcRef.current) {
        rtcRef.current.handleOffer(data.offer).then((answer) => {
          socket.emit("call:ice-restart-answer", {
            targetUserId: data.fromUserId,
            answer,
          });
        }).catch((err) => console.error("[CALL] ICE restart failed:", err));
      }
    }

    function onIceRestartAnswer(data: { answer: any }) {
      console.log("[CALL] Received ICE restart answer");
      if (rtcRef.current) {
        rtcRef.current.handleAnswer(data.answer).catch((err) => 
          console.error("[CALL] ICE restart answer failed:", err)
        );
      }
    }

    socket.on("call:answered", onCallAnswered);
    socket.on("call:ice-candidate", onIceCandidate);
    socket.on("call:ended", onCallEnded);
    socket.on("call:rejected", onCallRejected);
    socket.on("call:ice-restart", onIceRestart);
    socket.on("call:ice-restart-answer", onIceRestartAnswer);

    async function startCall() {
      try {
        console.log("[CALL] Fetching ICE servers...");
        const iceServers = await fetchIceServers();
        console.log("[CALL] Got", iceServers.length, "ICE server configs");

        const rtc = new WebRTCConnection(iceServers);
        rtcRef.current = rtc;

        rtc.onRemoteStream = (stream) => {
          console.log("[CALL] Remote stream updated, tracks:", stream.getTracks().length);
          showRemoteVideo(stream);
          setCallState("active");
        };

        rtc.onIceCandidate = (candidate) => {
          socket.emit("call:ice-candidate", {
            targetUserId: otherUserId,
            candidate: candidate.toJSON(),
          });
        };

        rtc.onNegotiationNeeded = (offer) => {
          console.log("[CALL] Sending ICE restart offer");
          socket.emit("call:ice-restart", {
            targetUserId: otherUserId,
            offer,
          });
        };

        rtc.onConnectionStateChange = (state) => {
          console.log("[CALL] PeerConnection state:", state);
          if (state === "connected") {
            stopRingtone();
            setCallState("active");
          }
          if (state === "failed") {
            handleCallEnd("Connection failed");
          }
          if (state === "closed") {
            handleCallEnd();
          }
        };

        console.log("[CALL] Getting local media...");
        const localStream = await rtc.getLocalStream();
        showLocalVideo(localStream);

        if (isAnswerMode) {
          const pendingCall = getPendingIncomingCall();
          if (!pendingCall) {
            console.error("[CALL] No pending call data");
            toast({ title: "Call not found", variant: "destructive" });
            setLocation("/watched");
            return;
          }

          console.log("[CALL] Answering call:", pendingCall.callId);
          callIdRef.current = pendingCall.callId;

          const answer = await rtc.handleOffer(pendingCall.offer);
          console.log("[CALL] Sending answer back to caller");

          socket.emit("call:answer", {
            callId: pendingCall.callId,
            callerId: pendingCall.callerId,
            answer,
          });

          setCallState("active");
        } else {
          const offer = await rtc.createOffer();
          console.log("[CALL] Calling", otherUserId);
          setCallState("ringing");
          startOutgoingRingtone();

          socket.emit("call:initiate", {
            receiverId: otherUserId,
            callType: "video",
            offer,
          }, (response: any) => {
            console.log("[CALL] Initiate response:", JSON.stringify(response));
            if (response?.success) {
              callIdRef.current = response.callId;
            } else {
              handleCallEnd(response?.error || "Could not connect");
            }
          });
        }
      } catch (err: any) {
        console.error("[CALL] Start failed:", err);
        toast({
          title: "Camera/Mic access needed",
          description: "Please allow camera and microphone access to make calls.",
          variant: "destructive",
        });
        setLocation("/watched");
      }
    }

    startCall();

    return () => {
      socket.off("call:answered", onCallAnswered);
      socket.off("call:ice-candidate", onIceCandidate);
      socket.off("call:ended", onCallEnded);
      socket.off("call:rejected", onCallRejected);
      socket.off("call:ice-restart", onIceRestart);
      socket.off("call:ice-restart-answer", onIceRestartAnswer);
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
      const stream = rtcRef.current?.getLocalMediaStream();
      if (stream) showLocalVideo(stream);
    } catch {
      toast({ title: "Could not switch camera", variant: "destructive" });
    }
  }

  return (
    <div className="fixed inset-0 bg-black flex flex-col" data-testid="call-screen" onClick={needsTap ? handleTapToUnmute : undefined}>
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

      {needsTap && callState === "active" && (
        <div className="absolute top-4 left-4 z-30 bg-black/70 rounded-lg px-3 py-2 flex items-center gap-2 text-white text-sm" data-testid="tap-to-unmute">
          <Volume2 className="w-4 h-4" />
          <span>Tap anywhere to hear audio</span>
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
