let context: AudioContext | undefined;
export type SoundCue =
  | 'join'
  | 'message'
  | 'click'
  | 'deal'
  | 'chips'
  | 'turn'
  | 'win'
  | 'loss'
  | 'push';

type GameCue = Exclude<SoundCue, 'join' | 'message' | 'click'>;
type SoundPhrase = {
  notes: number[];
  spacing: number;
  duration: number;
  type: OscillatorType;
  shimmer?: boolean;
};

// Bright card/chip accents, a major-key reward, and an original descending
// arcade phrase. Keep these separate from the gateway's connection sounds.
const gamePhrases: Record<GameCue, SoundPhrase> = {
  deal: {
    notes: [1046.5, 1568],
    spacing: 0.045,
    duration: 0.16,
    type: 'sine',
    shimmer: true,
  },
  chips: {
    notes: [1318.5, 1760],
    spacing: 0.055,
    duration: 0.13,
    type: 'sine',
  },
  turn: {
    notes: [784, 1174.7],
    spacing: 0.09,
    duration: 0.24,
    type: 'sine',
    shimmer: true,
  },
  win: {
    notes: [1046.5, 1318.5, 1568, 2093],
    spacing: 0.105,
    duration: 0.48,
    type: 'sine',
    shimmer: true,
  },
  loss: {
    notes: [659.3, 622.3, 493.9, 392, 261.6],
    spacing: 0.12,
    duration: 0.2,
    type: 'triangle',
  },
  push: { notes: [784, 784], spacing: 0.13, duration: 0.18, type: 'sine' },
};

export function cue(kind: SoundCue, enabled: boolean) {
  if (!enabled) return;
  const synth = () => {
    try {
      context ??= new AudioContext();
      void context.resume();
      const now = context.currentTime;
      const phrase =
        kind === 'join' || kind === 'message' || kind === 'click'
          ? undefined
          : gamePhrases[kind];
      const spacing = phrase?.spacing ?? 0.08;
      const duration = phrase?.duration ?? 0.18;
      const notes =
        phrase?.notes ??
        (kind === 'join'
          ? [220, 330, 440, 660]
          : kind === 'message'
            ? [540, 720]
            : [180]);
      notes.forEach((frequency, index) => {
        const start = now + index * spacing;
        const playTone = (
          pitch: number,
          volume: number,
          decay: number,
          type: OscillatorType,
        ) => {
          const oscillator = context!.createOscillator();
          const gain = context!.createGain();
          oscillator.type = type;
          oscillator.frequency.setValueAtTime(pitch, start);
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(
            volume,
            start + (phrase ? 0.004 : 0.01),
          );
          gain.gain.exponentialRampToValueAtTime(0.001, start + decay);
          oscillator.connect(gain);
          gain.connect(context!.destination);
          oscillator.start(start);
          oscillator.stop(start + decay + 0.02);
        };
        playTone(
          frequency,
          phrase ? 0.065 : 0.09,
          duration,
          phrase?.type ?? 'triangle',
        );
        if (phrase?.shimmer)
          playTone(frequency * 2, 0.014, duration * 0.55, 'sine');
      });
    } catch {
      /* Sound is optional; browsers require a user gesture. */
    }
  };
  const custom = localStorage.getItem(`nexus-audio-${kind}`);
  if (
    custom &&
    (custom.startsWith('/sounds/') || custom.startsWith('https://'))
  )
    void new Audio(custom).play().catch(synth);
  else synth();
}
