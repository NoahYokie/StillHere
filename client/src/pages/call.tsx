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
import { startOutgoingRingtone, startIncomingRingtone, stopRingtone, playCallConnected, playCallEnded } from "@/lib/ringtone";

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
  const callIdRef = useRef<string | null>(null);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const rtcRef = useRef<WebRTCConnection | null>(null);
  const hasInitiatedRef = useRef(false);
  const hasEndedRef = useRef(false);

  const { data: userProfile } = useQuery<{ id: string; name: string }>({
    queryKey: ["/api/users", otherUserId, "profile"],
    enabled: !!otherUserId,
  });

  const otherUserName = userProfile?.name || "User";

  const attachStream = useCallback((videoEl: HTMLVideoElement | null, stream: MediaStream) => {
    if (!videoEl) return;
    videoEl.srcObject = stream;
    videoEl.play().catch(() => {});
  }, []);

  const cleanup = useCallback(() => {
    stopRingtone();
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  }, []);

  const handleCallEnd = useCallback((reason?: string, emitToServer = false) => {
    if (hasEndedRef.current) return;
    hasEndedRef.current = true;
    stopRingtone();
    playCallEnded();
    if (emitToServer) {
      const socket = getSocket();
      if (callIdRef.current && otherUserId) {
        socket.emit("call:end", { callId: callIdRef.current, targetUserId: otherUserId });
      }
    }
    if (reason) {
      toast({ title: "Call ended", description: reason });
    }
    cleanup();
    setCallState("ended");
    setTimeout(() => setLocation("/watched"), 1500);
  }, [otherUserId, cleanup, setLocation, toast]);

  const endCall = useCallback(() => {
    handleCallEnd(undefined, true);
  }, [handleCallEnd]);

  useEffect(() => {
    if (!currentUserId || !otherUserId || hasInitiatedRef.current) return;
    hasInitiatedRef.current = true;

    const socket = getSocket();

    async function initCall() {
      const iceServers = await fetchIceServers();
      const rtc = new WebRTCConnection(iceServers);
      rtcRef.current = rtc;

      rtc.onRemoteStream = (stream) => {
        stopRingtone();
        playCallConnected();
        attachStream(remoteVideoRef.current, stream);
        setCallState("active");
      };

      rtc.onIceCandidate = (candidate) => {
        socket.emit("call:ice-candidate", {
          targetUserId: otherUserId,
          candidate: candidate.toJSON(),
        });
      };

      rtc.onConnectionStateChange = (state) => {
        if (state === "disconnected" || state === "failed" || state === "closed") {
          handleCallEnd("Connection lost");
        }
      };

      if (isAnswerMode) {
        answerIncomingCall(rtc, socket);
      } else {
        initiateOutgoingCall(rtc, socket);
      }
    }

    socket.on("call:ice-candidate", async (data: { candidate: any }) => {
      if (rtcRef.current && data.candidate) {
        await rtcRef.current.addIceCandidate(data.candidate);
      }
    });

    socket.on("call:ended", () => {
      handleCallEnd(`${otherUserName} ended the call`);
    });

    socket.on("call:rejected", () => {
      handleCallEnd(`${otherUserName} declined the call`);
    });

    initCall();

    return () => {
      socket.off("call:answered");
      socket.off("call:ice-candidate");
      socket.off("call:ended");
      socket.off("call:rejected");
      cleanup();
    };
  }, [currentUserId, otherUserId]);

  async function answerIncomingCall(rtc: WebRTCConnection, socket: any) {
    const pendingCall = getPendingIncomingCall();
    if (!pendingCall) {
      toast({ title: "Call not found", variant: "destructive" });
      setLocation("/watched");
      return;
    }

    try {
      const localStream = await rtc.getLocalStream();
      attachStream(localVideoRef.current, localStream);

      callIdRef.current = pendingCall.callId;
      const answer = await rtc.handleOffer(pendingCall.offer);

      socket.emit("call:answer", {
        callId: pendingCall.callId,
        callerId: pendingCall.callerId,
        answer,
      });

      setCallState("active");
    } catch (err: any) {
      toast({
        title: "Camera/Mic access denied",
        description: "Please allow camera and microphone access.",
        variant: "destructive",
      });
      setLocation("/watched");
    }
  }

  async function initiateOutgoingCall(rtc: WebRTCConnection, socket: any) {
    try {
      const localStream = await rtc.getLocalStream();
      attachStream(localVideoRef.current, localStream);

      const offer = await rtc.createOffer();
      setCallState("ringing");
      startOutgoingRingtone();

      socket.emit("call:initiate", {
        receiverId: otherUserId,
        callType: "video",
        offer,
      }, (response: any) => {
        if (response?.success) {
          callIdRef.current = response.callId;
        } else {
          handleCallEnd("Could not connect");
        }
      });

      socket.on("call:answered", async (data: { callId: string; answer: any }) => {
        stopRingtone();
        if (rtcRef.current) {
          await rtcRef.current.handleAnswer(data.answer);
        }
      });
    } catch (err: any) {
      stopRingtone();
      toast({
        title: "Camera/Mic access denied",
        description: "Please allow camera and microphone access to make video calls.",
        variant: "destructive",
      });
      setLocation("/watched");
    }
  }

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
            onClick={endCall}
            data-testid="button-end-call"
          >
            <PhoneOff className="w-6 h-6" />
          </Button>
        </div>
      </div>
    </div>
  );
}
