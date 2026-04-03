const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export async function fetchIceServers(): Promise<{ iceServers: RTCIceServer[]; hasTurn: boolean }> {
  try {
    const res = await fetch("/api/turn-credentials", { credentials: "include" });
    if (!res.ok) return { iceServers: DEFAULT_ICE_SERVERS, hasTurn: false };
    const data = await res.json();
    const servers = data.iceServers || DEFAULT_ICE_SERVERS;
    const hasTurn = servers.some((s: any) => {
      const urlList = typeof s.urls === "string" ? [s.urls] : (Array.isArray(s.urls) ? s.urls : []);
      return urlList.some((u: string) => u.startsWith("turn:") || u.startsWith("turns:"));
    });
    console.log("[WebRTC] ICE servers fetched:", servers.length, "hasTurn:", hasTurn);
    return { iceServers: servers, hasTurn };
  } catch {
    return { iceServers: DEFAULT_ICE_SERVERS, hasTurn: false };
  }
}

export class WebRTCConnection {
  private pc: RTCPeerConnection;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private callEstablished = false;
  private isRestarting = false;

  public onRemoteStream: ((stream: MediaStream) => void) | null = null;
  public onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  public onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null;
  public onNegotiationNeeded: ((offer: RTCSessionDescriptionInit) => void) | null = null;

  constructor(iceServers: RTCIceServer[]) {
    const config: RTCConfiguration = {
      iceServers,
      iceCandidatePoolSize: 2,
      iceTransportPolicy: "all",
    };

    this.pc = new RTCPeerConnection(config);
    console.log("[WebRTC] PeerConnection created, iceTransportPolicy: all, servers:", iceServers.length);

    this.setupListeners();
    this.setupNetworkMonitor();
  }

  private setupListeners() {
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        console.log("[WebRTC] Local ICE candidate:", event.candidate.candidate?.substring(0, 80));
        this.onIceCandidate(event.candidate);
      }
      if (!event.candidate) {
        console.log("[WebRTC] ICE gathering complete (null candidate)");
      }
    };

    this.pc.ontrack = (event) => {
      console.log("[WebRTC] ontrack fired, kind:", event.track.kind, "readyState:", event.track.readyState, "muted:", event.track.muted);

      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }

      this.remoteStream.addTrack(event.track);

      event.track.onunmute = () => {
        console.log("[WebRTC] Track unmuted:", event.track.kind);
        if (this.onRemoteStream && this.remoteStream) {
          this.onRemoteStream(this.remoteStream);
        }
      };

      event.track.onended = () => {
        console.log("[WebRTC] Track ended:", event.track.kind);
      };

      if (this.onRemoteStream) {
        this.onRemoteStream(this.remoteStream);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log("[WebRTC] ICE connection state:", state);

      if (state === "connected" || state === "completed") {
        this.callEstablished = true;
        this.isRestarting = false;
        if (this.disconnectTimer) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
        }
      }

      if (state === "disconnected" && this.callEstablished) {
        this.disconnectTimer = setTimeout(() => {
          if (this.pc.iceConnectionState === "disconnected") {
            console.log("[WebRTC] Still disconnected after 3s, restarting ICE");
            this.restartIce();
          }
        }, 3000);
      }

      if (state === "failed") {
        if (this.callEstablished) {
          console.log("[WebRTC] ICE failed after established, attempting restart");
          this.restartIce();
        } else {
          console.error("[WebRTC] ICE failed during initial connection");
          if (this.onConnectionStateChange) {
            this.onConnectionStateChange("failed");
          }
        }
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log("[WebRTC] Connection state:", state);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
    };

    this.pc.onsignalingstatechange = () => {
      console.log("[WebRTC] Signaling state:", this.pc.signalingState);
    };

    this.pc.onnegotiationneeded = async () => {
      if (!this.callEstablished || this.isRestarting) {
        return;
      }
      if (this.pc.signalingState !== "stable") {
        return;
      }
      console.log("[WebRTC] Negotiation needed (ICE restart)");
      if (this.onNegotiationNeeded) {
        try {
          this.isRestarting = true;
          const offer = await this.pc.createOffer({ iceRestart: true });
          await this.pc.setLocalDescription(offer);
          await this.waitForIceGathering(3000);
          const finalDesc = this.pc.localDescription!;
          this.onNegotiationNeeded({ type: finalDesc.type, sdp: finalDesc.sdp });
        } catch (err) {
          this.isRestarting = false;
          console.error("[WebRTC] ICE restart negotiation failed:", err);
        }
      }
    };

    this.pc.onicegatheringstatechange = () => {
      console.log("[WebRTC] ICE gathering state:", this.pc.iceGatheringState);
    };
  }

  private networkHandler = () => {
    console.log("[WebRTC] Network change detected, online:", navigator.onLine);
    if (navigator.onLine && this.callEstablished && this.pc.iceConnectionState !== "connected" && this.pc.iceConnectionState !== "completed") {
      setTimeout(() => this.restartIce(), 1000);
    }
  };

  private setupNetworkMonitor() {
    window.addEventListener("online", this.networkHandler);
  }

  private removeNetworkMonitor() {
    window.removeEventListener("online", this.networkHandler);
  }

  private restartIce() {
    try {
      if (this.pc.signalingState === "closed" || this.isRestarting) return;
      console.log("[WebRTC] Triggering ICE restart");
      this.pc.restartIce();
    } catch (err) {
      console.error("[WebRTC] restartIce error:", err);
    }
  }

  private waitForIceGathering(timeout = 5000): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === "complete") {
        console.log("[WebRTC] ICE gathering already complete");
        resolve();
        return;
      }

      let timer: ReturnType<typeof setTimeout>;

      const checkComplete = () => {
        if (this.pc.iceGatheringState === "complete") {
          console.log("[WebRTC] ICE gathering completed");
          clearTimeout(timer);
          this.pc.removeEventListener("icegatheringstatechange", checkComplete);
          resolve();
        }
      };

      this.pc.addEventListener("icegatheringstatechange", checkComplete);

      timer = setTimeout(() => {
        console.log("[WebRTC] ICE gathering timeout after", timeout, "ms, proceeding with current candidates");
        this.pc.removeEventListener("icegatheringstatechange", checkComplete);
        resolve();
      }, timeout);
    });
  }

  async getLocalStream(video = true, audio = true): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      audio: audio ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } : false,
      video: video ? {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 },
      } : false,
    };

    console.log("[WebRTC] Requesting getUserMedia...");
    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    const trackInfo = this.localStream.getTracks().map(t => `${t.kind}:${t.readyState}:enabled=${t.enabled}`).join(", ");
    console.log("[WebRTC] Got local stream, tracks:", trackInfo);

    this.localStream.getTracks().forEach((track) => {
      this.pc.addTrack(track, this.localStream!);
    });

    console.log("[WebRTC] Added", this.pc.getSenders().length, "senders to peer connection");
    return this.localStream;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await this.pc.setLocalDescription(offer);
    console.log("[WebRTC] Offer created, waiting for ICE gathering...");

    await this.waitForIceGathering(3000);

    const finalDesc = this.pc.localDescription!;
    const candidateCount = (finalDesc.sdp?.match(/a=candidate:/g) || []).length;
    console.log("[WebRTC] Final offer SDP length:", finalDesc.sdp?.length, "embedded candidates:", candidateCount);
    return { type: finalDesc.type, sdp: finalDesc.sdp };
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const offerCandidates = (offer.sdp?.match(/a=candidate:/g) || []).length;
    console.log("[WebRTC] Received offer, SDP length:", offer.sdp?.length, "embedded candidates:", offerCandidates, "signalingState:", this.pc.signalingState);

    await this.pc.setRemoteDescription(offer);
    this.hasRemoteDescription = true;
    console.log("[WebRTC] Remote description set, signalingState:", this.pc.signalingState);
    await this.flushPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    console.log("[WebRTC] Answer created, waiting for ICE gathering...");

    await this.waitForIceGathering(3000);

    const finalDesc = this.pc.localDescription!;
    const candidateCount = (finalDesc.sdp?.match(/a=candidate:/g) || []).length;
    console.log("[WebRTC] Final answer SDP length:", finalDesc.sdp?.length, "embedded candidates:", candidateCount);
    return { type: finalDesc.type, sdp: finalDesc.sdp };
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    const answerCandidates = (answer.sdp?.match(/a=candidate:/g) || []).length;
    console.log("[WebRTC] Received answer, SDP length:", answer.sdp?.length, "embedded candidates:", answerCandidates, "signalingState:", this.pc.signalingState);

    if (this.pc.signalingState === "have-local-offer") {
      await this.pc.setRemoteDescription(answer);
      this.hasRemoteDescription = true;
      console.log("[WebRTC] Remote description set, signalingState:", this.pc.signalingState);
      await this.flushPendingCandidates();
    } else {
      console.warn("[WebRTC] Unexpected signaling state for answer:", this.pc.signalingState);
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.error("[WebRTC] Error adding ICE candidate:", err);
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const count = this.pendingCandidates.length;
    if (count > 0) {
      console.log(`[WebRTC] Flushing ${count} pending ICE candidates`);
    }
    for (const candidate of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        console.error("[WebRTC] Error adding pending ICE candidate:", err);
      }
    }
    this.pendingCandidates = [];
  }

  toggleAudio(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  toggleVideo(enabled: boolean): void {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }

  async switchCamera(): Promise<void> {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (!videoTrack) return;

    const currentFacing = videoTrack.getSettings().facingMode;
    const newFacing = currentFacing === "user" ? "environment" : "user";

    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: newFacing },
      audio: false,
    });

    const newVideoTrack = newStream.getVideoTracks()[0];
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(newVideoTrack);
    }

    videoTrack.stop();
    if (this.localStream) {
      this.localStream.removeTrack(videoTrack);
      this.localStream.addTrack(newVideoTrack);
    }
  }

  getLocalMediaStream(): MediaStream | null {
    return this.localStream;
  }

  close(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    this.removeNetworkMonitor();
    this.localStream?.getTracks().forEach((t) => t.stop());
    try {
      this.pc.close();
    } catch {}
    console.log("[WebRTC] Connection closed");
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.pc.iceConnectionState;
  }
}
