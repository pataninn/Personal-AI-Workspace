import { RenameProjectUseCase } from '@/modules/projects/use-cases/rename-project';
import { ProjectNameConflictError, ProjectNameInvalidError, ProjectNotFoundError, ProjectVersionConflictError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';

const project: Project = { id: 'project', ownerId: 'owner', name: 'Before', slug: 'before', relativeRoot: 'existing-folder', storageKind: 'legacy', objective: null, status: 'active', version: 2, createdAt: new Date(), updatedAt: new Date() };

describe('RenameProjectUseCase', () => {
  const input = { ownerId: 'owner', projectId: 'project', expectedVersion: 2, name: '  New name  ' };
  function setup(current: Project | null = project) {
    const repository = { findByIdForOwner: jest.fn().mockResolvedValue(current), rename: jest.fn().mockResolvedValue({ ...project, name: 'New name', slug: 'new-name', version: 3 }) };
    return { repository, useCase: new RenameProjectUseCase(repository) };
  }
  it('normalizes the name and scopes the update by owner and version without changing the root', async () => {
    const { repository, useCase } = setup();
    const result = await useCase.execute(input);
    expect(repository.rename).toHaveBeenCalledWith({ ...input, name: 'New name', slug: 'new-name' });
    expect(result.relativeRoot).toBe(project.relativeRoot);
    expect(result.id).toBe(project.id);
  });
  it('rejects blank names before writing', async () => {
    const { repository, useCase } = setup();
    await expect(useCase.execute({ ...input, name: ' ' })).rejects.toBeInstanceOf(ProjectNameInvalidError);
    expect(repository.rename).not.toHaveBeenCalled();
  });
  it('does not rename another owner workspace', async () => {
    const { repository, useCase } = setup(null);
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(repository.findByIdForOwner).toHaveBeenCalledWith('owner', 'project');
    expect(repository.rename).not.toHaveBeenCalled();
  });
  it('rejects stale versions and a concurrent update', async () => {
    const { repository, useCase } = setup();
    await expect(useCase.execute({ ...input, expectedVersion: 1 })).rejects.toBeInstanceOf(ProjectVersionConflictError);
    expect(repository.rename).not.toHaveBeenCalled();
    repository.rename.mockResolvedValue(null);
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(ProjectVersionConflictError);
  });
  it('preserves duplicate name errors', async () => {
    const { repository, useCase } = setup();
    repository.rename.mockRejectedValue(new ProjectNameConflictError());
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(ProjectNameConflictError);
  });
});
