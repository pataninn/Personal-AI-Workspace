import { Icon } from '@/shared/ui';

/** Match the reference's decorative identity without adding authentication fields. */
export function SignInArtwork(): React.JSX.Element {
  return <div className="login-artwork" aria-hidden="true"><span className="login-brand-mark">P</span><div className="login-art-tiles"><span className="login-art-tile art-folder"><Icon name="folder" size={68} /></span><span className="login-art-tile art-file"><Icon name="file" size={56} /></span><span className="login-art-tile art-chat"><Icon name="chat" size={64} /></span><span className="login-art-tile art-check"><Icon name="check" size={44} /></span></div><p className="login-wordmark">Personal <span>AI</span><br />Workspace.</p></div>;
}
