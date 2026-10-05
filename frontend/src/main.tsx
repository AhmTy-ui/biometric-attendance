import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { ScopeProvider } from './lib/scope';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Keep showing the last synchronised data when offline; retry only transient failures.
      retry: (count, err) => (err instanceof ApiError ? (err.status === 0 || err.status >= 500) && count < 2 : count < 2),
      placeholderData: (prev: unknown) => prev
    }
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <ScopeProvider>
              <App />
            </ScopeProvider>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
