'use client';
import { useEffect, useRef, useState } from 'react';
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff } from 'lucide-react';
import '@/lib/desktop';
import {
  VoiceConnection,
  type VoiceMember,
  type VoiceView,
} from '@/lib/voice-client';

export function VoicePanel({
  channel,
  userId,
  members,
}: {
  channel: string;
  userId?: string;
  members: VoiceMember[];
}) {
  const connection = useRef<VoiceConnection | null>(null);
  const [view, setView] = useState<VoiceView>({
    joined: false,
    muted: false,
    deafened: false,
    members: [],
    connections: {},
    error: '',
    playbackBlocked: false,
  });
  const [joining, setJoining] = useState(false);
  const currentView = useRef(view);
  useEffect(() => {
    currentView.current = view;
    window.nexusDesktop?.setVoiceState(view);
  }, [view]);
  useEffect(() => {
    const unsubscribe = window.nexusDesktop?.onVoiceCommand((command) => {
      if (!currentView.current.joined) return;
      if (command === 'mute') void connection.current?.mute(!currentView.current.muted);
      if (command === 'deafen') connection.current?.deafen(!currentView.current.deafened);
      if (command === 'leave') connection.current?.stop();
    });
    return () => {
      unsubscribe?.();
      window.nexusDesktop?.setVoiceState({ joined: false, muted: false, deafened: false });
    };
  }, []);
  useEffect(() => {
    const leave = () => connection.current?.stop();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, []);
  const roster = view.joined
    ? view.members
    : members.filter((person) => person.channel === channel);
  async function join() {
    connection.current?.stop();
    setJoining(true);
    setView((previous) => ({ ...previous, error: '' }));
    const next = new VoiceConnection((nextView) => {
      setView(nextView);
      if (nextView.joined || nextView.error) setJoining(false);
    });
    connection.current = next;
    await next.join();
  }
  return (
    <section className="voice-panel" aria-label={`Voice in ${channel}`}>
      <div className="voice-controls">
        <span className="voice-heading">
          <Headphones size={15} /> Channel voice{' '}
          <small>{roster.length}/8</small>
        </span>
        <span className="voice-actions">
          {view.joined ? (
            <>
              <button
                type="button"
                className={view.muted ? 'voice-muted' : ''}
                aria-pressed={view.muted}
                onClick={() => void connection.current?.mute(!view.muted)}
              >
                {view.muted ? <MicOff size={14} /> : <Mic size={14} />}
                {view.muted ? 'Unmute' : 'Mute'}
              </button>
              <button
                type="button"
                className={view.deafened ? 'voice-muted' : ''}
                aria-pressed={view.deafened}
                title="Silence incoming voices. Your microphone stays unchanged."
                onClick={() => connection.current?.deafen(!view.deafened)}
              >
                {view.deafened ? (
                  <HeadphoneOff size={14} />
                ) : (
                  <Headphones size={14} />
                )}
                {view.deafened ? 'Undeafen' : 'Deafen'}
              </button>
              <button type="button" onClick={() => connection.current?.stop()}>
                <PhoneOff size={14} /> Leave
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!userId || joining}
              onClick={() => void join()}
            >
              <Mic size={14} />
              {joining ? 'Connecting…' : 'Join voice'}
            </button>
          )}
        </span>
      </div>
      <div className="voice-members" aria-live="polite">
        {roster.length ? (
          roster.map((person) => (
            <span
              key={person.id}
              className="voice-person"
              title={
                person.userId === userId
                  ? view.muted
                    ? 'Your microphone is muted'
                    : 'Your microphone is on'
                  : view.connections[person.id] || 'In voice'
              }
            >
              {person.muted || (person.userId === userId && view.muted) ? (
                <MicOff size={12} />
              ) : (
                <Mic size={12} />
              )}
              {person.name}
              {person.userId === userId ? ' (you)' : ''}
              {view.joined &&
              person.userId !== userId &&
              view.connections[person.id] !== 'Connected' ? (
                <small>{view.connections[person.id] || 'Connecting'}</small>
              ) : null}
            </span>
          ))
        ) : (
          <span className="voice-empty">
            {userId
              ? 'No one in voice. Join when you’re ready.'
              : 'Connect to join voice.'}
          </span>
        )}
      </div>
      {view.deafened && (
        <output className="voice-deafened">
          Incoming voices silenced · Your microphone is{' '}
          {view.muted ? 'muted' : 'still on'}
        </output>
      )}
      {!view.deafened && view.playbackBlocked && (
        <button
          className="voice-enable-audio"
          onClick={() => void connection.current?.resumeAudio()}
        >
          Enable incoming audio
        </button>
      )}
      {view.error && (
        <p className="voice-error" role="alert">
          {view.error}
        </p>
      )}
    </section>
  );
}
