import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { getAiRun, sendChatMessage } from '@/entities/ai-run';
import type { AiRunSnapshot } from '@/entities/ai-run';
import { getConversation, type ConversationHistoryResponse } from '@/entities/conversation';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

const ACTIVE = new Set(['ready', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'staging']);

export function useDirectChat(input: {
  readonly projectId: string;
  readonly conversationId: string;
  readonly csrfToken: string | null;
  readonly disabled: boolean;
  readonly onHistory: (history: ConversationHistoryResponse) => void;
}): {
  readonly content: string;
  readonly setContent: (content: string) => void;
  readonly error: string | null;
  readonly pending: boolean;
  readonly restoring: boolean;
  readonly hasRunLink: boolean;
  readonly busy: boolean;
  readonly run: AiRunSnapshot | null;
  readonly setRun: (run: AiRunSnapshot) => void;
  readonly send: () => Promise<void>;
  readonly refresh: () => void;
} {
  const { projectId, conversationId, csrfToken, disabled, onHistory } = input;
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [run, setRun] = useState<AiRunSnapshot | null>(null);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [params, setParams] = useSearchParams();
  const runId = params.get('runId');
  const busyRef = useRef(false);
  const intent = useRef<{ content: string; key: string } | null>(null);
  const currentConversation = useRef(conversationId);
  currentConversation.current = conversationId;

  useEffect(() => {
    setContent(''); setError(null); setRun(null); intent.current = null;
  }, [projectId, conversationId]);

  useEffect(() => {
    let cancelled = false;
    if (!runId) { setRestoring(false); return; }
    setRestoring(true);
    void getAiRun(runId).then((saved) => {
      if (saved.projectId !== projectId || saved.conversationId !== conversationId) throw new Error('Wrong conversation');
      if (!cancelled) { setRun(saved); setError(null); }
    }).catch(() => { if (!cancelled) setError('The current AI run could not be loaded. Refresh its status before sending again.'); })
      .finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; };
  }, [runId, projectId, conversationId, refreshAttempt]);

  async function send(): Promise<void> {
    const request = content.trim();
    if (!request || !csrfToken || disabled || busyRef.current || restoring || (runId && !run) || (run && ACTIVE.has(run.status))) return;
    busyRef.current = true; setPending(true); setError(null);
    const key = intent.current?.content === request ? intent.current.key : createIdempotencyKey();
    intent.current = { content: request, key };
    try {
      const started = await sendChatMessage(projectId, conversationId, request, csrfToken, key);
      if (currentConversation.current !== conversationId) return;
      if (['failed', 'blocked', 'rejected'].includes(started.status) && started.providerTransmission === 'not_started_confirmed') {
        setRun(started); intent.current = null; setError(started.safeMessage || 'The message was not sent. Try again.'); return;
      }
      setRun(started); setContent(''); intent.current = null;
      setParams((previous) => { const next = new URLSearchParams(previous); next.set('runId', started.runId); return next; }, { replace: true });
      try {
        const history = await getConversation(projectId, conversationId);
        if (currentConversation.current === conversationId) onHistory(history);
      } catch {
        setError('Message sent. The conversation could not be refreshed; refresh the run status to reload it.');
      }
    } catch (caught: unknown) {
      if (caught instanceof ApiClientError && ['EGRESS_SOURCE_CHANGED', 'AI_RUN_RUNTIME_UNAVAILABLE'].includes(caught.code)) intent.current = null;
      if (currentConversation.current === conversationId) setError(chatError(caught));
    } finally { busyRef.current = false; setPending(false); }
  }

  return { content, setContent, error, pending, restoring, hasRunLink: Boolean(runId), run, setRun, send,
    busy: pending || restoring || Boolean(runId && !run) || Boolean(run && ACTIVE.has(run.status)), refresh: () => setRefreshAttempt((value) => value + 1) };
}

function chatError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const detail = error.details[0];
    if (detail) return detail.message;
    if (error.code === 'EGRESS_SOURCE_CHANGED') return 'A selected file or fact changed while sending. Try again with the current context.';
    if (error.code === 'AI_RUN_RUNTIME_UNAVAILABLE') return 'The AI provider is unavailable. Keep your message and try again.';
    if (error.code === 'PROJECT_NOT_FOUND') return 'This project is unavailable or archived.';
  }
  return 'Your message could not be sent. Keep your draft and try again.';
}
