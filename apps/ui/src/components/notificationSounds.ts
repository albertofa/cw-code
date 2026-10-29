import type { NotificationSoundEvent, NotificationSoundId } from "../cw.js";

type Overtone = readonly [ratio: number, amplitude: number, decay?: number];

interface ToneOptions {
  freq: number;
  dur: number;
  gain: number;
  attack?: number;
  glideTo?: number;
  glideTime?: number;
  partials?: readonly Overtone[];
  lowpass?: number;
  pan?: number;
}

interface NoiseOptions {
  freq: number;
  q: number;
  dur: number;
  gain: number;
  pan?: number;
}

interface Voice {
  ctx: AudioContext;
  out: AudioNode;
}

interface TockOptions {
  body: number;
  bend?: number;
  noise?: number;
  q?: number;
  click?: number;
  dur?: number;
  gain?: number;
  pan?: number;
}

interface FeltOptions {
  freq: number;
  dur: number;
  bend?: number;
  gain?: number;
  pan?: number;
}

export interface NotificationSoundInfo {
  label: string;
  description: string;
  /** The event the sound was designed for; any sound can be used for any event. */
  family: NotificationSoundEvent;
  play: (voice: Voice, t: number) => number;
}

const BRIGHTNESS_HZ = 1540;
const SILENT = 0.0001;
const RELEASE_TAIL_S = 0.5;

function bus(voice: Voice, lowpass: number | undefined, pan: number | undefined): AudioNode {
  const input = voice.ctx.createGain();
  let tail: AudioNode = input;
  if (lowpass) {
    const filter = voice.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    filter.Q.value = 0.3;
    tail = tail.connect(filter);
  }
  if (pan) {
    const panner = voice.ctx.createStereoPanner();
    panner.pan.value = pan;
    tail = tail.connect(panner);
  }
  tail.connect(voice.out);
  return input;
}

function tone(voice: Voice, t: number, o: ToneOptions): number {
  const out = bus(voice, o.lowpass, o.pan);
  const attack = o.attack ?? 0.004;
  for (const [ratio, amplitude, decay = 1] of o.partials ?? [[1, 1]]) {
    const osc = voice.ctx.createOscillator();
    osc.frequency.setValueAtTime(o.freq * ratio, t);
    if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo * ratio, t + (o.glideTime ?? o.dur * 0.5));
    const env = voice.ctx.createGain();
    const end = t + attack + o.dur * decay;
    env.gain.setValueAtTime(SILENT, t);
    env.gain.linearRampToValueAtTime(o.gain * amplitude, t + attack);
    env.gain.exponentialRampToValueAtTime(SILENT, end);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(end + 0.05);
  }
  return t + attack + o.dur;
}

function noise(voice: Voice, t: number, o: NoiseOptions): number {
  const out = bus(voice, undefined, o.pan);
  const length = Math.ceil(voice.ctx.sampleRate * o.dur);
  const buffer = voice.ctx.createBuffer(1, length, voice.ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const source = voice.ctx.createBufferSource();
  source.buffer = buffer;
  const filter = voice.ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = o.freq;
  filter.Q.value = o.q;
  const env = voice.ctx.createGain();
  env.gain.setValueAtTime(o.gain, t);
  env.gain.exponentialRampToValueAtTime(SILENT, t + o.dur);
  source.connect(filter).connect(env).connect(out);
  source.start(t);
  return t + o.dur;
}

function pluck(voice: Voice, t: number, o: { freq: number; dur: number; gain: number; damp: number; lowpass: number }): number {
  const out = bus(voice, o.lowpass, undefined);
  const rate = voice.ctx.sampleRate;
  const period = Math.round(rate / o.freq);
  const length = Math.ceil(rate * o.dur);
  const buffer = voice.ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < period; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
  for (let i = period; i < length; i++) data[i] = o.damp * 0.5 * (data[i - period] + data[Math.max(0, i - period - 1)]);
  const source = voice.ctx.createBufferSource();
  source.buffer = buffer;
  const env = voice.ctx.createGain();
  env.gain.setValueAtTime(o.gain, t);
  env.gain.setValueAtTime(o.gain, t + o.dur - 0.08);
  env.gain.linearRampToValueAtTime(0, t + o.dur);
  source.connect(env).connect(out);
  source.start(t);
  return t + o.dur;
}

function tock(voice: Voice, t: number, o: TockOptions): number {
  const gain = o.gain ?? 1;
  noise(voice, t, { freq: o.noise ?? 1400, q: o.q ?? 3, dur: o.click ?? 0.03, gain: 0.35 * gain, pan: o.pan });
  return tone(voice, t, {
    freq: o.body,
    glideTo: o.body * (o.bend ?? 0.87),
    glideTime: 0.04,
    dur: o.dur ?? 0.09,
    gain: 0.16 * gain,
    pan: o.pan
  });
}

function felt(voice: Voice, t: number, o: FeltOptions): number {
  const gain = o.gain ?? 1;
  noise(voice, t, { freq: 700, q: 2, dur: 0.015, gain: 0.1 * gain, pan: o.pan });
  return tone(voice, t, {
    freq: o.freq,
    glideTo: o.bend ? o.freq * o.bend : undefined,
    glideTime: 0.12,
    dur: o.dur,
    gain: 0.22 * gain,
    partials: [
      [1, 1],
      [2, 0.08, 0.4]
    ],
    lowpass: 1100,
    pan: o.pan
  });
}

function pop(voice: Voice, t: number, from: number, to: number, gain = 1): number {
  noise(voice, t, { freq: 900, q: 2, dur: 0.012, gain: 0.12 * gain });
  return tone(voice, t, { freq: from, glideTo: to, glideTime: 0.03, dur: 0.08, gain: 0.26 * gain, attack: 0.002, lowpass: 1500 });
}

const NOTE = { G3: 196, D4: 293.66, G4: 392, A3: 220, A4: 440 } as const;

export const NOTIFICATION_SOUNDS: Record<NotificationSoundId, NotificationSoundInfo> = {
  "tock-up": {
    label: "Tock up",
    description: "Two tocks stepping up",
    family: "done",
    play: (v, t) => {
      tock(v, t, { body: 520 });
      return tock(v, t + 0.11, { body: 690 });
    }
  },
  "wood-steps": {
    label: "Wood steps",
    description: "Three tocks climbing",
    family: "done",
    play: (v, t) => {
      tock(v, t, { body: 440, gain: 0.85 });
      tock(v, t + 0.09, { body: 554, gain: 0.9 });
      return tock(v, t + 0.18, { body: 660, dur: 0.14 });
    }
  },
  "felt-resolve": {
    label: "Felt resolve",
    description: "Soft mallet stepping up a fourth",
    family: "done",
    play: (v, t) => {
      felt(v, t, { freq: NOTE.D4, dur: 0.25 });
      return felt(v, t + 0.12, { freq: NOTE.G4, dur: 0.4 });
    }
  },
  "felt-chord": {
    label: "Felt chord",
    description: "Rolled soft-mallet chord, warm",
    family: "done",
    play: (v, t) => {
      [NOTE.G3, NOTE.D4, NOTE.G4].forEach((freq, i) => felt(v, t + i * 0.045, { freq, dur: 0.5, gain: 0.8, pan: -0.2 + i * 0.2 }));
      return t + 0.6;
    }
  },
  "thump-tock": {
    label: "Thump + tock",
    description: "Low soft thump followed by a tock",
    family: "done",
    play: (v, t) => {
      tone(v, t, { freq: 170, glideTo: 110, glideTime: 0.1, dur: 0.16, gain: 0.35, lowpass: 600 });
      return tock(v, t + 0.08, { body: 620 });
    }
  },
  "pop-up": {
    label: "Pop up",
    description: "Single rounded pop",
    family: "done",
    play: (v, t) => pop(v, t, 260, 620)
  },
  "knock-knock": {
    label: "Knock knock",
    description: "Two darker knocks, like a door",
    family: "question",
    play: (v, t) => {
      tock(v, t, { body: 380, noise: 900, q: 4, dur: 0.1 });
      return tock(v, t + 0.16, { body: 380, noise: 900, q: 4, dur: 0.1 });
    }
  },
  ask: {
    label: "Ask",
    description: "Tock, then a higher tock that bends up",
    family: "question",
    play: (v, t) => {
      tock(v, t, { body: 500 });
      return tock(v, t + 0.13, { body: 640, bend: 1.08, dur: 0.12 });
    }
  },
  "triple-tap": {
    label: "Triple tap",
    description: "Three quick even tocks",
    family: "question",
    play: (v, t) => {
      tock(v, t, { body: 580, gain: 0.9 });
      tock(v, t + 0.09, { body: 580, gain: 0.9 });
      return tock(v, t + 0.18, { body: 580, gain: 0.9 });
    }
  },
  "felt-question": {
    label: "Felt question",
    description: "Soft mallet rising with an upward bend",
    family: "question",
    play: (v, t) => {
      felt(v, t, { freq: NOTE.D4, dur: 0.22 });
      return felt(v, t + 0.12, { freq: NOTE.A4, bend: 1.05, dur: 0.4 });
    }
  },
  "hollow-knock": {
    label: "Hollow knock",
    description: "Two resonant bottle-like knocks",
    family: "question",
    play: (v, t) => {
      for (const dt of [0, 0.15]) {
        noise(v, t + dt, { freq: 700, q: 14, dur: 0.12, gain: 0.8 });
        tone(v, t + dt, { freq: 350, dur: 0.1, gain: 0.12, lowpass: 900 });
      }
      return t + 0.3;
    }
  },
  "pop-pop": {
    label: "Pop pop",
    description: "Two rising pops",
    family: "question",
    play: (v, t) => {
      pop(v, t, 230, 480);
      return pop(v, t + 0.13, 290, 640);
    }
  },
  tock: {
    label: "Tock",
    description: "Short wooden tock",
    family: "prUpdate",
    play: (v, t) => tock(v, t, { body: 620 })
  },
  "soft-tap": {
    label: "Soft tap",
    description: "Smaller, darker tock",
    family: "prUpdate",
    play: (v, t) => tock(v, t, { body: 400, noise: 1000, q: 2, click: 0.02, gain: 0.75, dur: 0.07 })
  },
  "tock-down": {
    label: "Tock down",
    description: "Two quiet tocks stepping down",
    family: "prUpdate",
    play: (v, t) => {
      tock(v, t, { body: 620, gain: 0.7 });
      return tock(v, t + 0.1, { body: 480, gain: 0.7 });
    }
  },
  "felt-tap": {
    label: "Felt tap",
    description: "Single soft mallet note",
    family: "prUpdate",
    play: (v, t) => felt(v, t, { freq: NOTE.G4, dur: 0.22 })
  },
  "muted-pluck": {
    label: "Muted pluck",
    description: "Palm-muted low string",
    family: "prUpdate",
    play: (v, t) => pluck(v, t, { freq: NOTE.A3, dur: 0.3, gain: 0.32, damp: 0.985, lowpass: 1200 })
  },
  pop: {
    label: "Pop",
    description: "Small low pop",
    family: "prUpdate",
    play: (v, t) => pop(v, t, 220, 440, 0.8)
  }
};

export function isNotificationSoundId(id: string): id is NotificationSoundId {
  return Object.hasOwn(NOTIFICATION_SOUNDS, id);
}

let output: { ctx: AudioContext; master: AudioNode } | null = null;
let failureLogged = false;

function audioOutput(): { ctx: AudioContext; master: AudioNode } {
  if (output) return output;
  const ctx = new AudioContext();
  const tilt = ctx.createBiquadFilter();
  tilt.type = "lowpass";
  tilt.frequency.value = BRIGHTNESS_HZ;
  tilt.Q.value = 0.5;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  tilt.connect(limiter).connect(ctx.destination);
  output = { ctx, master: tilt };
  return output;
}

export function volumeGain(volume: number): number {
  const level = Math.min(100, Math.max(0, volume)) / 100;
  return level * level * 1.4;
}

export async function playNotificationSound(id: NotificationSoundId, volume: number): Promise<void> {
  if (volume <= 0) return;
  try {
    const { ctx, master } = audioOutput();
    if (ctx.state !== "running") await ctx.resume();
    const out = ctx.createGain();
    out.gain.value = volumeGain(volume);
    out.connect(master);
    const end = NOTIFICATION_SOUNDS[id].play({ ctx, out }, ctx.currentTime + 0.02);
    window.setTimeout(() => out.disconnect(), (end - ctx.currentTime + RELEASE_TAIL_S) * 1000);
  } catch (err) {
    if (failureLogged) return;
    failureLogged = true;
    console.warn(`cw-code: could not play notification sound: ${(err as Error).message}`);
  }
}
