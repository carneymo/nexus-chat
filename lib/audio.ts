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
export function cue(kind: SoundCue, enabled: boolean) {
  if (!enabled) return;
  const synth = () => {
    try {
      context ??= new AudioContext();
      void context.resume();
      const now = context.currentTime;
      const game = !['join', 'message', 'click'].includes(kind);
      const spacing = game ? 0.12 : 0.08;
      const duration = game ? 0.075 : 0.18;
      const notes =
        kind === 'join'
          ? [220, 330, 440, 660]
          : kind === 'message'
            ? [540, 720]
            : kind === 'deal'
              ? [160, 110]
              : kind === 'chips'
                ? [1300, 850]
                : kind === 'turn'
                  ? [240, 240]
                  : kind === 'win'
                    ? [520, 780]
                    : kind === 'loss'
                      ? [150, 90]
                      : kind === 'push'
                        ? [190]
                        : [180];
      notes.forEach((frequency, index) => {
        const oscillator = context!.createOscillator();
        const gain = context!.createGain();
        oscillator.type = game ? 'sine' : 'triangle';
        oscillator.frequency.setValueAtTime(frequency, now + index * spacing);
        if (game)
          oscillator.frequency.exponentialRampToValueAtTime(
            frequency * 0.55,
            now + index * spacing + duration,
          );
        gain.gain.setValueAtTime(0, now + index * spacing);
        gain.gain.linearRampToValueAtTime(
          game ? 0.065 : 0.09,
          now + index * spacing + (game ? 0.003 : 0.01),
        );
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          now + index * spacing + duration,
        );
        oscillator.connect(gain);
        gain.connect(context!.destination);
        oscillator.start(now + index * spacing);
        oscillator.stop(now + index * spacing + duration + 0.02);
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
