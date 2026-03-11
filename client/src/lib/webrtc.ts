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
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  public onRemoteStream: ((stream: MediaStream) => void) | null = null;
  public onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  public onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null;

  constructor(iceServers?: RTCIceServer[]) {
    this.pc = new RTCPeerConnection({ iceServers: iceServers || DEFAULT_ICE_SERVERS });

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    this.pc.ontrack = (event) => {
      if (event.streams[0]) {
        if (!this.remoteStream) {
          this.remoteStream = event.streams[0];
        } else {
          event.streams[0].getTracks().forEach((track) => {
            if (!this.remoteStream!.getTrackById(track.id)) {
              this.remoteStream!.addTrack(track);
            }
          });
        }
        if (this.onRemoteStream) {
          this.onRemoteStream(this.remoteStream!);
        }
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.pc.connectionState);
      }
    };
  }

  async getLocalStream(video = true, audio = true): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      audio: audio ? { echoCancellation: true, noiseSuppression: true } : false,
      video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
    };
    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    this.localStream.getTracks().forEach((track) => {
      this.pc.addTrack(track, this.localStream!);
    });
    return this.localStream;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("[WebRTC] Error adding ICE candidate:", err);
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
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

  close(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.pc.close();
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }
}
