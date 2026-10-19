import { useState } from 'react';
import { useLocation } from 'react-router-dom';

import { selectPrincipal } from '@/entities/user-session';
import { HomeChat } from '@/features/home-chat';
import { useAppSelector } from '@/app/store/hooks';
import { Button, DialogRoot, DialogTrigger, Icon } from '@/shared/ui';

import './home-ask.css';

interface HomeAskProps {
  readonly onSummaryRefreshRequested?: () => void;
}

export function HomeAsk({ onSummaryRefreshRequested }: HomeAskProps): React.JSX.Element | null {
  const principal = useAppSelector(selectPrincipal);
  const location = useLocation();
  const [open, setOpen] = useState(false);

  if (!principal || /^\/admin(?:\/|$)/u.test(location.pathname) || location.pathname === '/login') return null;

  return <DialogRoot open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button type="button" className="home-ask-launcher" data-testid="home-ask-launcher" aria-label="Open Home assistant">
        <Icon name="chat" size={18} /><span>Ask</span>
      </Button>
    </DialogTrigger>
    <HomeChat
      key={principal.id}
      scope={{ kind: 'home' }}
      scopeLabel="Home scope"
      presentation="ask"
      open={open}
      onSummaryRefreshRequested={onSummaryRefreshRequested}
      onClose={() => setOpen(false)}
    />
  </DialogRoot>;
}
