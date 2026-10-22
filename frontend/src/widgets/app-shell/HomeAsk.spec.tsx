import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { sessionAuthenticated, userSessionReducer } from '@/entities/user-session';
import { HomeAsk } from '@/widgets/app-shell/HomeAsk';

vi.mock('@/features/home-chat', () => ({ HomeChat: () => null }));

describe('HomeAsk placement', () => {
  it.each([
    ['/dashboard', true], ['/tasks', true], ['/projects/one/skills', true],
    ['/projects/one', false], ['/projects/one/conversations', false],
    ['/projects/one/conversations/chat', false], ['/projects/one/planning-chat', false], ['/admin', false]
  ] as const)('shows the global launcher on %s: %s', (route, visible) => {
    const store = configureStore({ reducer: { userSession: userSessionReducer } });
    store.dispatch(sessionAuthenticated({ principal: { id: 'owner', displayName: 'Owner', accountKind: 'regular', role: 'user' },
      csrfToken: 'csrf', expiresAt: '2099-01-01T00:00:00Z' }));
    render(<Provider store={store}><MemoryRouter initialEntries={[route]}><HomeAsk /></MemoryRouter></Provider>);
    expect(Boolean(screen.queryByRole('button', { name: 'Open Home assistant' }))).toBe(visible);
  });
});
