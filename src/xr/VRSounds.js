/**
 * Short clicks and blips for the headset. A controller answers a press with a
 * buzz. A bare hand has nothing to feel, so a sound tells you the press
 * landed. Each one is a tone or two synthesised on the spot: nothing to
 * download, and nothing that plays outside VR.
 *
 * Audio has to be started by a click or a key press, like full screen. The
 * click on the page's VR button is one, so the session's start unlocks it.
 */

/** Tones: start and end frequency in Hz, start time and length in seconds, peak gain. */
const SOUNDS = {
  // A panel button.
  press: [{ from: 1250, to: 1100, at: 0, length: 0.045, gain: 0.07 }],
  // Choosing something in the scene.
  select: [
    { from: 660, to: 660, at: 0, length: 0.07, gain: 0.06 },
    { from: 990, to: 990, at: 0.055, length: 0.09, gain: 0.05 },
  ],
  // A press that needs a second one to go through.
  arm: [{ from: 520, to: 470, at: 0, length: 0.08, gain: 0.06 }],
  // The panel coming to hand.
  summon: [{ from: 420, to: 700, at: 0, length: 0.12, gain: 0.035 }],
};

export class VRSounds {
  constructor() {
    this.enabled = true;
    /** @type {AudioContext|null} */
    this.context = null;
  }

  /** Called from the click that starts a session. */
  unlock() {
    if (!this.enabled) return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    } catch {
      // Fine without audio, since every sound here has a visible counterpart.
      this.context = null;
    }
  }

  /** @param {keyof SOUNDS} name */
  play(name) {
    const context = this.context;
    if (!this.enabled || !context) return;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    const start = context.currentTime;
    for (const tone of SOUNDS[name] ?? []) {
      const at = start + tone.at;
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(tone.from, at);
      if (tone.to !== tone.from) oscillator.frequency.exponentialRampToValueAtTime(tone.to, at + tone.length);
      // Ramp up over a few milliseconds or the start clicks, then fall off exponentially.
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(tone.gain, at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + tone.length + 0.02);
    }
  }
}
