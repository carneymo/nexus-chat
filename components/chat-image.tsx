'use client';
/* Authenticated, uncached images must be served directly by the gateway. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from 'react';

export function ImageDraft({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}) {
  const preview = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const reader = new FileReader();
    reader.onload = () => {
      if (preview.current && typeof reader.result === 'string')
        preview.current.src = reader.result;
    };
    reader.readAsDataURL(file);
    return () => {
      reader.onload = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
    };
  }, [file]);
  return (
    <div className="gif-draft image-draft">
      <img ref={preview} alt={`Preview: ${file.name}`} />
      <span>{file.name} · Ready to send</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label="Remove image"
      >
        ×
      </button>
    </div>
  );
}

export function ChatImage({
  id,
  name,
  deleted,
  own,
  onDelete,
}: {
  id: number;
  name: string;
  deleted?: boolean;
  own: boolean;
  onDelete: () => Promise<void>;
}) {
  const [unavailable, setUnavailable] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (deleted)
    return (
      <span className="image-unavailable">Image deleted or unavailable</span>
    );
  return (
    <div className="chat-image">
      {unavailable ? (
        <span className="image-unavailable">Image unavailable</span>
      ) : (
        <a
          href={`/api/images/${id}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open image: ${name}`}
        >
          <img
            src={`/api/images/${id}`}
            alt={name}
            loading="lazy"
            onError={() => setUnavailable(true)}
          />
        </a>
      )}
      {own && (
        <button
          type="button"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true);
            try {
              await onDelete();
            } finally {
              setDeleting(false);
            }
          }}
        >
          {deleting ? 'Deleting…' : 'Delete image'}
        </button>
      )}
    </div>
  );
}

export function imagePayload(
  file: File,
): Promise<{ name: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error('Unable to read this image. Try selecting it again.'));
    reader.onload = () =>
      resolve({
        name: file.name,
        data:
          typeof reader.result === 'string' ? reader.result.split(',')[1] : '',
      });
    reader.readAsDataURL(file);
  });
}
