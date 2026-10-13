import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

import { Layout } from '@/components/layout/layout';
import { AuthProvider, useSession } from '@/lib/auth-context';
import LoginPage from '@/pages/login';
import PinLoginPage from '@/pages/pin-login';
import DashboardPage from '@/pages/dashboard';
import ProductsPage from '@/pages/products';
import BouquetsPage from '@/pages/bouquets';
import MovementsPage from '@/pages/movements';
import AnalyticsPage from '@/pages/analytics';
import AssistantPage from '@/pages/assistant';
import UsersPage from '@/pages/users';
import SettingsPage from '@/pages/settings';
import SetupPage from '@/pages/setup';

// A stock terminal runs on a shop LAN, so a failed request is either a real
// outage or a dead server: three retries with exponential backoff only delay the
// offline notice the user needs to see.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      retryDelay: 1000,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Layout>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/products" component={ProductsPage} />
          <Route path="/bouquets" component={BouquetsPage} />
          <Route path="/movements" component={MovementsPage} />
          <Route path="/analytics" component={AnalyticsPage} />
          <Route path="/assistant" component={AssistantPage} />
          <Route path="/users" component={UsersPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Layout>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

/**
 * Decides between the sign-in screens and the app itself.
 *
 * The session is the single source of truth: while it is unknown a placeholder
 * is shown, so a signed-in user never sees the login form flash on reload.
 */
function AuthenticatedApp() {
  const { session, isLoading, unauthorized } = useSession();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Проверяем сессию...
      </div>
    );
  }

  if (unauthorized || !session) {
    return (
      <Switch>
        {/* Первый вход нового магазина: ссылка сама себя удостоверяет, сессии ещё нет. */}
        <Route path="/setup/:token" component={SetupPage} />
        <Route path="/setup" component={SetupPage} />
        <Route path="/login" component={LoginPage} />
        <Route path="/pin" component={PinLoginPage} />
        <Route component={LoginPage} />
      </Switch>
    );
  }

  return (
    <AuthProvider session={session}>
      <Router />
    </AuthProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthenticatedApp />
        </WouterRouter>
        <Toaster richColors position="top-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
