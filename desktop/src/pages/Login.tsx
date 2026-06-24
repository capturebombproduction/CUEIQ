import { LoginForm } from "@/components/auth/login-form";

/** Mirrors the web login: the same LoginForm component (reused verbatim) centered
 *  with the CueIQ wordmark. Same Supabase auth → same accounts as the web app. */
export function Login() {
  return (
    <div className="grid min-h-screen place-items-center bg-muted/30 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-primary">CueIQ</h1>
          <p className="mt-1 text-sm text-muted-foreground">Desktop · Smart cues for every show</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
