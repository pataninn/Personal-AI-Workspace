const PROJECT_COLORS = ['#9D8CFF', '#FF9272', '#55CDE3', '#F28BBE'];

/** Give a project the same decorative color in navigation, cards, and tasks. */
export function projectColor(id: string): string {
  const hash = Array.from(id).reduce((value, character) => value + character.charCodeAt(0), 0);
  return PROJECT_COLORS[hash % PROJECT_COLORS.length] ?? '#9D8CFF';
}
