import { useNavigate } from 'react-router-dom';
import { Badge, Button, KV, LinkButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { StatusScreen } from '@/pages/auth/components';

export default function Forbidden() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <StatusScreen
      icon="block"
      tone="error"
      code="HTTP 403 · Forbidden"
      title="You don't have permission to access this resource"
      actions={
        <>
          <Button icon="arrow_back" onClick={() => navigate(-1)}>
            Go back
          </Button>
          {me ? (
            <>
              <LinkButton to="/" variant="primary" icon="grid_view">
                Back to dashboard
              </LinkButton>
              <Button variant="ghost" icon="logout" onClick={() => void logout()}>
                Sign in as a different user
              </Button>
            </>
          ) : (
            <LinkButton to="/login" variant="primary" icon="login">
              Sign in
            </LinkButton>
          )}
        </>
      }
    >
      <p>
        Access is granted by role and, for branch supervisors, by assigned locations. Every request is checked by the server, so this page appears when your
        account lacks the required permission.
      </p>
      {me && (
        <div className="bg-surface-container-lowest rounded-lg p-space-md">
          <KV label="Signed in as">{me.user.fullName}</KV>
          <KV label="Role">
            <Badge tone="primary">{me.user.roleLabel}</Badge>
          </KV>
          <KV label="Location access">{me.locationScope ? (me.locationScope.length ? me.locationScope.map((l) => l.name).join(', ') : 'None assigned') : 'All locations'}</KV>
        </div>
      )}
      <p className="font-body-sm text-body-sm">If you need this access, ask an administrator to change your role or location assignment in Users &amp; Roles.</p>
    </StatusScreen>
  );
}
