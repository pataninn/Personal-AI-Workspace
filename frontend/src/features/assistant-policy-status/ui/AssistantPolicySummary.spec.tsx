import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AssistantExecutionPolicyStatus } from '@/entities/assistant-policy';
import { AssistantPolicySummary } from '@/features/assistant-policy-status/ui/AssistantPolicySummary';

const readyPolicy: NonNullable<AssistantExecutionPolicyStatus['policy']> = {
    enabled: true,
    revision: '987654321012345678',
    provider: { name: 'Nebius Token Factory', model: 'Nemotron Example' },
    included: {
      categories: ['request', 'recent_conversation', 'project_files'],
      items: [{ kind: 'file', name: 'src/app.ts' }]
    },
    exclusionsEnforced: true,
    capabilities: ['workspace_file_read', 'workspace_file_write']
  };

const readyWorkspace: AssistantExecutionPolicyStatus = {
  scope: { kind: 'workspace', label: 'Planning Portal' },
  policy: readyPolicy,
  fileAccess: true,
  readiness: { state: 'ready' }
};

describe('AssistantPolicySummary', () => {
  it('keeps a healthy assistant silent and hides technical details', () => {
    const { container } = render(<AssistantPolicySummary status="loaded" policy={readyWorkspace} compact />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Nebius|Nemotron|operator-managed|Context and permitted/)).not.toBeInTheDocument();
  });
  it('announces loading without model or deployment information', () => {
    render(<AssistantPolicySummary status="loading" policy={null} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Assistant is working');
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
  it('uses a short actionable error', () => {
    render(<AssistantPolicySummary status="error" policy={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('Unable to connect. Try again.');
  });
  it('shows a concise unavailable state while execution remains gated', () => {
    render(<AssistantPolicySummary status="loaded" policy={{ ...readyWorkspace, readiness: { state: 'unavailable', reasonCode: 'runtime_unverified' } }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Assistant is temporarily unavailable.');
    expect(screen.queryByText(/runtime|provider|Nemotron/)).not.toBeInTheDocument();
  });
});
