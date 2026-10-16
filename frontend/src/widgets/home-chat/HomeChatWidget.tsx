import type { HomeConversationScope } from '@/entities/home-conversation';
import { HomeChat } from '@/features/home-chat';

interface HomeChatWidgetProps {
  readonly scope: HomeConversationScope;
  readonly scopeLabel: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

/** Compose the Home-only planning conversation surface for Home and rootless workspaces. */
export function HomeChatWidget(props: HomeChatWidgetProps): React.JSX.Element {
  return <HomeChat {...props} />;
}
