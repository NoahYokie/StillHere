const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch("/api/turn-credentials", { credentials: "include" });
    if (!res.ok) return DEFAULT_ICE_SERVERS;
    const data = await res.json();
    return data.iceServers || DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

export class WebRTCConnection {
  private pc: RTCPeerConnection;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  private iceServers: RTCIceServer[];
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private callEstablished = false;
  private isRestarting = false;

  public onRemoteStream: ((stream: MediaStream) => void) | null = null;
  public onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  public onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null;
  public onNegotiationNeeded: ((offer: RTCSessionDescriptionInit) => void) | null = null;

  constructor(iceServers?: RTCIceServer[]) {
    this.iceServers = iceServers || DEFAULT_ICE_SERVERS;

    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2,
    });

    this.setupListeners();
    this.setupNetworkMonitor();
  }

  private setupListeners() {
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    this.pc.ontrack = (event) => {
      console.log("[WebRTC] ontrack fired, kind:", event.track.kind, "readyState:", event.track.readyState);

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

      if (state === "failed" && this.callEstablished) {
        console.log("[WebRTC] ICE failed, attempting restart");
        this.restartIce();
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log("[WebRTC] Connection state:", state);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
    };

    this.pc.onnegotiationneeded = async () => {
      if (!this.callEstablished || this.isRestarting) {
        console.log("[WebRTC] Skipping negotiation (not established or already restarting)");
        return;
      }
      if (this.pc.signalingState !== "stable") {
        console.log("[WebRTC] Skipping negotiation (signaling state:", this.pc.signalingState, ")");
        return;
      }
      console.log("[WebRTC] Negotiation needed (ICE restart)");
      if (this.onNegotiationNeeded) {
        try {
          this.isRestarting = true;
          const offer = await this.pc.createOffer({ iceRestart: true });
          await this.pc.setLocalDescription(offer);
          this.onNegotiationNeeded(offer);
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
    if (navigator.onLine && this.pc.iceConnectionState !== "connected" && this.pc.iceConnectionState !== "completed") {
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

    console.log("[WebRTC] Requesting media with constraints:", JSON.stringify(constraints));
    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log("[WebRTC] Got local stream, tracks:", this.localStream.getTracks().map(t => `${t.kind}:${t.readyState}`).join(", "));

    this.localStream.getTracks().forEach((track) => {
      this.pc.addTrack(track, this.localStream!);
    });
    return this.localStream;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await this.pc.setLocalDescription(offer);
    const localDesc = this.pc.localDescription;
    console.log("[WebRTC] Created offer, SDP length:", localDesc?.sdp?.length, "signalingState:", this.pc.signalingState);
    return localDesc as RTCSessionDescriptionInit;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    console.log("[WebRTC] Setting remote description (offer), type:", offer.type, "SDP length:", offer.sdp?.length, "signalingState:", this.pc.signalingState);
    await this.pc.setRemoteDescription(offer);
    this.hasRemoteDescription = true;
    console.log("[WebRTC] Remote description set, signalingState:", this.pc.signalingState);
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    console.log("[WebRTC] Created answer, SDP length:", answer.sdp?.length, "signalingState:", this.pc.signalingState);
    return this.pc.localDescription as RTCSessionDescriptionInit;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    console.log("[WebRTC] Setting remote description (answer), type:", answer.type, "SDP length:", answer.sdp?.length, "signalingState:", this.pc.signalingState);
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
      console.log("[WebRTC] Queuing ICE candidate (no remote desc yet), total queued:", this.pendingCandidates.length + 1);
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
      console.log(`[WebRTC] Flushing ${count} buffered ICE candidates`);
    }
    for (const candidate of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        console.error("[WebRTC] Error adding buffered ICE candidate:", err);
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
    this.pc.close();
    console.log("[WebRTC] Connection closed");
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.pc.iceConnectionState;
  }
}
