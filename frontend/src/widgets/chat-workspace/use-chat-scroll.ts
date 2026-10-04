import { useLayoutEffect, useRef, useState } from 'react';

/** Keep the reader anchored while older history is prepended or an answer grows. */
export function useChatScroll(input: { readonly conversationId?: string; readonly ready: boolean; readonly firstSequence?: number; readonly lastSequence?: number; readonly olderLoading?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const previousRef = useRef({ conversationId: input.conversationId, firstSequence: input.firstSequence, height: 0, top: 0 });
  const [showLatest, setShowLatest] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !input.ready) return;
    const previous = previousRef.current;
    const changedConversation = previous.conversationId !== input.conversationId || previous.height === 0;
    const prepended = !changedConversation && input.firstSequence !== undefined && previous.firstSequence !== undefined && input.firstSequence < previous.firstSequence;
    if (changedConversation || followRef.current && !prepended) viewport.scrollTop = viewport.scrollHeight;
    else if (prepended) {
      const anchor = prependAnchorRef.current ?? previous;
      viewport.scrollTop = anchor.top + viewport.scrollHeight - anchor.height;
    }
    if (changedConversation || prepended || !input.olderLoading) prependAnchorRef.current = null;
    followRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
    setShowLatest(!followRef.current);
    previousRef.current = { conversationId: input.conversationId, firstSequence: input.firstSequence, height: viewport.scrollHeight, top: viewport.scrollTop };
  }, [input.conversationId, input.firstSequence, input.lastSequence, input.ready, input.olderLoading]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !input.ready) return;
    const update = (): void => {
      if (prependAnchorRef.current) return;
      if (followRef.current) viewport.scrollTop = viewport.scrollHeight;
      previousRef.current = { ...previousRef.current, height: viewport.scrollHeight, top: viewport.scrollTop };
    };
    const observer = new MutationObserver(update);
    observer.observe(viewport, { childList: true, characterData: true, subtree: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    for (const child of viewport.children) resize?.observe(child);
    return () => { observer.disconnect(); resize?.disconnect(); };
  }, [input.conversationId, input.ready]);

  function onScroll(): void {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
    setShowLatest(!followRef.current);
    previousRef.current = { ...previousRef.current, height: viewport.scrollHeight, top: viewport.scrollTop };
  }

  function jumpToLatest(): void {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
    setShowLatest(false);
  }

  function beforeLoadOlder(): void {
    onScroll();
    followRef.current = false;
    const viewport = viewportRef.current;
    if (viewport) prependAnchorRef.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
  }

  return { viewportRef, showLatest, onScroll, jumpToLatest, beforeLoadOlder };
}
