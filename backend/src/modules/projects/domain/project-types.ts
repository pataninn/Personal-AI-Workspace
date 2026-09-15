export type ProjectStatus = 'active' | 'archived';

export interface Project {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly slug: string;
  readonly relativeRoot: string;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

