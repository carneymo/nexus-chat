let context: AudioContext | undefined;
export function cue(kind: 'join' | 'message' | 'click', enabled: boolean) {
  if (!enabled) return;
  const synth = () => {
    try {
      context ??= new AudioContext();
      void context.resume();
      const now = context.currentTime;
      const notes =
        kind === 'join'
          ? [220, 330, 440, 660]
          : kind === 'message'
            ? [540, 720]
            : [180];
      notes.forEach((frequency, index) => {
        const oscillator = context!.createOscillator();
        const gain = context!.createGain();
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(frequency, now + index * 0.08);
        gain.gain.setValueAtTime(0, now + index * 0.08);
        gain.gain.linearRampToValueAtTime(0.09, now + index * 0.08 + 0.01);
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          now + index * 0.08 + 0.18,
        );
        oscillator.connect(gain);
        gain.connect(context!.destination);
        oscillator.start(now + index * 0.08);
        oscillator.stop(now + index * 0.08 + 0.2);
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
