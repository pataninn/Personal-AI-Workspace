interface IconProps {
  readonly name: 'folder' | 'file' | 'home' | 'user' | 'plus' | 'arrow' | 'close' | 'chat' | 'check' | 'chevron';
  readonly size?: number;
}

const PATHS: Record<IconProps['name'], string> = {
  folder: 'M3 7h6l2 3h10v10H3V7Z',
  file: 'M6 3h9l4 4v14H6V3Zm9 0v5h4',
  home: 'M3.5 11 12 3.5 20.5 11M5.5 9.5V20h13V9.5',
  user: 'M8 7a4 4 0 1 0 8 0 4 4 0 1 0-8 0M5 21v-2a7 7 0 0 1 14 0v2',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  close: 'm6 6 12 12M6 18 18 6',
  chat: 'M3 4h18v13H9l-6 5V4Z',
  check: 'm5 12 4 4L19 6',
  chevron: 'm6 9 6 6 6-6'
};

/** Decorative line icon; the owning control supplies its accessible name. */
export function Icon({ name, size = 20 }: IconProps): React.JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>;
}
