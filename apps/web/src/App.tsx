import { useEffect, useState } from 'react';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

type Health = {
  service: string;
  status: string;
  version: string;
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBaseUrl}/health`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`API returned ${response.status}`);
        }
        return response.json() as Promise<Health>;
      })
      .then(setHealth)
      .catch((requestError: unknown) => {
        setError(requestError instanceof Error ? requestError.message : 'API is unavailable');
      });
  }, []);

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">FLOWGUARD · FOUNDATION</p>
        <h1>RecoveryPilot 2.0</h1>
        <p className="lede">
          A controlled revenue-recovery system for gradual payment degradation. Foundation milestone
          only—no financial actions are available yet.
        </p>
      </section>

      <section className="status-card" aria-labelledby="status-heading">
        <div>
          <p className="eyebrow">SYSTEM STATUS</p>
          <h2 id="status-heading">API health</h2>
        </div>
        {health ? (
          <p className="status success">
            {health.status.toUpperCase()} · {health.service} · v{health.version}
          </p>
        ) : (
          <p className="status pending">{error ?? 'CHECKING'}</p>
        )}
      </section>
    </main>
  );
}
