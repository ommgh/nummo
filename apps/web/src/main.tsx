import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FullPageSpinner } from "@/components/brand";
import "./index.css";

// The website and the dashboard are separate chunks: visitors never download the dashboard, and the reverse.
const Landing = lazy(() => import("@/site/landing").then((m) => ({ default: m.Landing })));
const SignIn = lazy(() => import("@/auth/sign-in").then((m) => ({ default: m.SignInPage })));
const SignUp = lazy(() => import("@/auth/sign-up").then((m) => ({ default: m.SignUpPage })));
const ForgotPassword = lazy(() => import("@/auth/reset-password").then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPassword = lazy(() => import("@/auth/reset-password").then((m) => ({ default: m.ResetPasswordPage })));
const Terms = lazy(() => import("@/site/legal").then((m) => ({ default: m.TermsPage })));
const Privacy = lazy(() => import("@/site/legal").then((m) => ({ default: m.PrivacyPage })));
const Onboarding = lazy(() => import("@/auth/onboarding").then((m) => ({ default: m.OnboardingPage })));
const DashboardRoot = lazy(() => import("@/dashboard/root").then((m) => ({ default: m.DashboardRoot })));
const page = (load: () => Promise<Record<string, unknown>>, name: string) => async () => ({ Component: (await load())[name] as React.ComponentType });

const router = createBrowserRouter([
  {
    element: (
      <Suspense fallback={<FullPageSpinner />}>
        <Outlet />
      </Suspense>
    ),
    children: [
      { path: "/", element: <Landing /> },
      { path: "/sign-in", element: <SignIn /> },
      { path: "/sign-up", element: <SignUp /> },
      { path: "/forgot-password", element: <ForgotPassword /> },
      { path: "/reset-password", element: <ResetPassword /> },
      { path: "/onboarding", element: <Onboarding /> },
      { path: "/terms", element: <Terms /> },
      { path: "/privacy", element: <Privacy /> },
      {
        path: "/dashboard",
        element: <DashboardRoot />,
        children: [
          { index: true, lazy: page(() => import("@/dashboard/pages/overview"), "OverviewPage") },
          { path: "customers", lazy: page(() => import("@/dashboard/pages/customers"), "CustomersPage") },
          { path: "customers/:id", lazy: page(() => import("@/dashboard/pages/customer"), "CustomerPage") },
          { path: "plans", lazy: page(() => import("@/dashboard/pages/plans"), "PlansPage") },
          { path: "payments", lazy: page(() => import("@/dashboard/pages/payments"), "PaymentsPage") },
          { path: "usage", lazy: page(() => import("@/dashboard/pages/usage"), "UsagePage") },
          { path: "webhooks", lazy: page(() => import("@/dashboard/pages/webhooks"), "WebhooksPage") },
          { path: "keys", lazy: page(() => import("@/dashboard/pages/keys"), "KeysPage") },
          { path: "settings", lazy: page(() => import("@/dashboard/pages/settings"), "SettingsPage") },
        ],
      },
      { path: "*", element: <Landing /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  </StrictMode>,
);
