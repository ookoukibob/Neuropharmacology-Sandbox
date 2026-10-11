import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

/**
 * Async-wait budget (phase 20): `findBy*`/`waitFor` poll the SAME
 * assertions as before — only their default deadline is raised from 1 s
 * to 5 s so wall-clock waits are not exceeded purely by full-suite CPU
 * contention (the save/import chains are storage-bound; a broken chain
 * still fails, just after the longer budget). No assertion, retry
 * semantics or skip behavior changes.
 */
configure({ asyncUtilTimeout: 5000 })
