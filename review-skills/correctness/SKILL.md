---
name: correctness
description: Defects the change introduces in behavior, control flow, state and error handling. Applies to every file.
---

# Correctness

Report defects this change causes:

- Broken control flow and incorrect assumptions.
- Null, undefined, empty and boundary cases.
- State that becomes inconsistent, including partial failure and concurrent use.
- Missing or wrong error handling.
- Regressions for existing callers, data or configuration.

Read the callers, callees and tests a change touches when the diff alone cannot show the effect. Explain the input or state that triggers the defect and what goes wrong.
