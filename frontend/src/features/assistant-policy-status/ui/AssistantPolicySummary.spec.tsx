import { render, screen, within } from '@testing-library/react';
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
  it('keeps scope, readiness and provider visible while compact details start closed', () => {
    render(<AssistantPolicySummary compact status="loaded" policy={readyWorkspace} />);
    expect(screen.getByRole('status')).toHaveTextContent('Assistant is available.');
    expect(screen.getAllByText(/Nebius Token Factory.*Nemotron Example/u)[0]).toBeVisible();
    expect(screen.getByText(/Workspace data is stored on the operator-managed deployment/u)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Read Nebius Token Factory terms' })).toHaveAttribute('href', 'https://docs.nebius.com/legal/token-factory');
    expect(screen.getByText('Context and permitted actions').closest('details')).not.toHaveAttribute('open');
  });
  it('shows safe server-provided scope, provider, included context and plain action labels', () => {
    render(<AssistantPolicySummary status="loaded" policy={readyWorkspace} />);

    expect(screen.getByRole('heading', { name: 'Assistant scope' })).toBeInTheDocument();
    expect(screen.getByText('Planning Portal')).toBeInTheDocument();
    expect(screen.getByText('Nebius Token Factory · Nemotron Example')).toBeInTheDocument();
    expect(screen.getByText('Assistant is available.')).toBeInTheDocument();
    expect(screen.getByText(/Workspace data is stored on the operator-managed deployment/u)).toHaveTextContent('When you submit an assistant request, selected context is sent to Nebius Token Factory for processing.');
    expect(screen.getByRole('link', { name: 'Read Nebius Token Factory terms' })).toBeVisible();
    expect(screen.getByText('Current request')).toBeInTheDocument();
    expect(screen.getByText('Recent conversation')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('Read selected workspace files')).toBeInTheDocument();
    expect(screen.getByText('Update selected workspace files')).toBeInTheDocument();
    expect(screen.getByText('Protected locations, other workspaces, and unselected items stay outside this scope.')).toBeInTheDocument();

    const summary = screen.getByRole('region', { name: 'Assistant policy summary' });
    expect(within(summary).queryByRole('button', { name: /approve|accept/u })).not.toBeInTheDocument();
    expect(summary).not.toHaveTextContent('987654321012345678');
    expect(summary).not.toHaveTextContent('workspace_file_read');
    expect(summary).not.toHaveTextContent('revision');
  });

  it('announces loading and error without implying readiness', () => {
    const { rerender } = render(<AssistantPolicySummary status="loading" policy={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking assistant availability…');
    expect(screen.queryByText('Assistant is available.')).not.toBeInTheDocument();

    rerender(<AssistantPolicySummary status="error" policy={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('Assistant availability could not be checked.');
    expect(screen.getByText('Current scope')).toBeInTheDocument();
  });

  it('keeps policy-disabled and unavailable states safe and separate from provider details', () => {
    const disabled: AssistantExecutionPolicyStatus = {
      ...readyWorkspace,
      policy: { ...readyPolicy, enabled: false },
      readiness: { state: 'blocked', reasonCode: 'policy_revoked' }
    };
    const { rerender } = render(<AssistantPolicySummary status="loaded" policy={disabled} />);
    expect(screen.getByRole('status')).toHaveTextContent('Execution is blocked by policy.');
    expect(screen.getByText('Execution is turned off for this scope.')).toBeInTheDocument();
    expect(screen.getByText('Nebius Token Factory · Nemotron Example')).toBeInTheDocument();
    expect(screen.queryByText('Current request')).not.toBeInTheDocument();

    const unconfigured: AssistantExecutionPolicyStatus = {
      ...readyWorkspace,
      policy: { ...readyPolicy, provider: null },
      readiness: { state: 'unavailable', reasonCode: 'provider_unconfigured' }
    };
    rerender(<AssistantPolicySummary status="loaded" policy={unconfigured} />);
    expect(screen.getByRole('status')).toHaveTextContent('The provider is not configured.');
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/No provider is configured, so selected context is not sent/u)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /terms/u })).not.toBeInTheDocument();

    const runtimeUnverified: AssistantExecutionPolicyStatus = {
      ...readyWorkspace,
      readiness: { state: 'unavailable', reasonCode: 'runtime_unverified' }
    };
    rerender(<AssistantPolicySummary status="loaded" policy={runtimeUnverified} />);
    expect(screen.getByRole('status')).toHaveTextContent('The configured assistant runtime is unavailable.');
    expect(screen.getByText(/The configured assistant runtime is unavailable, so no request is sent to the provider/u)).toHaveTextContent('If it becomes available and policy permits execution, selected context will be sent to Nebius Token Factory for processing.');
    expect(screen.queryByText('runtime_unverified')).not.toBeInTheDocument();
  });

  it('does not link to terms based on an unrecognized provider label', () => {
    const unknownProvider: AssistantExecutionPolicyStatus = {
      ...readyWorkspace,
      policy: { ...readyPolicy, provider: { name: 'Unrecognized display name', model: 'safe-model' } }
    };
    render(<AssistantPolicySummary status="loaded" policy={unknownProvider} />);

    expect(screen.getByText(/Unrecognized display name.*safe-model/u)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /terms/u })).not.toBeInTheDocument();
  });

  it('hides unsafe file paths and explains workspace-only file unavailability', () => {
    const unavailableFiles: AssistantExecutionPolicyStatus = {
      ...readyWorkspace,
      policy: {
        ...readyPolicy,
        included: { ...readyPolicy.included, items: [
          { kind: 'file', name: 'C:\\private\\token.txt' },
          { kind: 'file', name: '../outside.txt' }
        ] }
      },
      fileAccess: false,
      readiness: { state: 'ready' }
    };
    render(<AssistantPolicySummary status="loaded" policy={unavailableFiles} />);

    expect(screen.getByText('Files and file tools are unavailable in this workspace. Task and planning assistance remain available where enabled.')).toBeInTheDocument();
    expect(screen.queryByText('C:\\private\\token.txt')).not.toBeInTheDocument();
    expect(screen.queryByText('../outside.txt')).not.toBeInTheDocument();
    expect(screen.queryByText('Read selected workspace files')).not.toBeInTheDocument();
    expect(screen.queryByText('Update selected workspace files')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Assistant policy summary' })).getByText('Assistant is available.')).toBeInTheDocument();
  });

  it('does not display a host path returned as a workspace label', () => {
    const unexpectedLabel: AssistantExecutionPolicyStatus = {
      ...readyWorkspace,
      scope: { kind: 'workspace', label: 'C:\\operator\\private' }
    };
    render(<AssistantPolicySummary status="loaded" policy={unexpectedLabel} />);

    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.queryByText('C:\\operator\\private')).not.toBeInTheDocument();
  });

  it('handles a missing policy with generic copy and does not reveal backend reason codes', () => {
    const missing: AssistantExecutionPolicyStatus = {
      scope: { kind: 'home', label: 'Home' },
      policy: null,
      fileAccess: false,
      readiness: { state: 'unavailable', reasonCode: 'policy_unavailable' }
    };
    render(<AssistantPolicySummary status="loaded" policy={missing} />);

    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Assistant policy is unavailable.');
    expect(screen.getByText('Policy details are unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Execution is turned off for this scope.')).not.toBeInTheDocument();
    expect(screen.queryByText('policy_unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText(/Files and file tools are unavailable/iu)).not.toBeInTheDocument();
  });
});
