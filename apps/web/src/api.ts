export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

export type DemoScenario =
  | 'successful_recovery'
  | 'policy_rejection'
  | 'duplicate_prevention'
  | 'abstention'
  | 'expired_action'
  | 'verification_failure';

export type DemoState = {
  mode: 'SIMULATION';
  scenario: DemoScenario;
  scenarioLabel: string;
  correlationId: string;
  systemStatus: {
    detector: string;
    policy: string;
    executor: string;
    verification: string;
    llm: string;
  };
  current: {
    merchantReference: string;
    paymentReference: string;
    segment: string;
    severity: string;
    riskScore: number;
    expectedRecoveryValuePaise: number;
    amountPaise: number;
    action: string;
    state: string;
    reasonCodes: string[];
    reason: string;
  };
  pipeline: { key: string; label: string; status: 'active' | 'complete' | 'blocked' | 'pending' }[];
  approvalPayload: {
    merchantReference: string;
    paymentReference: string;
    candidateId: string;
    reasonCodes: string[];
    riskScore: number;
    expectedRecoveryValuePaise: number;
    amountPaise: number;
    actionType: string;
    expiresAt: string;
    policyChecks: { check: string; passed: boolean }[];
    explanation: {
      summary: string;
      reasonCodes: string[];
      merchantExplanation: string;
      customerMessageDraft?: string;
    };
  } | null;
  explanation: {
    output: {
      summary: string;
      reasonCodes: string[];
      merchantExplanation: string;
      customerMessageDraft?: string;
    };
    source: 'llm' | 'deterministic_fallback';
    failureReason?: string;
  };
  outcome: {
    status: string;
    recoveredAmountPaise: number;
    verification: string;
    reason: string;
  } | null;
  batch: {
    label: string;
    runtime: {
      candidates: number;
      interventions: number;
      recoveries: number;
      abstentions: number;
      policyRejections: number;
      recoveredValuePaise: number;
      duplicateActionsPrevented: number;
      interventionRate: number;
      recoverySuccessRate: number;
      falseInterventionsAvoided: number;
    };
    syntheticEvaluation: {
      label: string;
      budgetCurve: { budget: number; flowGuardPaise: number; baselinePaise: number }[];
      note: string;
    };
  };
  audit: {
    sequence: number;
    timestamp: string;
    eventType: string;
    state: string;
    actionId: string | null;
    data: Record<string, string | number | boolean | null>;
  }[];
  technical: Record<string, string>;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${url}`, {
    ...init,
    ...(init?.body ? { headers: { 'Content-Type': 'application/json' } } : {}),
  });
  if (!response.ok) {
    throw new Error(`Demo API returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchDemoState(): Promise<DemoState> {
  return request<DemoState>('/demo/state');
}

export function resetDemo(scenario: DemoScenario): Promise<DemoState> {
  return request<DemoState>('/demo/scenario', {
    method: 'POST',
    body: JSON.stringify({ scenario }),
  });
}

export function decideRecovery(
  correlationId: string,
  decision: 'approve' | 'reject',
): Promise<DemoState> {
  return request<DemoState>(`/recovery/${correlationId}/${decision}`, {
    method: 'POST',
  });
}
