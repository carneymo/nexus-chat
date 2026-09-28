export function releaseTimestamp(timestamp) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
}

export function datedReleaseText(text, timestamp) {
  return text.replace(
    /^Nexus (?:deployment announcement|release)(?: \([^)]*\))?: /,
    `Nexus release (${releaseTimestamp(timestamp)}): `,
  );
}
