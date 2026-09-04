let audioContext: AudioContext | null = null;
let ringInterval: ReturnType<typeof setInterval> | null = null;
let activeTimeouts: ReturnType<typeof setTimeout>[] = [];
let activeOscillators: OscillatorNode[] = [];

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

function playTone(frequency: number, duration: number, volume = 0.3) {
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.05);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration - 0.05);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);

    activeOscillators.push(oscillator);
    oscillator.onended = () => {
      activeOscillators = activeOscillators.filter((o) => o !== oscillator);
    };
  } catch {}
}

function scheduleTone(delay: number, frequency: number, duration: number, volume: number) {
  const t = setTimeout(() => playTone(frequency, duration, volume), delay);
  activeTimeouts.push(t);
}

export function startOutgoingRingtone() {
  stopRingtone();
  playRingPattern();
  ringInterval = setInterval(playRingPattern, 3000);
}

function playRingPattern() {
  playTone(440, 0.4, 0.2);
  scheduleTone(500, 440, 0.4, 0.2);
}

export function startIncomingRingtone() {
  stopRingtone();
  playIncomingPattern();
  ringInterval = setInterval(playIncomingPattern, 2500);
}

function playIncomingPattern() {
  playTone(523, 0.3, 0.35);
  scheduleTone(400, 659, 0.3, 0.35);
  scheduleTone(800, 784, 0.4, 0.35);
}

export function stopRingtone() {
  if (ringInterval) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
  for (const t of activeTimeouts) {
    clearTimeout(t);
  }
  activeTimeouts = [];
  for (const osc of activeOscillators) {
    try { osc.stop(); } catch {}
  }
  activeOscillators = [];
}

export function playCallConnected() {
  playTone(880, 0.15, 0.2);
  scheduleTone(180, 1100, 0.2, 0.2);
}

export function playCallEnded() {
  playTone(440, 0.2, 0.15);
  scheduleTone(250, 330, 0.3, 0.15);
}
