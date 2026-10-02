# Architecture

The fork retains the upstream workflow tool and adds a separate reusable library. This avoids binding multi-provider scheduling to its Codex-only prompt generation and automatic integration assumptions.

```
TaskSource             QuotaReader
  GitHub / JSON / MD     official Codex metadata / helper / file
          \               /
             Scheduler
       admission + reservations
       dependencies + concurrency
       durable state + recovery
                 |
             AgentAdapter
          Codex / Claude / custom
                 |
          isolated Git worktree
                 |
           review -> done
```

The orchestrator is ordinary Node code. It does not spend model calls choosing tasks, polling quotas, or waiting. Vendor clients execute prompts; their session IDs are persisted early. A failed turn is classified at the adapter boundary. Only quota failures with a known session receive automatic continuation. An interrupted process is a different state and needs explicit inspection.

Storage is versioned JSON with atomic rename and an exclusive supervisor lock. It deliberately uses one writer. A crashed lock is not forcefully recovered because another process or descendant may still be running. Worktrees are retained as artifacts; they are never automatically merged or removed.

Task identity is immutable once attempted. Sources only provide definitions; execution status does not mutate the remote tracker. GitHub Issues marked closed supply an initial done state. Local approval is the review boundary for dependency unlocking. The source checkout's HEAD is the integration boundary for subsequent worktrees.

Quota admission is conservative and approximate: subtract configured reserves and outstanding worker estimates from all reported windows. Recent workers retain their reservations briefly to mitigate telemetry lag. Pool identity binds reservations for model adapters that use the same account. No percentage threshold can guarantee a hard token budget; extensions could learn task costs or add provider-side per-run caps, but this version does not claim those properties.

Extension points are TaskSource, AgentAdapter, QuotaReader and StateStore. The package root exports them with TypeScript declarations. CLI configuration builds the concrete adapters; library consumers can inject their own.
