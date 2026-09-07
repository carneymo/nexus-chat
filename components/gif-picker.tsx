'use client';
/* GIPHY media must load directly, without an image optimization proxy. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { gifReference, giphyRequest, parseGif, type Gif } from '@/lib/giphy';

export function GifPicker({
  open,
  onClose,
  onSelect,
  apiKey,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (gif: Gif) => void;
  apiKey: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<Gif | null>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function search() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setResults([]);
    try {
      const data = await giphyRequest(
        apiKey,
        '/search',
        { q: query.trim(), limit: '12' },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setResults(Array.isArray(data.data) ? data.data.map(parseGif) : []);
        if (!Array.isArray(data.data) || !data.data.length)
          setError('No GIFs found. Try a different search.');
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="nexus-dialog gif-dialog">
        <DialogTitle>Find a GIF</DialogTitle>
        <DialogDescription>
          Search GIPHY, choose a GIF, then press Send. Searches and previews
          connect directly to GIPHY.
        </DialogDescription>
        {!apiKey ? (
          <output>
            GIF search isn’t configured yet. The server owner needs to add a
            GIPHY API key.
          </output>
        ) : (
          <>
            <form
              className="gif-search"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <input
                aria-label="Search GIFs"
                placeholder="Victory, facepalm, happy dance…"
                maxLength={100}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                className="dialog-action"
                disabled={busy || !query.trim()}
              >
                Search
              </button>
            </form>
            <output>{busy ? 'Searching…' : error}</output>
            <div className="gif-grid">
              {results.map((gif, i) =>
                gif ? (
                  <button
                    key={gif.id}
                    aria-label={'Select ' + gif.title}
                    onClick={() => {
                      onSelect(gif);
                      onClose();
                    }}
                  >
                    <img
                      src={gif.animated}
                      alt={gif.title}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                    <span>{gif.title || 'GIF'}</span>
                  </button>
                ) : (
                  <span key={'unavailable-' + i}>Preview unavailable</span>
                ),
              )}
            </div>
          </>
        )}
        <a
          className="giphy-credit"
          href="https://giphy.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          Powered By GIPHY
        </a>
      </DialogContent>
    </Dialog>
  );
}

export function GifMessage({ id, apiKey }: { id: string; apiKey: string }) {
  const [gif, setGif] = useState<Gif | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function load() {
    setBusy(true);
    setError('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const data = await giphyRequest(apiKey, '/' + id, {}, controller.signal);
      const value = parseGif(data.data);
      if (!value) throw Error('This GIF is no longer available.');
      if (!controller.signal.aborted) {
        setGif(value);
        setPlaying(true);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'GIF unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <span className="gif-message">
      {gif ? (
        <button
          type="button"
          className="gif-play"
          aria-label={playing ? 'Pause GIF' : 'Play GIF'}
          onClick={() => setPlaying(!playing)}
        >
          <img
            src={playing ? gif.animated : gif.still}
            alt={gif.title}
            width={gif.width}
            height={gif.height}
            referrerPolicy="no-referrer"
            onError={() => {
              setGif(null);
              setError('GIF could not load.');
            }}
          />
          <span>{playing ? 'Pause' : 'Play'} GIF</span>
        </button>
      ) : (
        <button
          type="button"
          disabled={busy || !apiKey}
          onClick={() => void load()}
        >
          {busy ? 'Loading…' : 'Load GIF'}
        </button>
      )}
      {error && <output>{error}</output>}
      <a href={gifReference(id)} target="_blank" rel="noopener noreferrer">
        View on GIPHY
      </a>
      {!gif && <small>Loads from GIPHY when clicked.</small>}
      {gif && <small>Powered By GIPHY</small>}
    </span>
  );
}
