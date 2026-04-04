import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, PhoneOff, Phone, Volume2, User } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import { WebRTCConnection, fetchIceServers } from "@/lib/webrtc";
import { useToast } from "@/hooks/use-toast";
import { getPendingIncomingCall, getBufferedIceCandidates } from "@/components/incoming-call";
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
  const [callDuration, setCallDuration] = useState(0);
  const [needsTap, setNeedsTap] = useState(false);

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const rtcRef = useRef<WebRTCConnection | null>(null);
  const callIdRef = useRef<string | null>(null);
  const hasInitiatedRef = useRef(false);
  const hasEndedRef = useRef(false);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: userProfile } = useQuery<{ id: string; name: string }>({
    queryKey: ["/api/users", otherUserId, "profile"],
    enabled: !!otherUserId,
  });

  const otherUserName = userProfile?.name || "User";

  const playRemoteAudio = useCallback((stream: MediaStream) => {
    const el = remoteAudioRef.current;
    if (!el) return;
    console.log("[CALL] Setting remote audio stream, tracks:", stream.getTracks().map(t => `${t.kind}:${t.readyState}`).join(", "));
    el.srcObject = stream;
    el.volume = 1.0;
    const p = el.play();
    if (p) {
      p.catch(() => {
        console.warn("[CALL] Autoplay blocked, will need user tap");
        setNeedsTap(true);
      });
    }
  }, []);

  const handleTapToUnmute = useCallback(() => {
    const el = remoteAudioRef.current;
    if (el) {
      el.muted = false;
      el.volume = 1.0;
      el.play().catch(() => {});
      setNeedsTap(false);
    }
  }, []);

  const doCleanup = useCallback(() => {
    stopRingtone();
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
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

    let startConnectionTimeoutFn: (() => void) | null = null;

    function onCallAnswered(data: { callId: string; answer: any }) {
      console.log("[CALL] Received call:answered");
      stopRingtone();
      if (rtcRef.current) {
        rtcRef.current.handleAnswer(data.answer)
          .then(() => {
            console.log("[CALL] Answer applied, starting connection timeout");
            if (startConnectionTimeoutFn) startConnectionTimeoutFn();
          })
          .catch((err) => console.error("[CALL] Failed to apply answer:", err));
      } else {
        console.error("[CALL] No RTC connection when answer received");
      }
    }

    function onIceCandidate(data: { candidate: any; fromUserId: string }) {
      if (rtcRef.current && data.candidate) {
        console.log("[CALL] Received ICE candidate from", data.fromUserId);
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

    async function waitForSocket(): Promise<void> {
      if (socket.connected) return;
      console.log("[CALL] Waiting for socket to connect...");
      return new Promise((resolve) => {
        const onConnect = () => {
          socket.off("connect", onConnect);
          resolve();
        };
        socket.on("connect", onConnect);
        setTimeout(() => {
          socket.off("connect", onConnect);
          resolve();
        }, 5000);
      });
    }

    async function startCall() {
      try {
        await waitForSocket();
        console.log("[CALL] Socket ready, id:", socket.id, "connected:", socket.connected);

        console.log("[CALL] Fetching ICE servers...");
        const { iceServers, hasTurn } = await fetchIceServers();
        console.log("[CALL] Got", iceServers.length, "ICE server configs, hasTurn:", hasTurn);

        const rtc = new WebRTCConnection(iceServers);
        rtcRef.current = rtc;

        rtc.onRemoteStream = (stream) => {
          console.log("[CALL] Remote stream received, tracks:", stream.getTracks().length);
          playRemoteAudio(stream);
        };

        const queuedCandidates: RTCIceCandidate[] = [];
        let callInitiated = false;

        rtc.onIceCandidate = (candidate) => {
          if (!callInitiated && !isAnswerMode) {
            queuedCandidates.push(candidate);
            return;
          }
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

        let connectionTimer: ReturnType<typeof setTimeout> | null = null;

        rtc.onConnectionStateChange = (state) => {
          console.log("[CALL] PeerConnection state:", state);
          if (state === "connected") {
            if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
            stopRingtone();
            playCallConnected();
            setCallState("active");
            durationTimerRef.current = setInterval(() => {
              setCallDuration(prev => prev + 1);
            }, 1000);
          }
          if (state === "failed") {
            if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
            handleCallEnd("Connection failed. Please check your internet and try again.");
          }
          if (state === "closed") {
            if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
            handleCallEnd();
          }
        };

        function startConnectionTimeout() {
          if (connectionTimer) clearTimeout(connectionTimer);
          connectionTimer = setTimeout(() => {
            if (rtcRef.current && rtcRef.current.connectionState !== "connected") {
              console.log("[CALL] Connection stalled after 20s post-answer, state:", rtcRef.current.connectionState);
              handleCallEnd("Could not connect. Please try again.", true);
            }
          }, 20000);
        }
        startConnectionTimeoutFn = startConnectionTimeout;

        console.log("[CALL] Getting microphone...");
        await rtc.getLocalStream();

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

          const buffered = getBufferedIceCandidates();
          if (buffered.length > 0) {
            console.log(`[CALL] Applying ${buffered.length} buffered ICE candidates from caller`);
            for (const candidate of buffered) {
              await rtc.addIceCandidate(candidate);
            }
          }

          setCallState("connecting");
          startConnectionTimeout();
        } else {
          const offer = await rtc.createOffer();
          console.log("[CALL] Calling", otherUserId);
          setCallState("ringing");
          startOutgoingRingtone();

          socket.emit("call:initiate", {
            receiverId: otherUserId,
            callType: "audio",
            offer,
          }, (response: any) => {
            console.log("[CALL] Initiate response:", JSON.stringify(response));
            if (response?.success) {
              callIdRef.current = response.callId;
              callInitiated = true;
              if (queuedCandidates.length > 0) {
                console.log(`[CALL] Flushing ${queuedCandidates.length} queued ICE candidates`);
                for (const c of queuedCandidates) {
                  socket.emit("call:ice-candidate", {
                    targetUserId: otherUserId,
                    candidate: c.toJSON(),
                  });
                }
                queuedCandidates.length = 0;
              }

              setTimeout(() => {
                if (!hasEndedRef.current && rtcRef.current?.connectionState !== "connected") {
                  console.log("[CALL] Ring timeout (45s), no answer");
                  handleCallEnd("No answer", true);
                }
              }, 45000);
            } else {
              handleCallEnd(response?.error || "Could not connect");
            }
          });
        }
      } catch (err: any) {
        console.error("[CALL] Start failed:", err);
        toast({
          title: "Microphone access needed",
          description: "Please allow microphone access to make calls.",
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

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div
      className="fixed inset-0 bg-gradient-to-b from-slate-900 to-slate-800 flex flex-col items-center justify-between py-16"
      data-testid="call-screen"
      onClick={needsTap ? handleTapToUnmute : undefined}
    >
      <audio ref={remoteAudioRef} autoPlay playsInline data-testid="audio-remote" />

      <div className="flex flex-col items-center">
        <div className="w-24 h-24 rounded-full bg-primary/20 flex items-center justify-center mb-6">
          {callState === "ringing" ? (
            <Phone className="w-12 h-12 text-primary animate-pulse" />
          ) : (
            <User className="w-12 h-12 text-primary" />
          )}
        </div>

        <h2 className="text-2xl font-semibold text-white mb-2" data-testid="text-call-user">
          {otherUserName}
        </h2>

        <p className="text-white/60 text-sm" data-testid="text-call-state">
          {callState === "connecting" && "Connecting..."}
          {callState === "ringing" && "Ringing..."}
          {callState === "active" && formatDuration(callDuration)}
          {callState === "ended" && "Call ended"}
        </p>

        {callState === "ringing" && (
          <div className="mt-4 flex gap-2">
            <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce [animation-delay:0ms]" />
            <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce [animation-delay:150ms]" />
            <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce [animation-delay:300ms]" />
          </div>
        )}

        {callState === "active" && (
          <div className="mt-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            <span className="text-green-400 text-xs">Connected</span>
          </div>
        )}
      </div>

      {needsTap && callState === "active" && (
        <div className="bg-black/50 rounded-lg px-4 py-2 flex items-center gap-2 text-white text-sm" data-testid="tap-to-unmute">
          <Volume2 className="w-4 h-4" />
          <span>Tap anywhere to hear audio</span>
        </div>
      )}

      <div className="flex justify-center gap-6">
        <Button
          variant="secondary"
          size="icon"
          className={`w-16 h-16 rounded-full ${isMuted ? "bg-red-500/30 hover:bg-red-500/40" : "bg-white/20 hover:bg-white/30"} text-white`}
          onClick={toggleMute}
          data-testid="button-toggle-mute"
        >
          {isMuted ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
        </Button>

        <Button
          variant="destructive"
          size="icon"
          className="w-16 h-16 rounded-full"
          onClick={() => handleCallEnd(undefined, true)}
          data-testid="button-end-call"
        >
          <PhoneOff className="w-7 h-7" />
        </Button>
      </div>
    </div>
  );
}
