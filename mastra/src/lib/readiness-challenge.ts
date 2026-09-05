import { createReadinessChallenge } from './readiness-challenge.internal.js'

export type ReadinessArtifactOrigin = 'fixture:buggy' | 'fixture:reference' | 'candidate'

export interface ReadinessArtifact {
  source: string
  identity: string
  origin: ReadinessArtifactOrigin
}

export interface ReferenceArtifact extends ReadinessArtifact {
  origin: 'fixture:reference'
  targetIdentity: string
}

export interface CertifiedArtifact extends ReadinessArtifact {
  certification: {
    testsPassed: 5
    testsFailed: 0
    testsSkipped: 0
    exitCode: 0
  }
}

export interface ReadinessTestResult {
  pass: number
  fail: number
  skip: number
  green: boolean
  output: string
  exitCode: number
  durationMs: number
  failed: string[]
}

export type CertificationResult =
  | { outcome: 'certified'; artifact: CertifiedArtifact; result: ReadinessTestResult }
  | { outcome: 'ineligible'; reason: string }
  | { outcome: 'candidate-failed'; failure: 'compile' | 'tests'; result: ReadinessTestResult }
  | { outcome: 'cancelled'; reason: string }
  | { outcome: 'timed-out'; reason: string }
  | { outcome: 'execution-error'; error: string; result?: ReadinessTestResult }

export interface ReadinessChallenge {
  load(kind: 'buggy'): Promise<ReadinessArtifact>
  load(kind: 'reference'): Promise<ReferenceArtifact>
  certify(
    source: string | ReadinessArtifact,
    options?: { abortSignal?: AbortSignal },
  ): Promise<CertificationResult>
}

export const readinessChallenge: ReadinessChallenge = createReadinessChallenge()
