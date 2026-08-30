import { useCallback, useEffect, useState } from 'react';

import {
  decideRecovery,
  fetchDemoState,
  resetDemo,
  type DemoScenario,
  type DemoState,
} from './api';

const scenarios: { id: DemoScenario; label: string }[] = [
  { id: 'successful_recovery', label: 'Successful Recovery' },
  { id: 'policy_rejection', label: 'Policy Rejection' },
  { id: 'duplicate_prevention', label: 'Duplicate Prevention' },
  { id: 'abstention', label: 'Abstention' },
  { id: 'expired_action', label: 'Expired Action' },
  { id: 'verification_failure', label: 'Verification Failure' },
];

function formatSimulatedValue(paise: number) {
  return `${paise.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} simulated units`;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

function shortTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function StatusChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-chip">
      <span>{label}</span>
      <strong>
        <i aria-hidden="true" />
        {value}
      </strong>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  detail,
  headingId,
}: {
  eyebrow: string;
  title: string;
  detail?: string;
  headingId?: string;
}) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={headingId}>{title}</h2>
      </div>
      {detail ? <p className="section-detail">{detail}</p> : null}
    </div>
  );
}

export function App() {
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDemo = useCallback(async () => {
    setError(null);
    try {
      setDemo(await fetchDemoState());
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Demo API is unavailable');
    }
  }, []);

  useEffect(() => {
    void loadDemo();
  }, [loadDemo]);

  async function chooseScenario(scenario: DemoScenario) {
    setBusy(true);
    setError(null);
    try {
      setDemo(await resetDemo(scenario));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to reset demo');
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'approve' | 'reject') {
    if (!demo) return;
    setBusy(true);
    setError(null);
    try {
      setDemo(await decideRecovery(demo.correlationId, decision));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to update recovery');
    } finally {
      setBusy(false);
    }
  }

  if (demo === null) {
    return (
      <main className="shell loading-shell">
        <div className="brand-mark">FG</div>
        <p className="eyebrow">FLOWGUARD · CONTROL TOWER</p>
        <h1>Connecting to the deterministic demo…</h1>
        {error ? (
          <div className="error-banner" role="alert">
            <strong>Demo API unavailable.</strong> {error}
            <button type="button" onClick={() => void loadDemo()}>
              Retry connection
            </button>
          </div>
        ) : null}
      </main>
    );
  }

  const awaitingApproval = demo.current.state === 'AWAITING_MERCHANT_APPROVAL';
  const recovered = demo.outcome?.status === 'RECOVERED';
  const maxValue = Math.max(
    ...demo.batch.syntheticEvaluation.budgetCurve.map((point) => point.flowGuardPaise),
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">FG</span>
          <div>
            <strong>FlowGuard</strong>
            <span>RecoveryPilot 2.0</span>
          </div>
        </div>
        <div className="topbar-meta">
          <span className="mode-badge">SIMULATION / DEMO MODE</span>
          <span className="topbar-time">Fixed seed · deterministic</span>
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">RECOVERY CONTROL TOWER</p>
          <h1>Turn payment degradation into a controlled recovery decision.</h1>
          <p className="lede">
            FlowGuard detects emerging UPI Intent risk, quantifies the opportunity, then waits for
            explicit merchant approval before one bounded action.
          </p>
        </div>
        <div className="intro-status">
          <p className="eyebrow">RUNNING IN</p>
          <strong>Simulation</strong>
          <span>Nothing here touches production funds.</span>
        </div>
      </section>

      {error ? (
        <div className="error-banner" role="alert">
          <strong>Could not update the demo.</strong> {error}
          <button type="button" onClick={() => void loadDemo()}>
            Reload state
          </button>
        </div>
      ) : null}

      <section className="status-grid" aria-label="System status">
        <StatusChip label="Detector" value={demo.systemStatus.detector} />
        <StatusChip label="Policy engine" value={demo.systemStatus.policy} />
        <StatusChip label="Executor" value={demo.systemStatus.executor} />
        <StatusChip label="Verification" value={demo.systemStatus.verification} />
        <StatusChip label="AI explanation" value={demo.systemStatus.llm} />
      </section>

      <section className="scenario-strip" aria-labelledby="scenario-heading">
        <div>
          <p className="eyebrow">DEMO SCENARIO</p>
          <h2 id="scenario-heading">{demo.scenarioLabel}</h2>
        </div>
        <div className="scenario-list" role="list" aria-label="Choose a deterministic scenario">
          {scenarios.map((scenario) => (
            <button
              className={
                scenario.id === demo.scenario ? 'scenario-button selected' : 'scenario-button'
              }
              disabled={busy}
              key={scenario.id}
              onClick={() => void chooseScenario(scenario.id)}
              type="button"
            >
              {scenario.label}
            </button>
          ))}
        </div>
      </section>

      <section className="opportunity-grid" aria-labelledby="opportunity-heading">
        <div className="opportunity-main">
          <SectionHeading
            eyebrow="WHAT IS HAPPENING?"
            title="A merchant is drifting into UPI Intent degradation."
            detail={`Source event ${demo.current.paymentReference}`}
            headingId="opportunity-heading"
          />
          <div className="opportunity-value">
            <span>Expected recovery opportunity</span>
            <strong>{formatSimulatedValue(demo.current.expectedRecoveryValuePaise)}</strong>
            <small>Predicted value · not recovered value · SIMULATION</small>
          </div>
          <div className="signal-row">
            <div>
              <span>Risk score</span>
              <strong>{formatPercent(demo.current.riskScore)}</strong>
            </div>
            <div>
              <span>Amount at risk</span>
              <strong>{formatSimulatedValue(demo.current.amountPaise)}</strong>
            </div>
            <div>
              <span>Severity</span>
              <strong>{demo.current.severity}</strong>
            </div>
          </div>
          <div className="reason-box">
            <span className="label">WHY THIS OPPORTUNITY</span>
            <p>{demo.current.reason}</p>
            <div className="reason-codes">
              {demo.current.reasonCodes.map((code) => (
                <span key={code}>{code.replaceAll('_', ' ')}</span>
              ))}
            </div>
          </div>
          <div className="model-signal">
            <div className="model-signal-heading">
              <span className="label">MODEL SIGNAL</span>
              <small>{demo.current.modelSignal.provenance}</small>
            </div>
            <div className="model-signal-details">
              <div>
                <span>Model</span>
                <strong>{demo.current.modelSignal.modelType}</strong>
              </div>
              <div>
                <span>Estimated recovery probability</span>
                <strong>{formatPercent(demo.current.modelSignal.estimatedProbability)}</strong>
              </div>
              <div>
                <span>Version</span>
                <strong>{demo.current.modelSignal.modelVersion}</strong>
              </div>
            </div>
            <div className="signal-tags">
              {demo.current.modelSignal.importantSignals.map((signal) => (
                <span key={signal}>{signal.replaceAll('_', ' ')}</span>
              ))}
            </div>
            <small className="model-signal-note">{demo.current.modelSignal.calibrationNote}</small>
          </div>
        </div>
        <div className="pipeline-card">
          <SectionHeading eyebrow="RECOVERY PIPELINE" title="Every step is visible." />
          <ol className="pipeline">
            {demo.pipeline.map((step) => (
              <li className={`pipeline-step ${step.status}`} key={step.key}>
                <span className="pipeline-node" aria-hidden="true">
                  {step.status === 'complete' ? '✓' : step.status === 'active' ? '•' : '—'}
                </span>
                <span>{step.label}</span>
                <small>{step.status}</small>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="decision-grid" aria-label="Recovery decision">
        <div className="approval-panel">
          <div className="panel-kicker">
            <span className="step-number">01</span>
            <span>DETERMINISTIC DECISION</span>
          </div>
          <SectionHeading
            eyebrow="RECOMMENDED ACTION"
            title={demo.current.action}
            detail={demo.current.state}
          />
          <p className="approval-copy">
            {awaitingApproval
              ? 'Approval is required before the financial/test action.'
              : 'Merchant approval was required before the financial/test action.'}{' '}
            FlowGuard will attempt at most one payment link and only verified payment capture counts
            as recovery.
          </p>
          <div className="approval-details">
            <div>
              <span>Merchant reference</span>
              <strong>{demo.current.merchantReference}</strong>
            </div>
            <div>
              <span>Payment reference</span>
              <strong>{demo.current.paymentReference}</strong>
            </div>
            <div>
              <span>Action expires</span>
              <strong>
                {demo.approvalPayload ? shortTime(demo.approvalPayload.expiresAt) : 'Not created'}
              </strong>
            </div>
          </div>
          <div className="policy-checks">
            <span className="label">POLICY CHECKS</span>
            {demo.approvalPayload?.policyChecks.map((check) => (
              <div className="check-row" key={check.check}>
                <span className={check.passed ? 'check-icon passed' : 'check-icon blocked'}>
                  {check.passed ? '✓' : '×'}
                </span>
                <span>{check.check.replaceAll('_', ' ')}</span>
                <strong>{check.passed ? 'PASS' : 'BLOCK'}</strong>
              </div>
            ))}
          </div>
          <div className="approval-actions">
            <button
              className="primary-button"
              disabled={!awaitingApproval || busy}
              onClick={() => void decide('approve')}
              type="button"
            >
              Approve recovery <span>→</span>
            </button>
            <button
              className="secondary-button"
              disabled={!awaitingApproval || busy}
              onClick={() => void decide('reject')}
              type="button"
            >
              Reject
            </button>
          </div>
          <p className="decision-source">
            <span>DECISION SOURCE</span> Model <b>→</b> Policy <b>→</b> Merchant approval
          </p>
        </div>

        <div className={recovered ? 'outcome-panel recovered-panel' : 'outcome-panel'}>
          <div className="panel-kicker">
            <span className="step-number">02</span>
            <span>EXPLANATION & OUTCOME</span>
          </div>
          <SectionHeading eyebrow="AI EXPLANATION" title="Why FlowGuard made this call." />
          <div className="explanation-quote">
            <span className="quote-mark">“</span>
            <p>{demo.explanation.output.merchantExplanation}</p>
          </div>
          <div className="explanation-source">
            <span>EXPLANATION SOURCE</span>
            <strong>
              {demo.explanation.source === 'llm' ? 'LLM · VALIDATED' : 'DETERMINISTIC FALLBACK'}
            </strong>
          </div>
          <div className="outcome-block" aria-live="polite">
            {demo.outcome ? (
              <>
                <span className="label">RECOVERY OUTCOME</span>
                <strong>{demo.outcome.status.replaceAll('_', ' ')}</strong>
                <p>
                  {demo.outcome.status === 'RECOVERED'
                    ? `${formatSimulatedValue(demo.outcome.recoveredAmountPaise)} verified by ${demo.outcome.verification}.`
                    : demo.outcome.reason}
                </p>
              </>
            ) : (
              <>
                <span className="label">OUTCOME</span>
                <strong>Awaiting merchant decision</strong>
                <p>The action has not been executed.</p>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="impact-section" aria-labelledby="impact-heading">
        <SectionHeading
          eyebrow="BATCH IMPACT"
          title="Opportunity ranking compounds at scale."
          detail="FlowGuard vs fixed input-order baseline"
          headingId="impact-heading"
        />
        <div className="impact-layout">
          <div className="metric-grid">
            <div className="impact-metric featured">
              <span>Demo recovered value</span>
              <strong>{formatSimulatedValue(demo.batch.runtime.recoveredValuePaise)}</strong>
              <small>DEMO / SIMULATION · PAISE-LIKE UNITS</small>
            </div>
            <div className="impact-metric">
              <span>Candidates</span>
              <strong>{demo.batch.runtime.candidates}</strong>
              <small>Current run</small>
            </div>
            <div className="impact-metric">
              <span>Interventions</span>
              <strong>{demo.batch.runtime.interventions}</strong>
              <small>Bounded attempts</small>
            </div>
            <div className="impact-metric">
              <span>Abstentions</span>
              <strong>{demo.batch.runtime.abstentions}</strong>
              <small>Policy controlled</small>
            </div>
            <div className="impact-metric">
              <span>Duplicates blocked</span>
              <strong>{demo.batch.runtime.duplicateActionsPrevented}</strong>
              <small>Idempotency</small>
            </div>
            <div className="impact-metric">
              <span>Success rate</span>
              <strong>{formatPercent(demo.batch.runtime.recoverySuccessRate)}</strong>
              <small>Verified recoveries</small>
            </div>
            <div className="impact-metric">
              <span>False interventions avoided</span>
              <strong>{demo.batch.runtime.falseInterventionsAvoided}</strong>
              <small>Policy controlled</small>
            </div>
          </div>
          <div className="chart-card">
            <div className="chart-header">
              <div>
                <span className="label">{demo.batch.syntheticEvaluation.label}</span>
                <h3>Cumulative recovered value by budget</h3>
              </div>
              <div className="legend">
                <span>
                  <i className="legend-flow" />
                  FlowGuard
                </span>
                <span>
                  <i className="legend-base" />
                  Baseline
                </span>
              </div>
            </div>
            <div className="bar-chart" aria-label="FlowGuard versus fixed baseline recovered value">
              {demo.batch.syntheticEvaluation.budgetCurve.map((point) => (
                <div className="chart-row" key={point.budget}>
                  <span className="chart-label">Budget {point.budget}</span>
                  <div className="bar-track">
                    <div
                      className="bar flow-bar"
                      style={{ width: `${(point.flowGuardPaise / maxValue) * 100}%` }}
                      title={`FlowGuard ${formatSimulatedValue(point.flowGuardPaise)}`}
                    />
                    <div
                      className="bar base-bar"
                      style={{ width: `${(point.baselinePaise / maxValue) * 100}%` }}
                      title={`Baseline ${formatSimulatedValue(point.baselinePaise)}`}
                    />
                  </div>
                  <div className="chart-values">
                    <strong>{formatSimulatedValue(point.flowGuardPaise)}</strong>
                    <small>{formatSimulatedValue(point.baselinePaise)} baseline</small>
                  </div>
                </div>
              ))}
            </div>
            <p className="chart-note">{demo.batch.syntheticEvaluation.note}</p>
          </div>
        </div>
      </section>

      <section className="lower-grid">
        <div className="audit-card">
          <SectionHeading
            eyebrow="OBSERVABILITY"
            title="Audit timeline"
            detail={`${demo.audit.length} events`}
          />
          <ol className="audit-list">
            {demo.audit.map((event) => (
              <li key={`${event.sequence}-${event.eventType}`}>
                <time>{shortTime(event.timestamp)}</time>
                <span className="audit-line" aria-hidden="true" />
                <div>
                  <strong>{event.eventType.replaceAll('_', ' ')}</strong>
                  <small>
                    {event.state} {event.actionId ? `· ${event.actionId}` : ''}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="safety-card">
          <SectionHeading eyebrow="SAFETY / FAILURE SCENARIOS" title="The system can say no." />
          <p>
            Choose any scenario above to reset the same flow and see a deterministic safe stop:
            policy rejection, abstention, duplicate prevention, expiry or verification failure.
          </p>
          <div className="retry-note">
            <span className="label">WHY NOT JUST RETRY?</span>
            <p>
              A fixed retry spends limited intervention budget without ranking opportunity value.
              Timing, approval, duplicate state and verified outcomes matter.
            </p>
          </div>
          <div className="safety-list">
            <span>
              <b>ABSTAINED</b> Low confidence
            </span>
            <span>
              <b>BLOCKED</b> Duplicate request
            </span>
            <span>
              <b>STOPPED</b> Already recovered
            </span>
            <span>
              <b>PENDING</b> Verification timeout
            </span>
          </div>
          <details>
            <summary>Technical detail</summary>
            <dl className="technical-list">
              {Object.entries(demo.technical).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll(/([A-Z])/g, ' $1')}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </section>

      <section className="how-section" aria-labelledby="how-heading">
        <SectionHeading
          eyebrow="HOW FLOWGUARD WORKS"
          title="A controlled path from signal to value."
          headingId="how-heading"
        />
        <div className="how-grid">
          {[
            ['01', 'DETECT', 'Detect payment degradation.'],
            ['02', 'QUANTIFY', 'Estimate recovery opportunity.'],
            ['03', 'DECIDE', 'Apply deterministic safety policy.'],
            ['04', 'APPROVE', 'Get merchant authorization.'],
            ['05', 'RECOVER', 'Execute one bounded action.'],
            ['06', 'VERIFY', 'Confirm actual payment outcome.'],
            ['07', 'MEASURE', 'Track recovered value against baseline.'],
          ].map(([number, title, copy]) => (
            <div className="how-step" key={title}>
              <span>{number}</span>
              <strong>{title}</strong>
              <p>{copy}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="disclosure">
        <strong>HONEST AI DISCLOSURE</strong>
        <span>
          Model evaluation uses synthetic data and does not represent production Razorpay traffic.
          Demo recovery outcomes are simulated unless explicitly marked Razorpay TEST MODE.
        </span>
      </footer>
    </main>
  );
}
