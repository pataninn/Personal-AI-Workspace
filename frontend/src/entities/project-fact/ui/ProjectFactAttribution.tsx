import type { ProjectFact, ProjectFactSourceKind, ProjectFactVerificationStatus } from '@/entities/project-fact/model/types';

interface ProjectFactAttributionProps {
  readonly fact: ProjectFact;
}

/** Usage: Render beside a fact in memory management or run selection to show its server-owned source and review status. */
export function ProjectFactAttribution({ fact }: ProjectFactAttributionProps): React.JSX.Element {
  return (
    <dl className="project-fact-attribution">
      <div>
        <dt>Source</dt>
        <dd>{sourceLabel(fact.source.kind, fact.source.label)}{fact.source.reference ? ` · ${fact.source.reference}` : ''}</dd>
      </div>
      <div>
        <dt>Review status</dt>
        <dd>{verificationLabel(fact.verificationStatus, fact.verifiedAt)}</dd>
      </div>
      <div>
        <dt>Updated</dt>
        <dd><time dateTime={fact.updatedAt}>Last updated {formatDate(fact.updatedAt)}</time></dd>
      </div>
    </dl>
  );
}

function sourceLabel(kind: ProjectFactSourceKind, label: string): string {
  if (!label.trim()) {
    return 'Source not recorded';
  }
  if (kind === 'user') {
    return label;
  }
  return `${label} (${kind === 'conversation' ? 'conversation' : 'project file'})`;
}

function verificationLabel(status: ProjectFactVerificationStatus, verifiedAt: string | null): string {
  if (status === 'needs_review') {
    return 'Needs review';
  }
  const date = verifiedAt ? formatDate(verifiedAt) : '';
  return date ? `Verified by you on ${date}` : 'Verified by you';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'date unavailable' : date.toLocaleDateString();
}
