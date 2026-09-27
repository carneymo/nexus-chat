'use client';
import { useState } from 'react';
import type { CommunityState, SocialMember } from './community-panel';

export function WhispersPanel({
  members,
  userId,
  community,
  open,
}: {
  members: SocialMember[];
  userId: string;
  community: CommunityState;
  open: (member: SocialMember) => void;
}) {
  const [query, setQuery] = useState('');
  const unread = new Map(
    community.unread.map((entry) => [entry.peer, entry.count]),
  );
  const recent = new Map(
    (community.conversations || []).map((entry) => [
      entry.peer,
      entry.lastMessageAt,
    ]),
  );
  const people = members
    .filter(
      (member) =>
        member.id !== userId &&
        !community.preferences.some(
          (p) => p.peer_id === member.id && p.blocked,
        ) &&
        `${member.name} ${member.handle || ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (unread.get(b.id) || 0) - (unread.get(a.id) || 0) ||
        (recent.get(b.id) || 0) - (recent.get(a.id) || 0) ||
        a.name.localeCompare(b.name),
    );
  return (
    <div className="whispers-inbox">
      <label>
        Find a conversation or start a whisper
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or handle"
        />
      </label>
      {!people.length && <p>No matching members.</p>}
      {people.map((member) => (
        <button
          className="whisper-conversation"
          key={member.id}
          onClick={() => open(member)}
        >
          <span>
            <strong>{member.name}</strong>
            <small>
              {recent.has(member.id) ? 'Open conversation' : 'Start a whisper'}{' '}
              · {member.online ? 'Online' : 'Offline'}
            </small>
          </span>
          {!!unread.get(member.id) && (
            <span className="unread-badge">{unread.get(member.id)} unread</span>
          )}
        </button>
      ))}
    </div>
  );
}
