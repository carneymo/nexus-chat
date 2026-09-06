'use client';

import { useImperativeHandle, useRef, type ComponentProps, type Ref } from 'react';
import { ScrollArea as Primitive } from '@base-ui/react/scroll-area';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { ScrollBar } from '@/components/ui/scroll-area';

type Props = ComponentProps<'div'> & { viewportRef?: Ref<HTMLDivElement> };

/** Native wheel/keyboard scrolling with a persistent, generously sized metal rail. */
export function LegacyScrollArea({
  children,
  className = '',
  viewportRef,
  ...props
}: Props) {
  const viewport = useRef<HTMLDivElement | null>(null);
  useImperativeHandle(viewportRef, () => viewport.current!, []);
  function move(direction: number) {
    viewport.current?.scrollBy({ top: direction * 100, behavior: 'smooth' });
  }
  return (
    <Primitive.Root
      className={(state) =>
        `legacy-scroll-area ${state.hasOverflowY ? 'is-overflowing' : ''}`
      }
    >
      <Primitive.Viewport
        {...props}
        className={`legacy-viewport ${className}`}
        ref={viewport}
      >
        <Primitive.Content>{children}</Primitive.Content>
      </Primitive.Viewport>
      <button
        type="button"
        className="scroll-arrow scroll-up"
        aria-label="Scroll up"
        onClick={() => move(-1)}
      >
        <ChevronUp size={18} />
      </button>
      <ScrollBar className="legacy-scrollbar" />
      <button
        type="button"
        className="scroll-arrow scroll-down"
        aria-label="Scroll down"
        onClick={() => move(1)}
      >
        <ChevronDown size={18} />
      </button>
    </Primitive.Root>
  );
}
