import { deleteNoContent, getJson, patchJson, postJson } from '@/shared/api';
import type { CreateSkillRequest, SkillInvocationResult, SkillTemplate, UpdateSkillRequest, UserSkill } from '@/entities/skill/model/types';

const SKILLS_PATH = '/api/v1/skills';

export async function listSkills(): Promise<readonly UserSkill[]> {
  const result = await getJson<{ readonly skills: UserSkill[] }>(SKILLS_PATH);
  return result.skills;
}

export async function listSkillTemplates(): Promise<readonly SkillTemplate[]> {
  const result = await getJson<{ readonly templates: SkillTemplate[] }>(`${SKILLS_PATH}/templates`);
  return result.templates;
}

export async function getSkill(skillId: string): Promise<UserSkill> {
  const result = await getJson<{ readonly skill: UserSkill }>(`${SKILLS_PATH}/${encodeURIComponent(skillId)}`);
  return result.skill;
}

export async function createSkill(request: CreateSkillRequest, csrfToken: string, idempotencyKey: string): Promise<UserSkill> {
  const result = await postJson<{ readonly skill: UserSkill }>(SKILLS_PATH, request, {
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey
  });
  return result.skill;
}

export async function updateSkill(skillId: string, request: UpdateSkillRequest, csrfToken: string): Promise<UserSkill> {
  const result = await patchJson<{ readonly skill: UserSkill }>(`${SKILLS_PATH}/${encodeURIComponent(skillId)}`, request, {
    'X-CSRF-Token': csrfToken
  });
  return result.skill;
}

export function deleteSkill(skillId: string, version: number, csrfToken: string): Promise<void> {
  return deleteNoContent(`${SKILLS_PATH}/${encodeURIComponent(skillId)}`, {
    'X-CSRF-Token': csrfToken,
    'If-Match': `"${version}"`
  });
}

export async function invokeSkill(
  skillId: string,
  request: { readonly conversationId: string; readonly expectedVersion: number; readonly request: string },
  csrfToken: string,
  idempotencyKey: string
): Promise<SkillInvocationResult> {
  return postJson<SkillInvocationResult>(`${SKILLS_PATH}/${encodeURIComponent(skillId)}/invocations`, request, {
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey
  });
}
